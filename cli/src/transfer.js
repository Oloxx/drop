import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { deriveKey, encryptChunk, decryptChunk } from './crypto.js';
import { renderProgressBar } from './ui.js';

const CHUNK_SIZE = 512 * 1024; // 512 KB por bloque para equilibrar streaming y memoria

/**
 * Empaqueta un buffer con prefijo de longitud de 4 bytes (UInt32BE)
 */
function frame(buf) {
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(buf.length, 0);
  return Buffer.concat([header, buf]);
}

/**
 * Servidor TCP del emisor que transmite archivos al receptor
 */
export function createSenderServer(files, code, onProgress, onComplete) {
  // La clave se deriva una vez por servidor, no por socket: scrypt cuesta 62 ms.
  const key = deriveKey(code);
  let totalBytes = files.reduce((acc, f) => acc + f.size, 0);

  const server = net.createServer((socket) => {
    socket.setNoDelay(true);
    socket.on('error', () => {});

    (async () => {
      try {
        const startTime = performance.now();
        // 1. Enviar manifiesto de archivos cifrado (tipo 0 = control JSON)
        const manifest = { files: files.map((f) => ({ name: path.basename(f.path), size: f.size })) };
        const encManifest = encryptChunk(Buffer.concat([Buffer.from([0]), Buffer.from(JSON.stringify(manifest))]), key);
        socket.write(frame(encManifest));

        let sentTotal = 0;
        let lastReport = performance.now();
        let lastBytes = 0;
        let speed = 0;

        // 2. Transmitir cada archivo bloque a bloque con backpressure
        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          const fd = await fs.promises.open(file.path, 'r');
          const buffer = Buffer.allocUnsafe(CHUNK_SIZE);
          let fileOffset = 0;
          const fileHash = crypto.createHash('sha256');

          while (fileOffset < file.size) {
            const bytesToRead = Math.min(CHUNK_SIZE, file.size - fileOffset);
            const { bytesRead } = await fd.read(buffer, 0, bytesToRead, fileOffset);
            if (bytesRead === 0) break;

            const slice = buffer.subarray(0, bytesRead);
            fileHash.update(slice);

            const enc = encryptChunk(Buffer.concat([Buffer.from([1]), slice]), key);
            const packet = frame(enc);

            if (!socket.write(packet)) {
              await new Promise((r) => socket.once('drain', r));
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
              if (onProgress) onProgress(sentTotal, totalBytes, speed);
            }
          }

          await fd.close();

          // Enviar control de fin de archivo con SHA-256 (tipo 0)
          const sha256 = fileHash.digest('hex');
          const endPayload = Buffer.concat([
            Buffer.from([0]),
            Buffer.from(JSON.stringify({ k: 'end', index: i, sha256 }))
          ]);
          socket.write(frame(encryptChunk(endPayload, key)));
        }

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
          onProgress(totalBytes, totalBytes, avgSpeed);
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
 * Cliente TCP del receptor que se conecta al emisor y guarda los archivos
 */
export function receiveFiles(host, port, code, outputDir, onProgress, connectTimeoutMs = 0) {
  return new Promise((resolve, reject) => {
    const key = deriveKey(code);
    const socket = net.connect({ host, port });
    socket.setNoDelay(true);

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
    let currentFileIndex = 0;
    let currentFd = null;
    let currentFileHash = null;
    let currentFileBytes = 0;
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

        let isControl = false;
        let payload = decrypted;

        if (decrypted[0] === 0) {
          isControl = true;
          payload = decrypted.subarray(1);
        } else if (decrypted[0] === 1) {
          isControl = false;
          payload = decrypted.subarray(1);
        } else if (!manifest && decrypted[0] === 0x7b) {
          // Compatibilidad con emisor antiguo sin prefijo
          isControl = true;
          payload = decrypted;
        }

        if (isControl) {
          let msg;
          try {
            msg = JSON.parse(payload.toString());
          } catch {
            continue;
          }

          if (!manifest && msg.files) {
            manifest = msg;
            totalBytes = manifest.files.reduce((acc, f) => acc + f.size, 0);
            startTime = performance.now();
            if (manifest.files.length > 0) {
              const f = manifest.files[0];
              const dest = path.join(outputDir, f.name);
              currentFd = await fs.promises.open(dest, 'w');
              currentFileHash = crypto.createHash('sha256');
              receivedFiles.push({ path: dest, name: f.name, verified: false });
            }
            continue;
          }

          if (msg.k === 'end') {
            if (currentFd) {
              await currentFd.close();
              currentFd = null;
            }
            const calcHash = currentFileHash ? currentFileHash.digest('hex') : null;
            currentFileHash = null;
            const target = manifest?.files[msg.index];
            if (msg.sha256 && calcHash && calcHash !== msg.sha256) {
              const err = new Error(`Error de integridad SHA-256 en ${target?.name || 'archivo'}: esperado ${msg.sha256}, calculado ${calcHash}`);
              err.code = 'INTEGRITY_MISMATCH';
              err.fileIndex = msg.index;
              err.expectedHash = msg.sha256;
              err.actualHash = calcHash;
              throw err;
            }
            const item = receivedFiles[msg.index] || receivedFiles[receivedFiles.length - 1];
            if (item) {
              item.verified = true;
              item.sha256 = calcHash || msg.sha256;
            }
            currentFileIndex = msg.index + 1;
            currentFileBytes = 0;
            if (currentFileIndex < manifest.files.length) {
              const nextF = manifest.files[currentFileIndex];
              const dest = path.join(outputDir, nextF.name);
              currentFd = await fs.promises.open(dest, 'w');
              currentFileHash = crypto.createHash('sha256');
              receivedFiles.push({ path: dest, name: nextF.name, verified: false });
            }
            continue;
          }

          if (msg.k === 'done') {
            continue;
          }
        }

        // Escribir datos en el archivo actual
        if (currentFd && payload.length > 0) {
          await currentFd.write(payload);
          if (currentFileHash) currentFileHash.update(payload);
          currentFileBytes += payload.length;
          totalReceived += payload.length;

          const now = performance.now();
          const dt = (now - lastReport) / 1000;
          if (dt >= 0.15) {
            const inst = (totalReceived - lastBytes) / dt;
            speed = speed ? speed * 0.7 + inst * 0.3 : inst;
            lastBytes = totalReceived;
            lastReport = now;
            if (onProgress) onProgress(totalReceived, totalBytes, speed);
          }

          // Compatibilidad: si un emisor antiguo no manda k === 'end'
          const currentTarget = manifest?.files[currentFileIndex];
          if (currentTarget && currentFileBytes >= currentTarget.size && decrypted[0] !== 0 && decrypted[0] !== 1) {
            await currentFd.close();
            currentFd = null;
            const calcHash = currentFileHash ? currentFileHash.digest('hex') : null;
            currentFileHash = null;
            const item = receivedFiles[currentFileIndex];
            if (item) {
              item.verified = true;
              item.sha256 = calcHash;
            }
            currentFileBytes = 0;
            currentFileIndex++;
            if (currentFileIndex < manifest.files.length) {
              const nextF = manifest.files[currentFileIndex];
              const dest = path.join(outputDir, nextF.name);
              currentFd = await fs.promises.open(dest, 'w');
              currentFileHash = crypto.createHash('sha256');
              receivedFiles.push({ path: dest, name: nextF.name, verified: false });
            }
          }
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
      }).catch((err) => {
        socket.destroy(err);
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
        if (currentFd) await currentFd.close();
        const totalTimeSec = Math.max(0.001, (performance.now() - (startTime || performance.now())) / 1000);
        const avgSpeed = totalBytes / totalTimeSec;
        receivedFiles.stats = { totalBytes, totalTimeSec, avgSpeed };
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
      if (currentFd) currentFd.close().catch(() => {});
      reject(err);
    });
  });
}

/**
 * Cliente Relay que recibe los archivos en streaming a través del WebSocket de señalización
 */
export function receiveFromRelay(ws, manifest, outputDir, onProgress) {
  return new Promise((resolve, reject) => {
    let currentFd = null;
    let currentFileHash = null;
    let currentTarget = null;
    let totalBytes = manifest.reduce((acc, f) => acc + (f.size || 0), 0);
    let totalReceived = 0;
    let lastReport = performance.now();
    let lastBytes = 0;
    let speed = 0;
    let startTime = null;
    const receivedFiles = [];
    let writeQueue = Promise.resolve();

    fs.mkdirSync(outputDir, { recursive: true });

    const cleanup = () => {
      ws.removeEventListener('message', onMsg);
      if (currentFd) {
        currentFd.close().catch(() => {});
        currentFd = null;
      }
    };

    const failWithError = (err) => {
      try {
        ws.send(JSON.stringify({
          t: 'signal',
          data: { type: 'cli-error', message: err.message }
        }));
      } catch {}
      cleanup();
      reject(err);
    };

    const onMsg = (ev) => {
      if (typeof ev.data !== 'string') {
        const data = ev.data;
        if (!startTime) startTime = performance.now();
        writeQueue = writeQueue.then(async () => {
          const chunk = Buffer.isBuffer(data)
            ? data
            : Buffer.from(data instanceof ArrayBuffer ? data : await data.arrayBuffer());
          if (currentFd) {
            await currentFd.write(chunk);
            if (currentFileHash) currentFileHash.update(chunk);
            totalReceived += chunk.length;

            const now = performance.now();
            const dt = (now - lastReport) / 1000;
            if (dt >= 0.15) {
              const inst = (totalReceived - lastBytes) / dt;
              speed = speed ? speed * 0.7 + inst * 0.3 : inst;
              lastBytes = totalReceived;
              lastReport = now;
              if (onProgress) onProgress(totalReceived, totalBytes, speed);
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
        const { data } = msg;
        if (data?.type === 'cli-start') {
          if (!startTime) startTime = performance.now();
          writeQueue = writeQueue.then(async () => {
            if (currentFd) {
              await currentFd.close();
              currentFd = null;
            }
            const idx = data.index || 0;
            currentTarget = manifest[idx] || { name: data.name, size: data.size };
            currentFileHash = crypto.createHash('sha256');
            const filename = path.basename(data.name || 'archivo');
            const dest = path.join(outputDir, filename);
            currentFd = await fs.promises.open(dest, 'w');
            receivedFiles.push({ path: dest, name: filename, verified: false });
          }).catch(failWithError);
        } else if (data?.type === 'cli-end') {
          writeQueue = writeQueue.then(async () => {
            if (currentFd) {
              await currentFd.close();
              currentFd = null;
            }
            const calcHash = currentFileHash ? currentFileHash.digest('hex') : null;
            currentFileHash = null;
            if (data.sha256 && calcHash && calcHash !== data.sha256) {
              const err = new Error(`Error de integridad SHA-256 en ${currentTarget?.name || 'archivo'}: esperado ${data.sha256}, calculado ${calcHash}`);
              err.code = 'INTEGRITY_MISMATCH';
              throw err;
            }
            const item = receivedFiles[data.index] || receivedFiles[receivedFiles.length - 1];
            if (item) {
              item.verified = true;
              item.sha256 = calcHash || data.sha256;
            }
          }).catch(failWithError);
        } else if (data?.type === 'cli-done') {
          writeQueue = writeQueue.then(async () => {
            if (currentFd) {
              await currentFd.close();
              currentFd = null;
            }
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
    ws.send(JSON.stringify({
      t: 'signal',
      data: { type: 'cli-accept' }
    }));
  });
}
