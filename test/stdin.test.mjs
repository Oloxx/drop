// Enviar por tuberia (issue #29): `drop send -` lee de stdin sin saber cuanto
// va a llegar. El manifiesto lleva `size: null`, los dos bucles de envio leen
// de un `openSource` que no vuelve atras, y el receptor da el archivo por
// terminado con el `end`, no contando bytes. La mitad de salida (`-o -`) ya
// existia; aqui se prueba que las dos mitades encajan en una tuberia real.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { startServer, cliSpawnTarget, freePort } from './helpers.mjs';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

function scratch(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ----------------------------------------------- extremo a extremo (CLI)

function runCli(args, { stdin = 'ignore', env = {} } = {}) {
  const [cmd, cmdArgs] = cliSpawnTarget(args);
  const proc = spawn(cmd, cmdArgs, {
    env: { ...process.env, DROP_NO_UPNP: '1', DROP_NO_QR: '1', DROP_NO_CONFIG: '1', ...env },
    stdio: [stdin, 'pipe', 'pipe'],
  });
  proc.output = '';
  proc.stdoutChunks = [];
  // Un emisor que sale antes de leer toda su tuberia nos da EPIPE al escribir:
  // es justo lo que prueba el test del corte, no un fallo del test.
  if (proc.stdin) proc.stdin.on('error', () => {});
  proc.stdout.on('data', (d) => { proc.stdoutChunks.push(d); proc.output += stripAnsi(d.toString()); });
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

test('drop send - con un archivo además es un error, y --name sin - también', async () => {
  const a = runCli(['send', '-', 'algo.txt'], { stdin: 'pipe' });
  assert.equal(await a.exited, 1);
  assert.match(a.output, /no se puede combinar/);

  const b = runCli(['send', 'algo.txt', '--name', 'x'], { stdin: 'pipe' });
  assert.equal(await b.exited, 1);
  assert.match(b.output, /--name solo tiene sentido/);
});

test('tubería completa por TCP: cat | drop send - ... y drop recv guarda el archivo con --name', { timeout: 60_000 }, async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const outDir = scratch(t, 'drop-stdin-e2e-');
  const body = crypto.randomBytes(3 * 1024 * 1024);

  const sender = runCli(['send', '-', '--name', 'copia.bin', '--server', server.http, '--yes'], { stdin: 'pipe' });
  t.after(() => sender.kill('SIGKILL'));
  // Se escribe entero antes de que exista receptor: el emisor tiene que
  // aguantar la contrapresion de la tuberia sin leerla hasta que toque.
  sender.stdin.end(body);

  const [, code] = await sender.waitFor(/Código:\s+(\d{4}(?:-[a-z]+){4})/, 20_000);
  assert.match(sender.output, /tamaño desconocido \(stdin\)/);

  const receiver = runCli(['recv', code, '--server', server.http, '-o', outDir]);
  t.after(() => receiver.kill('SIGKILL'));
  assert.equal(await receiver.exited, 0, `el receptor falló:\n${receiver.output}\n--- emisor ---\n${sender.output}`);
  assert.equal(sha256(fs.readFileSync(path.join(outDir, 'copia.bin'))), sha256(body));

  // Sin `--once`: el emisor se cierra solo porque stdin ya no tiene nada que
  // servir a un segundo receptor.
  assert.equal(await sender.exited, 0, sender.output);
  assert.match(sender.output, /ya está entregado/);
});

test('tubería completa por relay: drop send - | drop recv -o - devuelve los mismos bytes por stdout', { timeout: 60_000 }, async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const body = crypto.randomBytes(1024 * 1024 + 17);

  const sender = runCli(['send', '-', '--relay', '--server', server.http, '--yes'], { stdin: 'pipe' });
  t.after(() => sender.kill('SIGKILL'));
  sender.stdin.end(body);
  const [, code] = await sender.waitFor(/Código:\s+(\d{4}(?:-[a-z]+){4})/, 20_000);

  const receiver = runCli(['recv', code, '--relay', '--server', server.http, '-o', '-']);
  t.after(() => receiver.kill('SIGKILL'));
  assert.equal(await receiver.exited, 0, `el receptor falló:\n${receiver.output}\n--- emisor ---\n${sender.output}`);
  // Por stdout van SOLO los bytes: cualquier mensaje ahi rompe el `| tar xzf -`.
  assert.equal(sha256(Buffer.concat(receiver.stdoutChunks)), sha256(body));
  assert.equal(await sender.exited, 0, sender.output);
});

