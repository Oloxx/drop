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

import { pickedFiles } from '../public/shared/protocol.js';
import { startServer, cliSpawnTarget } from './helpers.mjs';

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

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

test('pickedFiles limpia la lista y distingue "todo" de "nada"', () => {
  assert.equal(pickedFiles(undefined, 3), null);
  assert.equal(pickedFiles('0,1', 3), null, 'lo que no es una lista es no haber elegido');
  assert.deepEqual(pickedFiles([2, 0, 2, 7, -1, 1.5, '1'], 3), [0, 2]);
  assert.deepEqual(pickedFiles([], 3), []);
});

// -------------------------------------------------- CLI -> CLI de verdad

function runCli(args) {
  const [cmd, cmdArgs] = cliSpawnTarget(args);
  const proc = spawn(cmd, cmdArgs, {
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
