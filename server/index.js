import http from 'node:http';
import path from 'node:path';
import { createHmac, randomBytes } from 'node:crypto';
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

/** @type {Map<string, {host: import('ws').WebSocket, guests: Map<number, import('ws').WebSocket>, createdAt: number, lastActivity: number, badGuests: number, relay: {rate: number, tokens: number, at: number} | null}>} */
const rooms = new Map();
let nextGuestId = 1;

// Todo lo que sigue es ajustable por entorno porque los tests necesitan valores
// ridiculos (una sala que caduca en segundo y medio) y un despliegue casero puede
// necesitar lo contrario. `num()` deja el valor por defecto si la variable no esta
// o no es un numero, que es lo que hace falta cuando alguien escribe `MAX=si`.
const num = (name, fallback) => {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
};

// Dos formatos de identificador de sala:
//   · 4 digitos publicos (`randomRoomId`) para `drop send` y la web: el secreto
//     son las palabras, que nunca llegan aqui.
//   · 96 bits base64url para /speed, que se comparte por enlace y no tiene mas
//     secreto que el propio identificador: le hace falta que sea inadivinable.
// El token largo fue tambien el formato de la v0.3.5, donde ademas era la clave
// de cifrado. Ese camino se elimino en la v0.8.0: un cliente que no pide `v:2`
// recibe `VERSION` en vez de un token que ya no sabria usar.
const LINK_TOKEN_BYTES = 12;

function newRoomId(link) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const id = link
      ? randomBytes(LINK_TOKEN_BYTES).toString('base64url')
      : randomRoomId(randomBytes);
    if (!rooms.has(id)) return id;
  }
  // Solo pasa con ~10.000 salas simultaneas y codigo nuevo: mejor negarse a abrir
  // otra que devolver un identificador ya en uso y cruzar dos transferencias.
  return null;
}

// El identificador de 4 digitos ya es publico, pero el token largo de /speed es
// la llave entera: en los logs va solo un prefijo, que basta para seguir una sesion.
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

// ------------------------------------------------------------- cuotas y TTL
//
// Las salas viven en un Map en memoria de este proceso, asi que todo lo que las
// crea sin control es memoria que no vuelve. Lo que se limita aqui:
//
//   · cuantas salas abre una IP por minuto,
//   · cuantos receptores caben en una sala,
//   · cuantas salas hay en total,
//   · cuanto vive una sala sin que pase nada por ella,
//   · cuantos mensajes de control manda un socket por segundo.
//
// QUE FRENA Y QUE NO: frena que un cliente hostil tire el proceso por memoria o
// por CPU. No frena a una botnet repartida (cada IP tiene su propio cupo), igual
// que el limite de fuerza bruta de arriba. Los numeros estan puestos muy por
// encima del uso real: un emisor normal abre una sala, no treinta por minuto.
const ROOM_RATE_MAX = num('DROP_ROOM_RATE_MAX', 30);
const ROOM_RATE_WINDOW = num('DROP_ROOM_RATE_WINDOW_MS', 60_000);
const MAX_GUESTS = num('DROP_MAX_GUESTS', 25);
const MAX_ROOMS = num('DROP_MAX_ROOMS', 5000);
const ROOM_TTL = num('DROP_ROOM_TTL_MS', 30 * 60_000);
const ROOM_SWEEP = num('DROP_ROOM_SWEEP_MS', 60_000);

// Cubo de fichas por socket, solo para los frames JSON. Un emisor con 25
// receptores manda cientos de candidatos ICE en pocos segundos, de ahi que la
// rafaga sea holgada; lo que corta es el goteo sostenido de miles por segundo.
const MSG_BURST = num('DROP_MSG_BURST', 300);
const MSG_RATE = num('DROP_MSG_RATE', 100);

/** @type {Map<string, {count: number, since: number}>} */
const roomsPerIp = new Map();

function tooManyRooms(ip) {
  if (!ip) return false;
  const now = Date.now();
  const entry = roomsPerIp.get(ip);
  if (!entry || now - entry.since > ROOM_RATE_WINDOW) return false;
  return entry.count >= ROOM_RATE_MAX;
}

function noteRoom(ip) {
  if (!ip) return;
  const now = Date.now();
  const entry = roomsPerIp.get(ip);
  if (!entry || now - entry.since > ROOM_RATE_WINDOW) roomsPerIp.set(ip, { count: 1, since: now });
  else entry.count++;
}

