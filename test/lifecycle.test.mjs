// --once y --expire: el canal del emisor se cierra solo, sin que nadie pulse
// Ctrl+C. Lanza los CLI como procesos, con su propio servidor de senalizacion.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

import { startServer, ROOT } from './helpers.mjs';

const CLI = path.join(ROOT, 'cli', 'src', 'cli.js');
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

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

const withTimeout = (p, ms, what) => Promise.race([
  p,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} no terminó en ${ms} ms`)), ms)),
]);

test('--once cierra el emisor tras la primera descarga completa', { timeout: 60_000 }, async () => {
  const server = await startServer();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'drop-once-'));
  const outDir = path.join(work, 'destino');
  fs.mkdirSync(outDir);
  const src = path.join(work, 'uno.bin');
  fs.writeFileSync(src, crypto.randomBytes(256 * 1024));

  const sender = runCli(['send', src, '--server', server.http, '--relay', '--once']);
  let receiver = null;
  try {
    const [, code] = await sender.waitFor(/Código:\s+(\d{4}(?:-[a-z]+){4})/, 20_000);
    await sender.waitFor(/se cierra tras la primera descarga/, 5_000);

    receiver = runCli(['recv', code, '--server', server.http, '--relay', '-o', outDir]);
    assert.equal(await receiver.exited, 0, receiver.output);

    // Sin Ctrl+C: el emisor sale solo, con codigo 0, y lo dice.
    const exitCode = await withTimeout(sender.exited, 15_000, 'el emisor');
    assert.equal(exitCode, 0, sender.output);
    assert.match(sender.output, /Entrega única completada/);
    assert.ok(fs.existsSync(path.join(outDir, 'uno.bin')));
  } finally {
    receiver?.kill('SIGKILL');
    sender.kill('SIGKILL');
    server.stop();
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('--expire cierra el emisor solo cuando nadie ha descargado', { timeout: 30_000 }, async () => {
  const server = await startServer();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'drop-expire-'));
  const src = path.join(work, 'uno.bin');
  fs.writeFileSync(src, 'hola');

  const sender = runCli(['send', src, '--server', server.http, '--relay', '--expire', '2s']);
  try {
    await sender.waitFor(/Código:\s+\d{4}/, 20_000);
    await sender.waitFor(/caduca en 2s/, 5_000);
    const t0 = Date.now();
    const exitCode = await withTimeout(sender.exited, 15_000, 'el emisor');
    assert.equal(exitCode, 0, sender.output);
    assert.ok(Date.now() - t0 < 10_000, 'tardó demasiado en caducar');
    assert.match(sender.output, /Canal caducado/);
  } finally {
    sender.kill('SIGKILL');
    server.stop();
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('--expire con una duración mal escrita no abre ningún canal', async () => {
  const proc = runCli(['send', CLI, '--expire', 'luego']);
  assert.equal(await proc.exited, 1);
  assert.match(proc.output, /Duración no válida/);
  assert.doesNotMatch(proc.output, /Canal abierto/);
});

// ------------------------------------------------- --text / --stdout (#34)

test('--text envía un fragmento y --stdout lo vuelca limpio por la tubería', { timeout: 60_000 }, async () => {
  const server = await startServer();
  const texto = 'la clave del wifi es: ñandú-2026 ✓\nsegunda línea';
  const sender = runCli(['send', '--text', texto, '--server', server.http, '--relay', '--no-qr']);
  let receiver = null;
  try {
    const [, code] = await sender.waitFor(/Código:\s+(\d{4}(?:-[a-z]+){4})/, 20_000);
    assert.match(sender.output, /message\.txt|1 archivo/);

    receiver = spawn(process.execPath, [CLI, 'recv', code, '--server', server.http, '--relay', '--stdout'], {
      env: { ...process.env, DROP_NO_UPNP: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out = [];
    let err = '';
    receiver.stdout.on('data', (d) => out.push(d));
    receiver.stderr.on('data', (d) => { err += stripAnsi(d.toString()); });
    const exitCode = await new Promise((resolve) => receiver.on('exit', resolve));

    assert.equal(exitCode, 0, err);
    // stdout lleva SOLO el contenido, byte a byte; todo lo demas fue a stderr.
    assert.equal(Buffer.concat(out).toString('utf-8'), texto);
    assert.match(err, /Buscando emisor/);
    assert.match(err, /verificado/);
  } finally {
    receiver?.kill('SIGKILL');
    sender.kill('SIGKILL');
    server.stop();
  }
});
