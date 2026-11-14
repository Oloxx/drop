// Escritor ZIP en streaming (public/shared/zip.js): CRC-32, saneado de rutas,
// colisiones, nombres UTF-8, entradas vacias, archivos de varios trozos y
// activacion automatica de ZIP64 al pasar de los limites de 32/16 bits.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

import { ZipWriter, crc32Update, sanitizeZipPath, zipArchiveName } from '../public/shared/zip.js';

/** Lee el directorio central y devuelve las entradas con su contenido extraido. */
function parseZip(buf) {
  // Busca EOCD desde el final (sin comentario, esta en los ultimos 22 bytes).
  let eocdOff = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocdOff = i; break; }
  }
  assert.ok(eocdOff >= 0, 'falta End of Central Directory');

  let totalEntries = buf.readUInt16LE(eocdOff + 10);
  let cdOffset = buf.readUInt32LE(eocdOff + 16);

  if (eocdOff >= 20 && buf.readUInt32LE(eocdOff - 20) === 0x07064b50) {
    const z64Off = Number(buf.readBigUInt64LE(eocdOff - 12));
    assert.equal(buf.readUInt32LE(z64Off), 0x06064b50);
    totalEntries = Number(buf.readBigUInt64LE(z64Off + 32));
    cdOffset = Number(buf.readBigUInt64LE(z64Off + 48));
  }

  const out = [];
  let p = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, `entrada ${i} sin firma CD`);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    let compSize = buf.readUInt32LE(p + 20);
    let uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    let lfhOff = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;

    assert.equal(method, 0);
    assert.ok(flags & 0x0800, 'deberia llevar bit 11 UTF-8');
    assert.equal(buf.readUInt32LE(lfhOff), 0x04034b50, `LFH invalido para ${name}`);
    const lfhNameLen = buf.readUInt16LE(lfhOff + 26);
    const lfhExtraLen = buf.readUInt16LE(lfhOff + 28);
    const dataStart = lfhOff + 30 + lfhNameLen + lfhExtraLen;
    const data = buf.subarray(dataStart, dataStart + uncompSize);
    assert.equal(compSize, uncompSize);
    assert.equal(crc32Update(0, data), crc, `CRC-32 no cuadra en ${name}`);
    out.push({ name, data, crc, size: uncompSize });
  }
  return out;
}

test('crc32Update coincide con el vector estandar IEEE 802.3', () => {
  assert.equal(crc32Update(0, Buffer.from('123456789')), 0xcbf43926);
  // Incremental en dos llamadas da exactamente lo mismo.
  let crc = crc32Update(0, Buffer.from('1234'));
  crc = crc32Update(crc, Buffer.from('56789'));
  assert.equal(crc, 0xcbf43926);
});

test('sanitizeZipPath neutraliza traversal y deshace colisiones sin distinguir mayusculas', () => {
  const used = new Set();
  assert.equal(sanitizeZipPath('x.txt', '../fuera/x.txt', used), '_/fuera/x.txt');
  assert.equal(sanitizeZipPath('x.txt', 'C:\\Windows\\win.ini', used), 'C_/Windows/win.ini');
  assert.equal(sanitizeZipPath('foto.jpg', 'fotos/foto.jpg', used), 'fotos/foto.jpg');
  assert.equal(sanitizeZipPath('FOTO.JPG', 'fotos/FOTO.JPG', used), 'fotos/FOTO (2).JPG');
  assert.equal(sanitizeZipPath('sin_ext', '', used), 'sin_ext');
  assert.equal(sanitizeZipPath('sin_ext', '', used), 'sin_ext (2)');
});

test('zipArchiveName nombra por la carpeta raiz cuando todas las entradas la comparten', () => {
  assert.equal(zipArchiveName([{ name: 'a.txt', path: 'proyecto/a.txt' }, { name: 'b.js', path: 'proyecto/src/b.js' }]), 'proyecto.zip');
  assert.equal(zipArchiveName([{ name: 'a.txt', path: 'uno/a.txt' }, { name: 'b.txt', path: 'dos/b.txt' }]), 'drop-files.zip');
  assert.equal(zipArchiveName([{ name: 'a.txt' }, { name: 'b.txt' }]), 'drop-files.zip');
  assert.equal(zipArchiveName([{ name: 'a.txt', path: 'camión/a.txt' }]), 'camión.zip');
});

