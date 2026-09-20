// El Service Worker de descargas en streaming (issue #55), sin navegador: se
// carga public/sw.js con un `self` de mentira y se le hablan los mismos
// mensajes que le manda swSink en app.js. Lo que se comprueba es la fontaneria
// que, si se rompe, no lo detecta nadie hasta que un iPhone se queda a medias:
// que los bytes salen en orden y completos, que `abort` rompe la respuesta
// (para que el navegador marque la descarga como fallida en vez de dejar un
// archivo corrupto), que la contrapresion devuelve creditos, y que el worker
// no toca ninguna otra peticion.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SW = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf-8');
const ORIGIN = 'https://drop.test';

/** Un `self` con lo justo: eventos, `location`, `clients` y las clases web. */
function loadWorker() {
  const listeners = new Map();
  const self = {
    location: { origin: ORIGIN },
    clients: { claim: async () => {} },
    skipWaiting: () => {},
    addEventListener: (type, fn) => listeners.set(type, fn),
  };
  const ctx = vm.createContext({
    self, URL, Response, ReadableStream, MessageChannel, ArrayBuffer, Uint8Array, Map, Number, String, Error, setTimeout, console,
  });
  vm.runInContext(SW, ctx, { filename: 'sw.js' });
  const fire = (type, event) => listeners.get(type)(event);
  const fetchFor = (pathname) => new Promise((resolve) => {
    let responded = false;
    fire('fetch', {
      request: { url: ORIGIN + pathname },
      respondWith: (r) => { responded = true; resolve(Promise.resolve(r)); },
    });
    if (!responded) resolve(null);
  });
  return { fire, fetchFor };
}

/** Anuncia un stream como hace la pagina y devuelve su puerto ya listo. */
async function announce(sw, id, opts = {}) {
  const { port1, port2 } = new MessageChannel();
  const inbox = [];
  const waiters = [];
  port1.onmessage = (ev) => {
    inbox.push(ev.data);
    for (const w of waiters.splice(0)) w();
  };
  const next = async (type) => {
    for (;;) {
      const i = inbox.findIndex((m) => m.type === type);
      if (i >= 0) return inbox.splice(i, 1)[0];
      await new Promise((r) => waiters.push(r));
    }
  };
  sw.fire('message', { data: { type: 'drop-stream', id, name: 'x.bin', size: null, ...opts }, ports: [port2] });
  const ready = await next('ready');
  return { port: port1, next, ready, close: () => { port1.close(); port2.close(); } };
}

async function readAll(res) {
  const parts = [];
  for await (const chunk of res.body) parts.push(Buffer.from(chunk));
  return Buffer.concat(parts);
}

test('las peticiones que no son de descarga se dejan pasar, sin respondWith', async () => {
  const sw = loadWorker();
  assert.equal(await sw.fetchFor('/'), null);
  assert.equal(await sw.fetchFor('/app.js'), null);
  assert.equal(await sw.fetchFor('/config'), null);
});

test('una descarga sin anunciar es un 404, no un stream colgado', async () => {
  const sw = loadWorker();
  const res = await sw.fetchFor('/__drop-download/nadie');
  assert.equal(res.status, 404);
});

test('el ping contesta 204 sin tocar nada', async () => {
  const sw = loadWorker();
  const res = await sw.fetchFor('/__drop-download/ping');
  assert.equal(res.status, 204);
});

test('los trozos salen en orden y completos, con cabeceras de descarga y tamaño', async () => {
  const sw = loadWorker();
  const body = crypto.randomBytes(300_000);
  const s = await announce(sw, 'uno', { name: 'vídeo "final".mp4', size: body.length, mime: 'video/mp4' });
  const res = await sw.fetchFor('/__drop-download/uno');
  assert.equal(res.status, 200);
  // Nunca el tipo real: un video se abriria en la pestana en vez de bajar.
  assert.equal(res.headers.get('content-type'), 'application/octet-stream');
  assert.equal(res.headers.get('content-length'), String(body.length));
  assert.match(res.headers.get('content-disposition'), /^attachment; filename="v_deo _final_.mp4"; filename\*=UTF-8''v%C3%ADdeo/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');

  const reading = readAll(res);
  for (let off = 0; off < body.length; off += 7000) {
    const piece = body.subarray(off, off + 7000);
    s.port.postMessage({ type: 'chunk', data: piece.buffer.slice(piece.byteOffset, piece.byteOffset + piece.byteLength) });
    await s.next('pull');
  }
  s.port.postMessage({ type: 'end' });
  const got = await reading;
  assert.equal(got.length, body.length);
  assert.ok(got.equals(body), 'los bytes no coinciden');
  s.close();
});

test('la contrapresión devuelve un crédito por trozo entregado, sin inventar ninguno', async () => {
  const sw = loadWorker();
  const s = await announce(sw, 'dos');
  assert.ok(s.ready.credits > 0);
  const res = await sw.fetchFor('/__drop-download/dos');
  const reader = res.body.getReader();
  // Se mandan mas trozos de los que el consumidor lee: cada `pull` que vuelve
  // corresponde a un trozo que ha entrado en el stream, ni uno mas.
  const n = 5;
  for (let i = 0; i < n; i++) s.port.postMessage({ type: 'chunk', data: new Uint8Array([i]).buffer });
  let pulls = 0;
  for (let i = 0; i < n; i++) {
    const { value } = await reader.read();
    assert.equal(value[0], i);
    await s.next('pull');
    pulls++;
  }
  assert.equal(pulls, n);
  s.port.postMessage({ type: 'end' });
  assert.equal((await reader.read()).done, true);
  s.close();
});

test('abort rompe la respuesta: el navegador marca la descarga como fallida', async () => {
  const sw = loadWorker();
  const s = await announce(sw, 'tres');
  const res = await sw.fetchFor('/__drop-download/tres');
  const reader = res.body.getReader();
  s.port.postMessage({ type: 'chunk', data: new Uint8Array([1, 2, 3]).buffer });
  await reader.read();
  s.port.postMessage({ type: 'abort' });
  await assert.rejects(() => reader.read(), /aborted/);
  // Y ya no se puede volver a pedir: el id ha muerto con el stream.
  assert.equal((await sw.fetchFor('/__drop-download/tres')).status, 404);
  s.close();
});

test('un stream vacío (end sin trozos) es un archivo vacío que termina', async () => {
  const sw = loadWorker();
  const s = await announce(sw, 'cuatro', { size: 0 });
  const res = await sw.fetchFor('/__drop-download/cuatro');
  s.port.postMessage({ type: 'end' });
  assert.equal((await readAll(res)).length, 0);
  s.close();
});

test('el worker no registra ninguna caché', () => {
  // La unica razon de existir del worker es la descarga: si algun dia cachea
  // app.js, una version vieja se quedaria pegada en el navegador.
  assert.ok(!/caches\./.test(SW), 'sw.js no deberia usar la Cache API');
});
