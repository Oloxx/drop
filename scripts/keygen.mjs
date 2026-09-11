// Genera el par de claves con el que se firman las releases.
//
//   node scripts/keygen.mjs [ruta-del-fichero-privado]
//
// La privada se escribe en un fichero fuera del repositorio y NO se imprime: de
// ahi va al secret DROP_SIGNING_KEY sin pasar por la pantalla ni por el
// historial de la terminal:
//
//   gh secret set DROP_SIGNING_KEY < ~/.drop-signing-key
//
// La publica si se imprime, porque es publica: va empotrada en `cli/src/cli.js`
// (PUBLIC_KEY) y en el README, para que cualquiera pueda comprobar una descarga
// con `minisign -V`.
//
// Solo hay que ejecutarlo una vez, o al rotar la clave. Rotarla obliga a sacar
// una version nueva del CLI: los binarios ya distribuidos llevan dentro la
// publica vieja y rechazarian las releases firmadas con la nueva.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { generateKeyPair } from '../cli/src/minisign.js';

const target = process.argv[2] || path.join(os.homedir(), '.drop-signing-key');

if (fs.existsSync(target)) {
  console.error(`Ya existe ${target}. Bórralo a mano si de verdad quieres rotar la clave.`);
  process.exit(1);
}

const keys = generateKeyPair();

// 0600 antes de escribir nada: en un sistema de ficheros POSIX no hay ventana en
// la que la clave exista y sea legible por todos. En Windows no aplica, pero el
// modo se ignora sin ruido.
fs.writeFileSync(target, keys.secretKey + '\n', { mode: 0o600 });

console.log(`
  Clave privada escrita en ${target} (no se imprime).
  Guarda una copia en un sitio seguro: sin ella no se pueden firmar releases.

  Súbela al repositorio con:

    gh secret set DROP_SIGNING_KEY < ${target}

  Clave pública (key id ${keys.keyId.toString('hex')}), para el CLI y el README:

    ${keys.publicKey}
`);
