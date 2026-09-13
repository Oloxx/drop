// scrypt (RFC 7914) en JavaScript puro, para que el navegador derive la MISMA
// clave AES que el CLI saca de `crypto.scryptSync` (cli/src/crypto.js).
//
// Existe porque WebCrypto no trae scrypt y el proyecto no admite dependencias.
// Sin el, el camino CLI -> navegador no podia tener cifrado de extremo a
// extremo propio: el navegador no era capaz de llegar a la clave y los bytes
// pasaban por el servidor de relay en claro. HKDF o PBKDF2 (que WebCrypto si
// trae) no valen como sustituto: el codigo tiene 44 bits de entropia y un KDF
// rapido lo deja a merced de un ataque offline (ver public/shared/codes.js).
//
// La aritmetica es toda de 32 bits sin signo sobre Uint32Array, con la
// conversion a little-endian hecha a mano: la especificacion trata los bloques
// como palabras LE y confiar en la endianness de la plataforma seria correcto
// hoy y sorprendente algun dia.
//
// El PBKDF2 de los extremos va sobre el Sha256 de shared/sha256.js. Es un HMAC
// con c=1 -- dos hashes por bloque --, asi que no compensa el salto asincrono a
// WebCrypto y ademas sigue funcionando en un contexto no seguro.
//
// `scrypt` es async y cede el hilo cada `yieldEvery` iteraciones: con N=2^15 el
// bucle son ~65.000 BlockMix y en un navegador eso es medio segundo de UI
// congelada si se hace de un tiron.

import { Sha256 } from './sha256.js';

const BLOCK = 64;   // tamano de bloque de SHA-256

/** HMAC-SHA256 sobre bytes. Devuelve los 32 bytes del digest. */
export function hmacSha256(key, message) {
  let k = key instanceof Uint8Array ? key : new Uint8Array(key);
  if (k.length > BLOCK) k = new Sha256().update(k).digestBytes();
  const ipad = new Uint8Array(BLOCK);
  const opad = new Uint8Array(BLOCK);
  for (let i = 0; i < BLOCK; i++) {
    const b = i < k.length ? k[i] : 0;
    ipad[i] = b ^ 0x36;
    opad[i] = b ^ 0x5c;
  }
  const inner = new Sha256().update(ipad).update(message).digestBytes();
  return new Sha256().update(opad).update(inner).digestBytes();
}

/** PBKDF2-HMAC-SHA256. Solo hace falta c=1 aqui, pero se implementa entero. */
export function pbkdf2Sha256(password, salt, iterations, dkLen) {
  const out = new Uint8Array(dkLen);
  const blocks = Math.ceil(dkLen / 32);
  const saltBlock = new Uint8Array(salt.length + 4);
  saltBlock.set(salt, 0);
  for (let i = 1; i <= blocks; i++) {
    saltBlock[salt.length] = (i >>> 24) & 0xff;
    saltBlock[salt.length + 1] = (i >>> 16) & 0xff;
    saltBlock[salt.length + 2] = (i >>> 8) & 0xff;
    saltBlock[salt.length + 3] = i & 0xff;
    let u = hmacSha256(password, saltBlock);
    const t = new Uint8Array(u);
    for (let c = 1; c < iterations; c++) {
      u = hmacSha256(password, u);
      for (let j = 0; j < 32; j++) t[j] ^= u[j];
    }
    out.set(t.subarray(0, Math.min(32, dkLen - (i - 1) * 32)), (i - 1) * 32);
  }
  return out;
}

const R = (a, b) => (a << b) | (a >>> (32 - b));

/** Salsa20/8 sobre 16 palabras, in situ. */
function salsa20_8(B, x) {
  for (let i = 0; i < 16; i++) x[i] = B[i];
  for (let i = 0; i < 8; i += 2) {
    x[4] ^= R(x[0] + x[12], 7);  x[8] ^= R(x[4] + x[0], 9);
    x[12] ^= R(x[8] + x[4], 13); x[0] ^= R(x[12] + x[8], 18);
    x[9] ^= R(x[5] + x[1], 7);   x[13] ^= R(x[9] + x[5], 9);
    x[1] ^= R(x[13] + x[9], 13); x[5] ^= R(x[1] + x[13], 18);
    x[14] ^= R(x[10] + x[6], 7); x[2] ^= R(x[14] + x[10], 9);
    x[6] ^= R(x[2] + x[14], 13); x[10] ^= R(x[6] + x[2], 18);
    x[3] ^= R(x[15] + x[11], 7); x[7] ^= R(x[3] + x[15], 9);
    x[11] ^= R(x[7] + x[3], 13); x[15] ^= R(x[11] + x[7], 18);
    x[1] ^= R(x[0] + x[3], 7);   x[2] ^= R(x[1] + x[0], 9);
    x[3] ^= R(x[2] + x[1], 13);  x[0] ^= R(x[3] + x[2], 18);
    x[6] ^= R(x[5] + x[4], 7);   x[7] ^= R(x[6] + x[5], 9);
    x[4] ^= R(x[7] + x[6], 13);  x[5] ^= R(x[4] + x[7], 18);
    x[11] ^= R(x[10] + x[9], 7); x[8] ^= R(x[11] + x[10], 9);
    x[9] ^= R(x[8] + x[11], 13); x[10] ^= R(x[9] + x[8], 18);
    x[12] ^= R(x[15] + x[14], 7); x[13] ^= R(x[12] + x[15], 9);
    x[14] ^= R(x[13] + x[12], 13); x[15] ^= R(x[14] + x[13], 18);
  }
  for (let i = 0; i < 16; i++) B[i] = (B[i] + x[i]) | 0;
}

