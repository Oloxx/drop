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
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { startServer, cliSpawnTarget, open as openSocket, deriveKey, proofFromKey, sleep } from './helpers.mjs';

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// ------------------------------------- transferencia CLI -> CLI (extremo a extremo)

/** Lanza el CLI y deja esperar a que aparezca algo en su salida. */
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

/**
 * Transferencia real CLI -> CLI por el relay, con el servidor arrancado con `env`.
 * Devuelve los segundos que tardo la descarga (medidos desde el `recv`).
 */
async function relayRoundTrip(env, sizeMb) {
  const server = await startServer(env);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'drop-e2e-'));
  const outDir = path.join(work, 'destino');
  fs.mkdirSync(outDir);

  const body = crypto.randomBytes(sizeMb * 1024 * 1024);
  const src = path.join(work, 'grande.bin');
  fs.writeFileSync(src, body);

  const sender = runCli(['send', src, '--server', server.http, '--relay']);
  let receiver = null;
  try {
    const [, code] = await sender.waitFor(/Código:\s+(\d{4}(?:-[a-z]+){4})/, 20_000);
    const t0 = performance.now();
    receiver = runCli(['recv', code, '--server', server.http, '--relay', '-o', outDir]);
    const exitCode = await receiver.exited;
    const seconds = (performance.now() - t0) / 1000;

    assert.equal(exitCode, 0, `el receptor falló:
${receiver.output}
--- emisor ---
${sender.output}`);
    const got = fs.readFileSync(path.join(outDir, 'grande.bin'));
    assert.equal(got.length, body.length);
    assert.equal(sha256(got), sha256(body), 'el archivo recibido no coincide');
    await sender.waitFor(/Transferencia completada con éxito/, 15_000);
    return seconds;
  } finally {
    receiver?.kill('SIGKILL');
    sender.kill('SIGKILL');
    server.proc.kill('SIGKILL');
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// Con `DROP_RELAY_LIMIT` puesto la transferencia tiene que llegar entera, solo
// mas despacio: el servidor pausa el socket, no descarta frames (#56). 12 MB a
// 4 MB/s no pueden bajar de ~2 s; sin limite, en loopback, tarda menos de uno.
test('relay CLI -> CLI con DROP_RELAY_LIMIT llega integro y frenado', { timeout: 120_000 }, async () => {
  const seconds = await relayRoundTrip({ DROP_RELAY_LIMIT: '4M' }, 12);
  assert.ok(seconds >= 2, `12 MB a 4 MB/s no pueden tardar ${seconds.toFixed(2)} s`);
});

test('relay CLI -> CLI entrega un archivo por encima de la ventana de 8 MB', { timeout: 120_000 }, async () => {
  const server = await startServer();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'drop-e2e-'));
  const outDir = path.join(work, 'destino');
  fs.mkdirSync(outDir);

  // 12 MB: el emisor no manda más de 8 MB sin acuse, así que este archivo no cabe
  // en la ventana. Antes de que `receiveFromRelay` acusara recibo, esto colgaba.
  const body = crypto.randomBytes(12 * 1024 * 1024);
  const src = path.join(work, 'grande.bin');
  fs.writeFileSync(src, body);

  const sender = runCli(['send', src, '--server', server.http, '--relay']);
  let receiver = null;

  try {
    const [, code] = await sender.waitFor(/Código:\s+(\d{4}(?:-[a-z]+){4})/, 20_000);

    receiver = runCli(['recv', code, '--server', server.http, '--relay', '-o', outDir]);
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

test('relay CLI: cli-accept y cli-retry sin cli-proof son ignorados y no queman --once', { timeout: 60_000 }, async () => {
  const server = await startServer();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'drop-auth-bypass-'));
  const outDir = path.join(work, 'destino');
  fs.mkdirSync(outDir);

  const body = crypto.randomBytes(64 * 1024);
  const src = path.join(work, 'secreto.bin');
  fs.writeFileSync(src, body);

  const sender = runCli(['send', src, '--server', server.http, '--relay', '--yes', '--once']);
  let attacker = null;
  let receiver = null;

  try {
    const [, code] = await sender.waitFor(/Código:\s+(\d{4}(?:-[a-z]+){4})/, 20_000);
    const roomId = code.split('-')[0];

    attacker = await openSocket(server.ws);
    let binaryReceived = 0;
    attacker.on('message', (_raw, isBinary) => {
      if (isBinary) binaryReceived++;
    });

    attacker.say({ t: 'join', token: roomId, name: 'cli' });
    const joined = await attacker.until((m) => m.t === 'joined');
    assert.ok(joined.guestId > 0);
    const offer = await attacker.until((m) => m.t === 'signal' && m.data?.type === 'cli-offer');
    assert.equal(offer.data.type, 'cli-offer');

    // Atacante intenta saltarse cli-proof enviando cli-accept y cli-retry directamente.
    attacker.say({ t: 'signal', data: { type: 'cli-accept' } });
    attacker.say({ t: 'signal', data: { type: 'cli-retry', index: 0 } });
    await sleep(600);

    assert.equal(binaryReceived, 0, 'no deben enviarse chunks sin cli-proof valido');
    assert.equal(
      attacker.queue.some((m) => m.t === 'signal' && ['cli-manifest', 'cli-sealed', 'cli-start'].includes(m.data?.type)),
      false,
      'no debe enviarse manifiesto ni inicio sin cli-proof',
    );
    attacker.close();

    // Un receptor legitimo todavia puede descargar (el atacante no quemo --once).
    receiver = runCli(['recv', code, '--server', server.http, '--relay', '--yes', '-o', outDir]);
    assert.equal(await receiver.exited, 0, `receptor legitimo fallo:\n${receiver.output}\n${sender.output}`);
    assert.equal(await sender.exited, 0);
    assert.deepEqual(fs.readFileSync(path.join(outDir, 'secreto.bin')), body);
  } finally {
    attacker?.close();
    receiver?.kill('SIGKILL');
    sender.kill('SIGKILL');
    server.proc.kill('SIGKILL');
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('relay CLI: receptor rechazado en peer_gate no puede iniciar transferencia con cli-accept', { timeout: 60_000 }, async () => {
  const server = await startServer();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'drop-auth-gate-'));
  const body = crypto.randomBytes(32 * 1024);
  const src = path.join(work, 'secreto.bin');
  fs.writeFileSync(src, body);

  const [cmd, cmdArgs] = cliSpawnTarget(['send', src, '--server', server.http, '--relay', '--once']);
  const sender = spawn(cmd, cmdArgs, {
    env: { ...process.env, DROP_NO_UPNP: '1', DROP_FORCE_PROMPT: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  sender.output = '';
  sender.stdout.on('data', (d) => { sender.output += stripAnsi(d.toString()); });
  sender.stderr.on('data', (d) => { sender.output += stripAnsi(d.toString()); });
  sender.waitFor = (re, ms) => new Promise((resolve, reject) => {
    const check = () => {
      const m = sender.output.match(re);
      if (m) { clearInterval(poll); clearTimeout(timer); resolve(m); }
    };
    const poll = setInterval(check, 50);
    const timer = setTimeout(() => {
      clearInterval(poll);
      reject(new Error(`no apareció ${re} en la salida:\n${sender.output}`));
    }, ms);
    check();
  });

  let ws = null;
  try {
    const [, code] = await sender.waitFor(/Código:\s+(\d{4}(?:-[a-z]+){4})/, 20_000);
    const roomId = code.split('-')[0];
    const key = deriveKey(code);

    ws = await openSocket(server.ws);
    let binaryReceived = 0;
    ws.on('message', (_raw, isBinary) => {
      if (isBinary) binaryReceived++;
    });

    ws.say({ t: 'join', token: roomId, name: 'cli' });
    await ws.until((m) => m.t === 'joined');
    const offer = await ws.until((m) => m.t === 'signal' && m.data?.type === 'cli-offer');

    // Envia cli-proof valido para llegar al prompt interactivo y rechazarlo.
    ws.say({
      t: 'signal',
      data: {
        type: 'cli-proof',
        v: offer.data.v,
        proof: proofFromKey(key, offer.data.nonce),
      },
    });
    await sender.waitFor(/¿Le dejas descargar\?/, 10_000);
    sender.stdin.write('n\n');

    const denied = await ws.until((m) => m.t === 'signal' && m.data?.type === 'cli-denied');
    assert.equal(denied.data.type, 'cli-denied');

    // Aunque ya tuviera la clave, al ser rechazado no puede forzar cli-accept.
    ws.say({ t: 'signal', data: { type: 'cli-accept' } });
    await sleep(500);
    assert.equal(binaryReceived, 0);
    assert.equal(
      ws.queue.some((m) => m.t === 'signal' && m.data?.type === 'cli-sealed'),
      false,
    );
  } finally {
    ws?.close();
    sender.kill('SIGKILL');
    server.proc.kill('SIGKILL');
    fs.rmSync(work, { recursive: true, force: true });
  }
});
