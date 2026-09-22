// Seleccion de archivos en el receptor (#10): `drop recv --only`, `files` en
// `ready` (TCP) y en `cli-accept` (relay), y el emisor que solo manda lo pedido.
// La mitad web (casillas en la oferta) esta en test/web.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

import { createSenderServer, receiveFiles, receiveFromRelay } from '../cli/src/transfer.js';
import { deriveKey, encryptChunk, sealFrame } from '../cli/src/crypto.js';
import { globToRegex, parsePatterns, selectFiles } from '../cli/src/select.js';
import { pickedFiles } from '../public/shared/protocol.js';
import { newCode, randomRoomId } from '../public/shared/codes.js';
import { startServer, ROOT } from './helpers.mjs';

const CLI = path.join(ROOT, 'cli', 'src', 'cli.js');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const someCode = () => newCode(randomRoomId(crypto.randomBytes), crypto.randomBytes);

function scratch(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Todos los archivos bajo `dir`, como rutas relativas con `/`, ordenadas. */
function tree(dir) {
  const out = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else out.push(r);
    }
  };
  walk(dir, '');
  return out.sort();
}

// ------------------------------------------------------------- patrones

test('patrones: sin / por nombre, con / por final de ruta, con / delante desde la raiz', () => {
  const entries = [
    { name: 'a.jpg' },
    { name: 'b.JPG', path: 'fotos/b.JPG' },
    { name: 'c.jpg', path: 'fotos/2024/c.jpg' },
    { name: 'notas.txt', path: 'fotos/notas.txt' },
    { name: 'informe.pdf', path: 'docs/informe.pdf' },
  ];
  const pick = (text) => selectFiles(entries, parsePatterns(text));

  assert.deepEqual(pick('*.jpg'), [0, 1, 2], 'sin / casa con el nombre en cualquier carpeta, sin mayusculas');
  assert.deepEqual(pick('fotos/*.jpg'), [1], '* no cruza carpetas');
  assert.deepEqual(pick('2024/*.jpg'), [2], 'con / casa tambien debajo de otras carpetas');
  assert.deepEqual(pick('/2024/*.jpg'), [], 'con / delante, solo desde la raiz');
  assert.deepEqual(pick('/fotos/*'), [1, 3]);
  assert.deepEqual(pick('otos/*.jpg'), [], 'empieza en una carpeta, no a mitad de nombre');
  assert.deepEqual(pick('fotos/**'), [1, 2, 3], '** si');
  assert.deepEqual(pick('**/c.jpg'), [2]);
  assert.deepEqual(pick('**/a.jpg'), [0], '**/ tambien vale por ninguna carpeta');
  assert.deepEqual(pick('*.pdf, notas.txt'), [3, 4], 'varios separados por comas, en orden del manifiesto');
  assert.deepEqual(pick('?.jpg'), [0, 1, 2]);
  assert.deepEqual(pick('*.png'), [], 'nada es una lista vacia, no null');
  assert.equal(selectFiles(entries, []), null, 'sin patrones es todo');
  assert.deepEqual(pick('.\\docs\\*.pdf'), [4], 'barras de Windows y ./ delante se normalizan');
});

test('un patron no es una expresion regular: los metacaracteres van literales', () => {
  assert.ok(globToRegex('a+b(1).txt').test('a+b(1).txt'));
  assert.ok(!globToRegex('a.txt').test('abtxt'));
  assert.ok(!globToRegex('*').test('sub/archivo'));
});

test('pickedFiles limpia la lista y distingue "todo" de "nada"', () => {
  assert.equal(pickedFiles(undefined, 3), null);
  assert.equal(pickedFiles('0,1', 3), null, 'lo que no es una lista es no haber elegido');
  assert.deepEqual(pickedFiles([2, 0, 2, 7, -1, 1.5, '1'], 3), [0, 2]);
  assert.deepEqual(pickedFiles([], 3), []);
});

// ------------------------------------------------------------ TCP directo

async function lotSender(t, bodies) {
  const dir = scratch(t, 'drop-select-src-');
  const files = Object.entries(bodies).map(([name, body]) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, body);
    return { path: p, size: body.length };
  });
  const completed = [];
  const code = someCode();
  const server = createSenderServer(files, code, null, (info) => completed.push(info));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { code, port: server.address().port, completed };
}

