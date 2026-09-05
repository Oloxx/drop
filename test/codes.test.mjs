// Codigos de sala memorizables: generacion, parseo tolerante y derivacion de clave.
// Este fichero no necesita el servidor levantado.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import { WORDLIST } from '../public/shared/wordlist.js';
import {
  CodeError,
  ROOM_ID_DIGITS,
  SECRET_BITS,
  SECRET_WORDS,
  formatCode,
  isRoomId,
  newCode,
  normalizeCode,
  parseCode,
  randomRoomId,
  randomSecretWords,
  splitForKey,
} from '../public/shared/codes.js';
import { deriveKey, secretProof } from '../cli/src/crypto.js';

// ------------------------------------------------------------- lista de palabras

test('la lista tiene 2048 palabras y prefijos de 4 letras unicos', () => {
  // 2048 es lo que hace que cada palabra valgan 11 bits exactos sin descartes.
  assert.equal(WORDLIST.length, 2048);
  assert.equal(new Set(WORDLIST).size, 2048);

  // Y esto es lo que sostiene la correccion de erratas por prefijo: si dos
  // palabras compartiesen las 4 primeras letras, `4271-lemo-...` seria ambiguo.
  const prefixes = new Set(WORDLIST.map((w) => w.slice(0, 4)));
  assert.equal(prefixes.size, 2048);

  // Solo ASCII en minusculas: se teclea igual en cualquier teclado.
  for (const word of WORDLIST) assert.match(word, /^[a-z]{3,8}$/);
});

// ------------------------------------------------------------------ generacion

test('un codigo generado tiene el formato y la entropia esperados', () => {
  assert.equal(SECRET_BITS, 44);

  const code = newCode(randomRoomId(randomBytes), randomBytes);
  assert.match(code, /^[0-9]{4}(-[a-z]{3,8}){4}$/);

  const { roomId, words, secret, legacy } = parseCode(code);
  assert.equal(legacy, false);
  assert.equal(roomId.length, ROOM_ID_DIGITS);
  assert.equal(words.length, SECRET_WORDS);
  assert.equal(secret, words.join('-'));
  for (const word of words) assert.ok(WORDLIST.includes(word));
});

test('la generacion no se repite y cubre el espacio de salas', () => {
  const codes = new Set();
  const rooms = new Set();
  for (let i = 0; i < 500; i++) {
    const roomId = randomRoomId(randomBytes);
    rooms.add(roomId);
    codes.add(newCode(roomId, randomBytes));
  }
  // 44 bits de secreto: 500 tiradas sin un solo repetido es lo unico que se puede
  // afirmar aqui sin escribir un test estadistico que falle una vez al ano.
  assert.equal(codes.size, 500);
  // Con 10.000 salas y 500 tiradas, el cumpleanios da ~12 colisiones esperadas;
  // que salgan mas de 400 distintas descarta un generador atascado o sesgado.
  assert.ok(rooms.size > 400, `solo ${rooms.size} salas distintas`);
});

test('las palabras salen de toda la lista, no de un trozo', () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i++) for (const w of randomSecretWords(randomBytes)) seen.add(w);
  // 8000 muestras sobre 2048 palabras: si el indice se calculase con menos de 11
  // bits, la mitad alta de la lista no aparaceria nunca.
  assert.ok(seen.size > 1800, `solo ${seen.size} palabras distintas`);
  assert.ok(seen.has(WORDLIST[2047]) || seen.has(WORDLIST[2046]));
});

// --------------------------------------------------------------------- parseo

test('el parseo tolera lo que la gente escribe de verdad', () => {
  const canonical = '4271-lemon-radar-tiger-orbit';
  const variantes = [
    canonical,
    '  4271-lemon-radar-tiger-orbit  ',          // espacios al pegar
    '4271 lemon radar tiger orbit',              // dictado con espacios
    '4271_lemon_radar_tiger_orbit',              // guiones bajos
    '4271.lemon.radar.tiger.orbit',              // puntos
    '4271--lemon---radar-tiger-orbit',           // separadores repetidos
    '4271-LEMON-Radar-TiGeR-orbit',              // mayusculas
    '4271-lemón-radar-tiger-orbit',              // acento de un teclado espaniol
    'https://drop.oloxx.dev/#4271-lemon-radar-tiger-orbit',   // enlace entero
    'drop.oloxx.dev/#4271 lemon radar tiger orbit',
  ];
  for (const v of variantes) {
    assert.equal(parseCode(v).code, canonical, `fallo con ${JSON.stringify(v)}`);
  }
});

test('el parseo completa prefijos unicos', () => {
  // Los 4 primeros caracteres son unicos en BIP-39, asi que esto siempre resuelve.
  assert.equal(parseCode('4271-lemo-rada-tige-orbi').code, '4271-lemon-radar-tiger-orbit');
  // Con 3 letras se intenta igual y funciona cuando no hay ambiguedad.
  assert.equal(parseCode('4271-lemo-rada-tige-orb').code, '4271-lemon-radar-tiger-orbit');
});

test('un prefijo ambiguo se rechaza en vez de adivinar', () => {
  // `rad` encaja con radar y radio: elegir uno derivaria una clave distinta y la
  // transferencia moriria mas tarde con un error incomprensible.
  assert.throws(
    () => parseCode('4271-lemon-rad-tiger-orbit'),
    (err) => err instanceof CodeError && /ambiguo/.test(err.message) && /radar/.test(err.message),
  );
});

