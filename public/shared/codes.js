// Codigos de sala memorizables: `4271-lemon-radar-tiger-orbit`.
//
// ============================================================================
// POR QUE ESTE FORMATO Y NO 96 BITS ALEATORIOS
// ============================================================================
// Hasta la v0.3.5 el codigo era `randomBytes(12).toString('base64url')`, algo
// como `T_9q_4uzB9iJAf8x`. Es inatacable, pero no se puede dictar por telefono
// ni recordar diez segundos: el unico camino real era mandar el enlace entero.
// Un codigo memorizable habilita el caso de uso de "te lo canto y lo tecleas",
// pero un codigo memorizable tiene, por definicion, poca entropia. Y aqui eso
// es grave, porque el codigo NO es solo un identificador de sala: de el sale la
// clave AES-256-GCM que cifra las transferencias TCP (ver cli/src/crypto.js).
//
// La solucion es partir el codigo en dos mitades con papeles distintos, y no
// dejar que la mitad secreta salga nunca de la maquina.
//
//   4271          -> IDENTIFICADOR PUBLICO DE SALA. Lo genera el servidor de
//                    senalizacion, viaja hasta el en el `join` y es lo unico de
//                    lo que se deriva el hash del broadcast UDP de la LAN.
//                    No es secreto y no aporta seguridad: solo dice "a que sala".
//   lemon-radar-  -> SECRETO COMPARTIDO. Lo genera el cliente, nunca se manda al
//   tiger-orbit      servidor, nunca sale por UDP y nunca viaja en claro. Es el
//                    unico material del que sale la clave de cifrado.
//
// ============================================================================
// ENTROPIA: 44 BITS, Y POR QUE 4 PALABRAS Y NO 3
// ============================================================================
// 4 palabras de una lista de 2048 = 4 x 11 = 44 bits exactos en la parte secreta.
//
// Con 3 palabras serian 33 bits, que es lo habitual en herramientas parecidas.
// Ahi 33 bits bastan porque negocian con un PAKE real (SPAKE2), que autentica sin
// dejar ningun verificador que atacar. Sin PAKE, quien capture cualquier
// verificador del secreto puede probarlo offline, y 33 bits caen en horas incluso
// detras de un KDF lento. Con 44 bits y el scrypt de crypto.js
// (N=2^15, r=8, p=1, 32 MB, medidos 62 ms) un ataque offline necesita
// 2^44 x 0,062 s = ~3,5 x 10^10 anos-CPU. Ahi ya no es el codigo el eslabon debil.
//
// El coste de la cuarta palabra es una palabra mas que dictar. Nos parece un
// intercambio evidente: 2048 veces mas caro de atacar por ~5 caracteres mas.
//
// El identificador de sala son 4 digitos (13,3 bits) y NO cuenta como entropia:
// se asume publico y enumerable. Lo unico que protege es el servidor limitando
// los `join` fallidos (ver server/index.js).
//
// ============================================================================
// MODELO DE AMENAZA: QUE CUBRE Y QUE NO
// ============================================================================
// CUBRE:
//   · Servidor de senalizacion malicioso o comprometido, y cualquiera que lea
//     sus logs: solo ve `4271`. No ve el secreto ni ningun hash del secreto, asi
//     que no tiene NADA que atacar offline. Descifrar es imposible, no caro.
//   · Vecino de LAN que escucha el broadcast UDP: el paquete `drop-lan` lleva
//     sha256 del identificador PUBLICO. Aprende "hay una sala 4271 en 192.168.1.5
//     puerto 51234" y puede conectar por TCP, pero sin el secreto no descifra un
//     byte: AES-GCM le rechaza el primer paquete.
//   · Grabacion pasiva del trafico TCP cifrado: romperlo exige fuerza bruta de
//     44 bits contra scrypt. Inviable.
//
// NO CUBRE:
//   · Enumeracion de identificadores de sala. Son 10.000. Con el limite de `join`
//     fallidos del servidor sale caro barrerlos, pero no imposible. Quien acierte
//     una sala viva entra en ella; lo unico que consigue es que el emisor le pida
//     una prueba de conocimiento del secreto (retos `challenge`/`proof` de la web)
//     y le eche. No obtiene ni el manifiesto de archivos ni los datos.
//   · MITM activo con control del servidor Y capacidad de responder al reto en
//     vivo. Sin PAKE no hay forma de autenticar mutuamente con 44 bits sin
//     exponer un verificador. Ver la nota "PAKE" abajo.
//   · Quien te mire la pantalla o escuche como dictas el codigo. Es un secreto
//     compartido de un solo uso, no una identidad.
//
// SOBRE PAKE: lo correcto de manual seria SPAKE2 o CPace, que autentican con
// entropia baja sin dejar verificador offline. No se implementa aqui a proposito:
// `node:crypto` no trae ninguno, exige aritmetica de curva elipticas escrita a
// mano (hash-to-curve, chequeos de subgrupo) y una implementacion casera y sin
// auditar de un PAKE es peor que no tenerlo. El proyecto no admite dependencias
// nuevas (se compila a binario unico con Node SEA), asi que se cubre el hueco
// con: identificador publico separado + KDF lento + limite de intentos.
//
// ============================================================================
// Este modulo es compartido por el servidor (Node ESM), el CLI (Node ESM, se
// bundlea con esbuild) y la web (ESM de navegador, sin bundler). Por eso no
// importa nada de `node:*`: la aleatoriedad entra como parametro y por defecto
// usa `crypto.getRandomValues`, que existe igual en el navegador y en Node.
// La derivacion de clave (scrypt, solo Node) vive aparte, en cli/src/crypto.js.
// ============================================================================