test('TCP: --only baja solo lo pedido y el emisor solo manda eso', async (t) => {
  const bodies = {
    'uno.jpg': crypto.randomBytes(300 * 1024),
    'dos.txt': crypto.randomBytes(200 * 1024),
    'tres.jpg': crypto.randomBytes(100 * 1024),
  };
  const { code, port, completed } = await lotSender(t, bodies);
  const out = scratch(t, 'drop-select-out-');
  const seen = [];

  const received = await receiveFiles('127.0.0.1', port, code, out, (done, total, speed, list) => {
    seen.push({ total, names: list.map((f) => f.name) });
  }, 0, { only: ['*.jpg'] });

  assert.deepEqual(tree(out), ['tres.jpg', 'uno.jpg']);
  assert.equal(sha256(fs.readFileSync(path.join(out, 'uno.jpg'))), sha256(bodies['uno.jpg']));
  assert.equal(sha256(fs.readFileSync(path.join(out, 'tres.jpg'))), sha256(bodies['tres.jpg']));
  assert.equal(received.filter(Boolean).length, 2);
  assert.ok(received.filter(Boolean).every((r) => r.verified));
  // El total es de lo pedido, no del lote: la barra llega al 100% con dos.
  assert.equal(received.stats.totalBytes, 400 * 1024);
  for (const s of seen) {
    assert.equal(s.total, 400 * 1024);
    assert.deepEqual(s.names, ['uno.jpg', 'tres.jpg']);
  }
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(completed[0].totalBytes, 400 * 1024);
  assert.equal(completed[0].files, 2);
});

test('TCP: un --only que no casa con nada corta sin escribir y dice que habia', async (t) => {
  const { code, port } = await lotSender(t, { 'a.bin': Buffer.from('a'), 'b.bin': Buffer.from('b') });
  const out = scratch(t, 'drop-select-none-');
  await assert.rejects(
    receiveFiles('127.0.0.1', port, code, out, null, 0, { only: ['*.jpg'] }),
    (err) => err.code === 'NOTHING_SELECTED' && err.available.join() === 'a.bin,b.bin',
  );
  assert.deepEqual(tree(out), []);
});