test('una errata de una letra sugiere la palabra correcta', () => {
  assert.throws(
    () => parseCode('4271-lemon-radar-tiger-orbut'),
    (err) => err instanceof CodeError && /orbit/.test(err.hint),
  );
});

test('los codigos mal formados se rechazan antes de tocar la red', () => {
  const malos = [
    '',                                       // vacio
    '4271',                                   // sin palabras
    '4271-lemon-radar-tiger',                 // falta una palabra
    '4271-lemon-radar-tiger-orbit-extra',     // sobra una
    '471-lemon-radar-tiger-orbit',            // sala de 3 digitos
    'sala-lemon-radar-tiger-orbit',           // sala no numerica
    '4271-lemon-radar-tiger-zzzzzz',          // palabra inexistente
  ];
  for (const malo of malos) {
    assert.throws(() => parseCode(malo), CodeError, `deberia fallar: ${JSON.stringify(malo)}`);
  }
});

test('normalizeCode e isRoomId hacen lo que dicen', () => {
  assert.equal(normalizeCode('  #4271 Lemon '), '4271-lemon');
  assert.equal(normalizeCode(null), '');
  assert.equal(isRoomId('4271'), true);
  assert.equal(isRoomId('427'), false);
  assert.equal(isRoomId('427a'), false);
  assert.equal(formatCode('4271', ['lemon', 'radar', 'tiger', 'orbit']), '4271-lemon-radar-tiger-orbit');
});

// @deprecated Compatibilidad con los codigos de la v0.3.5.
test('los tokens base64url de la v0.3.5 se siguen aceptando', () => {
  const viejo = 'T_9q_4uzB9iJAf8x';
  const parsed = parseCode(viejo);
  assert.equal(parsed.legacy, true);
  assert.equal(parsed.roomId, viejo);         // el token entero era el identificador
  assert.equal(parsed.secret, '');
  assert.equal(parseCode(`https://drop.oloxx.dev/#${viejo}`).code, viejo);
});

// ------------------------------------------------------------ derivacion de clave

test('emisor y receptor derivan exactamente la misma clave', () => {
  const code = newCode(randomRoomId(randomBytes), randomBytes);
  const emisor = deriveKey(code);
  // El receptor lo teclea con erratas y separadores raros: tras normalizar tiene
  // que salir la misma clave, o la transferencia falla al primer paquete.
  const receptor = deriveKey(parseCode(code.toUpperCase().replace(/-/g, ' ')).code);

  assert.equal(emisor.length, 32);            // AES-256
  assert.deepEqual(Buffer.from(receptor), Buffer.from(emisor));
});

test('la clave cambia con las palabras y con la sala', () => {
  const base = deriveKey('4271-lemon-radar-tiger-orbit');
  const otrasPalabras = deriveKey('4271-lemon-radar-tiger-olive');
  // La sala es la sal: dos salas con el mismo secreto no comparten clave, para
  // que una tabla precalculada no valga para todas a la vez.
  const otraSala = deriveKey('4272-lemon-radar-tiger-orbit');

  assert.notDeepEqual(Buffer.from(otrasPalabras), Buffer.from(base));
  assert.notDeepEqual(Buffer.from(otraSala), Buffer.from(base));
});

test('la clave se memoriza: scrypt solo se paga una vez por codigo', () => {
  const code = newCode(randomRoomId(randomBytes), randomBytes);
  const primera = process.hrtime.bigint();
  deriveKey(code);
  const coste = Number(process.hrtime.bigint() - primera) / 1e6;

  const segunda = process.hrtime.bigint();
  deriveKey(code);
  const cacheado = Number(process.hrtime.bigint() - segunda) / 1e6;

  // scrypt esta calibrado en ~62 ms; el margen es amplio a proposito para no
  // convertir esto en un test que falle en una maquina de CI cargada.
  assert.ok(coste < 400, `scrypt tardo ${coste.toFixed(0)} ms, revisa los parametros`);
  assert.ok(cacheado < coste / 4, `la cache no esta funcionando (${cacheado.toFixed(2)} ms)`);
});

test('splitForKey separa identificador y secreto sin validar', () => {
  assert.deepEqual(splitForKey('4271-lemon-radar-tiger-orbit'),
    { roomId: '4271', secret: 'lemon-radar-tiger-orbit', legacy: false });
  // Los tokens viejos no tienen parte secreta: el token entero es el material.
  assert.equal(splitForKey('T_9q_4uzB9iJAf8x').legacy, true);
});

test('la prueba de conocimiento del secreto depende del nonce', () => {
  const secret = 'lemon-radar-tiger-orbit';
  const uno = secretProof('a1b2', secret);
  assert.match(uno, /^[0-9a-f]{64}$/);
  assert.equal(uno, secretProof('a1b2', secret));
  // Nonce nuevo por receptor: una respuesta capturada no vale para el siguiente.
  assert.notEqual(uno, secretProof('a1b3', secret));
  assert.notEqual(uno, secretProof('a1b2', 'lemon-radar-tiger-olive'));
});