const sweepRooms = setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of roomsPerIp) {
    if (now - entry.since > ROOM_RATE_WINDOW) roomsPerIp.delete(ip);
  }
}, ROOM_RATE_WINDOW);
sweepRooms.unref?.();

// El cubo se rellena solo con el tiempo transcurrido: no hace falta un timer por
// socket, basta con mirar el reloj cuando llega un mensaje.
function takeToken(ws) {
  const now = Date.now();
  if (ws.tokens === undefined) {
    ws.tokens = MSG_BURST;
    ws.tokensAt = now;
  }
  ws.tokens = Math.min(MSG_BURST, ws.tokens + ((now - ws.tokensAt) * MSG_RATE) / 1000);
  ws.tokensAt = now;
  if (ws.tokens < 1) return false;
  ws.tokens--;
  return true;
}

// ------------------------------------------------------- caudal del relay
//
// Los frames binarios no pasan por el cubo de arriba (una transferencia por relay
// son ~160 frames/s de 64 KiB, muy por encima de cualquier ritmo sano de control),
// asi que hasta aqui el unico tope era `maxPayload`. El TURN tiene credenciales
// efimeras; el relay propio, que es el que paga el ancho de banda del VPS, no
// tenia nada: con `--relay` cualquiera lo usaba como tuberia ilimitada entre dos
// CLI que se hablarian por TCP directo (#56).
//
// Dos cubos de bytes que admiten deficit, como `cli/src/throttle.js`: uno por
// sala (`DROP_RELAY_LIMIT`) y otro para el proceso entero (`DROP_RELAY_LIMIT_TOTAL`),
// para que 25 salas a tope no saturen la linea. Al excederse NO se corta nada:
// se deja de leer del socket (`ws.pause()`) el tiempo que tarde en haber fichas,
// la contrapresion llega al emisor por TCP y por sus acuses, y la transferencia
// termina integra, solo mas despacio. Sin definir, no cambia nada.
//
// `rate()` entiende `10M`, `500K`, `1.5G` (base 1024) y bytes a secas, igual que
// `--limit` en el CLI. `0`, vacio o basura desactivan el limite.
function rate(name) {
  const raw = String(process.env[name] || '').trim().toLowerCase();
  const m = raw.match(/^(\d+(?:\.\d+)?)\s*([kmg])?(?:b|ib|b\/s)?$/);
  if (!m) return 0;
  const factor = { k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[2]] || 1;
  const value = Math.round(Number(m[1]) * factor);
  return value > 0 ? value : 0;
}
const RELAY_LIMIT = rate('DROP_RELAY_LIMIT');
const RELAY_LIMIT_TOTAL = rate('DROP_RELAY_LIMIT_TOTAL');

function makeBucket(bytesPerSec) {
  return { rate: bytesPerSec, tokens: bytesPerSec, at: Date.now() };
}

/** Descuenta `bytes` y devuelve cuantos ms hay que esperar (0 si sobran fichas). */
function drain(bucket, bytes) {
  if (!bucket) return 0;
  const now = Date.now();
  bucket.tokens = Math.min(bucket.rate, bucket.tokens + ((now - bucket.at) / 1000) * bucket.rate);
  bucket.at = now;
  bucket.tokens -= bytes;
  return bucket.tokens < 0 ? Math.ceil((-bucket.tokens / bucket.rate) * 1000) : 0;
}

const relayTotal = RELAY_LIMIT_TOTAL ? makeBucket(RELAY_LIMIT_TOTAL) : null;

// Un socket pausado no dispara `message`, y `ws` deja de leer del TCP: el
// emisor ve la ventana llena y se frena solo. Se reanuda con un timer, nunca
// desde otro frame, porque no hay otro frame mientras esta pausado.
function throttleRelay(ws, room, bytes) {
  const wait = Math.max(drain(room.relay, bytes), drain(relayTotal, bytes));
  if (wait <= 0 || ws.paused) return;
  ws.paused = true;
  metrics.relay.throttled++;
  ws.pause();
  const timer = setTimeout(() => {
    ws.paused = false;
    if (ws.readyState === ws.OPEN) ws.resume();
  }, wait);
  timer.unref?.();
}

