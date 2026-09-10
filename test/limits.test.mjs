// Cuotas del servidor de señalización y credenciales efímeras del TURN.
//
// Arranca su propio servidor en un puerto efímero, y con límites ridículos
// (tres salas por IP, dos receptores, salas que caducan en segundo y medio) para
// no tener que esperar treinta minutos a que salte nada.
//
// Servidor propio a propósito: test/signaling.test.mjs comparte los contadores
// por IP entre sus casos y el último deja el cupo de 127.0.0.1 agotado. Meter
// aquí las cuotas los volvería interdependientes.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'server', 'index.js');

const TURN_SECRET = 'secreto-de-prueba';
const TURN_URL = 'turn:turn.example:3478';

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Servidor con los límites que pida cada test, ya escuchando. */
async function startServer(env = {}) {
  const port = await freePort();
  const proc = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('el servidor no arrancó')), 10_000);
    proc.stdout.on('data', (d) => {
      if (d.toString().includes('Drop escuchando')) { clearTimeout(timer); resolve(); }
    });
    proc.on('error', reject);
  });
  return {
    proc,
    http: `http://127.0.0.1:${port}`,
    ws: `ws://127.0.0.1:${port}`,
    stop: () => proc.kill(),
  };
}

/** Mismo ayudante que en signaling.test.mjs: cola de mensajes y `next()`. */
function open(url) {
  const ws = new WebSocket(url);
  ws.queue = [];
  ws.waiters = [];
  ws.on('message', (raw, isBinary) => {
    if (isBinary) return;   // los chunks del relay no son mensajes de control
    const msg = JSON.parse(raw);
    const waiter = ws.waiters.shift();
    if (waiter) waiter(msg);
    else ws.queue.push(msg);
  });
  ws.next = () => new Promise((resolve) => {
    if (ws.queue.length) resolve(ws.queue.shift());
    else ws.waiters.push(resolve);
  });
  ws.say = (obj) => ws.send(JSON.stringify(obj));
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ TURN

test('/config firma credenciales TURN que caducan', async () => {
  const srv = await startServer({ TURN_URL, TURN_SECRET, TURN_TTL_SECONDS: '600' });
  try {
    const res = await fetch(`${srv.http}/config`);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const cfg = await res.json();
    assert.equal(cfg.ttl, 600);

    const turn = cfg.iceServers.find((s) => s.urls === TURN_URL);
    assert.ok(turn, 'la entrada del TURN deberia estar');

    // El usuario lleva dentro su propia caducidad y la firma es un HMAC-SHA1 del
    // usuario entero: es lo que coturn valida con --static-auth-secret.
    const [expiry, label] = turn.username.split(':');
    assert.equal(label, 'drop');
    const seconds = Number(expiry) - Math.floor(Date.now() / 1000);
    assert.ok(seconds > 0 && seconds <= 600, `caducidad fuera de rango: ${seconds}s`);

    const expected = crypto.createHmac('sha1', TURN_SECRET).update(turn.username).digest('base64');
    assert.equal(turn.credential, expected);
  } finally {
    srv.stop();
  }
});

test('sin TURN_SECRET no se sirve TURN, solo STUN', async () => {
  const srv = await startServer({ TURN_URL, TURN_SECRET: '' });
  try {
    const cfg = await (await fetch(`${srv.http}/config`)).json();
    assert.equal(cfg.iceServers.length, 1);
    assert.ok(String(cfg.iceServers[0].urls).includes('stun:'));
    assert.equal(cfg.iceServers.some((s) => s.username), false);
  } finally {
    srv.stop();
  }
});

// ---------------------------------------------------------------- cuotas

test('una IP no puede abrir salas sin fin', async () => {
  const srv = await startServer({ DROP_ROOM_RATE_MAX: '3' });
  const sockets = [];
  try {
    for (let i = 0; i < 3; i++) {
      const host = await open(srv.ws);
      sockets.push(host);
      host.say({ t: 'host', v: 2 });
      assert.equal((await host.next()).t, 'hosted');
    }

    const extra = await open(srv.ws);
    sockets.push(extra);
    extra.say({ t: 'host', v: 2 });
    assert.equal((await extra.next()).reason, 'TOO_MANY_ROOMS');
  } finally {
    for (const s of sockets) s.close();
    srv.stop();
  }
});

test('una sala llena rechaza al receptor de mas', async () => {
  const srv = await startServer({ DROP_MAX_GUESTS: '2' });
  const sockets = [];
  try {
    const host = await open(srv.ws);
    sockets.push(host);
    host.say({ t: 'host', v: 2 });
    const { token } = await host.next();

    for (let i = 0; i < 2; i++) {
      const guest = await open(srv.ws);
      sockets.push(guest);
      guest.say({ t: 'join', token });
      assert.equal((await guest.next()).t, 'joined');
    }

    const late = await open(srv.ws);
    sockets.push(late);
    late.say({ t: 'join', token });
    assert.equal((await late.next()).reason, 'ROOM_FULL');
  } finally {
    for (const s of sockets) s.close();
    srv.stop();
  }
});

// El cubo de fichas es por socket y solo cuenta frames de control: 40 `join`
// seguidos (lo que hace el test de fuerza bruta) tienen que seguir cabiendo.
test('un socket que inunda de mensajes se corta', async () => {
  const srv = await startServer({ DROP_MSG_BURST: '5', DROP_MSG_RATE: '1' });
  try {
    const flooder = await open(srv.ws);
    for (let i = 0; i < 20; i++) flooder.say({ t: 'join', token: `no-existe-${i}` });

    let cut = false;
    for (let i = 0; i < 20 && !cut; i++) {
      const msg = await flooder.next();
      if (msg.reason === 'FLOOD') cut = true;
    }
    assert.ok(cut, 'el servidor deberia haber cortado la inundacion');
    flooder.close();
  } finally {
    srv.stop();
  }
});

// -------------------------------------------------------------------- TTL

test('una sala sin actividad caduca sola', async () => {
  const srv = await startServer({ DROP_ROOM_TTL_MS: '600', DROP_ROOM_SWEEP_MS: '100' });
  try {
    const host = await open(srv.ws);
    host.say({ t: 'host', v: 2 });
    const { token } = await host.next();

    const guest = await open(srv.ws);
    guest.say({ t: 'join', token });
    assert.equal((await guest.next()).t, 'joined');
    await host.next();   // el aviso de que ha entrado un receptor

    assert.equal((await host.next()).reason, 'EXPIRED');
    assert.equal((await guest.next()).t, 'host-gone');

    host.close();
    guest.close();
  } finally {
    srv.stop();
  }
});

test('el trafico del relay mantiene viva la sala', async () => {
  const srv = await startServer({ DROP_ROOM_TTL_MS: '800', DROP_ROOM_SWEEP_MS: '100' });
  try {
    const host = await open(srv.ws);
    host.say({ t: 'host', v: 2 });
    const { token } = await host.next();

    const guest = await open(srv.ws);
    guest.say({ t: 'join', token });
    await guest.next();
    const { guestId } = await host.next();

    // Solo bytes: una transferencia por relay del CLI no manda ni un frame de
    // control durante minutos, y aun asi la sala no puede caducar.
    const header = Buffer.alloc(4);
    header.writeUInt32BE(guestId, 0);
    for (let i = 0; i < 12; i++) {
      host.send(Buffer.concat([header, Buffer.alloc(1024, i)]));
      await sleep(100);
    }

    const seen = [];
    while (guest.queue.length) seen.push(guest.queue.shift());
    assert.equal(seen.some((m) => m.t === 'host-gone'), false, 'la sala no deberia haber caducado');
    assert.equal(host.queue.some((m) => m.reason === 'EXPIRED'), false);

    host.close();
    guest.close();
  } finally {
    srv.stop();
  }
});
