// Firma Ed25519 de las releases, en formato minisign.
//
// El SHA256SUMS ya impedia que un binario llegase alterado, pero no dice nada de
// QUIEN lo publico: quien pueda servir una respuesta a api.github.com (un proxy
// con su propia CA, un DNS envenenado, la cuenta de GitHub comprometida) puede
// publicar su propio binario Y su propio SHA256SUMS, y las dos mitades cuadran.
// La firma cierra eso: la clave privada vive como secret del repositorio y solo
// el workflow de release la usa; la publica va empotrada en el binario, asi que
// para colar un ejecutable hay que romper la clave, no la red.
//
// Se usa el formato de minisign en vez de uno propio para que cualquiera pueda
// comprobar una descarga a mano con la herramienta estandar, sin fiarse de que
// nuestro propio codigo diga la verdad. Verificar y firmar aqui no necesita
// dependencias: Ed25519 viene en el `crypto` de Node.
//
// El formato, para no tener que ir a buscarlo:
//
//   clave publica    untrusted comment: <texto>
//                    base64( "Ed" | key_id[8] | pubkey[32] )
//
//   firma (.minisig) untrusted comment: <texto>
//                    base64( alg[2] | key_id[8] | firma[64] )
//                    trusted comment: <texto>
//                    base64( firma_global[64] )
//
// `alg` es "Ed" (la firma cubre el contenido tal cual) o "ED" (cubre su
// BLAKE2b-512). Aqui se firma con "Ed": el SHA256SUMS son unos cientos de bytes
// y asi no hace falta BLAKE2b, que Node no trae. La firma global cubre
// `firma | comentario de confianza`, y es lo que impide cambiar ese comentario
// sin invalidar el fichero.
import crypto from 'node:crypto';

const ALG_LEGACY = 'Ed';
const ALG_PREHASHED = 'ED';
const KEY_ID_BYTES = 8;
const SIG_BYTES = 64;
const KEY_BYTES = 32;

// Prefijos DER de una clave Ed25519 en crudo. Node solo acepta SPKI/PKCS8, y el
// formato de minisign guarda los 32 bytes pelados: envolverlos es todo lo que
// hace falta para pasar de uno a otro.
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

const publicKeyFrom = (raw) =>
  crypto.createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  });

const privateKeyFrom = (seed) =>
  crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });

/** Las lineas en base64 de un fichero de minisign, sin comentarios ni vacias. */
function base64Lines(text) {
  return String(text)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('untrusted comment:') && !line.startsWith('trusted comment:'));
}

/**
 * Lee una clave publica en formato minisign. Acepta el fichero entero (con su
 * linea de comentario) o solo la linea en base64.
 */
export function parsePublicKey(text) {
  const [line] = base64Lines(text);
  if (!line) throw new Error('clave publica vacia');
  const raw = Buffer.from(line, 'base64');
  if (raw.length !== 2 + KEY_ID_BYTES + KEY_BYTES) throw new Error('clave publica con longitud invalida');
  const alg = raw.subarray(0, 2).toString('latin1');
  if (alg !== ALG_LEGACY) throw new Error(`algoritmo de clave no soportado: ${alg}`);
  return {
    keyId: raw.subarray(2, 2 + KEY_ID_BYTES),
    key: raw.subarray(2 + KEY_ID_BYTES),
  };
}

/** Lee un fichero .minisig. */
export function parseSignature(text) {
  const raw = String(text);
  const lines = base64Lines(raw);
  if (lines.length < 2) throw new Error('firma incompleta');

  const head = Buffer.from(lines[0], 'base64');
  if (head.length !== 2 + KEY_ID_BYTES + SIG_BYTES) throw new Error('firma con longitud invalida');
  const alg = head.subarray(0, 2).toString('latin1');
  if (alg !== ALG_LEGACY && alg !== ALG_PREHASHED) throw new Error(`algoritmo de firma no soportado: ${alg}`);

  const globalSig = Buffer.from(lines[1], 'base64');
  if (globalSig.length !== SIG_BYTES) throw new Error('firma global con longitud invalida');

  // El comentario de confianza va dentro de la firma global, asi que hay que
  // cogerlo tal cual esta escrito, sin normalizar nada.
  const match = raw.match(/^trusted comment: (.*)$/m);
  if (!match) throw new Error('falta el comentario de confianza');

  return {
    alg,
    keyId: head.subarray(2, 2 + KEY_ID_BYTES),
    signature: head.subarray(2 + KEY_ID_BYTES),
    trustedComment: match[1].replace(/\r$/, ''),
    globalSignature: globalSig,
  };
}