// ---------------------------------------------------------------- metricas
//
// Contadores del proceso, expuestos en /healthz. Sin ellos no hay forma de saber
// si `DROP_RELAY_LIMIT` esta bien puesto o si alguien se esta comiendo el cupo de
// salas: el log dice que paso, no cuanto. Se reinician con el proceso, a proposito:
// no hay estado en disco y no se quiere.
const metrics = {
  startedAt: Date.now(),
  roomsOpened: 0,
  relay: { bytes: 0, frames: 0, throttled: 0 },
  rejected: {},   // motivo -> veces (NOT_FOUND, RATE_LIMITED, ROOM_FULL, ...)
};
const reject = (reason) => { metrics.rejected[reason] = (metrics.rejected[reason] || 0) + 1; };

// ------------------------------------------------------- origenes permitidos
//
// El limite de arriba cuenta la IP de quien conecta, y contra un navegador eso es
// la IP del visitante, no la del atacante: una pagina cualquiera puede abrir salas
// o barrer identificadores usando el navegador de quien la visita, repartiendo el
// barrido entre miles de IPs distintas. La cabecera `Origin` la pone el navegador
// y una pagina no puede falsearla, asi que aqui se mira.
//
// QUE FRENA Y QUE NO: frena que un tercero use navegadores ajenos como ariete. No
// frena a un cliente que no sea un navegador -- curl, un script, el propio CLI --
// porque esos eligen que cabeceras mandan. Por eso una conexion SIN `Origin` se
// acepta: es la del CLI, y cerrarla no ganaria nada (bastaria con no mandarla).

// Un origen es esquema+host+puerto: se comparan en minusculas y sin barra final,
// que es como los mandan unos navegadores y otros.
const normOrigin = (o) => {
  let out = o.trim().toLowerCase();
  while (out.endsWith('/')) out = out.slice(0, -1);
  return out;
};

// El dominio del proyecto va en la lista por defecto para que un despliegue que
// no configure nada siga funcionando; `DROP_DOMAIN` anade el de quien se lo monta
// en su propia maquina, y `DROP_ALLOWED_ORIGINS` (separada por comas) sustituye la
// lista entera. localhost queda dentro siempre: es el `npm run dev` y la suite.
const DEFAULT_ORIGINS = [
  'https://drop.oloxx.dev',
  process.env.DROP_DOMAIN && `https://${process.env.DROP_DOMAIN}`,
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
].filter(Boolean);

const ALLOWED_ORIGINS = new Set(
  (process.env.DROP_ALLOWED_ORIGINS
    ? process.env.DROP_ALLOWED_ORIGINS.split(',')
    : DEFAULT_ORIGINS
  )
    .map(normOrigin)
    .filter(Boolean)
);

// `*` desactiva la comprobacion. Existe para quien sirve Drop desde un dominio que
// no controla o monta su propio frontend, y para no dejarle sin salida si algo de
// esto se le atraviesa en produccion.
const ORIGIN_ANY = ALLOWED_ORIGINS.has('*');

function originAllowed(origin) {
  if (!origin) return true;
  if (ORIGIN_ANY) return true;
  return ALLOWED_ORIGINS.has(normOrigin(origin));
}

function closeRoom(token, reason, { hangUp = false } = {}) {
  const room = rooms.get(token);
  if (!room) return;
  for (const guest of room.guests.values()) {
    send(guest, { t: 'host-gone' });
    if (hangUp) guest.close();
  }
  send(room.host, { t: 'error', reason });
  // La sala que cierra el servidor por su cuenta tiene que colgar tambien el
  // socket: si no, el emisor se queda con la conexion viva creyendo que sigue
  // publicando, y el proceso con el socket abierto para nada.
  if (hangUp) room.host?.close();
  rooms.delete(token);
}

// Detras de Caddy la IP real llega en X-Forwarded-For; en local no hay proxy y
// vale la del socket. Lo usan el limite de fuerza bruta, el cupo de salas y el
// `publicIp` que se devuelve al cliente.
function clientIp(req) {
  return (
    req?.headers?.['x-forwarded-for']?.split(',')[0] ||
    req?.socket?.remoteAddress ||
    ''
  ).replace(/^::ffff:/, '').trim();
}

