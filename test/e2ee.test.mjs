// Cifrado de extremo a extremo del relay: el navegador tiene que llegar a la
// MISMA clave, la misma prueba y la misma huella que el CLI, y abrir lo que el
// CLI cierra. Se comprueba el modulo compartido de verdad (public/shared/*)
// contra node:crypto, que es lo que usa el CLI.
// Este fichero no necesita servidor.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { scrypt, hmacSha256, pbkdf2Sha256 } from '../public/shared/scrypt.js';
import {
  deriveRoomKey, proofFromKey, sasFromKeyBytes, sealBox, openBox, openerFor, unsealFrame, SCRYPT_PARAMS,
} from '../public/shared/e2ee.js';
import { PROTOCOL_VERSION } from '../public/shared/protocol.js';
import {
  deriveKey, encryptChunk, decryptChunk, sasFromKey, sealFrame,
  proofFromKey as cliProofFromKey, unsealFrame as cliUnsealFrame,
} from '../cli/src/crypto.js';

const CODE = '4271-lemon-radar-tiger-orbit';
const eq = (a, b) => assert.equal(Buffer.from(a).toString('hex'), Buffer.from(b).toString('hex'));

test('HMAC y PBKDF2 propios coinciden con node:crypto', () => {
  const msg = Buffer.from('The quick brown fox');
  for (const key of [Buffer.from('k'), Buffer.alloc(64, 3), Buffer.alloc(200, 9)]) {
    eq(hmacSha256(key, msg), crypto.createHmac('sha256', key).update(msg).digest());
  }
  eq(pbkdf2Sha256(Buffer.from('pw'), Buffer.from('salt'), 3, 70), crypto.pbkdf2Sync('pw', 'salt', 3, 70, 'sha256'));
});

test('scrypt pasa el vector de la RFC 7914 y cuadra con node:crypto', async () => {
  // RFC 7914, seccion 12, segundo vector.
  const rfc = await scrypt(Buffer.from('password'), Buffer.from('NaCl'), { N: 1024, r: 8, p: 16, dkLen: 64 });
  assert.equal(Buffer.from(rfc).toString('hex'),
    'fdbabe1c9d3472007856e7190d01e9fe7c6ad7cbc8237830e77376634b3731622eaf30d92e22a3886ff109279d9830dac727afb94a83ee6d8360cbdfa2cc0640');

  // Parametros pequenos con r y p raros, por si el orden de los bloques o la
  // conversion little-endian estuviese mal en algun caso que el vector no toca.
  for (const [N, r, p] of [[16, 1, 1], [32, 3, 2], [64, 8, 1]]) {
    const mine = await scrypt(Buffer.from('pw'), Buffer.from('sal'), { N, r, p, dkLen: 40, yieldEvery: 0 });
    const node = crypto.scryptSync('pw', 'sal', 40, { N, r, p, maxmem: 64 * 1024 * 1024 });
    eq(mine, node);
  }
});

test('el navegador deriva la misma clave de sala que el CLI', async () => {
  const cli = deriveKey(CODE);
  const web = await deriveRoomKey('4271', 'lemon-radar-tiger-orbit');
  eq(web, cli);
  assert.equal(web.length, SCRYPT_PARAMS.dkLen);
});

test('prueba de conocimiento y huella coinciden entre navegador y CLI', () => {
  const key = deriveKey(CODE);
  const nonce = 'deadbeef'.repeat(4);
  assert.equal(proofFromKey(key, nonce), cliProofFromKey(key, nonce));
  assert.match(proofFromKey(key, nonce), /^[0-9a-f]{64}$/);
  // Otra clave, otra prueba: es lo que el emisor compara.
  assert.notEqual(proofFromKey(deriveKey('4271-apple-bacon-cabin-dance'), nonce), proofFromKey(key, nonce));
  assert.equal(sasFromKeyBytes(key, '4271'), sasFromKey(key, '4271'));
});

test('el navegador abre lo que el CLI cifra, y al reves', async () => {
  const key = deriveKey(CODE);
  const body = crypto.randomBytes(64 * 1024 + 13);

  // CLI -> web: trozo binario.
  eq(await openBox(key, encryptChunk(body, key)), body);
  // Con el importKey reutilizado, que es lo que hace el receptor en caliente.
  const opener = await openerFor(key);
  eq(await openBox(opener, encryptChunk(body, key)), body);

  // CLI -> web: marco sellado.
  const frame = sealFrame({ type: 'cli-start', index: 2, name: 'ñ.bin', size: 5 }, key);
  assert.equal(frame.type, 'cli-sealed');
  assert.deepEqual(await unsealFrame(opener, frame), { type: 'cli-start', index: 2, name: 'ñ.bin', size: 5 });
  assert.deepEqual(cliUnsealFrame(frame, key), { type: 'cli-start', index: 2, name: 'ñ.bin', size: 5 });

  // web -> CLI, por simetria del formato.
  eq(decryptChunk(Buffer.from(await sealBox(key, body)), key), body);

  // Otra clave o un byte tocado: error, nunca bytes.
  const otra = deriveKey('4271-apple-bacon-cabin-dance');
  await assert.rejects(openBox(otra, encryptChunk(body, key)));
  const roto = encryptChunk(body, key);
  roto[40] ^= 1;
  await assert.rejects(openBox(key, roto));
  assert.throws(() => cliUnsealFrame(sealFrame({ a: 1 }, otra), key));
});

test('la version del protocolo es la 2: relay cifrado', () => {
  // Bajarla dejaria a un receptor nuevo aceptando ofertas de emisores que mandan
  // los archivos en claro y una prueba de conocimiento que es un hash del secreto.
  assert.ok(PROTOCOL_VERSION >= 2);
});
