// Carpetas enteras: un `drop send carpeta` llega al otro lado con su arbol.
// El caso de extremo a extremo levanta su propio servidor y va por relay.
// (Las pruebas unitarias de rutas seguras y reserva estan en cli-rs/tests/transfer_test.rs).
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