test('ZipWriter genera un archivo valido con varios trozos, entradas vacias, UTF-8 y colisiones', async () => {
  const chunks = [];
  const zip = new ZipWriter((c) => { chunks.push(Buffer.from(c)); });

  const bin = crypto.randomBytes(200 * 1024);
  const files = [
    { name: 'README.md', path: 'proyecto/README.md', body: Buffer.from('# Hola España 🚀\n') },
    { name: 'vacio.txt', path: 'proyecto/vacio.txt', body: Buffer.alloc(0) },
    { name: 'datos.bin', path: 'proyecto/datos/datos.bin', body: bin },
    { name: 'datos.bin', path: 'proyecto/datos/datos.bin', body: Buffer.from('segundo') },
  ];

  for (const f of files) {
    await zip.beginFile(f.name, f.path, f.body.length);
    for (let off = 0; off < f.body.length; off += 13_337) {
      await zip.writeChunk(f.body.subarray(off, off + 13_337));
    }
    await zip.endFile();
  }
  await zip.finish();

  const archive = Buffer.concat(chunks);
  const parsed = parseZip(archive);
  assert.equal(parsed.length, 4);
  assert.deepEqual(parsed.map((e) => e.name), [
    'proyecto/README.md',
    'proyecto/vacio.txt',
    'proyecto/datos/datos.bin',
    'proyecto/datos/datos (2).bin',
  ]);
  assert.ok(parsed[0].data.equals(files[0].body));
  assert.equal(parsed[1].data.length, 0);
  assert.ok(parsed[2].data.equals(bin));
  assert.ok(parsed[3].data.equals(files[3].body));

  // Comprobacion contra un extractor real del sistema operativo si hay uno disponible.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drop-zip-'));
  try {
    const zipPath = path.join(tmp, 'out.zip');
    const dest = path.join(tmp, 'extraido');
    fs.writeFileSync(zipPath, archive);
    fs.mkdirSync(dest);

    let extracted = false;
    if (process.platform === 'win32') {
      execFileSync('tar', ['-xf', zipPath, '-C', dest]);
      extracted = true;
    } else {
      for (const [cmd, args] of [
        ['unzip', ['-q', zipPath, '-d', dest]],
        ['python3', ['-m', 'zipfile', '-e', zipPath, dest]],
      ]) {
        try {
          execFileSync(cmd, args, { stdio: 'ignore' });
          extracted = true;
          break;
        } catch { /* probar siguiente extractor */ }
      }
    }
    if (extracted) {
      assert.ok(fs.readFileSync(path.join(dest, 'proyecto', 'README.md')).equals(files[0].body));
      assert.equal(fs.readFileSync(path.join(dest, 'proyecto', 'vacio.txt')).length, 0);
      assert.ok(fs.readFileSync(path.join(dest, 'proyecto', 'datos', 'datos.bin')).equals(bin));
      assert.ok(fs.readFileSync(path.join(dest, 'proyecto', 'datos', 'datos (2).bin')).equals(files[3].body));
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('ZipWriter activa ZIP64 automaticamente cuando una entrada o el directorio pasan los limites', async () => {
  const chunks = [];
  const zip = new ZipWriter((c) => { chunks.push(Buffer.from(c)); });
  // Simulamos un offset por encima de 4 GiB para verificar que las cabeceras ZIP64
  // (LFH, Data Descriptor de 24 bytes, CD extra 0x0001, EOCD64 y Locator) se escriben bien.
  zip.offset = 0x1_0000_0000;
  await zip.beginFile('grande.bin', 'carpeta/grande.bin', 5);
  await zip.writeChunk(Buffer.from('12345'));
  await zip.endFile();
  await zip.finish();

  const tail = Buffer.concat(chunks);
  // LFH con version 45 y extra ZIP64 (20 bytes) + '12345' + Data Descriptor 64 (24 bytes)
  assert.equal(tail.readUInt32LE(0), 0x04034b50);
  assert.equal(tail.readUInt16LE(4), 45);
  assert.equal(tail.readUInt16LE(28), 20);
  const nameLen = tail.readUInt16LE(26);
  const ddOff = 30 + nameLen + 20 + 5;
  assert.equal(tail.readUInt32LE(ddOff), 0x08074b50);
  assert.equal(tail.readBigUInt64LE(ddOff + 8), 5n);
  assert.equal(tail.readBigUInt64LE(ddOff + 16), 5n);

  // EOCD64 y Locator al final
  const eocdOff = tail.length - 22;
  assert.equal(tail.readUInt32LE(eocdOff), 0x06054b50);
  assert.equal(tail.readUInt32LE(eocdOff + 16), 0xffffffff);
  assert.equal(tail.readUInt32LE(eocdOff - 20), 0x07064b50);
  assert.equal(tail.readUInt32LE(eocdOff - 76), 0x06064b50);
  assert.equal(tail.readBigUInt64LE(eocdOff - 76 + 48), 0x1_0000_0000n + BigInt(ddOff + 24));
});
