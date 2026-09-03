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
export function createSenderServer(files, token, onProgress) {
  const key = deriveKey(token);
  let totalBytes = files.reduce((acc, f) => acc + f.size, 0);

  const server = net.createServer((socket) => {
    socket.setNoDelay(true);

    (async () => {
      try {
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

        // Finalizar reporte
        if (onProgress) onProgress(totalBytes, totalBytes, speed);
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
export function receiveFiles(host, port, token, outputDir, onProgress) {
  return new Promise((resolve, reject) => {
    const key = deriveKey(token);
    const socket = net.connect({ host, port });
    socket.setNoDelay(true);

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
      if (currentFd) await currentFd.close();
      if (onProgress) onProgress(totalBytes, totalBytes, speed);
      resolve(receivedFiles);
    });

    socket.on('error', (err) => {
      if (currentFd) currentFd.close().catch(() => {});
      reject(err);
    });
  });
}
