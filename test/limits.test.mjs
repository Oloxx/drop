// Cuotas del servidor de señalización y credenciales efímeras del TURN.
//
// Arranca su propio servidor en un puerto efímero, y con límites ridículos
// (tres salas por IP, dos receptores, salas que caducan en segundo y medio) para
// no tener que esperar treinta minutos a que salte nada.
//
// Un servidor por caso a propósito: los contadores por IP son del proceso, y el
// test de fuerza bruta de signaling.test.mjs deja el cupo de 127.0.0.1 agotado.
// Compartiendo servidor, estos casos serían interdependientes.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { startServer, open, sleep } from './helpers.mjs';

const TURN_SECRET = 'secreto-de-prueba';
const TURN_URL = 'turn:turn.example:3478';

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

// ------------------------------------------------------- caudal del relay

/** Sala con un receptor dentro; devuelve los dos sockets y la cabecera del relay. */
async function roomWithGuest(srv) {
  const host = await open(srv.ws);
  host.say({ t: 'host', v: 2 });
  const { token } = await host.next();
  const guest = await open(srv.ws);
  guest.say({ t: 'join', token });
  await guest.next();
  const { guestId } = await host.next();
  const header = Buffer.alloc(4);
  header.writeUInt32BE(guestId, 0);
  return { host, guest, header };
}

/** Bytes binarios que llegan a `ws`, contados fuera de la cola de JSON de `open`. */
function countBinary(ws) {
  const got = { bytes: 0, frames: 0 };
  ws.on('message', (raw, isBinary) => { if (isBinary) { got.bytes += raw.length; got.frames++; } });
  return got;
}

// Sin esto, `--relay` convierte el servidor en una tuberia ilimitada que paga el
// VPS (#56). El limite frena, no corta: todos los bytes tienen que llegar.
test('DROP_RELAY_LIMIT frena los frames binarios sin perder ninguno', { timeout: 30_000 }, async () => {
  // 1 MB/s con 3 MB en el aire: sin limite esto tarda milisegundos en loopback;
  // con limite, no puede bajar de ~2 s (el primer segundo va de rafaga).
  const srv = await startServer({ DROP_RELAY_LIMIT: '1M' });
  try {
    const { host, guest, header } = await roomWithGuest(srv);
    const got = countBinary(guest);
    const CHUNK = 64 * 1024;
    const FRAMES = 48;                       // 3 MB

    const t0 = performance.now();
    for (let i = 0; i < FRAMES; i++) host.send(Buffer.concat([header, Buffer.alloc(CHUNK, i)]));
    while (got.frames < FRAMES) {
      if (performance.now() - t0 > 20_000) throw new Error(`solo llegaron ${got.frames} de ${FRAMES} frames`);
      await sleep(50);
    }
    const seconds = (performance.now() - t0) / 1000;

    assert.equal(got.bytes, FRAMES * CHUNK, 'el limite tiene que frenar, no descartar');
    assert.ok(seconds >= 1.8, `3 MB a 1 MB/s no pueden tardar ${seconds.toFixed(2)} s`);

    // Y /healthz cuenta lo que ha pasado, que es la unica forma de saber si el
    // limite esta bien puesto.
    const health = await (await fetch(`${srv.http}/healthz`)).json();
    assert.equal(health.relay.limit, 1024 * 1024);
    assert.ok(health.relay.bytes >= FRAMES * CHUNK, `bytes relayed: ${health.relay.bytes}`);
    assert.ok(health.relay.throttled >= 1, 'deberia haber pausado al menos una vez');

    host.close(); guest.close();
  } finally {
    srv.stop();
  }
});

test('sin DROP_RELAY_LIMIT el relay no se frena', { timeout: 30_000 }, async () => {
  const srv = await startServer();
  try {
    const { host, guest, header } = await roomWithGuest(srv);
    const got = countBinary(guest);
    const CHUNK = 64 * 1024;
    const FRAMES = 48;

    const t0 = performance.now();
    for (let i = 0; i < FRAMES; i++) host.send(Buffer.concat([header, Buffer.alloc(CHUNK, i)]));
    while (got.frames < FRAMES) {
      if (performance.now() - t0 > 20_000) throw new Error(`solo llegaron ${got.frames} de ${FRAMES} frames`);
      await sleep(10);
    }
    const seconds = (performance.now() - t0) / 1000;
    assert.ok(seconds < 1.5, `sin limite, 3 MB en loopback no deberian tardar ${seconds.toFixed(2)} s`);

    const health = await (await fetch(`${srv.http}/healthz`)).json();
    assert.equal(health.relay.limit, 0);
    assert.equal(health.relay.throttled, 0);
    assert.equal(health.rooms, 1);
    assert.equal(health.guests, 1);

    host.close(); guest.close();
  } finally {
    srv.stop();
  }
});