// -------------------------------------------------------- credenciales TURN
//
// El TURN no se autentica con un usuario fijo, sino con el mecanismo REST de
// coturn (`--use-auth-secret`): el servidor firma con un secreto compartido un
// usuario que lleva dentro su propia fecha de caducidad, y coturn valida la firma
// sin saber nada de quien pide. Asi una credencial robada de /config deja de
// servir sola, en vez de abrir un relay gratis y perpetuo a cualquiera.
//
// El HMAC es SHA-1 porque es lo que dice la especificacion del mecanismo; no es
// una eleccion de seguridad nuestra y cambiarlo por SHA-256 lo rompe.
const TURN_TTL = num('TURN_TTL_SECONDS', 12 * 3600);

function turnCredentials(secret) {
  const username = `${Math.floor(Date.now() / 1000) + TURN_TTL}:drop`;
  const credential = createHmac('sha1', secret).update(username).digest('base64');
  return { username, credential };
}

const app = express();
app.disable('x-powered-by');

// ------------------------------------------------------ cabeceras de seguridad
//
// Van aqui y no en el Caddyfile (salvo HSTS, que solo tiene sentido donde acaba
// el TLS) para que viajen con la aplicacion: valen igual en `npm run dev`, en la
// suite y en cualquier despliegue que no pase por Caddy, y asi se prueban de
// verdad en vez de confiar en que el proxy de produccion este bien.
//
// La CSP esta ajustada a lo que la web usa REALMENTE, que es poco: no hay
// scripts ni estilos en linea, ni una sola peticion a terceros (la fuente esta
// servida desde public/fonts). Si algun dia se anade algo de fuera, esto lo
// parte, y esa es justo la idea.
//
// QUE FRENA Y QUE NO: frena que una inyeccion de HTML acabe ejecutando codigo o
// mandando el token de sala a otro sitio. No protege del servidor mismo: el
// token viaja en el fragmento de la URL, que no llega hasta aqui, pero quien
// controle este proceso puede servir el JavaScript que quiera.
//
// WebRTC no lo cubre `connect-src`: los candidatos STUN/TURN salen de /config y
// ningun navegador aplica CSP sobre ellos. Lo que si cubre es el WebSocket de
// senalizacion, que es del mismo origen.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self' data:",
  // Los archivos recibidos se entregan como blob: cuando no hay File System Access.
  "media-src 'self' blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  // No hay ningun formulario: cualquier envio seria de algo inyectado.
  "form-action 'none'",
  // Enmarcar la pagina permitiria un clickjacking sobre el boton de aceptar.
  "frame-ancestors 'none'",
].join('; ');

app.use((_req, res, next) => {
  res.set('Content-Security-Policy', CSP);
  // Sin esto, un archivo servido desde /public podria interpretarse como script
  // por el olfato del navegador en vez de por su Content-Type.
  res.set('X-Content-Type-Options', 'nosniff');
  // El token ya va en el fragmento, que no se manda en Referer. Esto tapa lo que
  // quede: nada de esta aplicacion tiene por que llegar a un tercero.
  res.set('Referrer-Policy', 'no-referrer');
  // Ni camara, ni micro, ni ubicacion: la aplicacion no los usa. WebRTC aqui solo
  // mueve datos, asi que quitarle los permisos de captura no le cuesta nada.
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

// La configuracion ICE se sirve desde el servidor para poder anadir TURN sin tocar el cliente.
app.get('/config', (_req, res) => {
  const iceServers = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] },
  ];
  if (process.env.TURN_URL && process.env.TURN_SECRET) {
    iceServers.push({
      urls: process.env.TURN_URL,
      ...turnCredentials(process.env.TURN_SECRET),
    });
  }
  // Estas credenciales caducan: que no se queden pegadas en ningun intermediario.
  res.set('Cache-Control', 'no-store');
  res.json({ iceServers, ttl: TURN_TTL });
});

app.get('/healthz', (_req, res) => {
  let guests = 0;
  for (const room of rooms.values()) guests += room.guests.size;
  res.set('Cache-Control', 'no-store');
  res.json({
    ok: true,
    rooms: rooms.size,
    guests,
    uptime: Math.round((Date.now() - metrics.startedAt) / 1000),
    roomsOpened: metrics.roomsOpened,
    relay: {
      ...metrics.relay,
      limit: RELAY_LIMIT,
      limitTotal: RELAY_LIMIT_TOTAL,
    },
    rejected: metrics.rejected,
  });
});

app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

