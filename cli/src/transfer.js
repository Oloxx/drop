import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { deriveKey, encryptChunk, decryptChunk, sasFromKey, unsealFrame } from './crypto.js';
import { splitForKey } from '../../public/shared/codes.js';
import { PROTOCOL_VERSION } from '../../public/shared/protocol.js';
import { makeThrottle } from './throttle.js';

const CHUNK_SIZE = 512 * 1024; // 512 KB por bloque para equilibrar streaming y memoria

// Version del protocolo de transferencia. Viaja DENTRO del primer marco de control
// (cifrado y autenticado por AES-GCM), no como byte en claro: un byte fuera del
// cifrado seria una huella gratis para quien mire el cable —hoy el primer paquete
// es indistinguible de ruido— y, al no ir autenticado, se podria cambiar sin
// romper el tag para llevar al receptor a otra rama de parseo. La contrapartida es
// que asi no se puede versionar el cifrado en si; si algun dia hace falta, eso se
// anuncia en la oferta de senializacion, que ya es publica.
//
// Antes no habia version ninguna y el receptor adivinaba si un paquete era control
// o datos por su primer byte, con dos ramas de "compatibilidad" que no daban
// compatibilidad: con un emisor sin prefijo, ese byte es CONTENIDO del archivo, y
// cuando valia 0x00 o 0x01 el trozo se tiraba en silencio.
//
// El numero vive en public/shared/protocol.js porque el receptor web tambien lo
// comprueba en la oferta del relay; aqui solo se reexporta.
export { PROTOCOL_VERSION };

// El receptor confirma cada 2 MB, igual que el cliente web (`ACK_EVERY` en
// public/app.js). No es cosmetico: el emisor no manda mas de 8 MB sin confirmar
// (`MAX_IN_FLIGHT` en cli.js), asi que un receptor que no acuse recibo deja la
// transferencia parada en seco al llegar a la ventana.
export const RELAY_ACK_EVERY = 2 * 1024 * 1024;

// Si por el relay no se mueve nada durante este tiempo, se corta con un mensaje.
// Antes no habia timeout en ningun extremo: un fallo dejaba a los dos colgados sin
// error y sin salida. Es generoso a proposito, porque el relay tambien se usa en
// enlaces malos donde un acuse puede tardar de verdad.
export const RELAY_IDLE_TIMEOUT_MS = 60_000;

/**
 * Empaqueta un buffer con prefijo de longitud de 4 bytes (UInt32BE)
 */
function frame(buf) {
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(buf.length, 0);
  return Buffer.concat([header, buf]);
}

/**
 * Resuelve donde se escribe un archivo del manifiesto dentro de `outputDir`.
 *
 * El nombre lo elige el EMISOR, asi que un `path.join(outputDir, name)` a secas es
 * una escritura arbitraria en el disco del receptor: un manifiesto con
 * `../../.ssh/authorized_keys` sale del directorio de destino con los permisos de
 * quien ejecuta `drop recv`. Que el emisor honesto mande siempre `path.basename` no
 * garantiza nada, porque es el lado equivocado: la comprobacion que vale es esta,
 * la del lado que escribe.
 */
export function safeOutputPath(outputDir, rawName, rawPath = null) {
  const unsafe = (why, what) => {
    const err = new Error(`${why}: ${JSON.stringify(what)}`);
    err.code = 'UNSAFE_NAME';
    return err;
  };
  const root = path.resolve(outputDir);

  // Con carpetas el emisor manda ademas `path`, una ruta RELATIVA con `/`
  // (`fotos/verano/playa.jpg`). Se acepta tramo a tramo y solo hacia abajo: ni
  // `..`, ni tramos vacios, ni letra de unidad, ni nada que al resolverse salga
  // del destino. Un `path` que no pasa no degrada al nombre suelto: se corta,
  // porque un emisor que manda `../` no es uno honesto con un despiste.
  if (rawPath != null) {
    const parts = typeof rawPath === 'string' ? rawPath.replace(/\\/g, '/').split('/').map((p) => p.trim()) : [];
    if (!parts.length || parts.some((p) => !p || p === '.' || p === '..' || p.includes('\0') || /^[a-zA-Z]:$/.test(p))) {
      throw unsafe('El emisor manda una ruta de archivo no válida', rawPath);
    }
    const dest = path.resolve(root, ...parts);
    if (!dest.startsWith(root + path.sep) || path.relative(root, dest).startsWith('..')) {
      throw unsafe('El emisor intenta escribir fuera del directorio de destino', rawPath);
    }
    return dest;
  }

  // `path.basename` no separa por `\` fuera de Windows y el emisor puede mandar
  // cualquiera de las dos barras: se normaliza antes de quedarse con el ultimo tramo.
  const name = typeof rawName === 'string'
    ? rawName.replace(/\\/g, '/').split('/').pop().trim()
    : '';

  if (!name || name === '.' || name === '..' || name.includes('\0')) {
    throw unsafe('El emisor manda un nombre de archivo no válido', rawName);
  }

  const dest = path.resolve(root, name);

  // Cinturon y tirantes: quedandonos con el ultimo tramo esto ya no deberia saltar
  // nunca, pero es la comprobacion que sigue valiendo si alguien toca lo de arriba.
  if (path.dirname(dest) !== root) {
    throw unsafe('El emisor intenta escribir fuera del directorio de destino', rawName);
  }

  return dest;
}

