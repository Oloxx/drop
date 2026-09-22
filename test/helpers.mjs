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
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { WebSocket } from 'ws';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'server', 'index.js');

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
