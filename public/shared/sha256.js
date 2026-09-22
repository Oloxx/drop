// SHA-256 en JavaScript, incremental.
//
// Hay implementacion propia porque hace falta ir alimentando el hash trozo a
// trozo segun llegan los datos, y `crypto.subtle.digest` es de un solo golpe:
// obligaria a tener el archivo entero en memoria, que es justo lo que la
// escritura en streaming evita.
//
// Vive aqui, y no dentro de app.js, para que el test que la comprueba use ESTE
// codigo. Antes el test copiaba las doscientas lineas y validaba su copia: un
// fallo corregido en app.js lo habria dejado en verde contra el codigo viejo.

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

export class Sha256 {
  constructor() {
    this.h0 = 0x6a09e667;
    this.h1 = 0xbb67ae85;
    this.h2 = 0x3c6ef372;
    this.h3 = 0xa54ff53a;
    this.h4 = 0x510e527f;
    this.h5 = 0x9b05688c;
    this.h6 = 0x1f83d9ab;
    this.h7 = 0x5be0cd19;
    this.block = new Uint8Array(64);
    this.blockLen = 0;
    this.totalLen = 0;
    this.w = new Uint32Array(64);
  }

  _processBlock(b) {
    const w = this.w;
    for (let i = 0; i < 16; i++) {
      const p = i * 4;
      w[i] = (b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3];
    }
    for (let i = 16; i < 64; i++) {
      const v0 = w[i - 15];
      const s0 = ((v0 >>> 7) | (v0 << 25)) ^ ((v0 >>> 18) | (v0 << 14)) ^ (v0 >>> 3);
      const v1 = w[i - 2];
      const s1 = ((v1 >>> 17) | (v1 << 15)) ^ ((v1 >>> 19) | (v1 << 13)) ^ (v1 >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }

    let a = this.h0, b0 = this.h1, c = this.h2, d = this.h3;
    let e = this.h4, f = this.h5, g = this.h6, h = this.h7;

    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ ((~e) & g);
      const temp1 = (h + S1 + ch + SHA256_K[i] + w[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b0) ^ (a & c) ^ (b0 & c);
      const temp2 = (S0 + maj) | 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b0;
      b0 = a;
      a = (temp1 + temp2) | 0;
    }

    this.h0 = (this.h0 + a) | 0;
    this.h1 = (this.h1 + b0) | 0;
    this.h2 = (this.h2 + c) | 0;
    this.h3 = (this.h3 + d) | 0;
    this.h4 = (this.h4 + e) | 0;
    this.h5 = (this.h5 + f) | 0;
    this.h6 = (this.h6 + g) | 0;
    this.h7 = (this.h7 + h) | 0;
  }

  update(data) {
    const bytes = data instanceof Uint8Array
      ? data
      : new Uint8Array(data.buffer || data, data.byteOffset || 0, data.byteLength || data.length);
    let offset = 0;
    const len = bytes.length;
    this.totalLen += len;

    if (this.blockLen > 0) {
      const needed = 64 - this.blockLen;
      if (len >= needed) {
        this.block.set(bytes.subarray(0, needed), this.blockLen);
        this._processBlock(this.block);
        this.blockLen = 0;
        offset = needed;
      } else {
        this.block.set(bytes, this.blockLen);
        this.blockLen += len;
        return this;
      }
    }

    while (offset + 64 <= len) {
      this._processBlock(bytes.subarray(offset, offset + 64));
      offset += 64;
    }

    if (offset < len) {
      this.block.set(bytes.subarray(offset), 0);
      this.blockLen = len - offset;
    }

    return this;
  }

  digest() {
    const totalBits = this.totalLen * 8;
    this.block[this.blockLen++] = 0x80;
    if (this.blockLen > 56) {
      this.block.fill(0, this.blockLen);
      this._processBlock(this.block);
      this.blockLen = 0;
    }
    this.block.fill(0, this.blockLen, 56);
    const hiBits = Math.floor(totalBits / 0x100000000);
    const loBits = totalBits >>> 0;
    this.block[56] = (hiBits >>> 24) & 0xff;
    this.block[57] = (hiBits >>> 16) & 0xff;
    this.block[58] = (hiBits >>> 8) & 0xff;
    this.block[59] = hiBits & 0xff;
    this.block[60] = (loBits >>> 24) & 0xff;
    this.block[61] = (loBits >>> 16) & 0xff;
    this.block[62] = (loBits >>> 8) & 0xff;
    this.block[63] = loBits & 0xff;
    this._processBlock(this.block);

    const hash = [this.h0, this.h1, this.h2, this.h3, this.h4, this.h5, this.h6, this.h7];
    return hash.map((v) => (v >>> 0).toString(16).padStart(8, '0')).join('');
  }

  /**
   * Otro hasher en el mismo punto. `digest()` cierra el estado, asi que para
   * mirar el hash de un prefijo y seguir hasheando detras (reanudar) hace falta
   * una copia.
   */
  copy() {
    const c = new Sha256();
    c.h0 = this.h0; c.h1 = this.h1; c.h2 = this.h2; c.h3 = this.h3;
    c.h4 = this.h4; c.h5 = this.h5; c.h6 = this.h6; c.h7 = this.h7;
    c.block.set(this.block);
    c.blockLen = this.blockLen;
    c.totalLen = this.totalLen;
    return c;
  }

  /** El mismo digest, en bytes: lo que necesita un HMAC para encadenar hashes. */
  digestBytes() {
    const hex = this.digest();
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
}

/** sha256 hexadecimal de una cadena, con el mismo Sha256 que verifica los archivos. */
export function sha256Hex(text) {
  return new Sha256().update(new TextEncoder().encode(text)).digest();
}
