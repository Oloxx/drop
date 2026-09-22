// Reanudacion de transferencias cortadas (issue #21): el `.part` que deja un
// corte de conexion se retoma en el siguiente `drop recv`, tanto por TCP directo
// como por relay, y solo si el emisor confirma que el prefijo es de su archivo.
//
// La prueba de extremo a extremo por relay arranca su propio servidor de
// senalizacion y mata al receptor a media descarga.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  createSenderServer, receiveFiles, receiveFromRelay, hashPartial, verifyPrefix, reserveOutputPath,
} from '../cli/src/transfer.js';
import { deriveKey, encryptChunk, sealFrame } from '../cli/src/crypto.js';
import { newCode, randomRoomId } from '../public/shared/codes.js';
import { startServer } from './helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'cli', 'src', 'cli.js');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const someCode = () => newCode(randomRoomId(crypto.randomBytes), crypto.randomBytes);

function scratch(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Emisor de verdad sirviendo `body` como `name`, cerrado al acabar el test. */
async function realSender(t, code, name, body, options = {}) {
  const dir = scratch(t, 'drop-resume-src-');
  const src = path.join(dir, name);
  fs.writeFileSync(src, body);
  const server = createSenderServer([{ path: src, size: body.length }], code, null, null, options);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return server.address().port;
}

/**
 * Un proxy TCP que deja pasar `cutAfter` bytes del emisor al receptor y entonces
 * corta las dos conexiones a pelo: la forma de simular que se cae la red a
 * media transferencia sin tocar ni el emisor ni el receptor.
 */
async function cuttingProxy(t, targetPort, cutAfter) {
  const server = net.createServer((client) => {
    const upstream = net.connect({ host: '127.0.0.1', port: targetPort });
    let forwarded = 0;
    client.on('error', () => {});
    upstream.on('error', () => {});
    client.pipe(upstream);
    upstream.on('data', (chunk) => {
      if (forwarded >= cutAfter) return;
      const room = cutAfter - forwarded;
      forwarded += Math.min(room, chunk.length);
      // `destroy` tira lo que aun no ha salido al kernel: se corta cuando el
      // ultimo trozo esta entregado, para que el corte sea donde se dice.
      client.write(chunk.subarray(0, room), () => {
        if (forwarded >= cutAfter) {
          client.destroy();
          upstream.destroy();
        }
      });
    });
    upstream.on('close', () => client.destroy());
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return server.address().port;
}

// ------------------------------------------------------------ piezas sueltas

test('verifyPrefix solo acepta un prefijo que es de verdad el principio del archivo', async (t) => {
  const dir = scratch(t, 'drop-prefix-');
  const body = crypto.randomBytes(300 * 1024);
  const file = path.join(dir, 'a.bin');
  fs.writeFileSync(file, body);

  const good = await hashPartial(file, 100 * 1024);
  assert.equal(good.sha256, sha256(body.subarray(0, 100 * 1024)));
  // El hash devuelto sigue vivo: sumarle el resto da el hash del archivo entero.
  assert.equal(good.hash.update(body.subarray(100 * 1024)).digest('hex'), sha256(body));

  const ok = await verifyPrefix(file, body.length, { offset: 100 * 1024, sha256: good.sha256 });
  assert.equal(ok?.offset, 100 * 1024);

  const wrong = sha256(Buffer.from('otra cosa'));
  assert.equal(await verifyPrefix(file, body.length, { offset: 100 * 1024, sha256: wrong }), null);
  assert.equal(await verifyPrefix(file, body.length, { offset: 0, sha256: good.sha256 }), null);
  assert.equal(await verifyPrefix(file, body.length, { offset: body.length + 1, sha256: good.sha256 }), null);
  assert.equal(await verifyPrefix(file, body.length, { offset: '1024', sha256: good.sha256 }), null);
  assert.equal(await verifyPrefix(file, body.length, null), null);
});

test('reserveOutputPath solo reanuda un .part que cabe en el archivo que viene', (t) => {
  const out = scratch(t, 'drop-reserve-');
  fs.writeFileSync(path.join(out, 'a.bin.part'), Buffer.alloc(10));

  // Con resume y un tamano que le cabe: el mismo nombre, con lo que hay.
  let r = reserveOutputPath(out, 'a.bin', new Set(), { resume: true, size: 100 });
  assert.equal(r.finalPath, path.join(out, 'a.bin'));
  assert.equal(r.resumeFrom, 10);

  // Un .part mas largo que el archivo no puede ser suyo: nombre nuevo.
  r = reserveOutputPath(out, 'a.bin', new Set(), { resume: true, size: 5 });
  assert.equal(r.finalPath, path.join(out, 'a (2).bin'));
  assert.equal(r.resumeFrom, null);

  // Sin resume (--no-resume) el .part es un nombre ocupado, como siempre.
  r = reserveOutputPath(out, 'a.bin', new Set(), { resume: false, size: 100 });
  assert.equal(r.finalPath, path.join(out, 'a (2).bin'));
  assert.equal(r.resumeFrom, null);

  // Si el nombre bueno ya existe, el .part no se toca aunque este ahi.
  fs.writeFileSync(path.join(out, 'a.bin'), 'hecho');
  r = reserveOutputPath(out, 'a.bin', new Set(), { resume: true, size: 100 });
  assert.equal(r.finalPath, path.join(out, 'a (2).bin'));
  assert.equal(r.resumeFrom, null);
});

// ------------------------------------------------------------- TCP directo

test('TCP: un corte a mitad deja el .part y el siguiente intento sigue desde ahi', async (t) => {
  const out = scratch(t, 'drop-resume-tcp-');
  const code = someCode();
  const body = crypto.randomBytes(3 * 1024 * 1024 + 321);
  const resumes = [];
  const port = await realSender(t, code, 'grande.bin', body, { onResume: (info) => resumes.push(info) });

  // 1. Se cae la red con ~1 MB de cable consumido.
  const proxyPort = await cuttingProxy(t, port, 1024 * 1024);
  await assert.rejects(
    receiveFiles('127.0.0.1', proxyPort, code, out, () => {}),
    (err) => err.resumable === true && err.partBytes > 0,
  );
  const partPath = path.join(out, 'grande.bin.part');
  assert.ok(fs.existsSync(partPath), 'el .part tiene que quedarse');
  assert.ok(!fs.existsSync(path.join(out, 'grande.bin')), 'el nombre bueno no existe');
  const partial = fs.statSync(partPath).size;
  assert.ok(partial > 0 && partial < body.length, `el .part tiene ${partial} bytes`);
  assert.ok(fs.readFileSync(partPath).equals(body.subarray(0, partial)), 'lo que hay es el prefijo bueno');

  // 2. El mismo comando otra vez: se reanuda desde lo que habia.
  const seen = [];
  const received = await receiveFiles('127.0.0.1', port, code, out, (cur) => seen.push(cur), 0, {
    onResume: (info) => seen.push(info),
  });
  assert.equal(received.length, 1);
  assert.equal(received[0].verified, true);
  assert.equal(received[0].resumedFrom, partial);
  assert.equal(received[0].path, path.join(out, 'grande.bin'));
  assert.equal(received.stats.resumedBytes, partial);
  assert.equal(sha256(fs.readFileSync(path.join(out, 'grande.bin'))), sha256(body));
  assert.ok(!fs.existsSync(partPath), 'el .part se ha renombrado');

  // El receptor ha avisado antes de hashear y al reanudar; el emisor, al aceptar.
  assert.deepEqual(seen.filter((s) => s.phase).map((s) => [s.phase, s.offset]), [['check', partial], ['resume', partial]]);
  assert.equal(resumes.length, 1);
  assert.equal(resumes[0].requested, partial);
  assert.equal(resumes[0].offset, partial);
  // Y la barra de progreso no ha vuelto a empezar de cero.
  const progress = seen.filter((s) => typeof s === 'number');
  assert.ok(progress.every((n) => n >= partial), `el progreso arranca donde se quedo: ${progress[0]}`);
});

test('TCP: un .part que no es de este archivo no se cose: va entero a un nombre nuevo', async (t) => {
  const out = scratch(t, 'drop-resume-ajeno-');
  const code = someCode();
  const body = crypto.randomBytes(200 * 1024);
  const port = await realSender(t, code, 'a.bin', body);

  // Un .part con el tamano justo para colar, pero de otra cosa.
  const ajeno = crypto.randomBytes(50 * 1024);
  fs.writeFileSync(path.join(out, 'a.bin.part'), ajeno);

  const phases = [];
  const received = await receiveFiles('127.0.0.1', port, code, out, () => {}, 0, {
    onResume: (info) => phases.push(info.phase),
  });
  assert.deepEqual(phases, ['check', 'restart']);
  assert.equal(received[0].path, path.join(out, 'a (2).bin'));
  assert.equal(received[0].resumedFrom, 0);
  assert.equal(sha256(fs.readFileSync(path.join(out, 'a (2).bin'))), sha256(body));
  assert.ok(fs.readFileSync(path.join(out, 'a.bin.part')).equals(ajeno), 'el .part ajeno queda como estaba');
});

test('TCP: un .part con el archivo entero pero sin verificar se verifica sin volver a bajarlo', async (t) => {
  const out = scratch(t, 'drop-resume-entero-');
  const code = someCode();
  const body = crypto.randomBytes(100 * 1024);
  const port = await realSender(t, code, 'a.bin', body);
  fs.writeFileSync(path.join(out, 'a.bin.part'), body);

  const received = await receiveFiles('127.0.0.1', port, code, out, () => {});
  assert.equal(received[0].resumedFrom, body.length);
  assert.equal(received[0].verified, true);
  assert.equal(sha256(fs.readFileSync(path.join(out, 'a.bin'))), sha256(body));
});

test('TCP: un .part vacio se reutiliza sin pedirle nada al emisor', async (t) => {
  const out = scratch(t, 'drop-resume-vacio-');
  const code = someCode();
  const body = crypto.randomBytes(10 * 1024);
  const resumes = [];
  const port = await realSender(t, code, 'a.bin', body, { onResume: (info) => resumes.push(info) });
  fs.writeFileSync(path.join(out, 'a.bin.part'), '');

  const phases = [];
  const received = await receiveFiles('127.0.0.1', port, code, out, () => {}, 0, {
    onResume: (info) => phases.push(info.phase),
  });
  assert.deepEqual(phases, []);
  assert.deepEqual(resumes, []);
  assert.equal(received[0].path, path.join(out, 'a.bin'));
  assert.equal(received[0].resumedFrom, 0);
  assert.equal(sha256(fs.readFileSync(path.join(out, 'a.bin'))), sha256(body));
  assert.deepEqual(fs.readdirSync(out), ['a.bin']);
});

// ------------------------------------------------------------------- relay

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

test('relay: el cli-accept pide el prefijo y el cli-start con offset sigue desde ahi', async (t) => {
  const out = scratch(t, 'drop-resume-relay-');
  const key = deriveKey('4271-lemon-radar-tiger-orbit');
  const body = crypto.randomBytes(200 * 1024);
  const half = 120 * 1024;
  fs.writeFileSync(path.join(out, 'a.bin.part'), body.subarray(0, half));

  const ws = fakeWs();
  const sealed = (obj) => ({ data: JSON.stringify({ t: 'signal', data: sealFrame(obj, key) }) });
  const done = receiveFromRelay(ws, [{ name: 'a.bin', size: body.length }], out, () => {}, { key });

  const accept = await ws.waitFor('cli-accept');
  assert.deepEqual(accept.resume, [{ index: 0, offset: half, sha256: sha256(body.subarray(0, half)) }]);

  // El emisor acepta el prefijo: empieza en `half` y el receptor acusa al momento.
  ws.emit('message', sealed({ type: 'cli-start', index: 0, name: 'a.bin', size: body.length, offset: half }));
  const ack = await ws.waitFor('cli-ack');
  assert.equal(ack.bytes, half);

  ws.emit('message', { data: encryptChunk(body.subarray(half), key) });
  ws.emit('message', sealed({ type: 'cli-end', index: 0, sha256: sha256(body) }));
  ws.emit('message', sealed({ type: 'cli-done' }));

  const received = await done;
  assert.equal(received[0].resumedFrom, half);
  assert.equal(received[0].verified, true);
  assert.equal(received.stats.resumedBytes, half);
  assert.equal(sha256(fs.readFileSync(path.join(out, 'a.bin'))), sha256(body));
  assert.equal(ws.sent.at(-1).data.type, 'cli-complete');
});

test('relay: un emisor que no acepta el prefijo manda desde cero y el .part no se toca', async (t) => {
  const out = scratch(t, 'drop-resume-relay-web-');
  const key = deriveKey('4271-lemon-radar-tiger-orbit');
  const body = Buffer.from('NUEVO CONTENIDO');
  fs.writeFileSync(path.join(out, 'a.bin.part'), 'VIEJO');

  const ws = fakeWs();
  const sealed = (obj) => ({ data: JSON.stringify({ t: 'signal', data: sealFrame(obj, key) }) });
  const done = receiveFromRelay(ws, [{ name: 'a.bin', size: body.length }], out, () => {}, { key });
  const accept = await ws.waitFor('cli-accept');
  assert.equal(accept.resume.length, 1);

  // Sin `offset`: el emisor no ha aceptado el prefijo.
  ws.emit('message', sealed({ type: 'cli-start', index: 0, name: 'a.bin', size: body.length }));
  ws.emit('message', { data: encryptChunk(body, key) });
  ws.emit('message', sealed({ type: 'cli-end', index: 0, sha256: sha256(body) }));
  ws.emit('message', sealed({ type: 'cli-done' }));

  const received = await done;
  assert.equal(received[0].path, path.join(out, 'a (2).bin'));
  assert.equal(fs.readFileSync(path.join(out, 'a (2).bin'), 'utf-8'), 'NUEVO CONTENIDO');
  assert.equal(fs.readFileSync(path.join(out, 'a.bin.part'), 'utf-8'), 'VIEJO');
});

test('relay: si se cae el websocket a mitad, el .part se queda para reanudar', async (t) => {
  const out = scratch(t, 'drop-resume-relay-corte-');
  const key = deriveKey('4271-lemon-radar-tiger-orbit');
  const body = crypto.randomBytes(64 * 1024);

  const ws = fakeWs();
  const sealed = (obj) => ({ data: JSON.stringify({ t: 'signal', data: sealFrame(obj, key) }) });
  const done = receiveFromRelay(ws, [{ name: 'a.bin', size: body.length * 2 }], out, () => {}, { key });
  await ws.waitFor('cli-accept');
  ws.emit('message', sealed({ type: 'cli-start', index: 0, name: 'a.bin', size: body.length * 2, offset: 0 }));
  ws.emit('message', { data: encryptChunk(body, key) });
  // Que el trozo llegue a disco antes de cortar.
  await new Promise((r) => setTimeout(r, 100));
  ws.emit('close', {});

  await assert.rejects(done, (err) => err.resumable === true && err.partBytes === body.length);
  assert.ok(fs.readFileSync(path.join(out, 'a.bin.part')).equals(body));
  assert.ok(!fs.existsSync(path.join(out, 'a.bin')));
});

// ------------------------------------- extremo a extremo (tres procesos, relay)

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

test('relay CLI -> CLI: matar al receptor a mitad y volver a lanzarlo reanuda', { timeout: 120_000 }, async () => {
  const server = await startServer();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'drop-e2e-resume-'));
  const outDir = path.join(work, 'destino');
  fs.mkdirSync(outDir);

  const body = crypto.randomBytes(6 * 1024 * 1024);
  const src = path.join(work, 'grande.bin');
  fs.writeFileSync(src, body);
  const partPath = path.join(outDir, 'grande.bin.part');

  const sender = runCli(['send', src, '--server', server.http, '--relay', '--yes']);
  let first = null;
  let second = null;

  try {
    const [, code] = await sender.waitFor(/Código:\s+(\d{4}(?:-[a-z]+){4})/, 20_000);

    // 1. Un receptor lento (--limit) al que se mata con parte del archivo en disco.
    first = runCli(['recv', code, '--server', server.http, '--relay', '-o', outDir, '--limit', '1M']);
    const t0 = Date.now();
    let partial = 0;
    while (partial < 1024 * 1024) {
      if (Date.now() - t0 > 30_000) throw new Error(`el .part no crece:\n${first.output}`);
      await new Promise((r) => setTimeout(r, 100));
      try { partial = fs.statSync(partPath).size; } catch { partial = 0; }
    }
    first.kill('SIGKILL');
    await first.exited;
    assert.ok(fs.existsSync(partPath), 'el .part sobrevive al receptor');
    partial = fs.statSync(partPath).size;

    // 2. El mismo comando: sigue desde el .part.
    second = runCli(['recv', code, '--server', server.http, '--relay', '-o', outDir]);
    const exitCode = await second.exited;
    assert.equal(exitCode, 0, `el segundo receptor falló:\n${second.output}\n--- emisor ---\n${sender.output}`);
    assert.match(second.output, /Reanudando grande\.bin desde/);
    assert.match(sender.output, /ya tiene .* de grande\.bin: se reanuda/);

    const got = fs.readFileSync(path.join(outDir, 'grande.bin'));
    assert.equal(got.length, body.length);
    assert.equal(sha256(got), sha256(body), 'el archivo recibido no coincide');
    assert.ok(!fs.existsSync(partPath));
    assert.ok(partial > 0, 'algo se reanudo de verdad');
  } finally {
    first?.kill('SIGKILL');
    second?.kill('SIGKILL');
    sender.kill('SIGKILL');
    server.proc.kill('SIGKILL');
    fs.rmSync(work, { recursive: true, force: true });
  }
});
