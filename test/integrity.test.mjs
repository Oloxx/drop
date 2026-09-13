import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createSenderServer, receiveFiles, PROTOCOL_VERSION } from '../cli/src/transfer.js';
import { deriveKey, encryptChunk, sealFrame } from '../cli/src/crypto.js';

// Por el relay todo va cifrado con la clave de la sala, como hace el emisor.
const RELAY_KEY = deriveKey('4271-lemon-radar-tiger-orbit');
const sealed = (obj) => JSON.stringify({ t: 'signal', data: sealFrame(obj, RELAY_KEY) });

// El MISMO modulo que usa el navegador, no una copia: el test tiene que caer si
// alguien rompe la implementacion de verdad.
import { Sha256 } from '../public/shared/sha256.js';

test('Sha256 streaming implementation matches node:crypto on various patterns', () => {
  const testBuffers = [
    Buffer.from(''),
    Buffer.from('a'),
    Buffer.from('hello world'),
    Buffer.alloc(64, 'A'),
    Buffer.alloc(65, 'B'),
    Buffer.alloc(1024 * 64, 'C'),
    Buffer.alloc(1024 * 1024 + 7, 'D'),
  ];

  for (const buf of testBuffers) {
    const expected = crypto.createHash('sha256').update(buf).digest('hex');

    // Single update
    const single = new Sha256().update(buf).digest();
    assert.equal(single, expected);

    // Fragmented updates across different chunk boundaries
    const chunkSizes = [1, 7, 16, 64, 128, 1024];
    for (const sz of chunkSizes) {
      const hasher = new Sha256();
      for (let i = 0; i < buf.length; i += sz) {
        hasher.update(buf.subarray(i, Math.min(i + sz, buf.length)));
      }
      assert.equal(hasher.digest(), expected);
    }
  }
});

