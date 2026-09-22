// La politica de compatibilidad de docs/COMPATIBILITY.md, puesta a prueba.
//
// Durante toda la 1.x el numero de protocolo no se mueve, asi que lo unico que
// permite anadir cosas sin romper a los binarios ya instalados es que cada lado
// ignore lo que no conoce: campos de mas en un marco, marcos de control con un
// `k`/`type` nuevo, capacidades en `features`. Si alguien "endurece" un
// receptor para que rechace lo desconocido, la 1.1 deja de hablar con la 1.0:
// estos casos existen para que eso falle aqui y no en casa de alguien.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';

import { receiveFiles, receiveFromRelay, createSenderServer, PROTOCOL_VERSION } from '../cli/src/transfer.js';
import { deriveKey, encryptChunk, decryptChunk, sealFrame } from '../cli/src/crypto.js';
import { newCode, randomRoomId } from '../public/shared/codes.js';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const someCode = () => newCode(randomRoomId(crypto.randomBytes), crypto.randomBytes);

function scratch(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// El candado. Cambiar esto dentro de la 1.x es exactamente lo que la politica
// prohibe: deja a cada `drop` instalado sin poder hablar con la web ni con los
// nuevos. Un protocolo nuevo es una 2.0, y entonces se cambia este test a la vez.
test('el protocolo esta congelado en la 5 hasta la 2.0', () => {
  const major = Number(pkg.version.split('.')[0]);
  if (major >= 2) return;
  assert.equal(PROTOCOL_VERSION, 5, 'PROTOCOL_VERSION no cambia dentro de la 1.x: ver docs/COMPATIBILITY.md');
});

// ------------------------------------------------------------ TCP directo

function tcpFrames(key) {
  const frame = (buf) => {
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(buf.length, 0);
    return Buffer.concat([header, buf]);
  };
  const packet = (type, payload) => frame(encryptChunk(Buffer.concat([Buffer.from([type]), payload]), key));
  return {
    control: (obj) => packet(0, Buffer.from(JSON.stringify(obj))),
    data: (buf) => packet(1, buf),
  };
}

test('TCP: un receptor 1.0 ignora campos, capacidades y marcos que no conoce', async (t) => {
  const code = someCode();
  const key = deriveKey(code);
  const { control, data } = tcpFrames(key);
  const body = crypto.randomBytes(40 * 1024);
  let ready = null;

  // Un emisor "de la 1.3": anuncia capacidades, lleva campos nuevos en cada
  // marco y mete un marco de control que la 1.0 no ha visto nunca a mitad de
  // archivo, que es donde mas dano haria si acabase escrito.
  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (ready || buf.length < 4 || buf.length < 4 + buf.readUInt32BE(0)) return;
      ready = JSON.parse(decryptChunk(buf.subarray(4, 4 + buf.readUInt32BE(0)), key).subarray(1).toString());
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

  const out = scratch(t, 'drop-compat-tcp-');
  const received = await receiveFiles('127.0.0.1', server.address().port, code, out);
  assert.equal(received[0].verified, true);
  assert.equal(sha256(fs.readFileSync(path.join(out, 'a.bin'))), sha256(body), 'el marco desconocido no entra en el archivo');
  assert.equal(ready.k, 'ready', 'la primera respuesta del receptor sigue siendo `ready`');
});

test('TCP: un emisor 1.0 ignora lo que un receptor mas nuevo anada al `ready`', async (t) => {
  const dir = scratch(t, 'drop-compat-src-');
  const body = crypto.randomBytes(30 * 1024);
  fs.writeFileSync(path.join(dir, 'a.bin'), body);
  const code = someCode();
  const key = deriveKey(code);
  const server = createSenderServer([{ path: path.join(dir, 'a.bin'), size: body.length }], code);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const { control } = tcpFrames(key);
  const got = await new Promise((resolve, reject) => {
    const socket = net.connect(server.address().port, '127.0.0.1');
    let buf = Buffer.alloc(0);
    const frames = [];
    socket.on('error', reject);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
        const plain = decryptChunk(buf.subarray(4, 4 + buf.readUInt32BE(0)), key);
        buf = buf.subarray(4 + buf.readUInt32BE(0));
        frames.push(plain);
        if (frames.length === 1) {
          socket.write(control({ k: 'ready', resume: [], features: ['algo-de-la-1.3'], window: 99 }));
        }
      }
    });
    socket.on('end', () => resolve(frames));
  });
  const payload = Buffer.concat(got.filter((f) => f[0] === 1).map((f) => f.subarray(1)));
  assert.equal(sha256(payload), sha256(body));
  const last = JSON.parse(got.at(-1).subarray(1).toString());
  assert.equal(last.k, 'done');
});

// ------------------------------------------------------------------ relay

function fakeWs() {
  const listeners = new Map();
  return {
    readyState: 1,
    sent: [],
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      listeners.set(type, (listeners.get(type) || []).filter((f) => f !== fn));
    },
    send(data) { this.sent.push(JSON.parse(data)); },
    emit(type, ev) { for (const fn of [...(listeners.get(type) || [])]) fn(ev); },
    async waitFor(type, ms = 5000) {
      const t0 = Date.now();
      for (;;) {
        const m = this.sent.find((x) => x.data?.type === type);
        if (m) return m.data;
        if (Date.now() - t0 > ms) throw new Error(`el receptor no ha mandado ${type}`);
        await new Promise((r) => setTimeout(r, 10));
      }
    },
  };
}

test('relay: un receptor 1.0 ignora marcos sellados y campos que no conoce', async (t) => {
  const key = deriveKey('4271-lemon-radar-tiger-orbit');
  const body = Buffer.from('contenido de la 1.3');
  const sealed = (obj) => ({ data: JSON.stringify({ t: 'signal', data: sealFrame(obj, key) }) });
  const out = scratch(t, 'drop-compat-relay-');
  const ws = fakeWs();
  const done = receiveFromRelay(ws, [{ name: 'a.txt', size: body.length, mtime: 1 }], out, () => {}, { key });
  await ws.waitFor('cli-accept');

  ws.emit('message', sealed({ type: 'cli-futuro', algo: 1 }));
  ws.emit('message', sealed({ type: 'cli-start', index: 0, name: 'a.txt', size: body.length, compression: 'none' }));
  ws.emit('message', { data: encryptChunk(body, key) });
  ws.emit('message', sealed({ type: 'cli-futuro' }));
  ws.emit('message', sealed({ type: 'cli-end', index: 0, sha256: sha256(body), sig: 'x' }));
  ws.emit('message', sealed({ type: 'cli-done', stats: {} }));

  const received = await done;
  assert.equal(received[0].verified, true);
  assert.equal(fs.readFileSync(path.join(out, 'a.txt'), 'utf8'), 'contenido de la 1.3');
});