// Un valor que no se entiende no puede convertirse en "cero bytes por segundo":
// eso seria un relay parado por una errata en el .env.
test('un DROP_RELAY_LIMIT ilegible desactiva el limite en vez de parar el relay', async () => {
  const srv = await startServer({ DROP_RELAY_LIMIT: 'mucho' });
  try {
    const health = await (await fetch(`${srv.http}/healthz`)).json();
    assert.equal(health.relay.limit, 0);
    assert.match(srv.output(), /sin limite por sala/);
  } finally {
    srv.stop();
  }
});

// /healthz cuenta los rechazos por motivo: es lo que dice si una cuota esta
// saltando de verdad o si esta puesta tan alta que no sirve de nada.
test('/healthz cuenta las conexiones rechazadas por motivo', async () => {
  const srv = await startServer();
  try {
    const guest = await open(srv.ws);
    guest.say({ t: 'join', token: '0000' });
    assert.equal((await guest.next()).reason, 'NOT_FOUND');
    guest.close();

    const old = await open(srv.ws);
    old.say({ t: 'host' });
    assert.equal((await old.next()).reason, 'VERSION');

    const health = await (await fetch(`${srv.http}/healthz`)).json();
    assert.equal(health.rejected.NOT_FOUND, 1);
    assert.equal(health.rejected.VERSION, 1);
    assert.equal(health.roomsOpened, 0);
  } finally {
    srv.stop();
  }
});

// Sin DROP_TRUST_PROXY, la cabecera X-Forwarded-For de un cliente directo se
// ignora para que no pueda rotar IPs y saltarse las cuotas por IP (#59).
test('un cliente directo no puede evadir TOO_MANY_ROOMS ni RATE_LIMITED con X-Forwarded-For', async () => {
  const srv = await startServer({ DROP_ROOM_RATE_MAX: '2' });
  const sockets = [];
  try {
    for (let i = 0; i < 2; i++) {
      const host = await open(srv.ws, { headers: { 'X-Forwarded-For': `203.0.113.${10 + i}` } });
      sockets.push(host);
      host.say({ t: 'host', v: 2 });
      const hosted = await host.next();
      assert.equal(hosted.t, 'hosted');
      assert.notEqual(hosted.publicIp, `203.0.113.${10 + i}`);
    }

    const extra = await open(srv.ws, { headers: { 'X-Forwarded-For': '203.0.113.99' } });
    sockets.push(extra);
    extra.say({ t: 'host', v: 2 });
    assert.equal((await extra.next()).reason, 'TOO_MANY_ROOMS');

    for (let i = 0; i < 20; i++) {
      const g = await open(srv.ws, { headers: { 'X-Forwarded-For': `198.51.100.${i + 1}` } });
      sockets.push(g);
      g.say({ t: 'join', token: '0000' });
      assert.equal((await g.next()).reason, 'NOT_FOUND');
    }

    const blocked = await open(srv.ws, { headers: { 'X-Forwarded-For': '198.51.100.250' } });
    sockets.push(blocked);
    blocked.say({ t: 'join', token: '0000' });
    assert.equal((await blocked.next()).reason, 'RATE_LIMITED');
  } finally {
    for (const s of sockets) s.close();
    srv.stop();
  }
});

// Con DROP_TRUST_PROXY configurado, solo se leen proxies autorizados y la
// cadena se recorre desde la derecha para tomar el ultimo salto no confiable.
test('DROP_TRUST_PROXY lee el salto real en X-Forwarded-For e ignora prefijos falsos', async () => {
  const srv = await startServer({ DROP_TRUST_PROXY: 'loopback,10.20.0.0/16', DROP_ROOM_RATE_MAX: '1' });
  const sockets = [];
  try {
    const h1 = await open(srv.ws, {
      headers: { 'X-Forwarded-For': '9.9.9.9, 198.51.100.42, 10.20.1.5' },
    });
    sockets.push(h1);
    h1.say({ t: 'host', v: 2 });
    const hosted1 = await h1.next();
    assert.equal(hosted1.t, 'hosted');
    assert.equal(hosted1.publicIp, '198.51.100.42');

    // Aunque el cliente ponga otra IP a la izquierda, el salto real antes del
    // proxy confiable sigue siendo 198.51.100.42 y cae en TOO_MANY_ROOMS.
    const h2 = await open(srv.ws, {
      headers: { 'X-Forwarded-For': '8.8.8.8, 198.51.100.42, 10.20.9.9' },
    });
    sockets.push(h2);
    h2.say({ t: 'host', v: 2 });
    assert.equal((await h2.next()).reason, 'TOO_MANY_ROOMS');

    // Otra IP real distinta detras del mismo proxy si tiene su propio cupo.
    const h3 = await open(srv.ws, { headers: { 'X-Forwarded-For': '198.51.100.43' } });
    sockets.push(h3);
    h3.say({ t: 'host', v: 2 });
    const hosted3 = await h3.next();
    assert.equal(hosted3.t, 'hosted');
    assert.equal(hosted3.publicIp, '198.51.100.43');

    // Cabeceras malformadas no rompen ni contaminan publicIp.
    const h4 = await open(srv.ws, { headers: { 'X-Forwarded-For': 'no-es-una-ip' } });
    sockets.push(h4);
    h4.say({ t: 'host', v: 2 });
    const hosted4 = await h4.next();
    assert.equal(hosted4.t, 'hosted');
    assert.match(hosted4.publicIp, /^(?:127\.0\.0\.1|::1)$/);
  } finally {
    for (const s of sockets) s.close();
    srv.stop();
  }
});

