// Pruebas de extremo a extremo de protocolos y seguridad de transferencia contra el binario Rust:
// traversal en nombre y subpath, colisiones (2), --overwrite, version incompatible y cortes TCP.
// (Las pruebas unitarias de safe_output_path/reserve_output_path estan en cli/tests/transfer_test.rs).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { PROTOCOL_VERSION } from '../public/shared/protocol.js';
import {
  startServer,
  decryptChunk,
  tcpFrames,
  hostMockSender,
  spawnCli,
} from './helpers.mjs';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

async function startTcpFixture(t, srv, onPeer, v = PROTOCOL_VERSION) {
  let mock = null;
  const tcpSrv = net.createServer((socket) => {
    socket.on('error', () => {});
    onPeer({ socket, key: mock.key, ...tcpFrames(mock.key) });
  });
  await new Promise((resolve) => tcpSrv.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => tcpSrv.close(resolve)));

  mock = await hostMockSender(srv, { tcpPort: tcpSrv.address().port, v });
  t.after(() => mock.close());
  return mock.code;
}

test('sanitiza traversal en name y aborta subpath malicioso sin escribir fuera', { timeout: 30_000 }, async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'drop-xfer-sec-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const outSafe = path.join(work, 'out-name');
  fs.mkdirSync(outSafe, { recursive: true });

  // 1. name con ../ se aplana al basename dentro de outSafe
  const payload = Buffer.from('contenido seguro\n');
  const codeName = await startTcpFixture(t, srv, ({ socket, key, control, data }) => {
    let buf = Buffer.alloc(0);
    let sent = false;
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (sent || buf.length < 4 || buf.length < 4 + buf.readUInt32BE(0)) return;
      sent = true;
      decryptChunk(buf.subarray(4, 4 + buf.readUInt32BE(0)), key);
      socket.write(control({ k: 'start', index: 0, offset: 0 }));
      socket.write(data(payload));
      socket.write(control({ k: 'end', index: 0, sha256: sha256(payload) }));
      socket.write(control({ k: 'done' }));
      socket.end();
    });
    socket.write(control({ v: PROTOCOL_VERSION, files: [{ name: '../../escapado.txt', size: payload.length }] }));
  });

  const recv1 = spawnCli(['recv', codeName, '--server', srv.http, '--direct-only', '--yes', '-o', outSafe]);
  t.after(() => recv1.kill());
  assert.equal(await recv1.exited, 0, recv1.output());
  assert.equal(fs.readFileSync(path.join(outSafe, 'escapado.txt'), 'utf8'), 'contenido seguro\n');
  assert.equal(fs.existsSync(path.join(work, 'escapado.txt')), false);

  // 2. path relativo malicioso (`../../fuera.txt`) aborta antes de tocar disco
  const outSub = path.join(work, 'out-sub');
  fs.mkdirSync(outSub, { recursive: true });
  const codePath = await startTcpFixture(t, srv, ({ socket, control }) => {
    socket.write(control({
      v: PROTOCOL_VERSION,
      files: [{ name: 'fuera.txt', path: '../../fuera.txt', size: payload.length }],
    }));
  });

  const recv2 = spawnCli(['recv', codePath, '--server', srv.http, '--direct-only', '--yes', '-o', outSub]);
  t.after(() => recv2.kill());
  assert.notEqual(await recv2.exited, 0);
  assert.equal(fs.existsSync(path.join(work, 'fuera.txt')), false);
});

test('numera colisiones (2) por defecto y sobrescribe con --overwrite', { timeout: 30_000 }, async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'drop-xfer-col-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const outDir = path.join(work, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'foto.txt'), 'viejo');

  const nuevo = Buffer.from('nuevo contenido');
  const serveOnce = () => startTcpFixture(t, srv, ({ socket, key, control, data }) => {
    let buf = Buffer.alloc(0);
    let sent = false;
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (sent || buf.length < 4 || buf.length < 4 + buf.readUInt32BE(0)) return;
      sent = true;
      decryptChunk(buf.subarray(4, 4 + buf.readUInt32BE(0)), key);
      socket.write(control({ k: 'start', index: 0, offset: 0 }));
      socket.write(data(nuevo));
      socket.write(control({ k: 'end', index: 0, sha256: sha256(nuevo) }));
      socket.write(control({ k: 'done' }));
      socket.end();
    });
    socket.write(control({ v: PROTOCOL_VERSION, files: [{ name: 'foto.txt', size: nuevo.length }] }));
  });

  const c1 = await serveOnce();
  const r1 = spawnCli(['recv', c1, '--server', srv.http, '--direct-only', '--yes', '-o', outDir]);
  t.after(() => r1.kill());
  assert.equal(await r1.exited, 0, r1.output());
  assert.equal(fs.readFileSync(path.join(outDir, 'foto.txt'), 'utf8'), 'viejo');
  assert.equal(fs.readFileSync(path.join(outDir, 'foto (2).txt'), 'utf8'), 'nuevo contenido');

  const c2 = await serveOnce();
  const r2 = spawnCli(['recv', c2, '--server', srv.http, '--direct-only', '--yes', '--overwrite', '-o', outDir]);
  t.after(() => r2.kill());
  assert.equal(await r2.exited, 0, r2.output());
  assert.equal(fs.readFileSync(path.join(outDir, 'foto.txt'), 'utf8'), 'nuevo contenido');
  assert.equal(fs.existsSync(path.join(outDir, 'foto (3).txt')), false);
});

test('rechaza version de protocolo incompatible y conserva .part si TCP se corta', { timeout: 30_000 }, async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'drop-xfer-err-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));

  // 1. Version incompatible en el manifiesto TCP cifrado
  const codeBadVer = await startTcpFixture(t, srv, ({ socket, control }) => {
    socket.write(control({ v: 999, files: [{ name: 'futuro.bin', size: 10 }] }));
    socket.end();
  });
  const rVer = spawnCli(['recv', codeBadVer, '--server', srv.http, '--direct-only', '--yes', '-o', work]);
  t.after(() => rVer.kill());
  assert.notEqual(await rVer.exited, 0);
  assert.match(rVer.output(), /Protocolo|Versión.*incompatible|drop update/i);

  // 2. Corte abrupto a mitad de transferencia: no se promueve y deja .part
  const outPart = path.join(work, 'trunc');
  fs.mkdirSync(outPart, { recursive: true });
  const codeTrunc = await startTcpFixture(t, srv, ({ socket, key, control, data }) => {
    let buf = Buffer.alloc(0);
    let sent = false;
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (sent || buf.length < 4 || buf.length < 4 + buf.readUInt32BE(0)) return;
      sent = true;
      decryptChunk(buf.subarray(4, 4 + buf.readUInt32BE(0)), key);
      socket.write(control({ k: 'start', index: 0, offset: 0 }));
      socket.write(data(crypto.randomBytes(96 * 1024)));
      setTimeout(() => socket.destroy(), 30);
    });
    socket.write(control({ v: PROTOCOL_VERSION, files: [{ name: 'parcial.bin', size: 256 * 1024 }] }));
  });

  const rTrunc = spawnCli(['recv', codeTrunc, '--server', srv.http, '--direct-only', '--yes', '-o', outPart]);
  t.after(() => rTrunc.kill());
  assert.notEqual(await rTrunc.exited, 0);
  assert.equal(fs.existsSync(path.join(outPart, 'parcial.bin')), false);
  const parts = fs.readdirSync(outPart).filter((f) => f.endsWith('.part'));
  assert.equal(parts.length, 1, `deberia conservar exactamente un .part en ${outPart}: ${fs.readdirSync(outPart)}`);
});
