import crypto from 'node:crypto';
import { splitForKey } from '../../public/shared/codes.js';

// Coste de scrypt. N=2^15 con r=8 son 128 x N x r = 32 MB de memoria por intento,
// y 62 ms medidos en un MacBook (Apple Silicon, Node 24).
//
// POR QUE scrypt Y NO HKDF: el codigo pasa de 96 bits aleatorios a 44 bits de
// palabras (ver public/shared/codes.js). HKDF es un hash: un atacante que grabe
// una transferencia cifrada prueba 2^44 candidatos a mil millones por segundo y
// termina en horas. scrypt es memoria-dura, asi que cada intento cuesta 62 ms y
// 32 MB tambien para el atacante: 2^44 x 0,062 s = ~3,5 x 10^10 anos-CPU, y las
// GPUs/ASICs no le sirven de mucho porque el cuello es el ancho de banda de RAM.
//
// POR QUE 2^15 Y NO 2^16: con 2^16 (64 MB) el mismo equipo tarda 126 ms, que
// tambien cabe en el presupuesto de ~250 ms. Nos quedamos en 2^15 porque el CLI
// se compila para Raspberry Pi y VPS ARM pequenios, donde 64 MB por derivacion y
// una CPU cuatro veces mas lenta se notarian en el arranque de cada transferencia.
const SCRYPT_N = 32768;      // 2^15
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 256 * SCRYPT_N * SCRYPT_R;   // el doble de lo que necesita

// `deriveKey` se llama por socket (transfer.js y speed.js abren uno por receptor
// y por reintento). Pagar 62 ms en cada conexion se notaria, y derivar dos veces
// el mismo codigo da siempre el mismo resultado: se memoriza.
const keyCache = new Map();

/**
 * Deriva la clave AES-256-GCM de la sala a partir del codigo.
 *
 * Solo entra en el KDF la PARTE SECRETA (las palabras). El identificador publico
 * de sala se usa como sal, que es justo su papel: no aporta secreto, pero separa
 * dominios para que una tabla precalculada no valga para todas las salas a la vez.
 */
export function deriveKey(code) {
  const cached = keyCache.get(code);
  if (cached) return cached;

  const { roomId, secret, legacy } = splitForKey(code);

  let key;
  if (legacy) {
    // @deprecated Camino de la v0.3.5: token base64url de 96 bits. Ahi el token
    // entero ERA el secreto y tenia entropia de sobra, asi que HKDF bastaba.
    // Se mantiene solo para poder recibir de binarios ya distribuidos; se elimina
    // en la v0.5.0 junto con el resto del soporte de codigos viejos.
    const salt = crypto.createHash('sha256').update('drop-salt-v1').digest();
    key = crypto.hkdfSync('sha256', Buffer.from(code), salt, Buffer.from('drop-e2ee-key'), 32);
    key = Buffer.from(key);
  } else {
    const salt = crypto.createHash('sha256').update(`drop-code-v2|${roomId}`).digest();
    key = crypto.scryptSync(Buffer.from(secret, 'utf-8'), salt, 32, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      maxmem: SCRYPT_MAXMEM,
    });
  }

  keyCache.set(code, key);
  return key;
}

/**
 * Prueba de conocimiento del secreto para receptores web.
 *
 * El navegador no puede derivar la clave AES (WebCrypto no trae scrypt y no
 * queremos dependencias), asi que en el camino CLI -> navegador el emisor no
 * puede autenticar al receptor descifrando: le manda un nonce y comprueba este
 * hash antes de ensenarle siquiera el manifiesto de archivos.
 *
 * LIMITE: esto es SHA-256, no scrypt, asi que la respuesta del receptor es un
 * verificador offline del secreto. Es deliberado y esta acotado: solo lo emite el
 * navegador, y en ese camino los datos ya viajan por el relay del servidor (no
 * hay cifrado de extremo a extremo nuestro que proteger). El CLI nunca emite este
 * hash: entre dos CLIs la prueba de conocimiento es el propio AES-GCM, que falla
 * al autenticar el primer paquete si la clave no coincide.
 */
export function secretProof(nonce, secret) {
  return crypto.createHash('sha256').update(`drop-proof-v2|${nonce}|${secret}`).digest('hex');
}

// Cifra un trozo de datos con AES-256-GCM.
// Formato del paquete: [12 bytes IV] [16 bytes Auth Tag] [N bytes Cifrados]
export function encryptChunk(chunk, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(chunk), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]);
}

// Descifra un paquete AES-256-GCM
export function decryptChunk(packet, key) {
  if (packet.length < 28) {
    throw new Error('Paquete demasiado corto para descifrar');
  }
  const iv = packet.subarray(0, 12);
  const tag = packet.subarray(12, 28);
  const encrypted = packet.subarray(28);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}
