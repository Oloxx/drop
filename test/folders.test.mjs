// Carpetas enteras: la ruta relativa del manifiesto se acepta solo hacia abajo,
// y un `drop send carpeta` llega al otro lado con su arbol. El caso de extremo a
// extremo levanta su propio servidor y va por relay.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

import { safeOutputPath, reserveOutputPath } from '../cli/src/transfer.js';
import { startServer, ROOT } from './helpers.mjs';

const CLI = path.join(ROOT, 'cli', 'src', 'cli.js');
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

test('safeOutputPath acepta una ruta relativa hacia abajo y la resuelve dentro del destino', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'drop-folders-'));
  assert.equal(safeOutputPath(out, 'playa.jpg', 'fotos/verano/playa.jpg'), path.join(out, 'fotos', 'verano', 'playa.jpg'));
  // Barras de Windows: se normalizan igual que en el nombre suelto.
  assert.equal(safeOutputPath(out, 'a.txt', 'dir\\sub\\a.txt'), path.join(out, 'dir', 'sub', 'a.txt'));
  // Sin `path` no cambia nada: el nombre suelto va a la raiz.
  assert.equal(safeOutputPath(out, 'suelto.bin'), path.join(out, 'suelto.bin'));
  fs.rmSync(out, { recursive: true, force: true });
});

test('safeOutputPath rechaza toda ruta que suba, salga o no sea relativa', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'drop-folders-'));
  const malas = [
    '../fuera.txt', 'a/../../fuera.txt', 'a/./b.txt', '/etc/passwd', 'C:/Windows/x.txt', 'C:\\x.txt',
    '', '/', 'a//b.txt', 'a/', 'con\u0000nulo/a.txt', '..', '.', 42,
  ];
  for (const mala of malas) {
    assert.throws(() => safeOutputPath(out, 'x.txt', mala), (err) => err.code === 'UNSAFE_NAME', `deberia rechazar ${JSON.stringify(mala)}`);
  }
  fs.rmSync(out, { recursive: true, force: true });
});

test('reserveOutputPath numera colisiones dentro de la subcarpeta', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'drop-folders-'));
  fs.mkdirSync(path.join(out, 'dir'));
  fs.writeFileSync(path.join(out, 'dir', 'a.txt'), 'viejo');
  const reserved = new Set();
  assert.equal(reserveOutputPath(out, 'a.txt', reserved, { subpath: 'dir/a.txt' }).finalPath, path.join(out, 'dir', 'a (2).txt'));
  assert.equal(reserveOutputPath(out, 'a.txt', reserved, { subpath: 'dir/a.txt' }).finalPath, path.join(out, 'dir', 'a (3).txt'));
  // El mismo nombre en otra carpeta no choca con nada.
  assert.equal(reserveOutputPath(out, 'a.txt', reserved, { subpath: 'otra/a.txt' }).finalPath, path.join(out, 'otra', 'a.txt'));
  fs.rmSync(out, { recursive: true, force: true });
});

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

test('drop send <carpeta> llega con su arbol y el hash de cada archivo', { timeout: 60_000 }, async () => {
  const server = await startServer();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'drop-folders-'));
  const src = path.join(work, 'proyecto');
  const tree = {
    'README.md': Buffer.from('# hola\n'),
    'src/index.js': crypto.randomBytes(70 * 1024),
    'src/lib/util.js': crypto.randomBytes(3 * 1024),
    'docs/img/logo.png': crypto.randomBytes(512 * 1024),
  };
  for (const [rel, body] of Object.entries(tree)) {
    const p = path.join(src, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  fs.mkdirSync(path.join(src, 'vacia'));   // no viaja: no tiene bytes
  const outDir = path.join(work, 'destino');
  fs.mkdirSync(outDir);

  const sender = runCli(['send', src, '--server', server.http, '--relay', '--no-qr']);
  let receiver = null;
  try {
    const [, code] = await sender.waitFor(/Código:\s+(\d{4}(?:-[a-z]+){4})/, 20_000);
    assert.match(sender.output, /4 archivo\(s\) en 1 carpeta\(s\)/);

    receiver = runCli(['recv', code, '--server', server.http, '--relay', '-o', outDir]);
    assert.equal(await receiver.exited, 0, receiver.output);

    for (const [rel, body] of Object.entries(tree)) {
      const got = fs.readFileSync(path.join(outDir, 'proyecto', ...rel.split('/')));
      assert.equal(got.equals(body), true, `${rel} no coincide`);
    }
    assert.ok(!fs.existsSync(path.join(outDir, 'proyecto', 'vacia')), 'una carpeta vacia no viaja');
    assert.match(receiver.output, /proyecto\/src\/lib\/util\.js ✔ verificado/);
  } finally {
    receiver?.kill('SIGKILL');
    sender.kill('SIGKILL');
    server.stop();
    fs.rmSync(work, { recursive: true, force: true });
  }
});
