// Modo relay: acuses de recibo del receptor CLI y transferencia completa por
// encima de la ventana de 8 MB del emisor.
//
// Arranca su propio servidor de señalización en un puerto efímero: no hace falta
// tener nada levantado a mano.
//
// La prueba de extremo a extremo lanza tres procesos (servidor y los dos CLI) y el
// receptor se rinde a los 10 s si el emisor no le manda la oferta. Con los ficheros
// de test corriendo en paralelo esa espera se agota por pura contienda de CPU, asi
// que `npm test` pasa `--test-concurrency=1`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { receiveFromRelay, RELAY_ACK_EVERY } from '../cli/src/transfer.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'cli', 'src', 'cli.js');
const SERVER = path.join(ROOT, 'server', 'index.js');

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// ------------------------------------------------- acuses del receptor (unitario)

/** WebSocket de mentira con la superficie que usa `receiveFromRelay`. */
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
  };
}

test('el receptor por relay acusa recibo cada 2 MB y confirma el final', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'drop-relay-'));
  const CHUNK = 256 * 1024;
  const CHUNKS = 48;                       // 12 MB: por encima de la ventana de 8 MB
  const total = CHUNK * CHUNKS;
  const body = crypto.randomBytes(total);

  const ws = fakeWs();
  const done = receiveFromRelay(ws, [{ name: 'grande.bin', size: total }], out, () => {});

  ws.emit('message', { data: JSON.stringify({ t: 'signal', data: { type: 'cli-start', index: 0, name: 'grande.bin', size: total } }) });
  for (let i = 0; i < CHUNKS; i++) {
    ws.emit('message', { data: body.subarray(i * CHUNK, (i + 1) * CHUNK) });
  }
  ws.emit('message', { data: JSON.stringify({ t: 'signal', data: { type: 'cli-end', index: 0, sha256: sha256(body) } }) });
  ws.emit('message', { data: JSON.stringify({ t: 'signal', data: { type: 'cli-done' } }) });

  const received = await done;

  const acks = ws.sent.filter((m) => m.data?.type === 'cli-ack').map((m) => m.data.bytes);
  // Sin estos acuses el emisor se para a los 8 MB y los dos extremos cuelgan.
  assert.ok(acks.length >= Math.floor(total / RELAY_ACK_EVERY), `pocos acuses: ${acks.length}`);
  assert.deepEqual(acks, [...acks].sort((a, b) => a - b), 'los acuses no van en orden');
  assert.equal(acks.at(-1), total, 'el último acuse no cubre todos los bytes');
  assert.equal(ws.sent.at(-1).data.type, 'cli-complete');

  assert.equal(received[0].verified, true);
  assert.equal(sha256(fs.readFileSync(path.join(out, 'grande.bin'))), sha256(body));

  fs.rmSync(out, { recursive: true, force: true });
});

// ------------------------------------- transferencia CLI -> CLI (extremo a extremo)

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function startSignalingServer() {
  const port = await freePort();
  const proc = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('el servidor no arrancó')), 10_000);
    proc.stdout.on('data', (d) => {
      if (d.toString().includes('Drop escuchando')) { clearTimeout(timer); resolve(); }
    });
    proc.on('error', reject);
  });
  return { proc, url: `http://127.0.0.1:${port}` };
}

/** Lanza el CLI y deja esperar a que aparezca algo en su salida. */
function runCli(args) {
  const proc = spawn(process.execPath, [CLI, ...args], {
    env: { ...process.env, DROP_NO_UPNP: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.output = '';
  proc.stdout.on('data', (d) => { proc.output += stripAnsi(d.toString()); });
  proc.stderr.on('data', (d) => { proc.output += stripAnsi(d.toString()); });
  proc.waitFor = (re, ms) => new Promise((resolve, reject) => {
    const check = () => {
      const m = proc.output.match(re);
      if (m) { clearInterval(poll); clearTimeout(timer); resolve(m); }
    };
    const poll = setInterval(check, 50);
    const timer = setTimeout(() => {
      clearInterval(poll);
      reject(new Error(`no apareció ${re} en la salida:\n${proc.output}`));
    }, ms);
    check();
  });
  proc.exited = new Promise((resolve) => proc.on('exit', (code) => resolve(code)));
  return proc;
}

test('relay CLI -> CLI entrega un archivo por encima de la ventana de 8 MB', { timeout: 120_000 }, async () => {
  const server = await startSignalingServer();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'drop-e2e-'));
  const outDir = path.join(work, 'destino');
  fs.mkdirSync(outDir);

  // 12 MB: el emisor no manda más de 8 MB sin acuse, así que este archivo no cabe
  // en la ventana. Antes de que `receiveFromRelay` acusara recibo, esto colgaba.
  const body = crypto.randomBytes(12 * 1024 * 1024);
  const src = path.join(work, 'grande.bin');
  fs.writeFileSync(src, body);

  const sender = runCli(['send', src, '--server', server.url, '--relay']);
  let receiver = null;

  try {
    const [, code] = await sender.waitFor(/Código:\s+(\d{4}(?:-[a-z]+){4})/, 20_000);

    receiver = runCli(['recv', code, '--server', server.url, '--relay', '-o', outDir]);
    const exitCode = await receiver.exited;

    assert.equal(exitCode, 0, `el receptor falló:\n${receiver.output}\n--- emisor ---\n${sender.output}`);
    assert.match(receiver.output, /MODO RELAY POR INTERNET/);

    const got = fs.readFileSync(path.join(outDir, 'grande.bin'));
    assert.equal(got.length, body.length);
    assert.equal(sha256(got), sha256(body), 'el archivo recibido no coincide');

    // Y el emisor tiene que darse por enterado del final, no quedarse esperando.
    await sender.waitFor(/Transferencia completada con éxito/, 15_000);
  } finally {
    receiver?.kill('SIGKILL');
    sender.kill('SIGKILL');
    server.proc.kill('SIGKILL');
    fs.rmSync(work, { recursive: true, force: true });
  }
});