/**
 * Dos rutas son "el mismo archivo" sin distinguir mayusculas donde el sistema
 * tampoco las distingue: en Windows y macOS `Foto.jpg` pisaria a `foto.jpg`.
 */
function sameFileKey(p) {
  return (process.platform === 'win32' || process.platform === 'darwin') ? p.toLowerCase() : p;
}

/**
 * Hay algo con ese nombre, aunque sea un enlace roto. `existsSync` sigue los
 * enlaces y diria que no de un simbolico colgado, que si ocupa el nombre.
 */
function occupied(p) {
  return fs.lstatSync(p, { throwIfNoEntry: false }) !== undefined;
}

/**
 * Reserva el nombre definitivo de un archivo del manifiesto y devuelve el par
 * (definitivo, temporal). NO toca el disco: solo mira. Eso es lo que permite
 * reservar el manifiesto entero antes de crear nada, para que un nombre imposible
 * en el ultimo archivo siga cortando la transferencia sin haber escrito un byte.
 *
 * `reserved` son los nombres ya pedidos EN ESTA transferencia: sin el, un
 * manifiesto con dos `a.zip` se pisaria a si mismo, porque al reservar el segundo
 * el primero todavia no existe en disco (esta en su `.part`).
 */
export function reserveOutputPath(outputDir, rawName, reserved = new Set(), { overwrite = false, subpath = null } = {}) {
  const dest = safeOutputPath(outputDir, rawName, subpath);
  const mine = (p) => reserved.has(sameFileKey(p));

  // Con --overwrite el destino se acepta tal cual, salvo que ya lo haya pedido
  // otro archivo de este mismo manifiesto: dos nombres iguales del emisor nunca
  // se pisan entre ellos, con flag o sin flag.
  const libre = overwrite
    ? (p) => !mine(p)
    : (p) => !mine(p) && !occupied(p) && !occupied(`${p}.part`);

  let finalPath = dest;
  if (!libre(dest)) {
    const { dir, name, ext } = path.parse(dest);
    let n = 2;
    // El tope es para no girar para siempre en un directorio patologico.
    for (; n <= 9999; n++) {
      const candidato = path.join(dir, `${name} (${n})${ext}`);
      if (!mine(candidato) && !occupied(candidato) && !occupied(`${candidato}.part`)) {
        finalPath = candidato;
        break;
      }
    }
    if (n > 9999) {
      const err = new Error(`No queda un nombre libre para ${JSON.stringify(rawName)} en el directorio de destino.`);
      err.code = 'DEST_COLLISION';
      throw err;
    }
  }

  reserved.add(sameFileKey(finalPath));
  return { finalPath, partPath: `${finalPath}.part` };
}

/**
 * Sumidero de un archivo: escribe en `nombre.part`, calcula el SHA-256 sobre la
 * marcha y solo renombra al nombre bueno cuando el hash cuadra.
 *
 * Antes se abria el nombre definitivo con 'w' y pasaban las tres cosas de golpe:
 * se truncaba lo que ya hubiera ahi, y un fallo de integridad dejaba los bytes
 * malos instalados con el nombre bueno, que es la peor combinacion posible.
 */
export async function openFileSink({ finalPath, partPath, name, index = null, overwrite = false }) {
  // Con carpetas el destino puede estar en un subdirectorio que aun no existe.
  // La ruta ya paso por safeOutputPath, asi que crearla es crear dentro del destino.
  await fs.promises.mkdir(path.dirname(partPath), { recursive: true });
  // 'wx' falla si el `.part` ya existe; con --overwrite el `.part` es nuestro.
  const fd = await fs.promises.open(partPath, overwrite ? 'w' : 'wx');
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  let closed = false;

  const close = async () => {
    if (closed) return;
    closed = true;
    await fd.close().catch(() => {});
  };

  return {
    finalPath,
    partPath,
    index,
    name: name || path.basename(finalPath),
    get bytes() { return bytes; },

    async write(buf) {
      await fd.write(buf);
      hash.update(buf);
      bytes += buf.length;
    },

    /**
     * Cierra, compara y renombra. El cierre va ANTES del rename a proposito: en
     * Windows no se puede renombrar un archivo con el descriptor abierto.
     */
    async commit(expected) {
      const calc = hash.digest('hex');
      await close();
      if (expected && calc !== expected) {
        // Los bytes estan demostrablemente mal: el `.part` no vale ni para
        // reanudar, se borra y el nombre bueno no llega a existir.
        await fs.promises.unlink(partPath).catch(() => {});
        const err = new Error(`Error de integridad SHA-256 en ${this.name}: esperado ${expected}, calculado ${calc}`);
        err.code = 'INTEGRITY_MISMATCH';
        err.fileIndex = index;
        err.expectedHash = expected;
        err.actualHash = calc;
        throw err;
      }
      // `rename` es atomico dentro del mismo sistema de ficheros (el `.part` vive
      // en el mismo directorio) y no sigue enlaces simbolicos: un simbolico
      // plantado en el destino se reemplaza, no se escribe a traves de el.
      try {
        await fs.promises.rename(partPath, finalPath);
      } catch (err) {
        // Windows no reemplaza siempre en el rename; con --overwrite el destino
        // es nuestro para quitarlo de en medio.
        if (!overwrite || (err.code !== 'EEXIST' && err.code !== 'EPERM' && err.code !== 'EACCES')) throw err;
        await fs.promises.rm(finalPath, { force: true });
        await fs.promises.rename(partPath, finalPath);
      }
      return calc;
    },

    /**
     * Interrupcion. Se borra el `.part`: dejarlo haria que el siguiente intento
     * lo viera ocupado y acabase escribiendo `archivo (2).zip`, que es justo lo
     * que hace `askRetry` al reintentar. Reanudar transferencias (issue #21)
     * tendra que conservarlo cuando el corte sea de conexion y negociar un
     * offset; el cambio queda aqui, en una linea.
     */
    async abort() {
      await close();
      await fs.promises.unlink(partPath).catch(() => {});
    },
  };
}