import { WORDLIST } from './wordlist.js';

export const ROOM_ID_DIGITS = 4;      // identificador publico de sala
export const SECRET_WORDS = 4;        // palabras de la parte secreta
export const SECRET_BITS = SECRET_WORDS * 11;   // 44 bits
export const MIN_PREFIX = 3;          // prefijo minimo aceptado al corregir erratas

// Token de la v0.3.5: 12 bytes en base64url. Se sigue aceptando para no romper
// los binarios ya distribuidos.
// @deprecated Se elimina en la v0.5.0.
export const LEGACY_TOKEN_RE = /^[A-Za-z0-9_-]{16}$/;

const WORD_SET = new Set(WORDLIST);

// Indice prefijo -> palabras que empiezan por el. Se construye una vez: el parser
// se llama en la ruta de teclear un codigo, no en la de transferir datos, pero
// recorrer 2048 palabras por cada caracter tampoco tiene ninguna gracia.
const BY_PREFIX = new Map();
for (const word of WORDLIST) {
  for (let n = MIN_PREFIX; n <= word.length; n++) {
    const key = word.slice(0, n);
    const hit = BY_PREFIX.get(key);
    if (hit) hit.push(word);
    else BY_PREFIX.set(key, [word]);
  }
}

/** Error de codigo con una sugerencia legible para enseniar al usuario. */
export class CodeError extends Error {
  constructor(message, hint = '') {
    super(hint ? `${message} ${hint}` : message);
    this.name = 'CodeError';
    this.code = 'BAD_CODE';
    this.hint = hint;
  }
}

// La aleatoriedad por defecto sale de WebCrypto, que esta tanto en el navegador
// como en Node >= 19. El servidor y el CLI le pasan `randomBytes` de node:crypto
// explicitamente, asi que Node 18 tampoco se queda fuera.
function webRandomBytes(n) {
  const buf = new Uint8Array(n);
  if (!globalThis.crypto || !globalThis.crypto.getRandomValues) {
    throw new Error('No hay fuente de aleatoriedad criptografica disponible');
  }
  globalThis.crypto.getRandomValues(buf);
  return buf;
}

/**
 * Identificador publico de sala: `ROOM_ID_DIGITS` digitos.
 * Muestreo por rechazo para que los 10.000 valores sean equiprobables: `% 10000`
 * a secas sobre 16 bits sesgaria los primeros 5536 hacia arriba.
 */
export function randomRoomId(randomBytes = webRandomBytes) {
  const range = 10 ** ROOM_ID_DIGITS;
  const limit = Math.floor(65536 / range) * range;
  for (;;) {
    const b = randomBytes(2);
    const value = (b[0] << 8) | b[1];
    if (value < limit) return String(value % range).padStart(ROOM_ID_DIGITS, '0');
  }
}

/**
 * Parte secreta: `SECRET_WORDS` palabras. 2048 es 2^11 exacto, asi que 11 bits
 * de cada par de bytes dan un indice uniforme sin descartar nada.
 */
export function randomSecretWords(randomBytes = webRandomBytes) {
  const bytes = randomBytes(SECRET_WORDS * 2);
  const words = [];
  for (let i = 0; i < SECRET_WORDS; i++) {
    const index = ((bytes[i * 2] << 8) | bytes[i * 2 + 1]) & 0x7ff;   // 11 bits
    words.push(WORDLIST[index]);
  }
  return words;
}

/** Junta identificador de sala y palabras en el codigo que ve el usuario. */
export function formatCode(roomId, words) {
  return [roomId, ...words].join('-');
}

/** Codigo completo nuevo para una sala ya asignada por el servidor. */
export function newCode(roomId, randomBytes = webRandomBytes) {
  return formatCode(roomId, randomSecretWords(randomBytes));
}

/**
 * Deja el codigo en su forma canonica antes de mirarlo siquiera.
 * Tolera lo que la gente escribe de verdad: enlaces enteros, mayusculas, acentos
 * de un teclado espaniol (`melón`), espacios al dictar, guiones bajos, puntos y
 * separadores repetidos.
 */
