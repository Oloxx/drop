// Codificador QR propio (public/shared/qr.js). Este fichero no necesita servidor.
//
// Los hashes "dorados" salen de matrices que se decodificaron con un lector
// independiente (jsQR en Chrome) al escribir el modulo, para versiones de la 1 a
// la 39 y los cuatro niveles. Aqui se fijan tres de ellas: si el codificador
// cambia un modulo, esto lo ve; si cambia a proposito, hay que volver a pasar las
// matrices por un lector antes de actualizar los hashes.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { encodeQr, qrToSvg, qrToBlocks, ECL } from '../public/shared/qr.js';

const matrixHash = (qr) =>
  crypto.createHash('sha256').update(Buffer.concat(qr.modules.map((r) => Buffer.from(r)))).digest('hex');

const LINK = 'https://drop.oloxx.dev/#4271-lemon-radar-tiger-orbit';

test('el enlace de una sala cabe en una version 4 con nivel M', () => {
  const qr = encodeQr(LINK);
  assert.equal(qr.version, 4);
  assert.equal(qr.size, 33);
  assert.equal(qr.mask, 2);
  assert.equal(matrixHash(qr), '8f9a56abc12d3fc5e34b2bc21a42e803f7a369e074b6a99266b5fd7ff7478bf0');
});

test('matrices doradas en los extremos: version 1 y version 15 con UTF-8', () => {
  const chico = encodeQr('hi', { ecl: ECL.L });
  assert.equal(chico.version, 1);
  assert.equal(matrixHash(chico), '127b6b5ad5abd7b41ff21c1d8ceb73603ed915b931f6dc7cd3e3a53c60f66911');

  const grande = encodeQr('x'.repeat(200) + ' ñandú ✓', { ecl: ECL.H });
  assert.equal(grande.version, 15);
  assert.equal(grande.size, 77);
  assert.equal(matrixHash(grande), '49ef7249c147e77b32bcb5c57b2da5b116f1c4a14d210855655cd57e2b0a7aba');
});

test('los tres patrones de busqueda estan donde tienen que estar', () => {
  const qr = encodeQr(LINK);
  const n = qr.size;
  // Centro oscuro 3x3, anillo claro, anillo oscuro: se mira la fila central.
  const finderRow = (y, x0) => Array.from({ length: 7 }, (_, i) => qr.modules[y][x0 + i]).join('');
  assert.equal(finderRow(3, 0), '1011101');
  assert.equal(finderRow(3, n - 7), '1011101');
  assert.equal(finderRow(n - 4, 0), '1011101');
  // Y el modulo oscuro fijo junto al formato.
  assert.equal(qr.modules[n - 8][8], 1);
});

test('la informacion de formato codifica el nivel y la mascara elegidos', () => {
  for (const [name, ecl] of Object.entries(ECL)) {
    const qr = encodeQr(LINK, { ecl });
    // Los 15 bits de la copia horizontal, leidos como los escribe drawFormat.
    let bits = 0;
    for (let i = 0; i <= 5; i++) bits |= qr.modules[i][8] << i;
    bits |= qr.modules[7][8] << 6;
    bits |= qr.modules[8][8] << 7;
    bits |= qr.modules[8][7] << 8;
    for (let i = 9; i < 15; i++) bits |= qr.modules[8][14 - i] << i;
    const data = (bits ^ 0x5412) >>> 10;
    assert.equal(data >>> 3, ecl.bits, `nivel ${name}`);
    assert.equal(data & 7, qr.mask, `mascara con nivel ${name}`);
  }
});

test('elige la version mas pequena y se niega a lo que no cabe', () => {
  assert.equal(encodeQr('a', { ecl: ECL.L }).version, 1);
  assert.equal(encodeQr('a'.repeat(17), { ecl: ECL.L }).version, 1);   // v1-L: 17 bytes
  assert.equal(encodeQr('a'.repeat(18), { ecl: ECL.L }).version, 2);
  assert.equal(encodeQr('a'.repeat(2953), { ecl: ECL.L }).version, 40); // el tope absoluto
  assert.throws(() => encodeQr('a'.repeat(2954), { ecl: ECL.L }), /no cabe/);
  assert.throws(() => encodeQr(LINK, { maxVersion: 3 }), /no cabe/);
});

test('el SVG y los bloques pintan la misma matriz', () => {
  const qr = encodeQr('hi', { ecl: ECL.L });
  const svg = qrToSvg(qr, { quiet: 4 });
  assert.match(svg, /^<svg /);
  assert.match(svg, /viewBox="0 0 29 29"/);          // 21 + 4 de margen por lado
  const dark = qr.modules.reduce((sum, row) => sum + row.reduce((a, b) => a + b, 0), 0);
  assert.equal((svg.match(/h1v1h-1z/g) || []).length, dark);

  const lines = qrToBlocks(qr, { quiet: 2, ansi: false }).split('\n');
  assert.equal(lines.length, Math.ceil((21 + 4) / 2));
  assert.ok(lines.every((l) => [...l].length === 25));
  // La primera fila de modulos (tras el margen) empieza por el patron de busqueda.
  const row = [...lines[1]].slice(2, 9).map((ch) => (ch === '█' || ch === '▀' ? 1 : 0)).join('');
  assert.equal(row, '1111111');
  // Con ANSI se fuerza fondo blanco y tinta negra: la polaridad normal en cualquier tema.
  assert.match(qrToBlocks(qr).split('\n')[0], /^\x1b\[47m\x1b\[30m/);
});
