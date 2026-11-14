// Escritor ZIP en streaming (sin compresion: metodo Store), compartido por el
// navegador y los tests.
//
// POR QUE EXISTE. Sin File System Access (`showDirectoryPicker`, que falta en
// Firefox, Safari de escritorio y todo iOS/Android), el navegador no puede crear
// subcarpetas en Descargas ni bajar varias fotos sin disparar un dialogo por
// cada archivo. Con esto se empaqueta el lote entero al vuelo dentro de un
// unico `.zip` hacia `swSink` (o `memorySink` si es pequeno), manteniendo la
// estructura de carpetas y la memoria constante.
//
// FORMATO. Cada entrada lleva bit 3 (Data Descriptor detras de los datos, asi no
// hace falta saber el CRC-32 ni el tamano antes de empezar) y bit 11 (nombres
// UTF-8). Cuando ninguna entrada ni el archivo completo pasan de 4 GiB ni de
// 65.534 entradas se emite ZIP clasico de 32 bits; si alguno pasa, se activa
// ZIP64 solo donde hace falta para no romper extractores antiguos en lotes
// normales.

const MAX32 = 0xffffffff;
const MAX16 = 0xffff;
const FLAG_STREAM_UTF8 = 0x0800 | 0x0008;
const UNIX_FILE_MODE = (0o100644 << 16) >>> 0;

const enc = new TextEncoder();

// Tabla IEEE 802.3 (polinomio reflejado 0xedb88320) calculada una sola vez.
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  CRC_TABLE[i] = c >>> 0;
}

