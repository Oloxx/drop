// Pruebas del servidor web y de senalizacion embebido (`drop serve`) usando el binario compilado.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import WebSocket from 'ws';
import { ROOT, cliSpawnTarget, open as openSocket, sleep, spawnCli } from './helpers.mjs';

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

test('`drop serve` sirve web, cabeceras de seguridad, APIs y relay WebSocket extremo a extremo', { timeout: 30_000 }, async (t) => {
  const srv = spawnCli(['serve', '-p', '0']);
  t.after(() => srv.kill());

  const m = await srv.waitFor(/http:\/\/localhost:(\d+)/);
  const port = Number(m[1]);
  assert.ok(port > 0, `puerto inesperado en salida:\n${srv.output()}`);
  const baseHttp = `http://127.0.0.1:${port}`;
  const baseWs = `ws://127.0.0.1:${port}`;

  // 1. HTML + cabeceras de seguridad (CSP, nosniff, sin X-Powered-By)
  const indexRes = await fetch(`${baseHttp}/`);
  assert.equal(indexRes.status, 200);
  assert.match(indexRes.headers.get('content-type') || '', /text\/html/);
  const csp = indexRes.headers.get('content-security-policy') || '';
  assert.ok(csp.includes("default-src 'self'"));
  assert.ok(csp.includes("frame-ancestors 'none'"));
  assert.equal(indexRes.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(indexRes.headers.get('referrer-policy'), 'no-referrer');
  assert.match(indexRes.headers.get('permissions-policy') || '', /camera=\(\)/);
  assert.equal(indexRes.headers.get('x-powered-by'), null);
  const html = await indexRes.text();
  assert.ok(html.includes('<script type="module" src="app.js">'));

  // 2. Rutas limpias (.html), modulos JS y fuentes embebidas identicas a public/
  const speedRes = await fetch(`${baseHttp}/speed`);
  assert.equal(speedRes.status, 200);
  const appJs = Buffer.from(await (await fetch(`${baseHttp}/app.js`)).arrayBuffer());
  assert.deepEqual(appJs, fs.readFileSync(path.join(ROOT, 'public', 'app.js')));
  const fontRes = await fetch(`${baseHttp}/fonts/jetbrains-mono-400-latin.woff2`);
  assert.equal(fontRes.status, 200);
  assert.equal(fontRes.headers.get('content-type'), 'font/woff2');

  // 3. /config, /version y /healthz con Cache-Control: no-store
  const cfgRes = await fetch(`${baseHttp}/config`);
  assert.equal(cfgRes.status, 200);
  assert.equal(cfgRes.headers.get('cache-control'), 'no-store');
  const cfg = await cfgRes.json();
  assert.ok(Array.isArray(cfg.iceServers));
  assert.ok(cfg.ttl > 0);

  const verRes = await fetch(`${baseHttp}/version`);
  assert.equal(verRes.status, 200);
  assert.equal(verRes.headers.get('cache-control'), 'no-store');
  const ver = await verRes.json();
  assert.equal(ver.version, pkg.version);
  assert.equal(ver.commit, null);

  // 4. WebSocket: rechaza origen cruzado y permite mismo origen o sin Origin
  await assert.rejects(
    () => new Promise((resolve, reject) => {
      const ws = new WebSocket(baseWs, { headers: { Origin: 'https://attacker.invalid' } });
      ws.on('open', () => { ws.close(); resolve(); });
      ws.on('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
      ws.on('error', reject);
    }),
    /HTTP 403/,
  );

  const hostWs = await openSocket(baseWs, { headers: { Origin: `http://localhost:${port}` } });
  const guestWs = await openSocket(baseWs);
  t.after(() => { hostWs.close(); guestWs.close(); });

  hostWs.say({ t: 'host', v: 2 });
  const hosted = await hostWs.until((msg) => msg.t === 'hosted');
  assert.match(hosted.token, /^\d{4}$/);

  guestWs.say({ t: 'join', token: hosted.token });
  const joined = await guestWs.until((msg) => msg.t === 'joined');
  const guestNotice = await hostWs.until((msg) => msg.t === 'guest');
  assert.equal(joined.guestId, guestNotice.guestId);

  hostWs.say({ t: 'signal', to: joined.guestId, data: { ok: 1 } });
  const sig = await guestWs.until((msg) => msg.t === 'signal');
  assert.equal(sig.from, 0);
  assert.equal(sig.data.ok, 1);

  hostWs.close();
  guestWs.close();

  // 5. Transferencia CLI -> CLI via `--server http://localhost:<port> --relay`
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'drop-serve-e2e-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const payload = crypto.randomBytes(64 * 1024);
  const srcFile = path.join(work, 'payload.bin');
  const outDir = path.join(work, 'out');
  fs.writeFileSync(srcFile, payload);
  fs.mkdirSync(outDir, { recursive: true });

  const sender = spawnCli(
    ['send', srcFile, '--server', baseHttp, '--relay', '--yes', '--no-qr', '--once'],
    { DROP_NO_LAN: '1' },
  );
  t.after(() => sender.kill());
  const codeMatch = await sender.waitFor(/Código:\s+(\d{4}-[a-z]+-[a-z]+-[a-z]+-[a-z]+)/);

  const recver = spawnCli(
    ['recv', codeMatch[1], '--server', baseHttp, '--relay', '--yes', '-o', outDir],
    { DROP_NO_LAN: '1' },
  );
  t.after(() => recver.kill());

  assert.equal(await recver.exited, 0, recver.output());
  assert.equal(await sender.exited, 0, sender.output());
  assert.deepEqual(fs.readFileSync(path.join(outDir, 'payload.bin')), payload);

  const hz = await (await fetch(`${baseHttp}/healthz`)).json();
  assert.equal(hz.ok, true);
  assert.ok(hz.roomsOpened >= 2);
  assert.ok(hz.relay.bytes >= payload.length);
  assert.ok(hz.relay.frames >= 1);
});

test('`drop serve` informa de puerto ocupado y host inválido sin volcar trazas', async (t) => {
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => blocker.close(resolve)));
  const busyPort = blocker.address().port;

  const conflict = spawnCli(['serve', '-H', '127.0.0.1', '-p', String(busyPort)]);
  t.after(() => conflict.kill());
  assert.equal(await conflict.exited, 1, conflict.output());
  assert.match(conflict.output(), /ya está en uso/);

  const badHost = spawnCli(['serve', '--host', 'host-no-valido']);
  t.after(() => badHost.kill());
  assert.equal(await badHost.exited, 1, badHost.output());
  assert.match(badHost.output(), /no válida/);
});