test('TCP: el .part de un archivo que no se ha pedido ni se toca ni se pide', async (t) => {
  const bodies = { 'a.bin': crypto.randomBytes(64 * 1024), 'b.bin': crypto.randomBytes(64 * 1024) };
  const { code, port } = await lotSender(t, bodies);
  const out = scratch(t, 'drop-select-part-');
  fs.writeFileSync(path.join(out, 'a.bin.part'), bodies['a.bin'].subarray(0, 1000));
  const phases = [];
  await receiveFiles('127.0.0.1', port, code, out, null, 0, {
    only: ['b.bin'], onResume: (e) => phases.push(e.phase),
  });
  assert.deepEqual(phases, [], 'no se hashea ni se ofrece reanudar lo que no se baja');
  assert.deepEqual(tree(out), ['a.bin.part', 'b.bin']);
  assert.equal(fs.readFileSync(path.join(out, 'a.bin.part')).length, 1000);
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

test('relay: el cli-accept lleva files y solo se acepta un cli-start de lo pedido', async (t) => {
  const key = deriveKey('4271-lemon-radar-tiger-orbit');
  const manifest = [{ name: 'a.txt', size: 3 }, { name: 'b.jpg', size: 3 }, { name: 'c.jpg', size: 3 }];
  const sealed = (obj) => ({ data: JSON.stringify({ t: 'signal', data: sealFrame(obj, key) }) });

  // Lo pedido llega entero y cuenta como el total.
  {
    const out = scratch(t, 'drop-select-relay-');
    const ws = fakeWs();
    const done = receiveFromRelay(ws, manifest, out, () => {}, { key, only: ['*.jpg'] });
    const accept = await ws.waitFor('cli-accept');
    assert.deepEqual(accept.files, [1, 2]);
    for (const [i, body] of [[1, 'BBB'], [2, 'CCC']]) {
      ws.emit('message', sealed({ type: 'cli-start', index: i, name: manifest[i].name, size: 3 }));
      ws.emit('message', { data: encryptChunk(Buffer.from(body), key) });
      ws.emit('message', sealed({ type: 'cli-end', index: i, sha256: sha256(Buffer.from(body)) }));
    }
    ws.emit('message', sealed({ type: 'cli-done' }));
    const received = await done;
    assert.equal(received.stats.totalBytes, 6);
    assert.deepEqual(tree(out), ['b.jpg', 'c.jpg']);
    // Con el total de lo pedido, el ultimo acuse sale al llegar el ultimo byte.
    assert.ok(ws.sent.some((m) => m.data?.type === 'cli-ack' && m.data.bytes === 6));
  }

  // Un emisor que manda lo que no se le ha pedido no escribe nada de eso.
  {
    const out = scratch(t, 'drop-select-relay-bad-');
    const ws = fakeWs();
    const done = receiveFromRelay(ws, manifest, out, () => {}, { key, only: ['*.jpg'] });
    await ws.waitFor('cli-accept');
    ws.emit('message', sealed({ type: 'cli-start', index: 0, name: 'a.txt', size: 3 }));
    await assert.rejects(done, (err) => err.code === 'PROTOCOL_ERROR' && /no se ha pedido/.test(err.message));
    assert.deepEqual(tree(out), []);
  }

  // Sin --only no viaja `files`: es lo que entiende cualquier emisor como "todo".
  {
    const out = scratch(t, 'drop-select-relay-all-');
    const ws = fakeWs();
    receiveFromRelay(ws, manifest, out, () => {}, { key }).catch(() => {});
    const accept = await ws.waitFor('cli-accept');
    assert.equal('files' in accept, false);
    ws.emit('close', {});
  }
});

// -------------------------------------------------- CLI -> CLI de verdad

function runCli(args) {
  const proc = spawn(process.execPath, [CLI, ...args], {
    env: { ...process.env, DROP_NO_UPNP: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.output = '';
  proc.stdout.on('data', (d) => { proc.output += stripAnsi(d.toString()); });
  proc.stderr.on('data', (d) => { proc.output += stripAnsi(d.toString()); });
  proc.waitFor = (re, ms) => new Promise((resolve, reject) => {
    const poll = setInterval(() => {
      const m = proc.output.match(re);
      if (m) { clearInterval(poll); clearTimeout(timer); resolve(m); }
    }, 50);
    const timer = setTimeout(() => {
      clearInterval(poll);
      reject(new Error(`no apareció ${re} en la salida:\n${proc.output}`));
    }, ms);
  });
  proc.exited = new Promise((resolve) => proc.on('exit', (code) => resolve(code)));
  return proc;
}

test('drop recv --only por relay: de una carpeta llega solo lo que casa', { timeout: 90_000 }, async (t) => {
  const server = await startServer();
  t.after(() => server.proc.kill('SIGKILL'));
  const work = scratch(t, 'drop-select-e2e-');
  const src = path.join(work, 'viaje');
  fs.mkdirSync(path.join(src, 'fotos'), { recursive: true });
  const bodies = {
    'fotos/playa.jpg': crypto.randomBytes(3 * 1024 * 1024),
    'fotos/cena.jpg': crypto.randomBytes(1024 * 1024),
    'fotos/lista.txt': Buffer.from('nada'),
    'gastos.xlsx': crypto.randomBytes(2048),
  };
  for (const [rel, body] of Object.entries(bodies)) fs.writeFileSync(path.join(src, rel), body);
  const outDir = path.join(work, 'destino');

  const sender = runCli(['send', src, '--server', server.http, '--relay']);
  t.after(() => sender.kill('SIGKILL'));
  const [, code] = await sender.waitFor(/Código:\s+(\d{4}(?:-[a-z]+){4})/, 20_000);
  const receiver = runCli(['recv', code, '--server', server.http, '--relay', '-o', outDir, '--only', 'fotos/*.jpg']);
  t.after(() => receiver.kill('SIGKILL'));

  assert.equal(await receiver.exited, 0, `el receptor falló:\n${receiver.output}\n--- emisor ---\n${sender.output}`);
  assert.deepEqual(tree(outDir), ['viaje/fotos/cena.jpg', 'viaje/fotos/playa.jpg']);
  for (const rel of ['fotos/playa.jpg', 'fotos/cena.jpg']) {
    assert.equal(sha256(fs.readFileSync(path.join(outDir, 'viaje', rel))), sha256(bodies[rel]));
  }
  await sender.waitFor(/Ha pedido 2 de 4 archivos/, 10_000);
  await sender.waitFor(/Transferencia completada con éxito/, 15_000);
});