/** Actualiza un CRC-32 incremental con `data` (Uint8Array o ArrayBuffer). */
export function crc32Update(crc, data) {
  const bytes = data instanceof Uint8Array
    ? data
    : new Uint8Array(data.buffer || data, data.byteOffset || 0, data.byteLength ?? data.length);
  let c = (crc ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function cleanSegment(seg) {
  let s = String(seg).replace(/[\x00-\x1f:*?"<>|\\\/]/g, '_');
  if (!s || s === '.' || s === '..') s = '_';
  return s.slice(0, 180);
}

/**
 * Normaliza la ruta de una entrada dentro del ZIP: solo relativa hacia abajo,
 * sin `..` ni letras de unidad, y sin colisiones (incluso sin distinguir
 * mayusculas, por Windows y macOS).
 */
export function sanitizeZipPath(name, relPath, used) {
  const raw = relPath ? String(relPath) : String(name || 'file');
  const parts = raw.split(/[/\\]+/).filter(Boolean).map(cleanSegment);
  const clean = parts.length ? parts.join('/') : 'file';
  if (!used) return clean;

  let candidate = clean;
  if (used.has(candidate.toLowerCase())) {
    const slash = candidate.lastIndexOf('/');
    const dir = slash >= 0 ? candidate.slice(0, slash + 1) : '';
    const base = slash >= 0 ? candidate.slice(slash + 1) : candidate;
    const dot = base.lastIndexOf('.');
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : '';
    for (let n = 2; n <= 9999; n++) {
      const next = `${dir}${stem} (${n})${ext}`;
      if (!used.has(next.toLowerCase())) { candidate = next; break; }
    }
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

/** Nombre del `.zip`: `<carpeta>.zip` si todo viene de una raiz, o `drop-files.zip`. */
export function zipArchiveName(files) {
  const roots = new Set();
  for (const f of files || []) {
    const raw = String(f?.path || '').replace(/\\/g, '/').replace(/^\/+/, '');
    const idx = raw.indexOf('/');
    const top = idx > 0 ? raw.slice(0, idx) : '';
    if (!top || top === '.' || top === '..') return 'drop-files.zip';
    roots.add(top);
  }
  if (roots.size === 1) {
    const [only] = roots;
    const clean = cleanSegment(only);
    if (clean && clean !== '_') return `${clean}.zip`;
  }
  return 'drop-files.zip';
}

function toDosDateTime(date) {
  const year = Math.min(2107, Math.max(1980, date.getFullYear()));
  const dosTime = ((date.getHours() & 31) << 11) | ((date.getMinutes() & 63) << 5) | ((date.getSeconds() >> 1) & 31);
  const dosDate = (((year - 1980) & 127) << 9) | (((date.getMonth() + 1) & 15) << 5) | (date.getDate() & 31);
  return { dosTime, dosDate };
}

function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

/**
 * Empaquetador ZIP en streaming: va soltando cabeceras locales, datos crudos,
 * descriptores de datos y, al final, el directorio central a `writeFn`.
 */
export class ZipWriter {
  constructor(writeFn, { now } = {}) {
    if (typeof writeFn !== 'function') throw new TypeError('writeFn debe ser una funcion');
    this.writeFn = writeFn;
    this.now = now instanceof Date ? now : new Date();
    this.offset = 0;
    this.entries = [];
    this.used = new Set();
    this.current = null;
    this.closed = false;
  }

  async _emit(bytes) {
    const u8 = toBytes(bytes);
    if (!u8.byteLength) return;
    await this.writeFn(u8);
    this.offset += u8.byteLength;
  }

  async beginFile(name, relPath = '', expectedSize = null) {
    if (this.closed) throw new Error('el archivo ZIP ya esta cerrado');
    if (this.current) throw new Error('ya hay una entrada abierta en el ZIP');

    const entryPath = sanitizeZipPath(name, relPath, this.used);
    const nameBytes = enc.encode(entryPath);
    const { dosTime, dosDate } = toDosDateTime(this.now);
    const headerOffset = this.offset;
    // Con `expectedSize == null` (stdin) no sabemos si pasara de 4 GiB:
    // mantenemos 32 bits mientras no haga falta ZIP64 por offset o tamano.
    const useZip64 = headerOffset >= MAX32 || (Number.isFinite(expectedSize) && expectedSize >= MAX32);
    const extraLen = useZip64 ? 20 : 0;

    const buf = new Uint8Array(30 + nameBytes.length + extraLen);
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, useZip64 ? 45 : 20, true);
    dv.setUint16(6, FLAG_STREAM_UTF8, true);
    dv.setUint16(8, 0, true);
    dv.setUint16(10, dosTime, true);
    dv.setUint16(12, dosDate, true);
    dv.setUint32(14, 0, true);
    dv.setUint32(18, 0, true);
    dv.setUint32(22, 0, true);
    dv.setUint16(26, nameBytes.length, true);
    dv.setUint16(28, extraLen, true);
    buf.set(nameBytes, 30);
    if (useZip64) {
      const off = 30 + nameBytes.length;
      dv.setUint16(off, 0x0001, true);
      dv.setUint16(off + 2, 16, true);
      dv.setBigUint64(off + 4, 0n, true);
      dv.setBigUint64(off + 12, 0n, true);
    }

    await this._emit(buf);
    this.current = { nameBytes, dosTime, dosDate, headerOffset, useZip64, crc: 0, size: 0 };
    return entryPath;
  }

  async writeChunk(chunk) {
    if (!this.current) throw new Error('no hay ninguna entrada abierta en el ZIP');
    const bytes = toBytes(chunk);
    if (!bytes.byteLength) return;
    this.current.crc = crc32Update(this.current.crc, bytes);
    this.current.size += bytes.byteLength;
    await this._emit(bytes);
  }

  async endFile() {
    if (!this.current) return;
    const entry = this.current;
    this.current = null;
    const is64 = entry.useZip64 || entry.size >= MAX32;
    const buf = new Uint8Array(is64 ? 24 : 16);
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, 0x08074b50, true);
    dv.setUint32(4, entry.crc >>> 0, true);
    if (is64) {
      dv.setBigUint64(8, BigInt(entry.size), true);
      dv.setBigUint64(16, BigInt(entry.size), true);
    } else {
      dv.setUint32(8, entry.size >>> 0, true);
      dv.setUint32(12, entry.size >>> 0, true);
    }
    await this._emit(buf);
    this.entries.push(entry);
  }

  async finish() {
    if (this.closed) return;
    if (this.current) throw new Error('queda una entrada abierta antes de cerrar el ZIP');
    this.closed = true;

    const cdOffset = this.offset;
    const records = [];
    let cdSize = 0;

    for (const e of this.entries) {
      const needSize64 = e.size >= MAX32;
      const needOff64 = e.headerOffset >= MAX32;
      const needCd64 = needSize64 || needOff64;
      const extraPayload = (needSize64 ? 16 : 0) + (needOff64 ? 8 : 0);
      const extraLen = needCd64 ? 4 + extraPayload : 0;
      const ver = (e.useZip64 || needCd64) ? 45 : 20;

      const rec = new Uint8Array(46 + e.nameBytes.length + extraLen);
      const dv = new DataView(rec.buffer);
      dv.setUint32(0, 0x02014b50, true);
      dv.setUint16(4, (3 << 8) | ver, true);
      dv.setUint16(6, ver, true);
      dv.setUint16(8, FLAG_STREAM_UTF8, true);
      dv.setUint16(10, 0, true);
      dv.setUint16(12, e.dosTime, true);
      dv.setUint16(14, e.dosDate, true);
      dv.setUint32(16, e.crc >>> 0, true);
      dv.setUint32(20, needSize64 ? MAX32 : (e.size >>> 0), true);
      dv.setUint32(24, needSize64 ? MAX32 : (e.size >>> 0), true);
      dv.setUint16(28, e.nameBytes.length, true);
      dv.setUint16(30, extraLen, true);
      dv.setUint16(32, 0, true);
      dv.setUint16(34, 0, true);
      dv.setUint16(36, 0, true);
      dv.setUint32(38, UNIX_FILE_MODE, true);
      dv.setUint32(42, needOff64 ? MAX32 : (e.headerOffset >>> 0), true);
      rec.set(e.nameBytes, 46);
      if (needCd64) {
        let p = 46 + e.nameBytes.length;
        dv.setUint16(p, 0x0001, true);
        dv.setUint16(p + 2, extraPayload, true);
        p += 4;
        if (needSize64) {
          dv.setBigUint64(p, BigInt(e.size), true);
          dv.setBigUint64(p + 8, BigInt(e.size), true);
          p += 16;
        }
        if (needOff64) {
          dv.setBigUint64(p, BigInt(e.headerOffset), true);
        }
      }
      records.push(rec);
      cdSize += rec.byteLength;
    }

    // Juntamos los registros del directorio central en bloques de hasta 64 KiB
    // para no mandar cientos de postMessage pequenos al Service Worker.
    const count = this.entries.length;
    const needZip64Eocd = count >= MAX16 || cdSize >= MAX32 || cdOffset >= MAX32;
    const tailLen = (needZip64Eocd ? 76 : 0) + 22;
    const tail = new Uint8Array(tailLen);
    const tdv = new DataView(tail.buffer);
    let tp = 0;

    if (needZip64Eocd) {
      const z64Offset = cdOffset + cdSize;
      tdv.setUint32(0, 0x06064b50, true);
      tdv.setBigUint64(4, 44n, true);
      tdv.setUint16(12, (3 << 8) | 45, true);
      tdv.setUint16(14, 45, true);
      tdv.setUint32(16, 0, true);
      tdv.setUint32(20, 0, true);
      tdv.setBigUint64(24, BigInt(count), true);
      tdv.setBigUint64(32, BigInt(count), true);
      tdv.setBigUint64(40, BigInt(cdSize), true);
      tdv.setBigUint64(48, BigInt(cdOffset), true);

      tdv.setUint32(56, 0x07064b50, true);
      tdv.setUint32(60, 0, true);
      tdv.setBigUint64(64, BigInt(z64Offset), true);
      tdv.setUint32(72, 1, true);
      tp = 76;
    }

    tdv.setUint32(tp, 0x06054b50, true);
    tdv.setUint16(tp + 4, 0, true);
    tdv.setUint16(tp + 6, 0, true);
    tdv.setUint16(tp + 8, count >= MAX16 ? MAX16 : count, true);
    tdv.setUint16(tp + 10, count >= MAX16 ? MAX16 : count, true);
    tdv.setUint32(tp + 12, cdSize >= MAX32 ? MAX32 : cdSize, true);
    tdv.setUint32(tp + 16, cdOffset >= MAX32 ? MAX32 : cdOffset, true);
    tdv.setUint16(tp + 20, 0, true);

    records.push(tail);
    const BATCH = 64 * 1024;
    let batch = [];
    let batchLen = 0;
    const flushBatch = async () => {
      if (!batchLen) return;
      const out = new Uint8Array(batchLen);
      let pos = 0;
      for (const part of batch) { out.set(part, pos); pos += part.byteLength; }
      batch = [];
      batchLen = 0;
      await this._emit(out);
    };
    for (const part of records) {
      if (batchLen + part.byteLength > BATCH && batchLen > 0) await flushBatch();
      batch.push(part);
      batchLen += part.byteLength;
    }
    await flushBatch();
  }
}
