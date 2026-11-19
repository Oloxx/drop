// Version del protocolo de transferencia del CLI: la que viaja dentro del
// manifiesto cifrado por TCP directo y en la oferta (`cli-offer`) del relay.
//
// CONGELADA EN LA 5 PARA TODA LA 1.x (docs/COMPATIBILITY.md). Lo nuevo entra
// como campos opcionales, marcos que el otro ignora o capacidades anunciadas
// en `features`, nunca subiendo este numero: subirlo deja a cada `drop`
// instalado sin hablar con la web ni con los nuevos, y eso es una 2.0.
// test/compat.test.mjs falla si cambia antes.
//
// Vive aqui, y no en cli/src/transfer.js, porque el receptor web tambien la
// comprueba: un `drop send` antiguo que ofrezca otra version no se entiende a
// medias, se rechaza con un mensaje que dice que actualice.
//
//   1  v0.5.0: manifiesto con version dentro del AEAD; relay en claro.
//   2  relay cifrado de extremo a extremo (AES-256-GCM con la clave scrypt del
//      codigo) y prueba de conocimiento derivada de esa clave, no del secreto.
//   3  reanudacion: por TCP el receptor contesta al manifiesto con `ready` (los
//      `.part` que tiene y el hash de cada uno) y el emisor abre cada archivo
//      con `start` y el offset desde el que manda; por relay lo mismo dentro de
//      `cli-accept` y `cli-start`. Un emisor v2 manda datos sin `start` y un
//      receptor v2 nunca contesta al manifiesto: no se entienden a medias.
//   4  tamano desconocido: un archivo del manifiesto (TCP directo y
//      `cli-manifest`/`cli-start` por relay) puede llevar `size: null`, que es
//      lo que manda `drop send -` al leer de stdin. El archivo acaba donde
//      diga su `end`, no en un byte contado. Un receptor v3 se creia el total
//      (NaN en la barra, acuses que no salen) y "funcionaba" a medias, que es
//      peor que rechazarse.
//   5  seleccion de archivos: el receptor puede pedir solo parte del lote con
//      `files` (indices del manifiesto) en `ready` por TCP y en `cli-accept`
//      por relay. Un emisor v4 lo ignoraria y mandaria el lote entero a quien
//      ha pedido tres fotos de quince.
export const PROTOCOL_VERSION = 5;

/**
 * Los archivos que ha pedido el receptor, como indices del manifiesto.
 *
 * `null` es "todos": el campo no venia, que es lo que manda quien no elige.
 * Una lista se limpia -- enteros dentro del manifiesto, sin repetir, en orden
 * -- y se respeta tal cual, vacia incluida: un receptor que no quiere nada
 * recibe solo el `done`. Mandarle el lote entero por un indice mal formado
 * seria darle justo lo que no ha pedido.
 *
 * La usan los tres emisores (web, `drop send` por TCP y por relay), asi que
 * los tres entienden lo mismo por la misma lista.
 */
export function pickedFiles(files, count) {
  if (!Array.isArray(files)) return null;
  const valid = files.filter((i) => Number.isInteger(i) && i >= 0 && i < count);
  return [...new Set(valid)].sort((a, b) => a - b);
}

export const PREFIX_READ_BLOCK = 2 * 1024 * 1024;

/**
 * Entero seguro no negativo de 53 bits (hasta `Number.MAX_SAFE_INTEGER`).
 * Evita el truncado a 32 bits con signo (`| 0`) en contadores > 2 GiB.
 */
export function safeNonNegInt(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * Actualiza un acumulador de bytes confirmados (`ack` / `cli-ack`) sin
 * truncarlo a 32 bits ni retroceder ante valores fuera de orden o invalidos.
 */
export function nextAckBytes(currentAcked, reportedBytes) {
  const acked = safeNonNegInt(reportedBytes);
  if (acked === null) return null;
  const base = safeNonNegInt(currentAcked) ?? 0;
  return Math.max(base, acked);
}

/**
 * Extrae `{ index, offset }` de un mensaje `resume` validando enteros seguros
 * de 53 bits. Devuelve `null` si el indice es invalido.
 */
export function parseResumePoint(msg) {
  if (!msg || typeof msg !== 'object') return null;
  const index = msg.index == null ? 0 : safeNonNegInt(msg.index);
  if (index === null) return null;
  const offset = msg.offset == null ? 0 : (safeNonNegInt(msg.offset) ?? 0);
  return { index, offset };
}

/**
 * Alimenta `hasher` con `[0, limit)` de `file` en bloques de `blockSize`
 * (2 MiB por defecto) para no reservar varios GB en RAM al reanudar.
 * Devuelve `false` si `shouldAbort()` se activa antes o durante la lectura.
 */
export async function hashFilePrefix(file, limit, hasher, {
  blockSize = PREFIX_READ_BLOCK,
  shouldAbort = null,
  onBlock = null,
} = {}) {
  for (let pos = 0; pos < limit; pos += blockSize) {
    if (shouldAbort && shouldAbort()) return false;
    const end = Math.min(pos + blockSize, limit);
    const buf = await file.slice(pos, end).arrayBuffer();
    if (shouldAbort && shouldAbort()) return false;
    hasher.update(buf);
    if (onBlock) await onBlock(pos, end, limit);
  }
  return true;
}
