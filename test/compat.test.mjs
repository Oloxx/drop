// La politica de compatibilidad de docs/COMPATIBILITY.md, puesta a prueba contra el CLI real.
//
// Durante toda la 1.x el numero de protocolo no se mueve, asi que lo unico que
// permite anadir cosas sin romper a los binarios ya instalados es que cada lado
// ignore lo que no conoce: campos de mas en un marco, marcos de control con un
// `k`/`type` nuevo, capacidades en `features`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';

import { PROTOCOL_VERSION } from '../public/shared/protocol.js';
import {
  startServer,
  open,
  deriveKey,
  decryptChunk,
  tcpFrames,
  hostMockSender,
  spawnCli,
} from './helpers.mjs';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function scratch(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// El candado. Cambiar esto dentro de la 1.x es exactamente lo que la politica
// prohibe: deja a cada `drop` instalado sin poder hablar con la web ni con los
// nuevos. Un protocolo nuevo es una 2.0, y entonces se cambia este test a la vez.
test('el protocolo esta congelado en la 5 hasta la 2.0', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const major = Number(pkg.version.split('.')[0]);
  if (major >= 2) return;
  assert.equal(PROTOCOL_VERSION, 5, 'PROTOCOL_VERSION no cambia dentro de la 1.x: ver docs/COMPATIBILITY.md');
});

test('TCP: el receptor CLI ignora campos, capacidades y marcos que no conoce', { timeout: 30_000 }, async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());

  const body = crypto.randomBytes(40 * 1024);
  let ready = null;
  let tcpKey = null;

  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    const { control, data } = tcpFrames(tcpKey);
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (ready || buf.length < 4 || buf.length < 4 + buf.readUInt32BE(0)) return;
      ready = JSON.parse(decryptChunk(buf.subarray(4, 4 + buf.readUInt32BE(0)), tcpKey).subarray(1).toString());
      socket.write(control({ k: 'start', index: 0, offset: 0, compression: 'none' }));
      socket.write(data(body.subarray(0, 1000)));
      socket.write(control({ k: 'futuro', nonce: 'abc' }));
      socket.write(data(body.subarray(1000)));
      socket.write(control({ k: 'end', index: 0, sha256: sha256(body), sig: 'xyz' }));
      socket.write(control({ k: 'done', stats: { ms: 1 } }));
      socket.end();
    });
    socket.write(control({
      v: PROTOCOL_VERSION,
      features: ['algo-de-la-1.3'],
      files: [{ name: 'a.bin', size: body.length, mtime: 123, mode: 0o644 }],
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const mock = await hostMockSender(srv, { tcpPort: server.address().port });
  t.after(() => mock.close());
  tcpKey = mock.key;

  const out = scratch(t, 'drop-compat-tcp-rx-');
  const recv = spawnCli(['recv', mock.code, '--server', srv.http, '--direct-only', '--yes', '-o', out]);
  t.after(() => recv.kill());

  assert.equal(await recv.exited, 0, recv.output());
  assert.equal(sha256(fs.readFileSync(path.join(out, 'a.bin'))), sha256(body));
  assert.equal(ready?.k, 'ready');
});

test('TCP: el emisor CLI ignora campos y caps futuras en ready', { timeout: 30_000 }, async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());

  const work = scratch(t, 'drop-compat-tcp-tx-');
  const body = crypto.randomBytes(40 * 1024);
  const src = path.join(work, 'envio.bin');
  fs.writeFileSync(src, body);

  const sender = spawnCli(['send', src, '--server', srv.http, '--yes', '--no-qr', '--once']);
  t.after(() => sender.kill());

  const [, code] = await sender.waitFor(/Código:\s+(\d{4}(?:-[a-z]+){4})/, 20_000);
  const roomId = code.slice(0, 4);
  const key = deriveKey(code);
  const { control } = tcpFrames(key);

  const ws = await open(srv.ws, { headers: { Origin: srv.origin } });
  t.after(() => { try { ws.close(); } catch {} });
  ws.say({ t: 'join', token: roomId, name: 'cli-1.3' });
  const offerSig = await ws.until((m) => m.t === 'signal' && m.data?.type === 'cli-offer');
  const port = offerSig.data.port;
  assert.ok(port > 0, 'el emisor debería anunciar su puerto TCP');

  const received = await new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    sock.on('error', reject);
    let buf = Buffer.alloc(0);
    let sentReady = false;
    const chunks = [];
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 4) {
        const len = buf.readUInt32BE(0);
        if (buf.length < 4 + len) break;
        const plain = decryptChunk(buf.subarray(4, 4 + len), key);
        buf = buf.subarray(4 + len);
        if (plain[0] === 0) {
          const msg = JSON.parse(plain.subarray(1).toString('utf8'));
          if (!sentReady && Array.isArray(msg.files)) {
            sentReady = true;
            sock.write(control({ k: 'ready', v: '1.3', caps: ['zstd'] }));
          } else if (msg.k === 'done') {
            sock.end();
            resolve(Buffer.concat(chunks));
            return;
          }
        } else if (plain[0] === 1) {
          chunks.push(plain.subarray(1));
        }
      }
    });
  });

  assert.equal(sha256(received), sha256(body));
  assert.equal(await sender.exited, 0, sender.output());
});

test('Relay: el receptor CLI ignora campos y marcos sellados futuros', { timeout: 30_000 }, async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());

  const body = crypto.randomBytes(40 * 1024);
  const mock = await hostMockSender(srv, {
    tcpPort: 0,
    onRelay: ({ data, sendSealed, sendBin }) => {
      if (data.type === 'cli-proof') {
        sendSealed({
          type: 'cli-manifest',
          v: PROTOCOL_VERSION,
          features: ['1.3'],
          manifest: [{ name: 'rel.bin', size: body.length, extra: 9 }],
        });
      } else if (data.type === 'cli-accept') {
        sendSealed({ type: 'cli-start', index: 0, offset: 0, extra: 1 });
        sendBin(body.subarray(0, 1000));
        sendSealed({ type: 'cli-futuro', x: 1 });
        sendBin(body.subarray(1000));
        sendSealed({ type: 'cli-end', index: 0, sha256: sha256(body), sig: 'xyz' });
        sendSealed({ type: 'cli-done', stats: {} });
      }
    },
  });
  t.after(() => mock.close());

  const out = scratch(t, 'drop-compat-relay-rx-');
  const recv = spawnCli(['recv', mock.code, '--server', srv.http, '--relay', '--yes', '-o', out]);
  t.after(() => recv.kill());

  assert.equal(await recv.exited, 0, recv.output());
  assert.equal(sha256(fs.readFileSync(path.join(out, 'rel.bin'))), sha256(body));
});