test('si el receptor se cae a medias, el emisor de stdin sale con error en vez de esperar a otro', { timeout: 60_000 }, async (t) => {
  // Lo leido de la tuberia no se puede volver a leer: quedarse esperando a un
  // segundo receptor seria prometerle un archivo que ya no existe.
  const server = await startServer();
  t.after(() => server.stop());
  const outDir = scratch(t, 'drop-stdin-cut-');
  // Mas que la ventana de 8 MB del relay: asi el emisor esta parado esperando
  // acuses cuando el receptor muere, que es el caso normal con algo grande.
  const body = crypto.randomBytes(24 * 1024 * 1024);

  const sender = runCli(['send', '-', '--relay', '--server', server.http, '--yes'], { stdin: 'pipe' });
  t.after(() => sender.kill('SIGKILL'));
  sender.stdin.end(body);
  const [, code] = await sender.waitFor(/Código:\s+(\d{4}(?:-[a-z]+){4})/, 20_000);

  const receiver = runCli(['recv', code, '--relay', '--server', server.http, '-o', outDir, '--limit', '1M']);
  t.after(() => receiver.kill('SIGKILL'));
  const partPath = path.join(outDir, 'stdin.part');
  const t0 = Date.now();
  let partial = 0;
  while (partial < 512 * 1024) {
    if (Date.now() - t0 > 30_000) throw new Error(`el .part no crece:\n${receiver.output}`);
    await new Promise((r) => setTimeout(r, 100));
    try { partial = fs.statSync(partPath).size; } catch { partial = 0; }
  }
  receiver.kill('SIGKILL');
  await receiver.exited;

  assert.equal(await sender.exited, 1, sender.output);
  assert.match(sender.output, /consumido a medias/);
});

// ------------------------------------------------- robustez TCP / stdin / --stdout (#69)

test('conexión TCP inactiva expira por timeout y no bloquea --once ni --expire (#69)', { timeout: 60_000 }, async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const work = scratch(t, 'drop-tcp-timeout-');
  const src = path.join(work, 'payload.txt');
  const outDir = path.join(work, 'out');
  const body = Buffer.from('archivo entregado tras timeout de socket inactivo\n');
  fs.writeFileSync(src, body);
  fs.mkdirSync(outDir, { recursive: true });
  const port = await freePort();

  const sender = runCli(
    ['send', src, '--server', server.http, '--yes', '--once', '--expire', '30s', '-p', String(port)],
    { env: { DROP_TCP_HANDSHAKE_TIMEOUT_MS: '700' } },
  );
  t.after(() => sender.kill('SIGKILL'));
  const [, code] = await sender.waitFor(/Código:\s+(\d{4}(?:-[a-z]+){4})/, 20_000);

  // Abrir un socket TCP mudo que aguanta mas de PEER_SETTLE_MS (400ms) sin mandar `ready`.
  const idleSock = net.connect(port, '127.0.0.1');
  t.after(() => idleSock.destroy());
  await new Promise((resolve, reject) => {
    idleSock.once('connect', resolve);
    idleSock.once('error', reject);
  });

  // El emisor debe expulsar el socket por timeout en ~1.1s y liberar `in_flight`.
  await sender.waitFor(/Tiempo de espera agotado/i, 10_000);
  idleSock.destroy();

  // Ahora un receptor legitimo completa la descarga y `--once` cierra limpio.
  const receiver = runCli(['recv', code, '--server', server.http, '-o', outDir, '--yes']);
  t.after(() => receiver.kill('SIGKILL'));
  assert.equal(await receiver.exited, 0, receiver.output);
  assert.deepEqual(fs.readFileSync(path.join(outDir, 'payload.txt')), body);
  assert.equal(await sender.exited, 0, sender.output);
});