test('TCP transfer calculates SHA-256 and verifies file integrity', async () => {
  const tmpDir = path.resolve('test_tmp_integrity');
  const outDir = path.join(tmpDir, 'recv');
  fs.mkdirSync(outDir, { recursive: true });

  const file1Path = path.join(tmpDir, 'file1.bin');
  const file2Path = path.join(tmpDir, 'file2.bin');

  const content1 = crypto.randomBytes(2 * 1024 * 1024 + 123);
  const content2 = crypto.randomBytes(512 * 1024);

  fs.writeFileSync(file1Path, content1);
  fs.writeFileSync(file2Path, content2);

  const hash1 = crypto.createHash('sha256').update(content1).digest('hex');
  const hash2 = crypto.createHash('sha256').update(content2).digest('hex');

  const code = '4271-lemon-radar-tiger-orbit';
  const files = [
    { path: file1Path, size: content1.length },
    { path: file2Path, size: content2.length },
  ];

  const server = createSenderServer(files, code);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    const received = await receiveFiles('127.0.0.1', port, code, outDir);
    assert.equal(received.length, 2);

    assert.equal(received[0].verified, true);
    assert.equal(received[0].sha256, hash1);
    const diskContent1 = fs.readFileSync(path.join(outDir, 'file1.bin'));
    assert.equal(crypto.createHash('sha256').update(diskContent1).digest('hex'), hash1);

    assert.equal(received[1].verified, true);
    assert.equal(received[1].sha256, hash2);
    const diskContent2 = fs.readFileSync(path.join(outDir, 'file2.bin'));
    assert.equal(crypto.createHash('sha256').update(diskContent2).digest('hex'), hash2);
  } finally {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TCP transfer detects corrupted chunks and triggers INTEGRITY_MISMATCH', async () => {
  const tmpDir = path.resolve('test_tmp_corrupt');
  const outDir = path.join(tmpDir, 'recv');
  fs.mkdirSync(outDir, { recursive: true });

  const file1Path = path.join(tmpDir, 'file1.bin');
  const content1 = Buffer.alloc(100 * 1024, 0x11);
  fs.writeFileSync(file1Path, content1);

  const code = '5310-cargo-velvet-jungle-anchor';

  // Spin up a server that intentionally sends a wrong SHA-256 in the end packet
  const key = (await import('../cli/src/crypto.js')).deriveKey(code);
  const { encryptChunk } = await import('../cli/src/crypto.js');
  const net = await import('node:net');

  function frame(buf) {
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(buf.length, 0);
    return Buffer.concat([header, buf]);
  }

  const server = net.createServer((socket) => {
    socket.setNoDelay(true);
    // 1. Manifest
    const manifest = { v: PROTOCOL_VERSION, files: [{ name: 'file1.bin', size: content1.length }] };
    socket.write(frame(encryptChunk(Buffer.concat([Buffer.from([0]), Buffer.from(JSON.stringify(manifest))]), key)));

    // 2. Data
    socket.write(frame(encryptChunk(Buffer.concat([Buffer.from([1]), content1]), key)));

    // 3. Corrupt end packet with wrong hash
    const fakeHash = '0000000000000000000000000000000000000000000000000000000000000000';
    const endPayload = Buffer.concat([Buffer.from([0]), Buffer.from(JSON.stringify({ k: 'end', index: 0, sha256: fakeHash }))]);
    socket.write(frame(encryptChunk(endPayload, key)));
    socket.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    await assert.rejects(
      async () => {
        await receiveFiles('127.0.0.1', port, code, outDir);
      },
      (err) => {
        assert.equal(err.code, 'INTEGRITY_MISMATCH');
        assert.ok(err.message.includes('SHA-256'));
        return true;
      }
    );
    // The bad bytes never reach the final name: they stay in the `.part`, which
    // is removed on failure, so the output directory is left untouched.
    assert.equal(fs.existsSync(path.join(outDir, 'file1.bin')), false);
    assert.deepEqual(fs.readdirSync(outDir), []);
  } finally {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Relay transfer calculates SHA-256 and verifies file integrity', async () => {
  const { EventEmitter } = await import('node:events');
  const { receiveFromRelay } = await import('../cli/src/transfer.js');
  const tmpDir = path.resolve('test_tmp_relay_ok');
  const outDir = path.join(tmpDir, 'recv');
  fs.mkdirSync(outDir, { recursive: true });

  const content = crypto.randomBytes(64 * 1024);
  const hash = crypto.createHash('sha256').update(content).digest('hex');
  const manifest = [{ name: 'relay_test.bin', size: content.length }];

  class MockWs extends EventEmitter {
    send(data) {}
    addEventListener(evt, fn) { this.on(evt, fn); }
    removeEventListener(evt, fn) { this.off(evt, fn); }
  }

  const mockWs = new MockWs();
  const recvPromise = receiveFromRelay(mockWs, manifest, outDir, () => {}, { key: RELAY_KEY });

  // Send cli-start
  mockWs.emit('message', { data: sealed({ type: 'cli-start', index: 0, name: 'relay_test.bin', size: content.length }) });

  // Send chunks
  mockWs.emit('message', { data: encryptChunk(content.subarray(0, 32 * 1024), RELAY_KEY) });
  mockWs.emit('message', { data: encryptChunk(content.subarray(32 * 1024), RELAY_KEY) });

  // Send cli-end with correct hash
  mockWs.emit('message', { data: sealed({ type: 'cli-end', index: 0, sha256: hash }) });

  // Send cli-done
  mockWs.emit('message', { data: sealed({ type: 'cli-done' }) });

  const received = await recvPromise;
  assert.equal(received.length, 1);
  assert.equal(received[0].verified, true);
  assert.equal(received[0].sha256, hash);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('Relay transfer detects corrupted SHA-256 and throws error', async () => {
  const { EventEmitter } = await import('node:events');
  const { receiveFromRelay } = await import('../cli/src/transfer.js');
  const tmpDir = path.resolve('test_tmp_relay_corrupt');
  const outDir = path.join(tmpDir, 'recv');
  fs.mkdirSync(outDir, { recursive: true });

  const content = crypto.randomBytes(64 * 1024);
  const fakeHash = '1111111111111111111111111111111111111111111111111111111111111111';
  const manifest = [{ name: 'relay_bad.bin', size: content.length }];

  class MockWs extends EventEmitter {
    send(data) {}
    addEventListener(evt, fn) { this.on(evt, fn); }
    removeEventListener(evt, fn) { this.off(evt, fn); }
  }

  const mockWs = new MockWs();
  const recvPromise = receiveFromRelay(mockWs, manifest, outDir, () => {}, { key: RELAY_KEY });

  mockWs.emit('message', { data: sealed({ type: 'cli-start', index: 0, name: 'relay_bad.bin', size: content.length }) });
  mockWs.emit('message', { data: encryptChunk(content, RELAY_KEY) });
  mockWs.emit('message', { data: sealed({ type: 'cli-end', index: 0, sha256: fakeHash }) });

  await assert.rejects(
    async () => await recvPromise,
    (err) => {
      assert.equal(err.code, 'INTEGRITY_MISMATCH');
      assert.ok(err.message.includes('SHA-256'));
      return true;
    }
  );

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

