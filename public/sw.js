// Service Worker de drop: convierte una descarga que la pagina va recibiendo
// por trozos en una respuesta HTTP en streaming, para que el navegador la
// escriba a disco segun llega, con memoria constante.
//
// Hace falta donde no hay File System Access API (Firefox, Safari de
// escritorio y todo iOS): sin esto el receptor acumula el archivo entero en
// memoria (`memorySink` en app.js) y una pestana muere sin mensaje con un
// video grande. Es el patron de StreamSaver, sin dependencias, como qr.js y
// scrypt.js.
//
// COMO VA. La pagina manda `{ type: 'drop-stream', id, name, size, mime }` con
// un puerto de MessageChannel; aqui se apunta. Luego navega un <iframe> a
// `/__drop-download/<id>`: la peticion entra por `fetch`, se contesta con
// `Content-Disposition: attachment` y un ReadableStream, y el navegador abre
// el dialogo de descarga. Cada `{ type: 'chunk' }` por el puerto se encola en
// el stream; `end` lo cierra y `abort` lo rompe, que es lo que hace que el
// navegador marque la descarga como fallida en vez de dejar un archivo
// corrupto cuando el SHA-256 no cuadra.
//
// CONTRAPRESION. El stream solo recibe un trozo cuando el navegador pide
// (`pull`); lo demas espera en `queue`. Por cada trozo que entra al stream se
// devuelve un `pull` a la pagina, que lleva la cuenta de creditos y no manda
// mas de N trozos sin confirmar: asi lo que hay en memoria en el worker esta
// acotado aunque el disco sea mas lento que la red.
//
// QUE NO HACE. No cachea nada: ni `install` ni `activate` tocan la Cache API,
// y cualquier peticion que no sea `/__drop-download/...` se deja pasar sin
// `respondWith`, o sea que va a la red exactamente igual que sin worker. La
// CSP de la pagina sigue mandando; la respuesta de descarga lleva la suya
// propia (`default-src 'none'`) por si algun navegador la renderizara.
//
// El fichero se carga tambien en Node desde test/sw.test.mjs con un `self` de
// mentira, asi que aqui no hay nada que no exista en las dos plataformas.

const PREFIX = '/__drop-download/';
// Trozos sin confirmar que la pagina puede tener en vuelo. Con los 64 KiB del
// relay del CLI o los ~16-64 KiB del DataChannel son menos de 2 MB.
const CREDITS = 16;

// id -> { port, name, size, mime, controller, queue, ended, wanting }
const streams = new Map();

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.type !== 'drop-stream' || typeof data.id !== 'string') return;
  const port = event.ports && event.ports[0];
  if (!port) return;
  const entry = {
    port,
    name: typeof data.name === 'string' ? data.name : 'download',
    size: Number.isFinite(data.size) && data.size >= 0 ? data.size : null,
    mime: typeof data.mime === 'string' ? data.mime : '',
    controller: null,
    queue: [],
    ended: false,
    failed: false,
    wanting: false,
  };
  streams.set(data.id, entry);
  port.onmessage = (ev) => onPortMessage(entry, ev.data);
  port.postMessage({ type: 'ready', credits: CREDITS });
});

function onPortMessage(entry, msg) {
  if (!msg) return;
  if (msg.type === 'chunk') {
    const chunk = msg.data instanceof ArrayBuffer ? new Uint8Array(msg.data)
      : ArrayBuffer.isView(msg.data) ? new Uint8Array(msg.data.buffer, msg.data.byteOffset, msg.data.byteLength)
        : null;
    if (!chunk) return;
    // Si el navegador ya estaba esperando, directo al stream; si no, a la cola.
    if (entry.controller && entry.wanting) {
      entry.wanting = false;
      deliver(entry, chunk);
    } else {
      entry.queue.push(chunk);
    }
    return;
  }
  if (msg.type === 'end') {
    entry.ended = true;
    if (entry.controller && !entry.queue.length) closeStream(entry);
    return;
  }
  if (msg.type === 'abort') {
    entry.failed = true;
    entry.queue = [];
    if (entry.controller) {
      try { entry.controller.error(new Error('aborted by the page')); } catch { /* ya cerrado */ }
    }
    forget(entry);
  }
}

function deliver(entry, chunk) {
  try { entry.controller.enqueue(chunk); } catch { forget(entry); return; }
  // Credito de vuelta a la pagina: ya hay sitio para otro.
  entry.port.postMessage({ type: 'pull' });
  if (entry.ended && !entry.queue.length) closeStream(entry);
}

function closeStream(entry) {
  try { entry.controller.close(); } catch { /* ya cerrado */ }
  forget(entry);
}

function forget(entry) {
  for (const [id, e] of streams) if (e === entry) streams.delete(id);
  try { entry.port.close(); } catch { /* nada */ }
}

function makeStream(entry) {
  return new ReadableStream({
    start(controller) {
      entry.controller = controller;
    },
    pull() {
      // El navegador quiere mas: se le da lo que espera en la cola, y si no
      // hay nada se apunta el deseo para el siguiente `chunk`.
      if (entry.queue.length) {
        deliver(entry, entry.queue.shift());
      } else if (entry.ended) {
        closeStream(entry);
      } else {
        entry.wanting = true;
      }
    },
    cancel() {
      // El usuario ha cancelado la descarga en el navegador: se avisa a la
      // pagina para que deje de mandar y se olvida.
      try { entry.port.postMessage({ type: 'cancel' }); } catch { /* nada */ }
      forget(entry);
    },
  });
}

/** `Content-Disposition` con el nombre en ASCII y en UTF-8 (RFC 5987). */
function disposition(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const utf8 = encodeURIComponent(name).replace(/['()*]/g, (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(PREFIX)) return;

  const id = url.pathname.slice(PREFIX.length);
  // La pagina hace ping mientras dura la descarga: algunos navegadores matan
  // un worker que lleve un rato sin atender peticiones.
  if (id === 'ping') {
    event.respondWith(new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } }));
    return;
  }

  const entry = streams.get(id);
  if (!entry || entry.controller) {
    event.respondWith(new Response('unknown download', { status: 404, headers: { 'Cache-Control': 'no-store' } }));
    return;
  }

  const headers = {
    // Siempre octet-stream, nunca el tipo real: que el navegador no intente
    // abrirlo en la pestana. `nosniff` es para que no adivine tampoco.
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': disposition(entry.name),
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'",
    'Cache-Control': 'no-store',
  };
  // Con el tamano el navegador ensena progreso y porcentaje en su dialogo.
  if (entry.size != null) headers['Content-Length'] = String(entry.size);

  event.respondWith(new Response(makeStream(entry), { status: 200, headers }));
});
