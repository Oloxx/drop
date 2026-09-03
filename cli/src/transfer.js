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
export function createSenderServer(files, token, onProgress, onComplete) {
  const key = deriveKey(token);
  let totalBytes = files.reduce((acc, f) => acc + f.size, 0);

  const server = net.createServer((socket) => {
    socket.setNoDelay(true);
    socket.on('error', () => {});

    (async () => {
      try {
        const startTime = performance.now();
        // 1. Enviar manifiesto de archivos cifrado
        const manifest = { files: files.map((f) => ({ name: path.basename(f.path), size: f.size })) };
        const encManifest = encryptChunk(Buffer.from(JSON.stringify(manifest)), key);
        socket.write(frame(encManifest));

        let sentTotal = 0;
        let lastReport = performance.now();
        let lastBytes = 0;
        let speed = 0;

        // 2. Transmitir cada archivo bloque a bloque con backpressure
        for (const file of files) {
          const fd = await fs.promises.open(file.path, 'r');
          const buffer = Buffer.allocUnsafe(CHUNK_SIZE);
          let fileOffset = 0;

          while (fileOffset < file.size) {
            const bytesToRead = Math.min(CHUNK_SIZE, file.size - fileOffset);
            const { bytesRead } = await fd.read(buffer, 0, bytesToRead, fileOffset);
            if (bytesRead === 0) break;

            const slice = buffer.subarray(0, bytesRead);
            const enc = encryptChunk(slice, key);
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
        }

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
export function receiveFiles(host, port, token, outputDir, onProgress, connectTimeoutMs = 0) {
  return new Promise((resolve, reject) => {
    const key = deriveKey(token);
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
    let currentFileBytes = 0;
    let totalReceived = 0;
    let totalBytes = 0;
    let lastReport = performance.now();
    let lastBytes = 0;
    let speed = 0;
    let startTime = null;
    const receivedFiles = [];

    async function processPackets() {
      while (buffer.length >= 4) {
        const packetLen = buffer.readUInt32BE(0);
        if (buffer.length < 4 + packetLen) {
          // Esperar a que llegue el paquete completo
          break;
        }

        const packet = buffer.subarray(4, 4 + packetLen);
        buffer = buffer.subarray(4 + packetLen);

        const decrypted = decryptChunk(packet, key);

        if (!manifest) {
          manifest = JSON.parse(decrypted.toString());
          totalBytes = manifest.files.reduce((acc, f) => acc + f.size, 0);
          startTime = performance.now();
          if (manifest.files.length > 0) {
            const f = manifest.files[0];
            const dest = path.join(outputDir, f.name);
            currentFd = await fs.promises.open(dest, 'w');
            receivedFiles.push(dest);
          }
          continue;
        }

        // Escribir datos en el archivo actual
        if (currentFd && decrypted.length > 0) {
          await currentFd.write(decrypted);
          currentFileBytes += decrypted.length;
          totalReceived += decrypted.length;

          const now = performance.now();
          const dt = (now - lastReport) / 1000;
          if (dt >= 0.15) {
            const inst = (totalReceived - lastBytes) / dt;
            speed = speed ? speed * 0.7 + inst * 0.3 : inst;
            lastBytes = totalReceived;
            lastReport = now;
            if (onProgress) onProgress(totalReceived, totalBytes, speed);
          }

          const currentTarget = manifest.files[currentFileIndex];
          if (currentFileBytes >= currentTarget.size) {
            await currentFd.close();
            currentFd = null;
            currentFileBytes = 0;
            currentFileIndex++;
            if (currentFileIndex < manifest.files.length) {
              const nextF = manifest.files[currentFileIndex];
              const dest = path.join(outputDir, nextF.name);
              currentFd = await fs.promises.open(dest, 'w');
              receivedFiles.push(dest);
            }
          }
        }
      }
    }

    socket.on('data', async (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      socket.pause();
      try {
        await processPackets();
      } catch (err) {
        socket.destroy(err);
        return reject(err);
      }
      socket.resume();
    });

    socket.on('end', async () => {
      if (connTimer) {
        clearTimeout(connTimer);
        connTimer = null;
      }
      if (currentFd) await currentFd.close();
      const totalTimeSec = Math.max(0.001, (performance.now() - (startTime || performance.now())) / 1000);
      const avgSpeed = totalBytes / totalTimeSec;
      receivedFiles.stats = { totalBytes, totalTimeSec, avgSpeed };
      resolve(receivedFiles);
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
            const filename = path.basename(data.name || 'archivo');
            const dest = path.join(outputDir, filename);
            currentFd = await fs.promises.open(dest, 'w');
            receivedFiles.push(dest);
          }).catch(failWithError);
        } else if (data?.type === 'cli-end') {
          writeQueue = writeQueue.then(async () => {
            if (currentFd) {
              await currentFd.close();
              currentFd = null;
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