test('un receptor con código incorrecto contra `drop send -` no consume ni aborta stdin (#69)', { timeout: 60_000 }, async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const outDir = scratch(t, 'drop-stdin-badcode-');
  const body = crypto.randomBytes(64 * 1024 + 19);
  const port = await freePort();

  const sender = runCli(
    ['send', '-', '--server', server.http, '--yes', '-p', String(port)],
    { stdin: 'pipe' },
  );
  t.after(() => sender.kill('SIGKILL'));
  sender.stdin.end(body);
  const [, code] = await sender.waitFor(/Código:\s+(\d{4}(?:-[a-z]+){4})/, 20_000);

  // Receptor con el mismo roomId pero palabras distintas (BAD_CODE)
  const roomId = code.split('-')[0];
  const wrongCode = `${roomId}-apple-apple-apple-apple`;
  const badRecv = runCli(['recv', wrongCode, '--server', server.http, '-o', outDir, '--yes']);
  t.after(() => badRecv.kill('SIGKILL'));
  assert.notEqual(await badRecv.exited, 0, 'el receptor con código malo debe fallar');

  // El emisor NO debe haber muerto ni marcado stdin como consumido a medias
  assert.doesNotMatch(sender.output, /consumido a medias/);

  // Un receptor legítimo recibe el 100% de stdin
  const goodRecv = runCli(['recv', code, '--server', server.http, '-o', outDir, '--yes']);
  t.after(() => goodRecv.kill('SIGKILL'));
  assert.equal(await goodRecv.exited, 0, `receptor bueno falló:\n${goodRecv.output}\n--- emisor ---\n${sender.output}`);
  assert.equal(sha256(fs.readFileSync(path.join(outDir, 'stdin'))), sha256(body));
  assert.equal(await sender.exited, 0, sender.output);
});

test('`drop recv --stdout` rechaza múltiples archivos tanto en TCP directo como en Relay y funciona con --only (#69)', { timeout: 60_000 }, async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const work = scratch(t, 'drop-stdout-multi-');
  const f1 = path.join(work, 'uno.txt');
  const f2 = path.join(work, 'dos.txt');
  fs.writeFileSync(f1, 'primero\n');
  fs.writeFileSync(f2, 'segundo\n');

  const sender = runCli(['send', f1, f2, '--server', server.http, '--yes']);
  t.after(() => sender.kill('SIGKILL'));
  const [, code] = await sender.waitFor(/Código:\s+(\d{4}(?:-[a-z]+){4})/, 20_000);

  // 1. Ruta Relay: debe rechazar con código != 0 y sin volcar nada a stdout
  const recvRelay = runCli(['recv', code, '--server', server.http, '--relay', '--stdout', '--yes']);
  t.after(() => recvRelay.kill('SIGKILL'));
  assert.equal(await recvRelay.exited, 1, recvRelay.output);
  assert.match(recvRelay.output, /--stdout solo admite un archivo/);
  assert.equal(Buffer.concat(recvRelay.stdoutChunks).length, 0);

  // 2. Ruta TCP directo (LAN o señalización): también debe rechazar igual
  const recvTcp = runCli(['recv', code, '--server', server.http, '--stdout', '--yes']);
  t.after(() => recvTcp.kill('SIGKILL'));
  assert.equal(await recvTcp.exited, 1, recvTcp.output);
  assert.match(recvTcp.output, /--stdout solo admite un archivo/);
  assert.equal(Buffer.concat(recvTcp.stdoutChunks).length, 0);

  // 3. Con `--only dos.txt`, sí permite volcar ese único archivo a stdout
  const recvOnly = runCli(['recv', code, '--server', server.http, '--relay', '--stdout', '--only', 'dos.txt', '--yes']);
  t.after(() => recvOnly.kill('SIGKILL'));
  assert.equal(await recvOnly.exited, 0, recvOnly.output);
  assert.equal(Buffer.concat(recvOnly.stdoutChunks).toString('utf8'), 'segundo\n');
});