/**
 * BlockMix: `B` son 2r bloques de 16 palabras a partir de `off`; el resultado
 * se deja en `Y` (mismo tamano) con los bloques pares primero y los impares
 * despues, como manda la especificacion. `X` y `tmp` son scratch de 16 palabras.
 */
function blockMix(B, off, Y, r, X, tmp) {
  const last = off + (2 * r - 1) * 16;
  for (let i = 0; i < 16; i++) X[i] = B[last + i];
  for (let i = 0; i < 2 * r; i++) {
    const src = off + i * 16;
    for (let j = 0; j < 16; j++) X[j] ^= B[src + j];
    salsa20_8(X, tmp);
    // Bloque i par -> posicion i/2; impar -> r + (i-1)/2.
    const dst = (i & 1) ? (r + (i >> 1)) * 16 : (i >> 1) * 16;
    for (let j = 0; j < 16; j++) Y[dst + j] = X[j];
  }
}

const yieldNow = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * scrypt(P, S, N, r, p, dkLen). `password` y `salt` son bytes; devuelve
 * `dkLen` bytes. Lanza si los parametros no son validos para la especificacion.
 */
export async function scrypt(password, salt, { N, r, p, dkLen, yieldEvery = 4096 } = {}) {
  if (!Number.isInteger(N) || N < 2 || (N & (N - 1)) !== 0) throw new Error('scrypt: N tiene que ser potencia de 2');
  if (!Number.isInteger(r) || r < 1 || !Number.isInteger(p) || p < 1) throw new Error('scrypt: r y p tienen que ser >= 1');
  if (r * p >= 1 << 30) throw new Error('scrypt: r*p demasiado grande');

  const pw = password instanceof Uint8Array ? password : new Uint8Array(password);
  const st = salt instanceof Uint8Array ? salt : new Uint8Array(salt);
  const blockBytes = 128 * r;
  const words = 32 * r;                    // palabras de 32 bits por bloque de 128r bytes

  const B = pbkdf2Sha256(pw, st, 1, p * blockBytes);

  // Scratch compartido entre las p pasadas: V es lo gordo (N x 128r bytes).
  const V = new Uint32Array(N * words);
  const X = new Uint32Array(words);
  const Y = new Uint32Array(words);
  const S = new Uint32Array(16);
  const T = new Uint32Array(16);

  for (let pi = 0; pi < p; pi++) {
    const base = pi * blockBytes;
    // Bytes -> palabras little-endian.
    for (let i = 0; i < words; i++) {
      const o = base + i * 4;
      X[i] = B[o] | (B[o + 1] << 8) | (B[o + 2] << 16) | (B[o + 3] << 24);
    }

    // ROMix, primera mitad: V[i] = X; X = BlockMix(X). Se alterna X/Y para no
    // copiar: las iteraciones pares leen de X y escriben en Y, y viceversa.
    for (let i = 0; i < N; i += 2) {
      V.set(X, i * words);
      blockMix(X, 0, Y, r, S, T);
      V.set(Y, (i + 1) * words);
      blockMix(Y, 0, X, r, S, T);
      if (yieldEvery && (i & (yieldEvery - 1)) === 0 && i) await yieldNow();
    }

    // Segunda mitad: X = BlockMix(X ^ V[Integerify(X) mod N]). Integerify es la
    // primera palabra LE del ultimo bloque de 64 bytes; N es potencia de 2, asi
    // que el modulo es una mascara.
    const lastWord = (2 * r - 1) * 16;
    for (let i = 0; i < N; i += 2) {
      let j = (X[lastWord] >>> 0) & (N - 1);
      let vo = j * words;
      for (let k = 0; k < words; k++) X[k] ^= V[vo + k];
      blockMix(X, 0, Y, r, S, T);
      j = (Y[lastWord] >>> 0) & (N - 1);
      vo = j * words;
      for (let k = 0; k < words; k++) Y[k] ^= V[vo + k];
      blockMix(Y, 0, X, r, S, T);
      if (yieldEvery && (i & (yieldEvery - 1)) === 0 && i) await yieldNow();
    }

    // Palabras -> bytes, de vuelta en B.
    for (let i = 0; i < words; i++) {
      const o = base + i * 4;
      const w = X[i];
      B[o] = w & 0xff;
      B[o + 1] = (w >>> 8) & 0xff;
      B[o + 2] = (w >>> 16) & 0xff;
      B[o + 3] = (w >>> 24) & 0xff;
    }
  }

  return pbkdf2Sha256(pw, B, 1, dkLen);
}