/**
 * Cuelga la logica del emisor de un servidor TCP que YA existe (y que puede estar
 * ya escuchando). Se separa de `createSenderServer` porque `runSend` necesita el
 * numero de puerto antes de conocer el codigo — UPnP y la senializacion arrancan
 * con el puerto — y antes esto se resolvia creando dos servidores y rebindeando el
 * mismo puerto en carrera.
 */
// Antes de conectarse de verdad, el receptor sondea el puerto con una conexion TCP
// que cierra al instante (`probeCandidateIPs` en discovery.js). Preguntarle al
// humano por ese sondeo seria preguntarle dos veces por el mismo receptor, y la
// primera por algo que ya no existe: se espera este momento y solo se pregunta por
// lo que sigue ahi. Es tiempo muerto solo cuando hay confirmacion activada.
const PEER_SETTLE_MS = 400;

/** true si el socket sigue abierto pasado `ms`; false si se cerro antes. */
function stillConnected(socket, ms) {
  return new Promise((resolve) => {
    if (socket.destroyed) return resolve(false);
    const timer = setTimeout(() => {
      socket.off('close', onClose);
      resolve(!socket.destroyed);
    }, ms);
    function onClose() {
      clearTimeout(timer);
      resolve(false);
    }
    socket.once('close', onClose);
  });
}

export function attachSender(server, files, code, onProgress, onComplete, options = {}) {
  // La clave se deriva una vez por servidor, no por socket: scrypt cuesta 62 ms.
  const key = deriveKey(code);
  const { onPeer } = options;
  // `--limit`: se pide permiso al cubo por cada trozo antes de escribirlo. Sin
  // limite es un `take` vacio y el camino caliente no cambia.
  const throttle = options.throttle || makeThrottle(0);
  const senderSas = sasFromKey(key, splitForKey(code).roomId);
  let totalBytes = files.reduce((acc, f) => acc + f.size, 0);

  server.on('connection', (socket) => {
    socket.setNoDelay(true);
    socket.on('error', () => {});

    (async () => {
      try {
        // Nada se escribe antes de que `onPeer` diga que si: el receptor se queda
        // esperando con el socket abierto, que es lo que le permite ensenar "el
        // emisor todavia no ha autorizado" en vez de fallar. Sin `onPeer` (tests,
        // benches, `--yes`) se sirve directamente, como siempre.
        if (onPeer) {
          if (!await stillConnected(socket, PEER_SETTLE_MS)) return;
          const aprobado = await onPeer({
            address: socket.remoteAddress,
            port: socket.remotePort,
            sas: senderSas,
          });
          if (!aprobado) {
            socket.end();
            return;
          }
          if (socket.destroyed || !socket.writable) return;
        }

        // El cronometro arranca DESPUES de la autorizacion: lo que tarde un humano
        // en decidir no es ancho de banda y no tiene que salir en la media.
        const startTime = performance.now();
        // 1. Enviar manifiesto de archivos cifrado (tipo 0 = control JSON)
        const manifest = {
          v: PROTOCOL_VERSION,
          files: files.map((f) => ({ name: path.basename(f.path), size: f.size, ...(f.rel ? { path: f.rel } : {}) })),
        };
        const encManifest = encryptChunk(Buffer.concat([Buffer.from([0]), Buffer.from(JSON.stringify(manifest))]), key);
        socket.write(frame(encManifest));

        let sentTotal = 0;
        let lastReport = performance.now();
        let lastBytes = 0;
        let speed = 0;

        // 2. Transmitir cada archivo bloque a bloque con backpressure
        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          if (socket.destroyed) break;
          const fd = await fs.promises.open(file.path, 'r');
          const fileHash = crypto.createHash('sha256');

          try {
            const buffer = Buffer.allocUnsafe(CHUNK_SIZE);
            let fileOffset = 0;

            while (fileOffset < file.size) {
              if (socket.destroyed) throw new Error('Socket cerrado por el receptor');
              const bytesToRead = Math.min(CHUNK_SIZE, file.size - fileOffset);
              const { bytesRead } = await fd.read(buffer, 0, bytesToRead, fileOffset);
              if (bytesRead === 0) break;

              const slice = buffer.subarray(0, bytesRead);
              fileHash.update(slice);

              const enc = encryptChunk(Buffer.concat([Buffer.from([1]), slice]), key);
              const packet = frame(enc);

              await throttle.take(bytesRead);
              if (!socket.write(packet)) {
                await new Promise((resolve, reject) => {
                  const onDrain = () => { cleanup(); resolve(); };
                  const onClose = () => { cleanup(); reject(new Error('Socket cerrado')); };
                  const onError = (err) => { cleanup(); reject(err); };
                  const cleanup = () => {
                    socket.off('drain', onDrain);
                    socket.off('close', onClose);
                    socket.off('error', onError);
                  };
                  socket.once('drain', onDrain);
                  socket.once('close', onClose);
                  socket.once('error', onError);
                });
              }

              fileOffset += bytesRead;
              sentTotal += bytesRead;

              const now = performance.now();
              const dt = (now - lastReport) / 1000;
              if (dt >= 0.15) {
                const inst = (sentTotal - lastBytes) / dt;
                speed = speed ? speed * 0.7 + inst * 0.3 : inst;
                lastBytes = sentTotal;
                lastReport = now;
                if (onProgress) onProgress(sentTotal, totalBytes, speed, manifest.files);
              }
            }
          } finally {
            await fd.close().catch(() => {});
          }

          if (socket.destroyed) break;

          // Enviar control de fin de archivo con SHA-256 (tipo 0)
          const sha256 = fileHash.digest('hex');
          const endPayload = Buffer.concat([
            Buffer.from([0]),
            Buffer.from(JSON.stringify({ k: 'end', index: i, sha256 }))
          ]);
          socket.write(frame(encryptChunk(endPayload, key)));
        }

        if (socket.destroyed) return;

        // Enviar control done (tipo 0)
        const donePayload = Buffer.concat([
          Buffer.from([0]),
          Buffer.from(JSON.stringify({ k: 'done' }))
        ]);
        socket.write(frame(encryptChunk(donePayload, key)));

        const totalTimeSec = Math.max(0.001, (performance.now() - startTime) / 1000);
        const avgSpeed = totalBytes / totalTimeSec;

        if (onComplete) {
          onComplete({ totalBytes, totalTimeSec, avgSpeed, socket });
        } else if (onProgress) {
          onProgress(totalBytes, totalBytes, avgSpeed, manifest.files);
        }
        socket.end();
      } catch (err) {
        socket.destroy(err);
      }
    })();
  });

  return server;
}

