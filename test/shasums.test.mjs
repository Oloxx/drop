// Verificacion de los binarios base de Node que descarga la compilacion.
// Ejecutar con:  npm test   (este fichero no necesita servidor)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseShasums, sha256File, verifyFile, expectedHash, fetchShasums } from '../scripts/shasums.mjs';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function tmpFile(contents) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'drop-sha-')), 'fichero.bin');
  fs.writeFileSync(p, contents);
  return p;
}

test('parseShasums entiende los dos formatos de sha256sum', () => {
  const sums = parseShasums([
    `${HASH_A}  node-v22.15.0-linux-x64.tar.gz`,
    `${HASH_B} *win-x64/node.exe`,
  ].join('\n'));

  assert.equal(sums.get('node-v22.15.0-linux-x64.tar.gz'), HASH_A);
  assert.equal(sums.get('win-x64/node.exe'), HASH_B);
});

test('parseShasums ignora lo que no sea una linea de hash', () => {
  const sums = parseShasums([
    '-----BEGIN PGP SIGNED MESSAGE-----',
    'Hash: SHA256',
    '',
    `${HASH_A}  node.tar.gz`,
    'abc  demasiado-corto.tar.gz',
    'basura',
  ].join('\n'));

  assert.equal(sums.size, 1);
  assert.equal(sums.get('node.tar.gz'), HASH_A);
});

test('expectedHash falla con un nombre que no esta publicado', () => {
  const sums = parseShasums(`${HASH_A}  node.tar.gz`);
  assert.equal(expectedHash(sums, 'node.tar.gz'), HASH_A);
  assert.throws(() => expectedHash(sums, 'otro.tar.gz'), /no incluye/);
});

test('verifyFile acepta el fichero que cuadra y lo deja donde estaba', async () => {
  const file = tmpFile('contenido de prueba');
  const hash = crypto.createHash('sha256').update('contenido de prueba').digest('hex');

  assert.equal(await sha256File(file), hash);
  assert.equal(await verifyFile(file, hash), hash);
  assert.ok(fs.existsSync(file), 'un fichero valido no se toca');
});

test('verifyFile borra el fichero que no cuadra', async () => {
  // Lo importante no es que falle, sino que no quede en la cache: si sobreviviera,
  // la siguiente compilacion lo encontraria ya descargado y se lo creeria.
  const file = tmpFile('me han cambiado por el camino');

  await assert.rejects(() => verifyFile(file, HASH_A, 'node.tar.gz'), /no coincide/);
  assert.equal(fs.existsSync(file), false);
});

test('fetchShasums se queja si la respuesta no trae hashes', async () => {
  const fakeFetch = async () => ({ ok: true, text: async () => 'una pagina de error de un proxy' });
  await assert.rejects(() => fetchShasums('v0.0.0-inventada', fakeFetch), /ningun hash/);
});
