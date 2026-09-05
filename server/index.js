import http from 'node:http';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { randomRoomId, ROOM_ID_DIGITS } from '../public/shared/codes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// El servidor SOLO reparte identificadores publicos de sala (4 digitos). La parte
// secreta del codigo -- las palabras -- la genera el cliente y no llega hasta aqui
// nunca, ni en claro ni hasheada. Ver public/shared/codes.js para el diseno entero.
//
// Que el identificador sea corto y publico tiene una consecuencia que hay que
// asumir: son 10.000 valores y se pueden probar todos. Por eso este fichero
// limita los `join` fallidos por IP y quema las salas cuyo emisor denuncia
// receptores que no saben el secreto.

/** @type {Map<string, {host: import('ws').WebSocket, guests: Map<number, import('ws').WebSocket>, createdAt: number, badGuests: number}>} */
const rooms = new Map();
let nextGuestId = 1;

// Token base64url de 96 bits: el formato de la v0.3.5. Se sigue sirviendo a
// quien no pide `v:2` por dos motivos distintos:
//   · @deprecated los binarios ya distribuidos no saben pedirlo, y para ellos el
//     token ES el material de clave: darles 4 digitos les romperia el cifrado.
//     Este motivo desaparece en la v0.5.0.
//   · la pagina /speed no necesita un codigo dictable (se comparte por enlace),
//     asi que le viene mejor un identificador largo e inadivinable.
const LEGACY_TOKEN_BYTES = 12;

function newRoomId(legacy) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const id = legacy
      ? randomBytes(LEGACY_TOKEN_BYTES).toString('base64url')
      : randomRoomId(randomBytes);
    if (!rooms.has(id)) return id;
  }
  // Solo pasa con ~10.000 salas simultaneas y codigo nuevo: mejor negarse a abrir
  // otra que devolver un identificador ya en uso y cruzar dos transferencias.
  return null;
}

// El identificador de sala nuevo ya es publico, pero el token viejo era la llave
// entera: en los logs va solo un prefijo, que basta para seguir una sesion.
const tag = (token) => (token.length <= ROOM_ID_DIGITS ? token : token.slice(0, 4) + '...');
const log = (...args) => console.log(new Date().toISOString(), ...args);

// -------------------------------------------------- limite de fuerza bruta

// Un barrido de los 10.000 identificadores a ritmo de red seria cuestion de
// segundos. Con esto, una IP agota su cupo en 20 intentos fallidos y se queda
// fuera un minuto: barrer la sala entera pasa a ser ~8 horas por IP, y las salas
// viven minutos. No para a una botnet, y esta asumido en el modelo de amenaza.
const JOIN_FAIL_MAX = 20;
const JOIN_FAIL_WINDOW = 60_000;

// Si el emisor denuncia tantos receptores que no saben el secreto, la sala se
// cierra: alguien esta probando codigos contra ella y el identificador ya no vale.
const BAD_GUEST_MAX = 5;

/** @type {Map<string, {count: number, since: number}>} */
const joinFails = new Map();

function tooManyFailures(ip) {
  if (!ip) return false;
  const now = Date.now();
  const entry = joinFails.get(ip);
  if (!entry || now - entry.since > JOIN_FAIL_WINDOW) return false;
  return entry.count >= JOIN_FAIL_MAX;
}

function noteFailure(ip) {
  if (!ip) return;
  const now = Date.now();
  const entry = joinFails.get(ip);
  if (!entry || now - entry.since > JOIN_FAIL_WINDOW) joinFails.set(ip, { count: 1, since: now });
  else entry.count++;
}

// El mapa de fallidos crece con cada IP que se equivoca: se poda con la misma
// ventana que usa el limite, o acabaria siendo una fuga de memoria lenta.
const sweepFails = setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of joinFails) {
    if (now - entry.since > JOIN_FAIL_WINDOW) joinFails.delete(ip);
  }
}, JOIN_FAIL_WINDOW);
sweepFails.unref?.();

function closeRoom(token, reason) {
  const room = rooms.get(token);
  if (!room) return;
  for (const guest of room.guests.values()) send(guest, { t: 'host-gone' });
  send(room.host, { t: 'error', reason });
  rooms.delete(token);
}

const app = express();
app.disable('x-powered-by');

// La configuracion ICE se sirve desde el servidor para poder anadir TURN sin tocar el cliente.
app.get('/config', (_req, res) => {
  const iceServers = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] },
  ];
  if (process.env.TURN_URL) {
    iceServers.push({
      urls: process.env.TURN_URL,
      username: process.env.TURN_USER,
      credential: process.env.TURN_PASS,
    });
  }
  res.json({ iceServers });
});

app.get('/healthz', (_req, res) => res.json({ ok: true, rooms: rooms.size }));