/**
 * Servidor TCP del emisor que transmite archivos al receptor
 */
export function createSenderServer(files, code, onProgress, onComplete, options = {}) {
  return attachSender(net.createServer(), files, code, onProgress, onComplete, options);
}

/**
 * Cliente TCP del receptor que se conecta al emisor y guarda los archivos
 */
export function receiveFiles(host, port, code, outputDir, onProgress, connectTimeoutMs = 0, options = {}) {
  const { overwrite = false, onConnected } = options;
  // Del lado receptor el limite frena la LECTURA: el socket esta en pausa
  // mientras se procesa la cola, asi que dormir aqui llena el buffer TCP y el
  // emisor se frena solo por la contrapresion de siempre.
  const throttle = options.throttle || makeThrottle(0);
  return new Promise((resolve, reject) => {
    const key = deriveKey(code);
    const socket = net.connect({ host, port });
    socket.setNoDelay(true);

    // El emisor puede tardar en mandar el manifiesto si esta pidiendo confirmacion
    // a un humano. Avisar en cuanto hay socket es lo que distingue "esperando a
    // que autorice" de "esto se ha colgado".
    if (onConnected) {
      socket.once('connect', () => {
        try { onConnected(sasFromKey(key, splitForKey(code).roomId)); } catch { /* solo es un aviso */ }
      });
    }

    let connTimer = null;
    if (connectTimeoutMs > 0) {
      connTimer = setTimeout(() => {
        socket.destroy(new Error('CONNECT_TIMEOUT'));
      }, connectTimeoutMs);
      socket.on('connect', () => {
        if (connTimer) {
          clearTimeout(connTimer);
          connTimer = null;
        }
      });
    }

    let buffer = Buffer.alloc(0);
    let manifest = null;
    let destPaths = [];
    let currentFileIndex = 0;
    let sink = null;
    let committed = 0;
    const reserved = new Set();
    let totalReceived = 0;
    let totalBytes = 0;
    let lastReport = performance.now();
    let lastBytes = 0;
    let speed = 0;
    let startTime = null;
    const receivedFiles = [];
    let packetQueue = Promise.resolve();

    async function processPackets() {
      while (buffer.length >= 4) {
        const packetLen = buffer.readUInt32BE(0);
        if (buffer.length < 4 + packetLen) {
          // Esperar a que llegue el paquete completo
          break;
        }

        const packet = buffer.subarray(4, 4 + packetLen);
        buffer = buffer.subarray(4 + packetLen);

        // El primer paquete es tambien la autenticacion: si la clave no coincide,
        // AES-GCM falla el tag y OpenSSL suelta un "unable to authenticate data"
        // que no le dice nada a nadie. Lo traducimos a lo que de verdad ha pasado.
        let decrypted;
        try {
          decrypted = decryptChunk(packet, key);
        } catch (err) {
          if (!manifest) {
            const wrong = new Error('El código no coincide con el del emisor: revisa las palabras.');
            wrong.code = 'BAD_CODE';
            throw wrong;
          }
          throw err;
        }
        if (decrypted.length === 0) continue;

        // El tipo de trama ya no se adivina por el contenido: 0x00 es control,
        // 0x01 son datos y cualquier otra cosa es un emisor que habla otro
        // protocolo. Antes se colaba una tercera rama para el emisor sin prefijo,
        // donde ese byte era CONTENIDO del archivo.
        const type = decrypted[0];
        if (type !== 0 && type !== 1) {
          const err = new Error(
            `Trama de tipo ${type} desconocida: el emisor usa una versión de drop incompatible. Actualiza drop en los dos equipos.`
          );
          err.code = 'PROTOCOL_FRAME';
          throw err;
        }
        const payload = decrypted.subarray(1);

        if (type === 0) {
          let msg;
          try {
            msg = JSON.parse(payload.toString());
          } catch {
            const err = new Error('El emisor ha mandado un marco de control ilegible.');
            err.code = 'PROTOCOL_ERROR';
            throw err;
          }

          if (!manifest) {
            // El primer marco de control TIENE que ser el manifiesto y TIENE que
            // declarar su version: sin eso no se sabe como leer lo que venga
            // detras, y adivinarlo es exactamente lo que corrompia archivos.
            if (msg.v !== PROTOCOL_VERSION) {
              const err = new Error(
                `El emisor usa la versión ${msg.v ?? '0 (drop anterior a la 0.5.0)'} del protocolo y este receptor la ${PROTOCOL_VERSION}: actualiza drop en los dos equipos.`
              );
              err.code = 'PROTOCOL_VERSION';
              err.senderVersion = msg.v ?? 0;
              err.supportedVersion = PROTOCOL_VERSION;
              throw err;
            }
            if (!Array.isArray(msg.files)) {
              const err = new Error('El primer marco del emisor no es el manifiesto de archivos.');
              err.code = 'PROTOCOL_ERROR';
              throw err;
            }

            manifest = msg;
            totalBytes = manifest.files.reduce((acc, f) => acc + f.size, 0);
            // Los nombres se validan y se RESERVAN todos aqui, antes de abrir el
            // primer descriptor: si el manifiesto trae una ruta que se sale del
            // destino, la transferencia se corta sin haber escrito ni un byte, y
            // dos archivos con el mismo nombre reciben ya destinos distintos.
            destPaths = manifest.files.map((f) => reserveOutputPath(outputDir, f.name, reserved, { overwrite, subpath: f.path ?? null }));
            startTime = performance.now();
            if (manifest.files.length > 0) {
              sink = await openFileSink({ ...destPaths[0], name: manifest.files[0].name, index: 0, overwrite });
              receivedFiles.push({ path: sink.finalPath, name: path.basename(sink.finalPath), verified: false });
            }
            continue;
          }

          if (msg.k === 'end') {
            if (!sink) {
              const err = new Error('El emisor cierra un archivo que nunca abrió.');
              err.code = 'PROTOCOL_ERROR';
              throw err;
            }
            // `commit` verifica, borra el `.part` si el hash no cuadra y solo
            // entonces renombra: el nombre bueno nunca llega a existir con bytes
            // sin verificar.
            const calcHash = await sink.commit(msg.sha256);
            sink = null;
            committed++;
            const item = receivedFiles[msg.index] || receivedFiles[receivedFiles.length - 1];
            if (item) {
              item.verified = true;
              item.sha256 = calcHash || msg.sha256;
            }
            currentFileIndex = msg.index + 1;
            if (currentFileIndex < manifest.files.length) {
              sink = await openFileSink({
                ...destPaths[currentFileIndex],
                name: manifest.files[currentFileIndex].name,
                index: currentFileIndex,
                overwrite,
              });
              receivedFiles.push({ path: sink.finalPath, name: path.basename(sink.finalPath), verified: false });
            }
            continue;
          }

          // `done` y cualquier control que no conozcamos se ignoran. Lo que NO
          // pueden hacer es caer al camino de datos: antes un `k` desconocido
          // acababa escrito dentro del archivo y sumado a su SHA-256.
          continue;
        }

        // Tipo 0x01: datos del archivo en curso.
        if (payload.length === 0) continue;
        if (!sink) {
          const err = new Error('El emisor manda datos sin haber abierto ningún archivo.');
          err.code = 'PROTOCOL_ERROR';
          throw err;
        }

        await throttle.take(payload.length);
        await sink.write(payload);
        totalReceived += payload.length;

        const now = performance.now();
        const dt = (now - lastReport) / 1000;
        if (dt >= 0.15) {
          const inst = (totalReceived - lastBytes) / dt;
          speed = speed ? speed * 0.7 + inst * 0.3 : inst;
          lastBytes = totalReceived;
          lastReport = now;
          if (onProgress) onProgress(totalReceived, totalBytes, speed, manifest.files);
        }
      }
    }

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      packetQueue = packetQueue.then(async () => {
        socket.pause();
        try {
          await processPackets();
        } finally {
          socket.resume();
        }
      }).catch(async (err) => {
        // El `.part` a medias se borra ANTES de rechazar: quien espera la promesa
        // mira el directorio en cuanto le llega el error, y `socket.destroy` de
        // aqui abajo hace su limpieza demasiado tarde para eso.
        if (sink) {
          const abandoned = sink;
          sink = null;
          await abandoned.abort().catch(() => {});
        }
        socket.destroy();
        reject(err);
      });
    });

    socket.on('end', async () => {
      try {
        await packetQueue;
        if (connTimer) {
          clearTimeout(connTimer);
          connTimer = null;
        }
        // Antes esto resolvia pasara lo que pasara: un emisor que se moria a
        // media transferencia dejaba archivos cortos con su nombre bueno y la
        // promesa daba la descarga por buena.
        if (!manifest || committed < manifest.files.length) {
          if (sink) {
            await sink.abort();
            sink = null;
          }
          const err = new Error('El emisor ha cerrado la conexión antes de terminar la transferencia.');
          err.code = 'TRUNCATED';
          throw err;
        }
        const totalTimeSec = Math.max(0.001, (performance.now() - (startTime || performance.now())) / 1000);
        const avgSpeed = totalBytes / totalTimeSec;
        receivedFiles.stats = { totalBytes, totalTimeSec, avgSpeed };
        // El emisor ya ha cerrado su mitad: cerrar la nuestra o la conexion se queda
        // a medias y mantiene vivo el proceso de quien use esto como libreria.
        socket.end();
        resolve(receivedFiles);
      } catch (err) {
        reject(err);
      }
    });

    socket.on('error', (err) => {
      if (connTimer) {
        clearTimeout(connTimer);
        connTimer = null;
      }
      // El `.part` a medias se borra: dejarlo haria que el siguiente intento lo
      // viera ocupado y acabase escribiendo `archivo (2).zip`.
      if (sink) {
        const abandoned = sink;
        sink = null;
        abandoned.abort().catch(() => {});
      }
      reject(err);
    });
  });
}

