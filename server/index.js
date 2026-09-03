import http from 'node:http';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// Nadie teclea el token: va en el enlace. Asi que lo hacemos largo y aleatorio de
// verdad (96 bits) en vez de corto y dictable: es lo unico que protege la sala.
const TOKEN_BYTES = 12;

/** @type {Map<string, {host: import('ws').WebSocket, guests: Map<number, import('ws').WebSocket>, createdAt: number}>} */
const rooms = new Map();
let nextGuestId = 1;

function newToken() {
  for (let attempt = 0; attempt < 50; attempt++) {
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    if (!rooms.has(token)) return token;
  }
  throw new Error('no free tokens');
}

// El token es un secreto (quien lo tiene entra en la sala): en los logs solo va un
// prefijo, suficiente para seguir una sesion sin dejar la llave escrita en disco.
const tag = (token) => token.slice(0, 4) + '...';
const log = (...args) => console.log(new Date().toISOString(), ...args);

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

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.role = null;     // 'host' | 'guest'
  ws.token = null;
  ws.guestId = null;

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.t) {
      case 'host': {
        if (ws.role) return;
        const token = newToken();
        rooms.set(token, { host: ws, guests: new Map(), createdAt: Date.now() });
        ws.role = 'host';
        ws.token = token;
        send(ws, { t: 'hosted', token });
        log('sala abierta', tag(token), '| salas activas:', rooms.size);
        break;
      }

      case 'join': {
        if (ws.role) return;
        const token = String(msg.token || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
        const room = rooms.get(token);
        if (!room) {
          send(ws, { t: 'error', reason: 'NOT_FOUND' });
          log('enlace caducado o invalido', token ? tag(token) : '(vacio)');
          return;
        }
        const guestId = nextGuestId++;
        room.guests.set(guestId, ws);
        ws.role = 'guest';
        ws.token = token;
        ws.guestId = guestId;
        send(ws, { t: 'joined', guestId });
        send(room.host, { t: 'guest', guestId, name: String(msg.name || '').slice(0, 40) });
        log('receptor', guestId, 'entra en', tag(token), '| receptores en la sala:', room.guests.size);
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