const server = http.createServer(app);
const wss = new WebSocketServer({
  server,
  // El frame legitimo mas grande es un paquete de relay del CLI: 4 bytes de
  // guestId, 28 de IV y tag AES-GCM y un chunk de 64 KiB. Con 256 KiB hay margen
  // de sobra y un cliente no puede reservar 100 MiB de golpe, que es lo que
  // permite `ws` por defecto.
  maxPayload: 256 * 1024,
  // Se rechaza en el upgrade, no en `connection`: asi el navegador recibe un 403
  // y el socket no llega a existir.
  verifyClient: ({ origin, req }, done) => {
    if (originAllowed(origin)) return done(true);
    log('origen no permitido', origin, 'desde', clientIp(req) || '(ip desconocida)');
    done(false, 403, 'Forbidden origin');
  },
});

function send(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.role = null;     // 'host' | 'guest'
  ws.token = null;
  ws.guestId = null;
  ws.clientIp = clientIp(req);

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw, isBinary) => {
    ws.isAlive = true;
    if (isBinary) {
      const room = rooms.get(ws.token);
      if (!room) return;
      // Una transferencia por relay del CLI son solo frames binarios durante
      // minutos u horas: si esto no cuenta como actividad, el barrido de salas
      // inactivas cierra la sala en mitad del envio.
      room.lastActivity = Date.now();
      metrics.relay.bytes += raw.length;
      metrics.relay.frames++;
      if (ws.role === 'host') {
        if (raw.length < 4) return;
        const toGuestId = raw.readUInt32BE(0);
        const payload = raw.subarray(4);
        const guest = room.guests.get(toGuestId);
        if (guest && guest.readyState === 1) guest.send(payload, { binary: true });
      } else if (ws.role === 'guest') {
        if (room.host && room.host.readyState === 1) room.host.send(raw, { binary: true });
      }
      // Despues de reenviar, no antes: el frame ya esta en memoria y pausar
      // ahora solo retrasa el siguiente, que es lo que se quiere.
      if (room.relay || relayTotal) throttleRelay(ws, room, raw.length);
      return;
    }

    // El cubo solo mide frames de control. Los binarios ya van acotados por
    // `maxPayload` y por el hecho de que hay que estar dentro de una sala.
    if (!takeToken(ws)) {
      reject('FLOOD');
      send(ws, { t: 'error', reason: 'FLOOD' });
      log('socket cortado por inundacion desde', ws.clientIp || '(ip desconocida)');
      ws.close();
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
        // Un socket abre como mucho una sala (`ws.role` lo impide despues), asi
        // que abrir muchas es abrir muchos sockets: lo que se cuenta es la IP.
        if (tooManyRooms(ws.clientIp)) {
          reject('TOO_MANY_ROOMS');
          send(ws, { t: 'error', reason: 'TOO_MANY_ROOMS' });
          log('demasiadas salas abiertas desde', ws.clientIp || '(ip desconocida)');
          ws.close();
          return;
        }
        // `v:2` es el cliente diciendo "se de codigos memorizables, dame solo el
        // identificador publico". Un binario v0.3.5 no lo manda, y para el ese
        // token largo era la clave de cifrado: mejor decirle que actualice que
        // darle algo que no puede usar.
        if (msg.v !== 2) {
          reject('VERSION');
          send(ws, { t: 'error', reason: 'VERSION' });
          log('cliente sin v:2 (anterior a la v0.4.0) desde', ws.clientIp || '(ip desconocida)');
          ws.close();
          return;
        }
        // Con codigos de 4 digitos `newRoomId` ya se niega a las ~10.000 salas,
        // pero los tokens largos de /speed no tienen ese techo natural.
        if (rooms.size >= MAX_ROOMS) {
          reject('NO_ROOMS');
          send(ws, { t: 'error', reason: 'NO_ROOMS' });
          log('tope de salas alcanzado |', rooms.size);
          return;
        }
        // `link:true` es /speed: sala compartida por enlace, sin palabras, asi que
        // el identificador tiene que ser largo e inadivinable.
        const link = msg.link === true;
        const token = newRoomId(link);
        if (!token) {
          reject('NO_ROOMS');
          send(ws, { t: 'error', reason: 'NO_ROOMS' });
          log('sin identificadores de sala libres | salas activas:', rooms.size);
          return;
        }
        const now = Date.now();
        rooms.set(token, {
          host: ws, guests: new Map(), createdAt: now, lastActivity: now, badGuests: 0,
          relay: RELAY_LIMIT ? makeBucket(RELAY_LIMIT) : null,
        });
        metrics.roomsOpened++;
        noteRoom(ws.clientIp);
        ws.role = 'host';
        ws.token = token;
        send(ws, { t: 'hosted', token, room: token, v: 2, publicIp: ws.clientIp });
        log('sala abierta', tag(token), link ? '(enlace)' : '', '| salas activas:', rooms.size);
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
            reject('RATE_LIMITED');
            send(ws, { t: 'error', reason: 'RATE_LIMITED' });
            log('demasiados intentos fallidos desde', ws.clientIp || '(ip desconocida)');
            ws.close();
            return;
          }
          noteFailure(ws.clientIp);
          reject('NOT_FOUND');
          send(ws, { t: 'error', reason: 'NOT_FOUND' });
          log('enlace caducado o invalido', token ? tag(token) : '(vacio)');
          return;
        }
        // La cadena de reenvio reparte una sola copia entre todos los receptores,
        // pero cada uno sigue siendo una conexion que el emisor sostiene: por
        // encima de este numero es mas probable que sea alguien llenando la sala
        // que una entrega de verdad.
        if (room.guests.size >= MAX_GUESTS) {
          reject('ROOM_FULL');
          send(ws, { t: 'error', reason: 'ROOM_FULL' });
          log('sala llena', tag(token), '| receptores:', room.guests.size);
          return;
        }
        joinFails.delete(ws.clientIp);
        room.lastActivity = Date.now();
        const guestId = nextGuestId++;
        room.guests.set(guestId, ws);
        ws.role = 'guest';
        ws.token = token;
        ws.guestId = guestId;
        send(ws, { t: 'joined', guestId, publicIp: ws.clientIp });
        send(room.host, {
          t: 'guest',
          guestId,
          name: String(msg.name || '').slice(0, 40),
          ip: ws.clientIp,
        });
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
          reject('BAD_SECRET');
          send(guest, { t: 'error', reason: 'BAD_SECRET' });
          guest.close();
        }
        if (++room.badGuests >= BAD_GUEST_MAX) {
          log('sala quemada por intentos fallidos de secreto', tag(ws.token));
          reject('BURNED');
          closeRoom(ws.token, 'BURNED');
        }
        break;
      }

      // Reenvio ciego de SDP/ICE. El servidor no mira dentro de `data`.
      case 'signal': {
        const room = rooms.get(ws.token);
        if (!room) return;
        room.lastActivity = Date.now();
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

// El ping de arriba mantiene vivo el socket, no la sala: un emisor que abre un
// canal y se olvida de la pestana deja una sala en memoria para siempre. Aqui se
// cierran las que llevan `ROOM_TTL` sin que pase nada por ellas. Cuenta como
// actividad cualquier senal y cualquier byte del relay, no el simple estar.
const sweepIdle = setInterval(() => {
  const now = Date.now();
  for (const [token, room] of rooms) {
    if (now - room.lastActivity < ROOM_TTL) continue;
    log('sala caducada por inactividad', tag(token), '| vivio',
        Math.round((now - room.createdAt) / 1000) + 's');
    closeRoom(token, 'EXPIRED', { hangUp: true });
  }
}, ROOM_SWEEP);
sweepIdle.unref?.();

server.listen(PORT, () => {
  log(`Drop escuchando en http://localhost:${PORT}`);
  // Una lista mal puesta se nota como "la web no conecta" y nada mas: dejarla
  // escrita al arrancar es lo que ahorra buscarlo a ciegas.
  log('origenes permitidos:', ORIGIN_ANY ? '(cualquiera)' : [...ALLOWED_ORIGINS].join(', '));
  log('caudal del relay:', RELAY_LIMIT ? RELAY_LIMIT + ' B/s por sala' : 'sin limite por sala',
      '|', RELAY_LIMIT_TOTAL ? RELAY_LIMIT_TOTAL + ' B/s en total' : 'sin limite total');
  // Un TURN configurado a medias no da error: simplemente no se ofrece, y las
  // conexiones que necesitaban relay fallan sin explicacion. Mejor decirlo aqui.
  if (process.env.TURN_URL && !process.env.TURN_SECRET) {
    log('AVISO: hay TURN_URL pero no TURN_SECRET, no se sirve TURN (ver .env.example)');
  } else if (process.env.TURN_URL) {
    log('TURN:', process.env.TURN_URL, '| credenciales efimeras de', TURN_TTL + 's');
  }
});