/**
 * Comprueba una firma sobre `content`. Devuelve `{ ok, reason, trustedComment }`
 * en vez de lanzar: quien llama tiene que poder distinguir "esto no es una firma"
 * de "esta firma no vale", y ensenar el motivo.
 */
export function verifySignature({ content, signature, publicKey }) {
  let pub;
  let sig;
  try {
    pub = typeof publicKey === 'string' ? parsePublicKey(publicKey) : publicKey;
    sig = typeof signature === 'string' ? parseSignature(signature) : signature;
  } catch (err) {
    return { ok: false, reason: err.message };
  }

  // Un algoritmo prehashed exigiria BLAKE2b-512, que Node no trae: nuestras
  // releases se firman con "Ed" y este caso solo aparece con un fichero ajeno.
  if (sig.alg === ALG_PREHASHED) {
    return { ok: false, reason: 'la firma es de tipo prehashed y este verificador solo admite Ed' };
  }

  if (!sig.keyId.equals(pub.keyId)) {
    return {
      ok: false,
      reason: `la firma es de otra clave (${sig.keyId.toString('hex')}, esperada ${pub.keyId.toString('hex')})`,
    };
  }

  const key = publicKeyFrom(pub.key);
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content);
  if (!crypto.verify(null, body, key, sig.signature)) {
    return { ok: false, reason: 'la firma no corresponde al contenido' };
  }

  // Sin esto, el comentario de confianza seria texto libre que cualquiera podria
  // reescribir dejando la firma principal intacta.
  const global = Buffer.concat([sig.signature, Buffer.from(sig.trustedComment, 'utf8')]);
  if (!crypto.verify(null, global, key, sig.globalSignature)) {
    return { ok: false, reason: 'el comentario de confianza no cuadra con la firma global' };
  }

  return { ok: true, trustedComment: sig.trustedComment };
}

/**
 * Firma `content` y devuelve el contenido de un fichero .minisig.
 *
 * `secretKey` son los 72 bytes de `key_id | semilla | publica` en base64, que es
 * lo que guarda el secret del repositorio y lo que produce `generateKeyPair`.
 */
export function signContent({ content, secretKey, comment, trustedComment }) {
  const { keyId, seed } = parseSecretKey(secretKey);
  const key = privateKeyFrom(seed);
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content);

  const signature = crypto.sign(null, body, key);
  const trusted = trustedComment || `timestamp:${Math.floor(Date.now() / 1000)}`;
  const globalSignature = crypto.sign(
    null,
    Buffer.concat([signature, Buffer.from(trusted, 'utf8')]),
    key,
  );

  const head = Buffer.concat([Buffer.from(ALG_LEGACY, 'latin1'), keyId, signature]);
  return [
    `untrusted comment: ${comment || 'signature from drop'}`,
    head.toString('base64'),
    `trusted comment: ${trusted}`,
    globalSignature.toString('base64'),
    '',
  ].join('\n');
}

/** Lee la clave privada tal y como se guarda en el secret del repositorio. */
export function parseSecretKey(secretKey) {
  const raw = Buffer.isBuffer(secretKey) ? secretKey : Buffer.from(String(secretKey).trim(), 'base64');
  if (raw.length !== KEY_ID_BYTES + KEY_BYTES * 2) {
    throw new Error(`clave privada con longitud invalida (${raw.length} bytes, esperados 72)`);
  }
  return {
    keyId: raw.subarray(0, KEY_ID_BYTES),
    seed: raw.subarray(KEY_ID_BYTES, KEY_ID_BYTES + KEY_BYTES),
    key: raw.subarray(KEY_ID_BYTES + KEY_BYTES),
  };
}

/**
 * Genera un par nuevo. Devuelve la privada lista para el secret y la publica ya
 * en el formato que lee `minisign -P`.
 */
export function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'der' }).subarray(SPKI_PREFIX.length);
  const seed = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(PKCS8_PREFIX.length);
  const keyId = crypto.randomBytes(KEY_ID_BYTES);

  return {
    keyId,
    secretKey: Buffer.concat([keyId, seed, pub]).toString('base64'),
    publicKey: Buffer.concat([Buffer.from(ALG_LEGACY, 'latin1'), keyId, pub]).toString('base64'),
  };
}
