import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createSenderServer, receiveFiles } from '../cli/src/transfer.js';

// Replicate the client-side Sha256 class to unit-test it directly in node:test
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

class ClientSha256 {
  constructor() {
    this.h0 = 0x6a09e667;
    this.h1 = 0xbb67ae85;
    this.h2 = 0x3c6ef372;
    this.h3 = 0xa54ff53a;
    this.h4 = 0x510e527f;
    this.h5 = 0x9b05688c;
    this.h6 = 0x1f83d9ab;
    this.h7 = 0x5be0cd19;
    this.block = new Uint8Array(64);
    this.blockLen = 0;
    this.totalLen = 0;
    this.w = new Uint32Array(64);
  }

  _processBlock(b) {
    const w = this.w;
    for (let i = 0; i < 16; i++) {
      const p = i * 4;
      w[i] = (b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3];
    }
    for (let i = 16; i < 64; i++) {
      const v0 = w[i - 15];
      const s0 = ((v0 >>> 7) | (v0 << 25)) ^ ((v0 >>> 18) | (v0 << 14)) ^ (v0 >>> 3);
      const v1 = w[i - 2];
      const s1 = ((v1 >>> 17) | (v1 << 15)) ^ ((v1 >>> 19) | (v1 << 13)) ^ (v1 >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }

    let a = this.h0, b0 = this.h1, c = this.h2, d = this.h3;
    let e = this.h4, f = this.h5, g = this.h6, h = this.h7;

    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ ((~e) & g);
      const temp1 = (h + S1 + ch + SHA256_K[i] + w[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b0) ^ (a & c) ^ (b0 & c);
      const temp2 = (S0 + maj) | 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b0;
      b0 = a;
      a = (temp1 + temp2) | 0;
    }

    this.h0 = (this.h0 + a) | 0;
    this.h1 = (this.h1 + b0) | 0;
    this.h2 = (this.h2 + c) | 0;
    this.h3 = (this.h3 + d) | 0;
    this.h4 = (this.h4 + e) | 0;
    this.h5 = (this.h5 + f) | 0;
    this.h6 = (this.h6 + g) | 0;
    this.h7 = (this.h7 + h) | 0;
  }

  update(data) {
    const bytes = data instanceof Uint8Array
      ? data
      : new Uint8Array(data.buffer || data, data.byteOffset || 0, data.byteLength || data.length);
    let offset = 0;
    const len = bytes.length;
    this.totalLen += len;

    if (this.blockLen > 0) {
      const needed = 64 - this.blockLen;
      if (len >= needed) {
        this.block.set(bytes.subarray(0, needed), this.blockLen);
        this._processBlock(this.block);
        this.blockLen = 0;
        offset = needed;
      } else {
        this.block.set(bytes, this.blockLen);
        this.blockLen += len;
        return this;
      }
    }

    while (offset + 64 <= len) {
      this._processBlock(bytes.subarray(offset, offset + 64));
      offset += 64;
    }

    if (offset < len) {
      this.block.set(bytes.subarray(offset), 0);
      this.blockLen = len - offset;
    }

    return this;
  }

  digest() {
    const totalBits = this.totalLen * 8;
    this.block[this.blockLen++] = 0x80;
    if (this.blockLen > 56) {
      this.block.fill(0, this.blockLen);
      this._processBlock(this.block);
      this.blockLen = 0;
    }
    this.block.fill(0, this.blockLen, 56);
    const hiBits = Math.floor(totalBits / 0x100000000);
    const loBits = totalBits >>> 0;
    this.block[56] = (hiBits >>> 24) & 0xff;
    this.block[57] = (hiBits >>> 16) & 0xff;
    this.block[58] = (hiBits >>> 8) & 0xff;
    this.block[59] = hiBits & 0xff;
    this.block[60] = (loBits >>> 24) & 0xff;
    this.block[61] = (loBits >>> 16) & 0xff;
    this.block[62] = (loBits >>> 8) & 0xff;
    this.block[63] = loBits & 0xff;
    this._processBlock(this.block);

    const hash = [this.h0, this.h1, this.h2, this.h3, this.h4, this.h5, this.h6, this.h7];
    return hash.map((v) => (v >>> 0).toString(16).padStart(8, '0')).join('');
  }
}

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
    const single = new ClientSha256().update(buf).digest();
    assert.equal(single, expected);

    // Fragmented updates across different chunk boundaries
    const chunkSizes = [1, 7, 16, 64, 128, 1024];
    for (const sz of chunkSizes) {
      const hasher = new ClientSha256();
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
    const manifest = { files: [{ name: 'file1.bin', size: content1.length }] };
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
  const recvPromise = receiveFromRelay(mockWs, manifest, outDir);

  // Send cli-start
  mockWs.emit('message', { data: JSON.stringify({ t: 'signal', data: { type: 'cli-start', index: 0, name: 'relay_test.bin', size: content.length } }) });

  // Send chunks
  mockWs.emit('message', { data: content.subarray(0, 32 * 1024) });
  mockWs.emit('message', { data: content.subarray(32 * 1024) });

  // Send cli-end with correct hash
  mockWs.emit('message', { data: JSON.stringify({ t: 'signal', data: { type: 'cli-end', index: 0, sha256: hash } }) });

  // Send cli-done
  mockWs.emit('message', { data: JSON.stringify({ t: 'signal', data: { type: 'cli-done' } }) });

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
  const recvPromise = receiveFromRelay(mockWs, manifest, outDir);

  mockWs.emit('message', { data: JSON.stringify({ t: 'signal', data: { type: 'cli-start', index: 0, name: 'relay_bad.bin', size: content.length } }) });
  mockWs.emit('message', { data: content });
  mockWs.emit('message', { data: JSON.stringify({ t: 'signal', data: { type: 'cli-end', index: 0, sha256: fakeHash } }) });

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

