// Utilidades compartidas por la suite: levantar un servidor de senalizacion
// propio y hablar con el por WebSocket.
//
// Arrancar el servidor desde los tests -- en vez de dar por hecho que hay uno
// escuchando en el 3000 -- es lo que permite que `npm test` funcione en un clon
// limpio y en un runner de CI, y que cada fichero de tests tenga sus propias
// cuotas por IP sin pisar las de los demas.
//
// El puerto lo elige el sistema (`freePort`), asi que dos ficheros de tests
// pueden correr a la vez sin chocar, y el origen que el servidor acepta por
// defecto (`http://localhost:<PORT>`) sale de ese mismo puerto.
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { WebSocket } from 'ws';
import { newCode, splitForKey } from '../public/shared/codes.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { existsSync } = await import('node:fs');
const SERVER = path.join(ROOT, 'server', 'index.js');
const BIN_EXT = process.platform === 'win32' ? '.exe' : '';
const RELEASE_CLI = path.join(ROOT, 'cli-rs', 'target', 'release', `drop${BIN_EXT}`);
const DEBUG_CLI = path.join(ROOT, 'cli-rs', 'target', 'debug', `drop${BIN_EXT}`);
export const CLI_BIN = process.env.DROP_CLI_BIN || (existsSync(RELEASE_CLI) ? RELEASE_CLI : DEBUG_CLI);

/** Devuelve [comando, args] para ejecutar el CLI compilado en Rust. */
export function cliSpawnTarget(args = []) {
  if (!existsSync(CLI_BIN)) {
    throw new Error(`No se encontró el binario de drop en ${CLI_BIN}. Compila con: cargo build --release --manifest-path cli-rs/Cargo.toml`);
  }
  return [CLI_BIN, args];
}

/** Un puerto libre, pidiendoselo al sistema y soltandolo acto seguido. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Arranca `server/index.js` en un puerto efimero y espera a que escuche.
 *
 * Devuelve las dos URL que hacen falta (`http` y `ws`), el proceso y un `stop()`
 * idempotente. `env` se mezcla con el entorno del proceso, para los tests que
 * necesitan limites ridiculos o un TURN de mentira.
 */
export async function startServer(env = {}) {
  const port = await freePort();
  const proc = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // La salida se guarda entera: si el arranque falla, el mensaje del servidor
  // explica por que mucho mejor que un tiempo de espera agotado.
  let output = '';
  proc.stdout.on('data', (d) => { output += d.toString(); });
  proc.stderr.on('data', (d) => { output += d.toString(); });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`el servidor no arranco en 10s:\n${output}`)),
      10_000,
    );
    const check = () => {
      if (output.includes('Drop escuchando')) { clearTimeout(timer); resolve(); }
    };
    proc.stdout.on('data', check);
    proc.on('error', (err) => { clearTimeout(timer); reject(err); });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`el servidor murio con codigo ${code}:\n${output}`));
    });
    check();
  });

  return {
    proc,
    port,
    http: `http://127.0.0.1:${port}`,
    ws: `ws://127.0.0.1:${port}`,
    // El origen que el servidor acepta por defecto para este puerto. Los tests
    // que mandan cabecera Origin necesitan uno que cuadre.
    origin: `http://localhost:${port}`,
    output: () => output,
    stop: () => { if (!proc.killed) proc.kill(); },
  };
}

/**
 * Un WebSocket con cola de mensajes: `next()` devuelve el siguiente frame JSON,
 * `say()` manda uno, `until(pred)` se salta el ruido (los avisos de `guest-gone`
 * se cuelan entre medias cuando el servidor echa a un receptor).
 */
