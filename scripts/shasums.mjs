// Verificacion de los binarios base de Node que descarga la compilacion.
//
// `build-cross.mjs` baja el runtime de nodejs.org y le inyecta el bytecode: ese
// binario ES el que se distribuye en las releases. Hasta ahora toda la confianza
// recaia en TLS, asi que un DNS envenenado, un proxy corporativo o un espejo
// manipulado se colaban enteros hasta el usuario final.
//
// nodejs.org publica junto a cada version un `SHASUMS256.txt` con el hash de todos
// sus ficheros. Sigue viniendo por el mismo TLS -- esto no es una cadena de firmas,
// para eso haria falta comprobar `SHASUMS256.txt.sig` con las claves del release
// team -- pero cierra el caso de un fichero cambiado en transito o en la cache
// local, que es donde un binario descargado hace meses se queda sin vigilancia.
import crypto from 'node:crypto';
import fs from 'node:fs';

/**
 * Parsea el formato de `sha256sum`: "<hash>  <nombre>", con dos espacios, o
 * "<hash> *<nombre>" en modo binario. Las lineas que no encajan se ignoran.
 */
export function parseShasums(text) {
  const out = new Map();
  for (const line of String(text).split('\n')) {
    const match = line.trim().match(/^([0-9a-f]{64})\s+\*?(\S.*)$/i);
    if (match) out.set(match[2].trim(), match[1].toLowerCase());
  }
  return out;
}

// Un solo fichero por ejecucion: `build:all` compila cinco destinos y todos miran
// la misma lista.
const cache = new Map();

export async function fetchShasums(nodeVersion, fetchImpl = fetch) {
  if (cache.has(nodeVersion)) return cache.get(nodeVersion);
  const url = `https://nodejs.org/dist/${nodeVersion}/SHASUMS256.txt`;
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} al descargar ${url}`);
  const sums = parseShasums(await res.text());
  if (!sums.size) throw new Error(`${url} no trae ningun hash reconocible`);
  cache.set(nodeVersion, sums);
  return sums;
}

/** SHA-256 de un fichero, en streaming: los tar.gz de Node pasan de 40 MB. */
export function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Comprueba un fichero contra el hash esperado. Si no cuadra lo BORRA antes de
 * fallar: dejarlo en la cache significaria que el siguiente intento de compilar
 * lo encuentra ya descargado y se lo cree.
 */
export async function verifyFile(filePath, expectedHash, label = filePath) {
  const actual = await sha256File(filePath);
  if (actual === String(expectedHash).toLowerCase()) return actual;
  try { fs.unlinkSync(filePath); } catch { /* si no se puede borrar, peor pero igual falla */ }
  throw new Error(
    `El hash de ${label} no coincide con el de nodejs.org.\n` +
    `  esperado: ${expectedHash}\n` +
    `  obtenido: ${actual}\n` +
    `  El fichero se ha borrado. Si se repite, no compiles: algo esta cambiando la descarga.`
  );
}

/** El hash que nodejs.org publica para ese nombre, o un error legible si no esta. */
export function expectedHash(sums, name) {
  const hash = sums.get(name);
  if (!hash) {
    throw new Error(`SHASUMS256.txt no incluye "${name}": no hay con que comparar, se aborta.`);
  }
  return hash;
}
