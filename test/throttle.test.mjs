// --limit: que el caudal real se ajusta al limite pedido en el emisor y en el receptor.
// Los casos de extremo a extremo levantan su propio servidor y van por relay.
// (Las pruebas unitarias de parseRate y Throttle estan en cli/tests/).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

import { startServer, cliSpawnTarget } from './helpers.mjs';

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

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
  proc.exited = new Promise((resolve) => proc.on('close', (code) => resolve(code)));
  return proc;
}

/** Envia 6 MB por relay con `--limit 3M` en el lado que se diga y mide lo que tarda. */
async function transferWithLimit(where) {
  const server = await startServer();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'drop-limit-'));
  const outDir = path.join(work, 'destino');
  fs.mkdirSync(outDir);
  const src = path.join(work, 'seis.bin');
  const body = crypto.randomBytes(6 * 1024 * 1024);
  fs.writeFileSync(src, body);

  const sender = runCli(['send', src, '--server', server.http, '--relay', '--no-qr', ...(where === 'send' ? ['--limit', '3M'] : [])]);
  let receiver = null;
  try {
    const [, code] = await sender.waitFor(/Código:\s+(\d{4}(?:-[a-z]+){4})/, 20_000);
    receiver = runCli(['recv', code, '--server', server.http, '--relay', '-o', outDir, ...(where === 'recv' ? ['--limit', '3M'] : [])]);
    await receiver.waitFor(/Huella de la sesión/, 15_000);
    const t0 = Date.now();
    const exitCode = await receiver.exited;
    const seconds = (Date.now() - t0) / 1000;
    assert.equal(exitCode, 0, receiver.output);
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(outDir, 'seis.bin'))).digest('hex'),
      crypto.createHash('sha256').update(body).digest('hex'));
    return { seconds, sender: sender.output, receiver: receiver.output };
  } finally {
    receiver?.kill('SIGKILL');
    sender.kill('SIGKILL');
    server.stop();
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// 6 MB a 3 MB/s son 2 s, menos la rafaga inicial de un segundo: nunca por
// debajo de ~1 s. Sin limite, en loopback, esto tarda menos de 0,2 s.
test('--limit en el emisor ajusta el caudal real', { timeout: 60_000 }, async () => {
  const { seconds, sender } = await transferWithLimit('send');
  assert.ok(seconds >= 0.9, `demasiado rápido para 3 MB/s: ${seconds.toFixed(2)} s`);
  assert.ok(seconds < 8, `demasiado lento: ${seconds.toFixed(2)} s`);
  assert.match(sender, /Límite de subida: 3\.0 MB\/s/);
});

test('--limit en el receptor frena al emisor por los acuses', { timeout: 60_000 }, async () => {
  const { seconds, receiver } = await transferWithLimit('recv');
  assert.ok(seconds >= 0.9, `demasiado rápido para 3 MB/s: ${seconds.toFixed(2)} s`);
  assert.ok(seconds < 8, `demasiado lento: ${seconds.toFixed(2)} s`);
  assert.match(receiver, /Límite de bajada: 3\.0 MB\/s/);
});

test('un --limit mal escrito no abre ningún canal', async () => {
  const proc = runCli(['send', 'package.json', '--limit', 'rapido']);
  assert.equal(await proc.exited, 1);
  assert.match(proc.output, /Límite no válido/);
});
