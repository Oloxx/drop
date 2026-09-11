// Firma de las releases: formato minisign y casos de manipulacion.
//
// El formato importa tanto como la criptografia: si el fichero que generamos no
// es el que espera `minisign -V`, la verificacion a mano que documenta el README
// no sirve de nada y nadie se entera hasta que alguien la intenta. Por eso hay
// casos sobre la disposicion de los bytes, no solo sobre firmar y verificar.
//
// La comprobacion cruzada con el minisign de verdad esta en el workflow de
// release, que firma y acto seguido verifica con el binario oficial antes de
// publicar nada.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  generateKeyPair,
  parsePublicKey,
  parseSecretKey,
  parseSignature,
  signContent,
  verifySignature,
} from '../cli/src/minisign.js';

const CONTENT = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  drop-v9.9.9-linux-x64.tar.gz\n';

test('una firma recien hecha se verifica con su clave', () => {
  const keys = generateKeyPair();
  const sig = signContent({ content: CONTENT, secretKey: keys.secretKey });

  const res = verifySignature({ content: CONTENT, signature: sig, publicKey: keys.publicKey });
  assert.equal(res.ok, true, res.reason);
  assert.match(res.trustedComment, /^timestamp:\d+$/);
});

test('el fichero tiene la forma que espera minisign', () => {
  const keys = generateKeyPair();
  const sig = signContent({ content: CONTENT, secretKey: keys.secretKey, comment: 'hola', trustedComment: 'file:SHA256SUMS' });
  const lines = sig.split('\n');

  assert.equal(lines[0], 'untrusted comment: hola');
  assert.equal(lines[2], 'trusted comment: file:SHA256SUMS');
  assert.equal(lines[4], '');

  // alg[2] | key_id[8] | firma[64], y la firma global pelada debajo.
  const head = Buffer.from(lines[1], 'base64');
  assert.equal(head.length, 74);
  assert.equal(head.subarray(0, 2).toString('latin1'), 'Ed');
  assert.equal(Buffer.from(lines[3], 'base64').length, 64);

  // El key_id de la firma es el mismo que lleva la clave publica.
  assert.deepEqual(head.subarray(2, 10), parsePublicKey(keys.publicKey).keyId);
});

test('la clave publica es "Ed" + key_id + 32 bytes', () => {
  const keys = generateKeyPair();
  const raw = Buffer.from(keys.publicKey, 'base64');
  assert.equal(raw.length, 42);
  assert.equal(raw.subarray(0, 2).toString('latin1'), 'Ed');

  const parsed = parsePublicKey(keys.publicKey);
  assert.equal(parsed.key.length, 32);
  // Y coincide con la que va dentro de la privada.
  assert.deepEqual(parsed.key, parseSecretKey(keys.secretKey).key);
});

test('un contenido alterado invalida la firma', () => {
  const keys = generateKeyPair();
  const sig = signContent({ content: CONTENT, secretKey: keys.secretKey });

  const res = verifySignature({
    content: CONTENT.replace('e3b0', 'f00d'),
    signature: sig,
    publicKey: keys.publicKey,
  });
  assert.equal(res.ok, false);
  assert.match(res.reason, /no corresponde al contenido/);
});

// Este es el caso que justifica que exista la firma global: sin ella, el
// comentario de confianza seria texto libre en un fichero firmado.
test('cambiar el comentario de confianza invalida la firma', () => {
  const keys = generateKeyPair();
  const sig = signContent({ content: CONTENT, secretKey: keys.secretKey, trustedComment: 'file:SHA256SUMS' });

  const res = verifySignature({
    content: CONTENT,
    signature: sig.replace('trusted comment: file:SHA256SUMS', 'trusted comment: file:otra-cosa'),
    publicKey: keys.publicKey,
  });
  assert.equal(res.ok, false);
  assert.match(res.reason, /comentario de confianza/);
});

