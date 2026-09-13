// Cifrado de extremo a extremo del camino por RELAY (CLI -> navegador y
// CLI -> CLI cuando no hay TCP directo), compartido por el navegador y los tests.
//
// ============================================================================
// EL PROBLEMA
// ============================================================================
// Por TCP directo los dos CLI cifran con AES-256-GCM y una clave scrypt del
// codigo. Entre navegadores va DTLS. Pero cuando el emisor es un CLI y no hay
// ruta directa, los bytes pasaban por el WebSocket del servidor EN CLARO: el
// servidor (o quien lo comprometiera) leia los archivos. Era la unica
// combinacion sin cifrado propio, y justo la que atraviesa un tercero.
//
// ============================================================================
// LA SOLUCION, Y POR QUE HACE FALTA scrypt EN EL NAVEGADOR
// ============================================================================
// El receptor deriva LA MISMA clave que el CLI (shared/scrypt.js con los
// parametros de cli/src/crypto.js) y el emisor cifra cada trozo y cada marco de
// control con ella. El servidor sigue reenviando a ciegas; ahora reenvia ruido.
//
// Con eso solo no bastaria: el receptor web demostraba conocer el codigo con
// `sha256(nonce|secreto)`, y ese hash pasa por el servidor. Es un verificador
// offline barato: 2^44 SHA-256 son horas, y con el secreto se deriva la clave y
// se descifra la grabacion. Por eso la prueba pasa a ser un HMAC con la CLAVE
// scrypt: probar un candidato cuesta ahora 62 ms y 32 MB, igual que atacar el
// cifrado a pelo (~3,5 x 10^10 anos-CPU, ver shared/codes.js).
//
// ============================================================================
// FORMATO
// ============================================================================
//   paquete cifrado:  [12 bytes IV] [16 bytes tag GCM] [ciphertext]
//                     el mismo que encryptChunk/decryptChunk en cli/src/crypto.js.
//   marco sellado:    { type: 'cli-sealed', box: <paquete en base64> }
//                     dentro, el JSON del marco de control de siempre
//                     (cli-manifest, cli-start, cli-end, cli-done...).
//   trozo binario:    el paquete cifrado tal cual; el receptor descifra y cuenta
//                     BYTES EN CLARO para los acuses (cli-ack).
//
// WebCrypto pone el tag al FINAL del ciphertext; aqui se recoloca para que el
// formato del cable sea uno solo. AES-GCM se hace con WebCrypto porque es
// rapido y esta en todos los navegadores; scrypt es JS porque no hay otra.

import { scrypt, hmacSha256 } from './scrypt.js';
import { Sha256 } from './sha256.js';
import { sasInput, sasWords, formatSas } from './sas.js';

// Los mismos parametros que cli/src/crypto.js. Cambiarlos en un sitio solo
// deja a los dos extremos con claves distintas y todo falla al autenticar.
export const SCRYPT_PARAMS = { N: 32768, r: 8, p: 1, dkLen: 32 };

const enc = new TextEncoder();
const subtle = () => {
  const s = globalThis.crypto && globalThis.crypto.subtle;
  if (!s) throw new Error('WebCrypto no disponible: hace falta HTTPS o localhost');
  return s;
};

/**
 * Clave AES-256 de la sala: scrypt(secreto, sha256('drop-code-v2|' + roomId)).
 * Identico a `deriveKey` del CLI. Tarda ~0,3 s y se llama una vez por sala.
 */
export async function deriveRoomKey(roomId, secret) {
  const salt = new Sha256().update(enc.encode(`drop-code-v2|${roomId}`)).digestBytes();
  return scrypt(enc.encode(String(secret)), salt, SCRYPT_PARAMS);
}

const toHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * Prueba de conocimiento del codigo para el camino por relay:
 * HMAC-SHA256(clave, 'drop-proof-v3|' + nonce). Deriva de la clave scrypt, no del
 * secreto, para que el servidor que la vea pasar no tenga nada barato que atacar.
 */
export function proofFromKey(key, nonce) {
  return toHex(hmacSha256(key, enc.encode(`drop-proof-v3|${nonce}`)));
}

/** La misma huella que `sasFromKey` del CLI, calculada con el Sha256 compartido. */
export function sasFromKeyBytes(key, roomId) {
  return formatSas(sasWords(toHex(hmacSha256(key, enc.encode(sasInput('tcp', [roomId]))))));
}

async function aesKey(raw, usage) {
  return subtle().importKey('raw', raw, { name: 'AES-GCM' }, false, [usage]);
}

/** Cifra `plain` con la clave de la sala. Devuelve [IV][tag][ciphertext]. */
export async function sealBox(key, plain) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const k = key.aes || await aesKey(key, 'encrypt');
  const out = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, k, plain));
  const packet = new Uint8Array(28 + out.length - 16);
  packet.set(iv, 0);
  packet.set(out.subarray(out.length - 16), 12);          // tag
  packet.set(out.subarray(0, out.length - 16), 28);       // ciphertext
  return packet;
}

/**
 * Descifra un paquete [IV][tag][ciphertext]. Lanza si el tag no autentica: un
 * paquete manipulado o cifrado con otra clave no produce bytes, produce error.
 * `key` puede ser la clave en bytes o un objeto de `openerFor`.
 */
export async function openBox(key, packet) {
  const p = packet instanceof Uint8Array ? packet : new Uint8Array(packet);
  if (p.length < 28) throw new Error('paquete cifrado demasiado corto');
  const k = key.aes || await aesKey(key, 'decrypt');
  const body = new Uint8Array(p.length - 12);
  body.set(p.subarray(28), 0);                 // ciphertext
  body.set(p.subarray(12, 28), p.length - 28); // tag al final, como quiere WebCrypto
  return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: p.subarray(0, 12), tagLength: 128 }, k, body));
}

/**
 * Importa la clave una sola vez para descifrar muchos trozos: `importKey` por
 * cada 64 KiB seria un coste tonto en la ruta caliente del receptor.
 */
export async function openerFor(key) {
  return { aes: await aesKey(key, 'decrypt'), raw: key };
}

/** Descifra un marco `cli-sealed` y devuelve el objeto de control que llevaba. */
export async function unsealFrame(opener, frame) {
  const box = Uint8Array.from(atob(frame.box), (c) => c.charCodeAt(0));
  const plain = await openBox(opener, box);
  return JSON.parse(new TextDecoder().decode(plain));
}
