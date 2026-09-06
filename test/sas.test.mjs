// Huella corta de sesion (SAS): lo que permite detectar un MITM comparandola a mano.
// Ejecutar con:  npm test   (este fichero no necesita servidor)
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { sasInput, sasWords, formatSas, dtlsFingerprints, SAS_WORDS } from '../public/shared/sas.js';
import { deriveKey, sasFromKey } from '../cli/src/crypto.js';
import { WORDLIST } from '../public/shared/wordlist.js';

const sha256Hex = (text) => crypto.createHash('sha256').update(text).digest('hex');

// Dos fingerprints DTLS de mentira, con el formato que ponen los navegadores.
const FP_A = 'sha-256 AA:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF';
const FP_B = 'sha-256 BB:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF';
const FP_MITM = 'sha-256 CC:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF';

const webSas = (...fps) => formatSas(sasWords(sha256Hex(sasInput('webrtc', fps))));

test('la huella son tres palabras de la lista BIP-39', () => {
  const words = sasWords(sha256Hex('lo que sea'));
  assert.equal(words.length, SAS_WORDS);
  for (const word of words) assert.ok(WORDLIST.includes(word), `${word} no esta en la lista`);
});

test('los dos extremos llegan a la misma huella con los papeles cambiados', () => {
  // El emisor tiene (mio=A, suyo=B) y el receptor (mio=B, suyo=A). Sin orden
  // canonico cada uno hashearia una cadena distinta y la comparacion no valdria.
  assert.equal(webSas(FP_A, FP_B), webSas(FP_B, FP_A));
});

test('un fingerprint sustituido cambia la huella', () => {
  // Este es el caso que importa: el servidor se mete en medio y le ensena a cada
  // lado su propio certificado. Ninguno de los dos ve la huella del otro.
  const legitima = webSas(FP_A, FP_B);
  const ladoEmisor = webSas(FP_A, FP_MITM);
  const ladoReceptor = webSas(FP_MITM, FP_B);

  assert.notEqual(ladoEmisor, legitima);
  assert.notEqual(ladoReceptor, legitima);
  assert.notEqual(ladoEmisor, ladoReceptor);
});

test('la huella no contiene el secreto ni se puede volver atras desde ella', () => {
  // Lo que se hashea lleva fingerprints publicos, nunca las palabras del codigo:
  // si las llevara, leer la huella en voz alta regalaria un verificador offline
  // de 44 bits detras de un SHA-256, que cae en horas.
  const input = sasInput('webrtc', [FP_A, FP_B]);
  assert.ok(!input.includes('lemon'));
  assert.match(input, /^drop-sas-v1\|webrtc\|/);
});

test('dtlsFingerprints saca los de un SDP y no repite', () => {
  const sdp = [
    'v=0',
    'o=- 1 2 IN IP4 127.0.0.1',
    'a=fingerprint:sha-256 AA:BB:CC',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'a=fingerprint:sha-256 AA:BB:CC',
    'a=setup:actpass',
  ].join('\r\n');

  assert.deepEqual(dtlsFingerprints(sdp), ['sha-256 AA:BB:CC']);
  assert.deepEqual(dtlsFingerprints(''), []);
  assert.deepEqual(dtlsFingerprints(undefined), []);
});

test('la huella del CLI sale de la clave, y cambia con el codigo y con la sala', () => {
  const key = deriveKey('4271-lemon-radar-tiger-orbit');

  // Determinista: los dos CLI derivan la misma clave y ven la misma huella sin
  // intercambiar nada por el cable.
  assert.equal(sasFromKey(key, '4271'), sasFromKey(deriveKey('4271-lemon-radar-tiger-orbit'), '4271'));
  assert.equal(sasFromKey(key, '4271').split('-').length, SAS_WORDS);

  // Otra sala con las mismas palabras no da la misma huella.
  assert.notEqual(sasFromKey(key, '4271'), sasFromKey(key, '4272'));
  // Y otro codigo tampoco.
  assert.notEqual(sasFromKey(key, '4271'), sasFromKey(deriveKey('4271-lemon-radar-tiger-ocean'), '4271'));
});

test('sasWords rechaza un digest que no lo es', () => {
  assert.throws(() => sasWords('no soy un hash'), /no valido/);
  assert.throws(() => sasWords(''), /no valido/);
});