export function normalizeCode(input) {
  let text = String(input == null ? '' : input).trim();
  // Enlace pegado: el codigo va siempre en el fragmento, detras de la ultima `#`.
  const hash = text.lastIndexOf('#');
  if (hash >= 0) text = text.slice(hash + 1);
  return text
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // lemon con tilde -> lemon
    .toLowerCase()
    .replace(/[\s_.,;:\/\\|+]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Distancia de edicion acotada a 1: solo nos interesa "¿querias decir X?". */
function isDistanceOne(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a === b) return false;
  if (a.length === b.length) {
    let diff = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && ++diff > 1) return false;
    return diff === 1;
  }
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  let i = 0;
  let j = 0;
  let skipped = false;
  while (i < short.length && j < long.length) {
    if (short[i] === long[j]) { i++; j++; continue; }
    if (skipped) return false;
    skipped = true;
    j++;
  }
  return true;
}

function suggestFor(token) {
  const near = WORDLIST.filter((w) => isDistanceOne(token, w)).slice(0, 3);
  return near.length ? `¿Querias decir ${near.join(' o ')}?` : '';
}

/**
 * Resuelve una palabra escrita a medias o con una errata.
 * Los 4 primeros caracteres de cada palabra BIP-39 son unicos, asi que a partir
 * de 4 letras siempre resuelve. Con 3 se intenta igual (la mitad de la lista ya
 * es unica ahi), y si el prefijo es ambiguo se dicen los candidatos en vez de
 * elegir uno al azar y descifrar basura.
 */
export function resolveWord(token) {
  if (WORD_SET.has(token)) return token;
  if (token.length >= MIN_PREFIX) {
    const matches = BY_PREFIX.get(token);
    if (matches && matches.length === 1) return matches[0];
    if (matches && matches.length > 1) {
      throw new CodeError(
        `"${token}" es ambiguo: encaja con ${matches.length} palabras.`,
        `Escribe al menos 4 letras (${matches.slice(0, 3).join(', ')}...).`,
      );
    }
  }
  throw new CodeError(`"${token}" no esta en la lista de palabras.`, suggestFor(token));
}

/** El identificador publico de sala tal cual lo genera el servidor. */
export function isRoomId(value) {
  return new RegExp(`^[0-9]{${ROOM_ID_DIGITS}}$`).test(String(value));
}

/**
 * @deprecated Token de sala de la v0.3.5. Se acepta solo para poder recibir de
 * clientes ya distribuidos; se elimina en la v0.5.0.
 */
export function isLegacyToken(value) {
  return LEGACY_TOKEN_RE.test(String(value == null ? '' : value).trim());
}

/**
 * Valida y descompone un codigo. Lanza `CodeError` con un mensaje que se puede
 * enseniar tal cual. Se llama ANTES de tocar la red: no tiene sentido abrir un
 * websocket para descubrir que faltaba una palabra.
 *
 * Devuelve `{ roomId, words, secret, code, legacy }`.
 */
export function parseCode(input) {
  const raw = String(input == null ? '' : input).trim();

  // Camino viejo: token base64url de 16 caracteres de la v0.3.5. Sensible a
  // mayusculas, asi que se comprueba antes de normalizar nada.
  // @deprecated
  const bare = raw.includes('#') ? raw.slice(raw.lastIndexOf('#') + 1).trim() : raw;
  if (isLegacyToken(bare)) {
    return { roomId: bare, words: [], secret: '', code: bare, legacy: true };
  }

  const normalized = normalizeCode(raw);
  if (!normalized) throw new CodeError('Codigo vacio.', 'Formato: 4271-lemon-radar-tiger-orbit');

  const parts = normalized.split('-').filter(Boolean);
  const roomId = parts[0];

  if (!isRoomId(roomId)) {
    throw new CodeError(
      `"${roomId}" no es un identificador de sala valido.`,
      `Un codigo empieza por ${ROOM_ID_DIGITS} digitos: 4271-lemon-radar-tiger-orbit`,
    );
  }

  const rest = parts.slice(1);
  if (rest.length !== SECRET_WORDS) {
    throw new CodeError(
      `Un codigo lleva ${SECRET_WORDS} palabras y has escrito ${rest.length}.`,
      'Formato: 4271-lemon-radar-tiger-orbit',
    );
  }

  const words = rest.map(resolveWord);
  return { roomId, words, secret: words.join('-'), code: formatCode(roomId, words), legacy: false };
}

/**
 * Version tolerante de `parseCode` para derivar claves: no valida nada, solo
 * separa por el primer guion. La usa `deriveKey`, que tiene que funcionar con
 * cualquier cadena que le den los dos extremos (incluidos los codigos de prueba
 * de los tests) mientras ambos deriven exactamente lo mismo.
 */
export function splitForKey(input) {
  const raw = String(input == null ? '' : input).trim();
  if (isLegacyToken(raw)) return { roomId: raw, secret: '', legacy: true };
  const normalized = normalizeCode(raw);
  const cut = normalized.indexOf('-');
  if (cut < 0) return { roomId: normalized, secret: '', legacy: false };
  return { roomId: normalized.slice(0, cut), secret: normalized.slice(cut + 1), legacy: false };
}
