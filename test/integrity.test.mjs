import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { PROTOCOL_VERSION } from '../public/shared/protocol.js';
// El MISMO modulo que usa el navegador, no una copia: el test tiene que caer si
// alguien rompe la implementacion de verdad.
import { Sha256 } from '../public/shared/sha256.js';
import {
  startServer,
  decryptChunk,
  tcpFrames,
  hostMockSender,
  spawnCli,
} from './helpers.mjs';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

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
    const expected = sha256(buf);

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

test('TCP transfer calculates SHA-256 and verifies file integrity', { timeout: 30_000 }, async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'drop-int-tcp-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const outDir = path.join(work, 'recv');
  fs.mkdirSync(outDir, { recursive: true });

  const content1 = crypto.randomBytes(2 * 1024 * 1024 + 123);
  const content2 = crypto.randomBytes(512 * 1024);
  const f1 = path.join(work, 'file1.bin');
  const f2 = path.join(work, 'file2.bin');
  fs.writeFileSync(f1, content1);
  fs.writeFileSync(f2, content2);

  const sender = spawnCli(['send', f1, f2, '--server', srv.http, '--yes', '--no-qr', '--once']);
  t.after(() => sender.kill());
  const [, code] = await sender.waitFor(/Código:\s+(\d{4}(?:-[a-z]+){4})/, 20_000);

  const recv = spawnCli(['recv', code, '--server', srv.http, '--direct-only', '--yes', '-o', outDir]);
  t.after(() => recv.kill());

  assert.equal(await recv.exited, 0, recv.output());
  assert.match(recv.output(), /verificado/);
  assert.equal(sha256(fs.readFileSync(path.join(outDir, 'file1.bin'))), sha256(content1));
  assert.equal(sha256(fs.readFileSync(path.join(outDir, 'file2.bin'))), sha256(content2));
});

test('TCP transfer detects corrupted chunks and leaves destination clean', { timeout: 30_000 }, async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'drop-int-badtcp-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const outDir = path.join(work, 'recv');
  fs.mkdirSync(outDir, { recursive: true });

  const content = crypto.randomBytes(128 * 1024);
  let keyRef = null;
  let replied = false;

  const tcpSrv = net.createServer((socket) => {
    socket.on('error', () => {});
    const { control, data } = tcpFrames(keyRef);
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (replied || buf.length < 4 || buf.length < 4 + buf.readUInt32BE(0)) return;
      replied = true;
      decryptChunk(buf.subarray(4, 4 + buf.readUInt32BE(0)), keyRef);
      socket.write(control({ k: 'start', index: 0, offset: 0 }));
      socket.write(data(content));
      socket.write(control({ k: 'end', index: 0, sha256: '0'.repeat(64) }));
      socket.write(control({ k: 'done' }));
      socket.end();
    });
    socket.write(control({ v: PROTOCOL_VERSION, files: [{ name: 'file1.bin', size: content.length }] }));
  });
  await new Promise((resolve) => tcpSrv.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => tcpSrv.close(resolve)));

  const mock = await hostMockSender(srv, { tcpPort: tcpSrv.address().port });
  t.after(() => mock.close());
  keyRef = mock.key;

  const recv = spawnCli(['recv', mock.code, '--server', srv.http, '--direct-only', '--yes', '-o', outDir]);
  t.after(() => recv.kill());

  assert.notEqual(await recv.exited, 0);
  assert.match(recv.output(), /Error|SHA-256|corrupto|verificación/i);
  assert.equal(fs.existsSync(path.join(outDir, 'file1.bin')), false);
});

test('Relay transfer verifies valid SHA-256 and rejects corrupted SHA-256', { timeout: 30_000 }, async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'drop-int-relay-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const content = crypto.randomBytes(64 * 1024);

  const runCase = async (name, reportedSha, outSubdir) => {
    const outDir = path.join(work, outSubdir);
    fs.mkdirSync(outDir, { recursive: true });
    const mock = await hostMockSender(srv, {
      tcpPort: 0,
      onRelay: ({ data, sendSealed, sendBin }) => {
        if (data.type === 'cli-proof') {
          sendSealed({
            type: 'cli-manifest',
            v: PROTOCOL_VERSION,
            manifest: [{ name, size: content.length }],
          });
        } else if (data.type === 'cli-accept') {
          sendSealed({ type: 'cli-start', index: 0, offset: 0 });
          sendBin(content);
          sendSealed({ type: 'cli-end', index: 0, sha256: reportedSha });
          sendSealed({ type: 'cli-done' });
        }
      },
    });
    const recv = spawnCli(['recv', mock.code, '--server', srv.http, '--relay', '--yes', '-o', outDir]);
    const code = await recv.exited;
    recv.kill();
    mock.close();
    return { code, out: recv.output(), outDir };
  };

  const ok = await runCase('relay_test.bin', sha256(content), 'ok');
  assert.equal(ok.code, 0, ok.out);
  assert.equal(sha256(fs.readFileSync(path.join(ok.outDir, 'relay_test.bin'))), sha256(content));

  const bad = await runCase('relay_bad.bin', '1'.repeat(64), 'bad');
  assert.notEqual(bad.code, 0);
  assert.equal(fs.existsSync(path.join(bad.outDir, 'relay_bad.bin')), false);
});