test('`drop serve -h` funciona independientemente de Node', () => {
  const [cmd, args] = cliSpawnTarget(['serve', '--help']);
  const out = execFileSync(cmd, args, { encoding: 'utf8' });
  assert.match(out, /drop serve/);
  assert.match(out, /--host/);
});

test('`drop serve` no descarta tramas JSON de control bajo contrapresion binaria', { timeout: 30_000 }, async (t) => {
  const srv = spawnCli(['serve', '-p', '0']);
  t.after(() => srv.kill());

  const m = await srv.waitFor(/http:\/\/localhost:(\d+)/);
  const baseWs = `ws://127.0.0.1:${m[1]}`;

  const hostWs = await openSocket(baseWs);
  const guestWs = await openSocket(baseWs);
  t.after(() => { hostWs.close(); guestWs.close(); });

  hostWs.say({ t: 'host', v: 2 });
  const hosted = await hostWs.until((msg) => msg.t === 'hosted');
  guestWs.say({ t: 'join', token: hosted.token, name: 'cli' });
  const joined = await guestWs.until((msg) => msg.t === 'joined');
  await hostWs.until((msg) => msg.t === 'guest');

  // Congelar lectura del receptor para llenar la cola OUTBOUND_QUEUE_CAP (512).
  let receivedBinary = 0;
  const events = [];
  guestWs.on('message', (raw, isBinary) => {
    if (isBinary) {
      receivedBinary++;
      events.push(`bin:${receivedBinary}`);
    } else {
      const msg = JSON.parse(raw);
      if (msg.t === 'signal') events.push(`sig:${msg.data?.type}`);
      else events.push(`ctrl:${msg.t}`);
    }
  });
  guestWs._socket.pause();

  const TOTAL_FRAMES = 650;
  const hdr = Buffer.allocUnsafe(4);
  hdr.writeUInt32BE(joined.guestId, 0);
  const chunk = Buffer.concat([hdr, Buffer.alloc(16 * 1024, 0xaa)]);

  // Enviar >512 frames binarios y justo detras `cli-end` + `cli-done` mientras el receptor sigue pausado.
  const sendAll = async () => {
    for (let i = 0; i < TOTAL_FRAMES; i++) {
      hostWs.send(chunk, { binary: true });
    }
    hostWs.say({ t: 'signal', to: joined.guestId, data: { type: 'cli-end', index: 0 } });
    hostWs.say({ t: 'signal', to: joined.guestId, data: { type: 'cli-done' } });
  };
  const sendPromise = sendAll();
  await sleep(300);

  // Reanudar lectura en el receptor y luego cerrar el emisor para comprobar tambien `host-gone`.
  guestWs._socket.resume();
  await sendPromise;

  const deadline = Date.now() + 15_000;
  while (
    (!events.includes('sig:cli-done') || receivedBinary < TOTAL_FRAMES)
    && Date.now() < deadline
  ) {
    await sleep(50);
  }
  assert.equal(receivedBinary, TOTAL_FRAMES, `faltaron frames binarios: ${receivedBinary}/${TOTAL_FRAMES}`);
  const endIdx = events.indexOf('sig:cli-end');
  const doneIdx = events.indexOf('sig:cli-done');
  const lastBinIdx = events.lastIndexOf(`bin:${TOTAL_FRAMES}`);
  assert.ok(endIdx > lastBinIdx, `cli-end debe llegar tras todos los chunks (${endIdx} vs ${lastBinIdx})`);
  assert.ok(doneIdx > endIdx, 'cli-done debe llegar tras cli-end');

  hostWs.close();
  const hostGone = await guestWs.until((msg) => msg.t === 'host-gone');
  assert.equal(hostGone.t, 'host-gone');
});