// ============================================================================
// PROTOCOLO DE RELAY DEL CLI  (la descripcion canonica: esta solo aqui)
// ============================================================================
//
// Cuando no hay ruta TCP directa -- NAT estricta, cortafuegos, o el receptor es
// un navegador -- los bytes viajan por el WebSocket de senializacion. Hay TRES
// implementaciones parciales de esto: el emisor en cli/src/cli.js
// (`streamToWebGuest` y el bucle de `signal`), el receptor de aqui
// (`receiveFromRelay`) y el receptor web en public/app.js (`routeSignal`).
// Estaban sin describir en ningun sitio, y las divergencias entre ellas son
// exactamente la causa de que el receptor CLI no mandase los acuses que el
// emisor esperaba y la transferencia se parase en seco a los 8 MB.
//
// El servidor no entiende nada de esto: reenvia `{t:'signal', to, data}` a quien
// diga `to`, dentro de la misma sala, y los frames binarios tal cual (del emisor
// llevan 4 bytes de guestId por delante que el servidor quita; del receptor van
// siempre al emisor). Ver la rama binaria de server/index.js.
//
// MENSAJES, en el orden en que ocurren
//
//   cli-offer      emisor -> receptor. Al entrar alguien en la sala. Lleva `v`
//                  (PROTOCOL_VERSION), las IPs y el puerto para intentar TCP
//                  directo, y un `nonce` nuevo por receptor. NO lleva el
//                  manifiesto: acertar una sala son 4 digitos y los nombres de
//                  los archivos ya son informacion. El receptor corta aqui si
//                  `v` no es la suya: es lo unico que va en claro y lo unico
//                  que hace falta mirar para saber si se va a entender el resto.
//   cli-proof      receptor -> emisor. `proofFromKey(clave, nonce)` y `v`:
//                  demuestra que ha derivado la misma clave scrypt que el
//                  emisor. Solo lo manda quien va a comer por el relay; por TCP
//                  directo la prueba es que AES-GCM autentique. Es un HMAC con
//                  la CLAVE y no un hash del secreto porque pasa por el servidor
//                  (public/shared/e2ee.js explica por que importa).
//   cli-denied     emisor -> receptor. El codigo era bueno pero quien envia ha
//                  dicho que no. Es un rechazo, no un fallo de emparejamiento.
//                  Con `reason: 'VERSION'` es que el receptor habla otra version.
//
//   A PARTIR DE AQUI TODO LO QUE MANDA EL EMISOR VA CIFRADO con la clave de la
//   sala (AES-256-GCM, cli/src/crypto.js). Los marcos de control viajan como
//   `{ type: 'cli-sealed', box }` con el marco de siempre dentro (sealFrame /
//   unsealFrame); los trozos binarios son el paquete [IV][tag][ciphertext] tal
//   cual. El servidor reenvia igual que antes: para el es ruido con destino.
//
//   cli-manifest   emisor -> receptor. La lista de archivos, ya autorizada.
//   cli-accept     receptor -> emisor. "Listo para recibir": abre el envio.
//
//   cli-start      emisor -> receptor. Empieza el archivo `index`, con nombre,
//                  tamano y mime. Un `cli-start` con un archivo aun abierto
//                  significa que el emisor se salto su `cli-end`: lo que hubiera
//                  a medias no esta verificado y su `.part` se tira.
//   (binario)      emisor -> receptor. Trozos de 64 KiB del archivo en curso, en
//                  orden, cada uno cifrado por separado. El receptor descifra y
//                  cuenta BYTES EN CLARO: los acuses y el progreso hablan del
//                  archivo, no del cable.
//   cli-ack        receptor -> emisor. Bytes totales recibidos, cada
//                  RELAY_ACK_EVERY (2 MB). Ver el control de flujo abajo.
//   cli-end        emisor -> receptor. Cierra el archivo `index` con su
//                  `sha256`. El receptor compara, borra el `.part` si no cuadra
//                  y solo entonces renombra al nombre definitivo.
//   cli-done       emisor -> receptor. No quedan archivos.
//   cli-complete   receptor -> emisor. Se manda con TODO ya escrito en disco, no
//                  al recibir `cli-done`: es lo que permite al emisor dar la
//                  transferencia por buena y soltar la ventana.
//
//   cli-retry      receptor -> emisor. Reenvia desde el archivo `index`
//                  (inclusive). Lo usa el receptor web cuando un hash no cuadra.
//   cli-error      receptor -> emisor. Algo se ha roto de este lado; el emisor
//                  suelta la ventana y da ese receptor por perdido.
//
// CONTROL DE FLUJO: es lo que se rompio, y es una ventana de acuses
//
// El emisor no manda mas de MAX_IN_FLIGHT (8 MB, cli.js) sin confirmar, y se
// para tambien si su propio `ws.bufferedAmount` pasa de 4 MB. Lo unico que mueve
// esa marca es el `cli-ack` del receptor. Un receptor que no acuse recibo no va
// "un poco mas lento": los dos extremos se quedan esperando para siempre en
// cuanto se llenan los 8 MB. Por eso los dos receptores acusan cada 2 MB
// (RELAY_ACK_EVERY aqui, ACK_EVERY en public/app.js) y ese numero tiene que
// quedarse muy por debajo de la ventana.
//
// El acuse dice BYTES TOTALES de la transferencia, no del archivo: es
// monotono creciente y el emisor se queda con el maximo, asi que un acuse que
// llegue tarde o repetido no hace retroceder nada.
//
// Y hay un reloj de inactividad en el receptor (RELAY_IDLE_TIMEOUT_MS) que se
// rearma con cualquier senial de vida: sin el, un fallo del emisor dejaba al
// receptor colgado sin error y sin salida.
/**
 * Cliente Relay que recibe los archivos en streaming a traves del WebSocket de
 * senializacion. La descripcion del protocolo esta justo arriba.
 */
