// Firma un fichero de la release y deja el .minisig al lado.
//
//   DROP_SIGNING_KEY=<base64> node scripts/sign-release.mjs dist/SHA256SUMS
//
// Lo usa el workflow de release sobre el SHA256SUMS: firmar el indice de hashes
// y no cada binario significa una sola firma que cubre los cinco, porque cambiar
// cualquiera obliga a cambiar el SHA256SUMS.
//
// La clave sale del entorno y nunca de un argumento: en la linea de comandos la
// verian el resto de procesos de la maquina y acabaria en los logs del runner.
import fs from 'node:fs';
import path from 'node:path';

import { signContent, verifySignature, parseSecretKey } from '../cli/src/minisign.js';

const target = process.argv[2];
if (!target) {
  console.error('Uso: node scripts/sign-release.mjs <fichero>');
  process.exit(1);
}

const secretKey = process.env.DROP_SIGNING_KEY;
if (!secretKey) {
  console.error('Falta DROP_SIGNING_KEY: sin la clave privada no se puede firmar la release.');
  console.error('Generala con `node scripts/keygen.mjs` y subela con `gh secret set DROP_SIGNING_KEY`.');
  process.exit(1);
}

const content = fs.readFileSync(target);
const name = path.basename(target);

const signature = signContent({
  content,
  secretKey,
  comment: `firma de drop para ${name}`,
  trustedComment: `timestamp:${Math.floor(Date.now() / 1000)}\tfile:${name}`,
});

// Verificar lo que se acaba de firmar, con la publica que va dentro de la propia
// clave privada. No prueba que el CLI lo acepte -- eso lo mira el workflow con el
// minisign de verdad -- pero si que la clave del secret es la que se cree.
const check = verifySignature({
  content,
  signature,
  publicKey: { keyId: parseSecretKey(secretKey).keyId, key: parseSecretKey(secretKey).key },
});
if (!check.ok) {
  console.error(`La firma recien hecha no se verifica: ${check.reason}`);
  process.exit(1);
}

fs.writeFileSync(`${target}.minisig`, signature);
console.log(`Firmado ${name} -> ${name}.minisig`);