export function open(url, options) {
  const ws = new WebSocket(url, options);
  ws.queue = [];
  ws.waiters = [];
  ws.on('message', (raw, isBinary) => {
    if (isBinary) return;   // los trozos del relay no son mensajes de control
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
  ws.until = async (pred) => {
    for (let i = 0; i < 20; i++) {
      const msg = await ws.next();
      if (pred(msg)) return msg;
    }
    throw new Error('no llego el mensaje esperado');
  };
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Flags de Chrome para que dos pestanas de la misma maquina se conecten por
 * WebRTC en cualquier runner. Chrome esconde las IPs locales detras de nombres
 * mDNS (`xxxx.local`), y en el runner de macOS esos nombres no resuelven: las
 * pestanas no llegaban a conectar nunca. Con las IPs tal cual (y el loopback
 * permitido) el ICE tiene candidatas que funcionan. Es un ajuste del banco de
 * pruebas, no de la app: en una red de verdad mDNS es lo que se quiere.
 */
export const CHROME_ARGS = [
  '--disable-features=WebRtcHideLocalIpsWithMdns',
  '--allow-loopback-in-peer-connection',
];

/**
 * Ruta a un Chrome instalado, o `null`. playwright-core no descarga navegador:
 * usa el del sistema, y `CHROME_PATH` manda sobre las rutas conocidas.
 */
export function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || null;
}

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

/** Deriva la clave AES-256-GCM de 32 B identica a Drop (scrypt N=2^15, r=8, p=1). */
export function deriveKey(code) {
  const { roomId, secret } = splitForKey(code);
  const salt = crypto.createHash('sha256').update(`drop-code-v2|${roomId}`).digest();
  return crypto.scryptSync(secret, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

export function proofFromKey(key, nonce) {
  return crypto.createHmac('sha256', key).update(`drop-proof-v3|${nonce}`).digest('hex');
}

/** Cifra a [12B IV][16B AuthTag][ciphertext]. */
export function encryptChunk(plain, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]);
}

/** Descifra un paquete [12B IV][16B AuthTag][ciphertext]. */
export function decryptChunk(packet, key) {
  const iv = packet.subarray(0, 12);
  const tag = packet.subarray(12, 28);
  const body = packet.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

export function sealFrame(obj, key) {
  return { type: 'cli-sealed', box: encryptChunk(Buffer.from(JSON.stringify(obj)), key).toString('base64') };
}

export function openFrame(frame, key) {
  return JSON.parse(decryptChunk(Buffer.from(frame.box, 'base64'), key).toString('utf8'));
}

export function tcpFrames(key) {
  const frame = (buf) => {
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(buf.length, 0);
    return Buffer.concat([header, buf]);
  };
  const packet = (type, payload) => frame(encryptChunk(Buffer.concat([Buffer.from([type]), payload]), key));
  return {
    control: (obj) => packet(0, Buffer.from(JSON.stringify(obj))),
    data: (buf) => packet(1, buf),
  };
}

/** Arranca el CLI compilado en segundo plano con captura de salida sin ANSI y `waitFor`. */
export function spawnCli(args, extraEnv = {}) {
  const [cmd, cmdArgs] = cliSpawnTarget(args);
  const proc = spawn(cmd, cmdArgs, {
    env: { ...process.env, DROP_NO_UPNP: '1', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  proc.stdout.on('data', (d) => { out += stripAnsi(d.toString()); });
  proc.stderr.on('data', (d) => { out += stripAnsi(d.toString()); });
  return {
    proc,
    output: () => out,
    waitFor: (re, ms = 15_000) => new Promise((resolve, reject) => {
      const check = () => {
        const m = out.match(re);
        if (m) { clearInterval(poll); clearTimeout(timer); resolve(m); }
      };
      const poll = setInterval(check, 40);
      const timer = setTimeout(() => {
        clearInterval(poll);
        reject(new Error(`no apareció ${re} en la salida:\n${out}`));
      }, ms);
      check();
    }),
    exited: new Promise((resolve) => proc.on('exit', (code) => resolve(code))),
    kill: () => { try { proc.kill('SIGKILL'); } catch {} },
  };
}

/** Abre una sala simulando un emisor en `srv` y sirve `cli-offer` (TCP o Relay). */
export async function hostMockSender(srv, { tcpPort = 0, v = 5, onRelay } = {}) {
  const ws = await open(srv.ws, { headers: { Origin: srv.origin } });
  ws.say({ t: 'host', v: 2 });
  const hosted = await ws.until((m) => m.t === 'hosted');
  const roomId = hosted.room || hosted.token;
  const code = newCode(roomId, crypto.randomBytes);
  const key = deriveKey(code);
  const nonce = crypto.randomBytes(16).toString('hex');

  ws.on('message', (raw, isBinary) => {
    if (isBinary) return;
    const msg = JSON.parse(raw);
    if (msg.t === 'guest') {
      ws.say({
        t: 'signal',
        to: msg.guestId,
        data: {
          type: 'cli-offer',
          v,
          ips: tcpPort ? ['127.0.0.1'] : [],
          port: tcpPort,
          nonce,
        },
      });
    } else if (msg.t === 'signal' && onRelay) {
      const unwrapped = msg.data?.type === 'cli-sealed' ? openFrame(msg.data, key) : msg.data;
      onRelay({
        from: msg.from,
        data: unwrapped,
        ws,
        key,
        nonce,
        sendSealed: (obj) => ws.say({ t: 'signal', to: msg.from, data: sealFrame(obj, key) }),
        sendBin: (buf) => {
          const enc = encryptChunk(buf, key);
          const hdr = Buffer.allocUnsafe(4);
          hdr.writeUInt32BE(msg.from, 0);
          ws.send(Buffer.concat([hdr, enc]));
        },
      });
    }
  });

  return {
    code,
    roomId,
    key,
    ws,
    close: () => { try { ws.close(); } catch {} },
  };
}