test('una firma de otra clave se rechaza por key_id', () => {
  const mias = generateKeyPair();
  const suyas = generateKeyPair();
  const sig = signContent({ content: CONTENT, secretKey: suyas.secretKey });

  const res = verifySignature({ content: CONTENT, signature: sig, publicKey: mias.publicKey });
  assert.equal(res.ok, false);
  assert.match(res.reason, /otra clave/);
});

// Un atacante que sepa el key_id ajeno puede ponerlo en su firma: lo que corta
// ahi no es el identificador, es que la firma no verifica con esa clave.
test('copiar el key_id ajeno no cuela', () => {
  const mias = generateKeyPair();
  const suyas = generateKeyPair();
  const sig = signContent({ content: CONTENT, secretKey: suyas.secretKey });

  const lines = sig.split('\n');
  const head = Buffer.from(lines[1], 'base64');
  parsePublicKey(mias.publicKey).keyId.copy(head, 2);
  lines[1] = head.toString('base64');

  const res = verifySignature({ content: CONTENT, signature: lines.join('\n'), publicKey: mias.publicKey });
  assert.equal(res.ok, false);
  assert.match(res.reason, /no corresponde al contenido/);
});

test('un fichero que no es una firma da un motivo, no una excepcion', () => {
  const keys = generateKeyPair();
  for (const basura of ['', 'no soy una firma', 'untrusted comment: solo esto\n']) {
    const res = verifySignature({ content: CONTENT, signature: basura, publicKey: keys.publicKey });
    assert.equal(res.ok, false);
    assert.ok(res.reason, 'deberia explicar por que');
  }
});

test('una firma prehashed se rechaza en vez de darse por buena', () => {
  const keys = generateKeyPair();
  const lines = signContent({ content: CONTENT, secretKey: keys.secretKey }).split('\n');
  const head = Buffer.from(lines[1], 'base64');
  head.write('ED', 0, 'latin1');
  lines[1] = head.toString('base64');

  const res = verifySignature({ content: CONTENT, signature: lines.join('\n'), publicKey: keys.publicKey });
  assert.equal(res.ok, false);
  assert.match(res.reason, /prehashed/);
});

test('la firma es Ed25519 estandar sobre el contenido tal cual', () => {
  const keys = generateKeyPair();
  const sig = parseSignature(signContent({ content: CONTENT, secretKey: keys.secretKey }));

  // Verificado con la API de Node a pelo, sin pasar por nuestro parser: si algun
  // dia cambiamos el envoltorio DER, esto lo cazaria.
  const spki = Buffer.concat([
    Buffer.from('302a300506032b6570032100', 'hex'),
    parsePublicKey(keys.publicKey).key,
  ]);
  const pub = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
  assert.equal(crypto.verify(null, Buffer.from(CONTENT), pub, sig.signature), true);
});

// La constante de `cli.js` es la unica copia de la clave publica que viaja en
// los binarios, y el workflow de release la saca de ahi con un grep para
// contrastarla con el minisign de verdad. Si alguien la parte en dos lineas o le
// cambia el formato, la release deja de verificarse y nadie se entera hasta que
// falla el despliegue.
test('la clave publica empotrada en el CLI es usable', async () => {
  const fs = await import('node:fs');
  const url = new URL('../cli/src/cli.js', import.meta.url);
  const fuente = fs.readFileSync(url, 'utf8');

  const match = fuente.match(/RW[A-Za-z0-9+/=]{40,}/);
  assert.ok(match, 'deberia haber una clave publica en cli/src/cli.js');

  const parsed = parsePublicKey(match[0]);
  assert.equal(parsed.key.length, 32);
  assert.equal(parsed.keyId.length, 8);
});

test('una clave privada con longitud rara se rechaza al usarla', () => {
  assert.throws(() => parseSecretKey(Buffer.alloc(10).toString('base64')), /longitud invalida/);
  assert.throws(
    () => signContent({ content: CONTENT, secretKey: 'no-es-base64-valido' }),
    /longitud invalida/,
  );
});