test('relay WS en server/index.js frena con backpressure y aplica techo defensivo ante receptor bloqueado', { timeout: 30_000 }, async () => {
  // 1. Backpressure suave: receptor pausado -> servidor frena lectura del emisor -> al reanudar llegan todos los frames.
  {
    const srv = await startServer({
      DROP_RELAY_BUFFER_HIGH: '64K',
      DROP_RELAY_BUFFER_MAX: '8M',
    });
    const sockets = [];
    try {
      const host = await open(srv.ws);
      const guest = await open(srv.ws);
      sockets.push(host, guest);

      host.say({ t: 'host', v: 2 });
      const { token } = await host.next();
      guest.say({ t: 'join', token, name: 'cli' });
      const { guestId } = await guest.next();
      await host.next();

      let rxBytes = 0;
      guest.on('message', (raw, isBinary) => {
        if (isBinary) rxBytes += raw.length;
      });
      guest._socket.pause();

      const hdr = Buffer.allocUnsafe(4);
      hdr.writeUInt32BE(guestId, 0);
      const payload = Buffer.alloc(32 * 1024, 0x55);
      const frame = Buffer.concat([hdr, payload]);
      const COUNT = 128; // 4 MiB >> DROP_RELAY_BUFFER_HIGH (64 KiB)
      for (let i = 0; i < COUNT; i++) host.send(frame, { binary: true });

      const pauseDeadline = Date.now() + 5_000;
      let hzWhilePaused = null;
      while (Date.now() < pauseDeadline) {
        hzWhilePaused = await (await fetch(`${srv.http}/healthz`)).json();
        if (hzWhilePaused.relay.throttled > 0) break;
        await sleep(50);
      }
      assert.ok(hzWhilePaused.relay.throttled > 0, `se esperaba throttled > 0: ${JSON.stringify(hzWhilePaused)}`);
      assert.ok(hzWhilePaused.relay.bytes < COUNT * frame.length, 'el servidor no debe acumular los 4 MiB en RAM');

      guest._socket.resume();
      const deadline = Date.now() + 10_000;
      while (rxBytes < COUNT * payload.length && Date.now() < deadline) {
        await sleep(50);
      }
      assert.equal(rxBytes, COUNT * payload.length);
    } finally {
      for (const s of sockets) s.close();
      srv.stop();
    }
  }

  // 2. Techo duro: multiples emisores contra un receptor bloqueado superan DROP_RELAY_BUFFER_MAX -> corte defensivo.
  {
    const srv = await startServer({
      DROP_RELAY_BUFFER_HIGH: '64K',
      DROP_RELAY_BUFFER_MAX: '128K',
    });
    const sockets = [];
    try {
      const host = await open(srv.ws);
      sockets.push(host);
      host.say({ t: 'host', v: 2 });
      const { token } = await host.next();

      const guests = [];
      for (let g = 0; g < 4; g++) {
        const guest = await open(srv.ws);
        sockets.push(guest);
        guest.say({ t: 'join', token, name: 'cli' });
        await guest.next();
        await host.next();
        guests.push(guest);
      }

      let hostClosed = false;
      host.on('close', () => { hostClosed = true; });
      host._socket.pause();

      const payload = Buffer.alloc(64 * 1024, 0x77);
      for (let round = 0; round < 32 && !hostClosed; round++) {
        for (const guest of guests) {
          if (guest.readyState === guest.OPEN) guest.send(payload, { binary: true });
        }
        await sleep(10);
      }

      const deadline = Date.now() + 5_000;
      let hz = null;
      while (Date.now() < deadline) {
        hz = await (await fetch(`${srv.http}/healthz`)).json();
        if ((hz.rejected.RELAY_BACKPRESSURE || 0) > 0) break;
        await sleep(50);
      }
      // Al reanudar lectura del socket cliente, este procesa el cierre TCP del servidor.
      host._socket.resume();
      while (!hostClosed && Date.now() < deadline) await sleep(50);
      assert.ok(hostClosed && (hz.rejected.RELAY_BACKPRESSURE || 0) > 0, `esperado corte por RELAY_BACKPRESSURE, healthz=${JSON.stringify(hz)}`);
    } finally {
      for (const s of sockets) s.close();
      srv.stop();
    }
  }
});