app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function send(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.role = null;     // 'host' | 'guest'
  ws.token = null;
  ws.guestId = null;
  ws.clientIp = (
    req?.headers?.['x-forwarded-for']?.split(',')[0] ||
    req?.socket?.remoteAddress ||
    ''
  ).replace(/^::ffff:/, '').trim();

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw, isBinary) => {
    ws.isAlive = true;
    if (isBinary) {
      const room = rooms.get(ws.token);
      if (!room) return;
      if (ws.role === 'host') {
        if (raw.length < 4) return;
        const toGuestId = raw.readUInt32BE(0);
        const payload = raw.subarray(4);
        const guest = room.guests.get(toGuestId);
        if (guest && guest.readyState === 1) guest.send(payload, { binary: true });
      } else if (ws.role === 'guest') {
        if (room.host && room.host.readyState === 1) room.host.send(raw, { binary: true });
      }
      return;
    }

    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.t) {
      case 'host': {
        if (ws.role) return;
        // `v:2` es el cliente diciendo "se de codigos memorizables, dame solo el
        // identificador publico". Quien no lo manda es un binario v0.3.5 y se le
        // sigue dando el token largo de siempre. @deprecated
        const legacy = msg.v !== 2;
        const token = newRoomId(legacy);
        if (!token) {
          send(ws, { t: 'error', reason: 'NO_ROOMS' });
          log('sin identificadores de sala libres | salas activas:', rooms.size);
          return;
        }
        rooms.set(token, { host: ws, guests: new Map(), createdAt: Date.now(), badGuests: 0 });
        ws.role = 'host';
        ws.token = token;
        send(ws, { t: 'hosted', token, room: token, v: legacy ? 1 : 2, publicIp: ws.clientIp });
        log('sala abierta', tag(token), legacy ? '(codigo v1)' : '', '| salas activas:', rooms.size);
        break;
      }

      case 'join': {
        if (ws.role) return;
        // Solo llega hasta aqui el identificador publico de sala: las palabras del
        // codigo se quedan en el cliente. Si algun dia llegasen, este `slice` y el
        // filtro las dejarian igualmente en los logs, asi que no deben llegar.
        const token = String(msg.token || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
        const room = rooms.get(token);
        // El limite se mira solo cuando la sala NO existe: lo que hay que frenar
        // es adivinar identificadores, no entrar en salas que si estan. Un acierto
        // ademas pone el contador a cero, para que a quien se equivoca al teclear
        // una vez no le quede castigo pegado durante un minuto.
        if (!room) {
          if (tooManyFailures(ws.clientIp)) {
            send(ws, { t: 'error', reason: 'RATE_LIMITED' });
            log('demasiados intentos fallidos desde', ws.clientIp || '(ip desconocida)');
            ws.close();
            return;
          }
          noteFailure(ws.clientIp);
          send(ws, { t: 'error', reason: 'NOT_FOUND' });
          log('enlace caducado o invalido', token ? tag(token) : '(vacio)');
          return;
        }
        joinFails.delete(ws.clientIp);
        const guestId = nextGuestId++;
        room.guests.set(guestId, ws);
        ws.role = 'guest';
        ws.token = token;
        ws.guestId = guestId;
        send(ws, { t: 'joined', guestId, publicIp: ws.clientIp });
        send(room.host, { t: 'guest', guestId, name: String(msg.name || '').slice(0, 40) });
        log('receptor', guestId, 'entra en', tag(token), '| receptores en la sala:', room.guests.size);
        break;
      }

      // El emisor ha pedido al receptor una prueba de conocimiento del secreto y
      // no la ha pasado. El servidor no sabe (ni puede saber) el secreto, asi que
      // se limita a contar: alguien que acierta el identificador de sala pero
      // falla el secreto esta probando codigos, y a los pocos intentos la sala
      // deja de existir para que no le sirva de nada seguir.
      case 'bad-guest': {
        if (ws.role !== 'host') return;
        const room = rooms.get(ws.token);
        if (!room) return;
        const guest = room.guests.get(msg.guestId);
        if (guest) {
          send(guest, { t: 'error', reason: 'BAD_SECRET' });
          guest.close();
        }
        if (++room.badGuests >= BAD_GUEST_MAX) {
          log('sala quemada por intentos fallidos de secreto', tag(ws.token));
          closeRoom(ws.token, 'BURNED');
        }
        break;
      }

      // Reenvio ciego de SDP/ICE. El servidor no mira dentro de `data`.
      case 'signal': {
        const room = rooms.get(ws.token);
        if (!room) return;
        if (ws.role === 'host') {
          send(room.guests.get(msg.to), { t: 'signal', from: 0, data: msg.data });
        } else if (msg.to) {
          // Receptor -> receptor: los eslabones de la cadena de reenvio. Sigue
          // siendo relay ciego; lo unico que comprobamos es que el destino este
          // en la misma sala, para que un token no de acceso a otra.
          send(room.guests.get(msg.to), { t: 'signal', from: ws.guestId, data: msg.data });
        } else {
          send(room.host, { t: 'signal', from: ws.guestId, data: msg.data });
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    const room = rooms.get(ws.token);
    if (!room) return;
    if (ws.role === 'host') {
      for (const guest of room.guests.values()) send(guest, { t: 'host-gone' });
      rooms.delete(ws.token);
      const vida = Math.round((Date.now() - room.createdAt) / 1000);
      log('sala cerrada', tag(ws.token), '| vivio', vida + 's con', room.guests.size,
          'receptores | salas activas:', rooms.size);
    } else {
      room.guests.delete(ws.guestId);
      send(room.host, { t: 'guest-gone', guestId: ws.guestId });
      log('receptor', ws.guestId, 'sale de', tag(ws.token), '| quedan:', room.guests.size);
    }
  });
});

// Los proxies/load balancers cortan websockets inactivos: ping cada 30s.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000);
wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => {
  log(`Drop escuchando en http://localhost:${PORT}`);
});