export function receiveFromRelay(ws, manifest, outputDir, onProgress, options = {}) {
  const { overwrite = false, key } = options;
  // Por relay no hay contrapresion TCP con el emisor: lo que le frena es que
  // los acuses lleguen tarde, y los acuses salen de esta misma cola, detras de
  // la espera. Con la ventana de 8 MB el emisor se para en cuanto el receptor
  // se retrasa, y la media queda en el limite.
  const throttle = options.throttle || makeThrottle(0);
  if (!key) throw new Error('receiveFromRelay necesita la clave de la sala: el relay va cifrado');
  return new Promise((resolve, reject) => {
    let sink = null;
    const reserved = new Set();
    let totalBytes = manifest.reduce((acc, f) => acc + (f.size || 0), 0);
    let totalReceived = 0;
    let lastReport = performance.now();
    let lastBytes = 0;
    let speed = 0;
    let startTime = null;
    const receivedFiles = [];
    let writeQueue = Promise.resolve();
    let lastAckBytes = 0;
    let idleTimer = null;

    fs.mkdirSync(outputDir, { recursive: true });

    const sendSignal = (data) => {
      try { ws.send(JSON.stringify({ t: 'signal', data })); } catch {}
    };

    // Reloj de inactividad: se rearma con cada senial de vida del emisor (datos o
    // control) y solo salta cuando de verdad no llega nada.
    const armIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        failWithError(new Error(
          `El emisor ha dejado de enviar: ${Math.round(RELAY_IDLE_TIMEOUT_MS / 1000)}s sin recibir nada por el relay.`
        ));
      }, RELAY_IDLE_TIMEOUT_MS);
      idleTimer.unref?.();
    };

    const cleanup = () => {
      ws.removeEventListener('message', onMsg);
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      if (sink) {
        // Se abandona el archivo a medias sin dejar el `.part` de rastro; el
        // nombre bueno nunca se creó, así que no hay nada que corregir.
        const abandoned = sink;
        sink = null;
        abandoned.abort().catch(() => {});
      }
    };

    const failWithError = (err) => {
      sendSignal({ type: 'cli-error', message: err.message });
      cleanup();
      reject(err);
    };

    const onMsg = (ev) => {
      armIdleTimer();
      if (typeof ev.data !== 'string') {
        const data = ev.data;
        if (!startTime) startTime = performance.now();
        writeQueue = writeQueue.then(async () => {
          const packet = Buffer.isBuffer(data)
            ? data
            : Buffer.from(data instanceof ArrayBuffer ? data : await data.arrayBuffer());
          // Un trozo que no autentica no se escribe ni se cuenta: o lo ha tocado
          // alguien por el camino o el emisor cifra con otra clave, y en los dos
          // casos lo que hay que hacer es cortar, no adivinar.
          let chunk;
          try {
            chunk = decryptChunk(packet, key);
          } catch {
            const err = new Error('Un trozo del relay no autentica: se corta la descarga.');
            err.code = 'PROTOCOL_ERROR';
            throw err;
          }
          if (sink) {
            await throttle.take(chunk.length);
            await sink.write(chunk);
            totalReceived += chunk.length;

            const now = performance.now();
            const dt = (now - lastReport) / 1000;
            if (dt >= 0.15) {
              const inst = (totalReceived - lastBytes) / dt;
              speed = speed ? speed * 0.7 + inst * 0.3 : inst;
              lastBytes = totalReceived;
              lastReport = now;
              if (onProgress) onProgress(totalReceived, totalBytes, speed, manifest);
            }

            // Acuse de recibo: sin esto el emisor se para a los 8 MB y los dos
            // extremos se quedan esperando para siempre.
            if (totalReceived - lastAckBytes >= RELAY_ACK_EVERY || totalReceived >= totalBytes) {
              lastAckBytes = totalReceived;
              sendSignal({ type: 'cli-ack', bytes: totalReceived });
            }
          }
        }).catch(failWithError);
        return;
      }

      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }

      if (msg.t === 'signal') {
        let { data } = msg;
        // Del emisor solo se acepta lo que viene sellado: un marco en claro con
        // `type: 'cli-start'` lo podria fabricar cualquiera que este en la sala.
        if (data?.type !== 'cli-sealed') return;
        try {
          data = unsealFrame(data, key);
        } catch {
          failWithError(Object.assign(
            new Error('Un marco de control del relay no autentica: se corta la descarga.'),
            { code: 'PROTOCOL_ERROR' },
          ));
          return;
        }
        if (data?.type === 'cli-start') {
          if (!startTime) startTime = performance.now();
          writeQueue = writeQueue.then(async () => {
            // Un `cli-start` con un archivo todavía abierto significa que el
            // emisor se ha saltado su `cli-end`: no está verificado, así que no
            // se promociona al nombre bueno.
            if (sink) {
              await sink.abort();
              sink = null;
            }
            const idx = data.index || 0;
            // Aquí los nombres llegan de uno en uno, así que el conjunto de
            // reservas se arrastra entre mensajes en vez de calcularse de golpe.
            const paths = reserveOutputPath(outputDir, data.name || 'archivo', reserved, { overwrite, subpath: data.path ?? null });
            sink = await openFileSink({ ...paths, name: data.name, index: idx, overwrite });
            receivedFiles.push({ path: sink.finalPath, name: path.basename(sink.finalPath), verified: false });
          }).catch(failWithError);
        } else if (data?.type === 'cli-end') {
          writeQueue = writeQueue.then(async () => {
            if (!sink) {
              const err = new Error('El emisor cierra un archivo que nunca abrió.');
              err.code = 'PROTOCOL_ERROR';
              throw err;
            }
            // Verifica, borra el `.part` si no cuadra y solo entonces renombra.
            const closing = sink;
            sink = null;
            const calcHash = await closing.commit(data.sha256);
            const item = receivedFiles[data.index] || receivedFiles[receivedFiles.length - 1];
            if (item) {
              item.verified = true;
              item.sha256 = calcHash || data.sha256;
            }
          }).catch(failWithError);
        } else if (data?.type === 'cli-done') {
          writeQueue = writeQueue.then(async () => {
            // Un archivo todavía abierto aquí no llegó a verificarse: se tira su
            // `.part` en vez de darlo por bueno con el nombre definitivo.
            if (sink) {
              await sink.abort();
              sink = null;
            }
            // El emisor espera este mensaje para dar la transferencia por buena y
            // soltar la ventana: se manda con todo ya escrito en disco.
            sendSignal({ type: 'cli-complete', bytes: totalReceived });
            const totalTimeSec = Math.max(0.001, (performance.now() - (startTime || performance.now())) / 1000);
            const avgSpeed = totalBytes / totalTimeSec;
            receivedFiles.stats = { totalBytes, totalTimeSec, avgSpeed };
            cleanup();
            resolve(receivedFiles);
          }).catch(failWithError);
        }
      }
    };

    ws.addEventListener('message', onMsg);
    ws.addEventListener('error', (err) => {
      failWithError(err);
    }, { once: true });
    ws.addEventListener('close', () => {
      cleanup();
      if (receivedFiles.length > 0 && totalReceived >= totalBytes) {
        if (!receivedFiles.stats) {
          const totalTimeSec = Math.max(0.001, (performance.now() - (startTime || performance.now())) / 1000);
          const avgSpeed = totalBytes / totalTimeSec;
          receivedFiles.stats = { totalBytes, totalTimeSec, avgSpeed };
        }
        resolve(receivedFiles);
      } else {
        reject(new Error('Conexión cerrada por el servidor antes de completar la descarga'));
      }
    }, { once: true });

    // Notificar al emisor que estamos listos para recibir por Relay
    armIdleTimer();
    sendSignal({ type: 'cli-accept' });
  });
}
