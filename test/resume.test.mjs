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

import { startServer, cliSpawnTarget } from './helpers.mjs';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

// ------------------------------------- extremo a extremo (tres procesos, relay)

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
