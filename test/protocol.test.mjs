// Pruebas unitarias de utilidades del protocolo web (public/shared/protocol.js):
// contadores y offsets de 53 bits (> 2 GiB) sin truncado a 32 bits, y lectura
// por bloques del prefijo al reanudar sin reservar varios GB en RAM.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  PREFIX_READ_BLOCK,
  pickedFiles,
  safeNonNegInt,
  nextAckBytes,
  parseResumePoint,
  hashFilePrefix,
} from '../public/shared/protocol.js';
import { Sha256 } from '../public/shared/sha256.js';

const GIB = 1024 ** 3;

test('safeNonNegInt acepta enteros seguros > 2 GiB y rechaza invalidos', () => {
  assert.equal(safeNonNegInt(0), 0);
  assert.equal(safeNonNegInt(2 ** 31 - 1), 2 ** 31 - 1);
  assert.equal(safeNonNegInt(2 * GIB), 2 * GIB);
  assert.equal(safeNonNegInt(3 * GIB), 3 * GIB);
  assert.equal(safeNonNegInt(5 * GIB + 777), 5 * GIB + 777);
  assert.equal(safeNonNegInt(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);

  for (const bad of [-1, -2147483648, 1.5, NaN, Infinity, -Infinity, '1024', null, undefined, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(safeNonNegInt(bad), null, `deberia rechazar ${String(bad)}`);
  }
});

test('nextAckBytes avanza mas alla de 2 GiB y 4 GiB sin desbordar ni retroceder', () => {
  let acked = 0;
  for (const bytes of [
    2 * GIB - 8192,
    2 * GIB,
    2 * GIB + 8 * 1024 * 1024,
    3 * GIB,
    4 * GIB + 12345,
    5 * GIB,
  ]) {
    const next = nextAckBytes(acked, bytes);
    assert.equal(next, bytes);
    acked = next;
  }

  // Acuses atrasados o invalidos no hacen retroceder la ventana.
  assert.equal(nextAckBytes(acked, 3 * GIB), 5 * GIB);
  assert.equal(nextAckBytes(acked, -100), null);
  assert.equal(nextAckBytes(acked, NaN), null);
  assert.equal(nextAckBytes(acked, '3221225472'), null);
});

test('parseResumePoint conserva offsets > 2 GiB y descarta indices invalidos', () => {
  assert.deepEqual(parseResumePoint({ k: 'resume', index: 0, offset: 3 * GIB }), {
    index: 0,
    offset: 3 * GIB,
  });
  assert.deepEqual(parseResumePoint({ k: 'resume', index: 2, offset: 5 * GIB + 512 }), {
    index: 2,
    offset: 5 * GIB + 512,
  });
  assert.deepEqual(parseResumePoint({ k: 'resume', index: 1, offset: -50 }), {
    index: 1,
    offset: 0,
  });
  assert.deepEqual(parseResumePoint({ k: 'resume' }), { index: 0, offset: 0 });

  assert.equal(parseResumePoint({ k: 'resume', index: -1, offset: 100 }), null);
  assert.equal(parseResumePoint({ k: 'resume', index: 1.5, offset: 100 }), null);
  assert.equal(parseResumePoint(null), null);
});

test('hashFilePrefix recorre prefijos > 2 GiB en bloques <= 2 MiB sin cargar todo en RAM', async () => {
  const limit = 3 * GIB + 512;
  const ranges = [];
  const reusableBlock = new ArrayBuffer(PREFIX_READ_BLOCK);
  const sparseFile = {
    size: 4 * GIB,
    slice(start, end) {
      ranges.push([start, end]);
      const len = end - start;
      assert.ok(len > 0 && len <= PREFIX_READ_BLOCK, `bloque fuera de limite: ${len}`);
      return {
        async arrayBuffer() {
          return len === PREFIX_READ_BLOCK ? reusableBlock : new ArrayBuffer(len);
        },
      };
    },
  };

  let hashed = 0;
  const spyHasher = {
    update(buf) { hashed += buf.byteLength; },
  };

  const ok = await hashFilePrefix(sparseFile, limit, spyHasher);
  assert.equal(ok, true);
  assert.equal(hashed, limit);
  assert.equal(ranges.length, Math.ceil(limit / PREFIX_READ_BLOCK));
  assert.equal(ranges[0][0], 0);
  assert.equal(ranges.at(-1)[1], limit);
  for (let i = 1; i < ranges.length; i++) {
    assert.equal(ranges[i][0], ranges[i - 1][1], 'los bloques deben ser contiguos');
  }
});

test('hashFilePrefix produce el mismo SHA-256 que un Blob entero y respeta cancelacion', async () => {
  const payload = crypto.randomBytes(5 * 1024 * 1024 + 123);
  const blob = new Blob([payload]);
  const hasher = new Sha256();

  const ok = await hashFilePrefix(blob, payload.length, hasher);
  assert.equal(ok, true);
  assert.equal(
    hasher.digest(),
    crypto.createHash('sha256').update(payload).digest('hex'),
  );

  // Cancelacion a mitad del prefijo: se detiene tras el primer bloque.
  let blocksRead = 0;
  const abortedHasher = new Sha256();
  const aborted = await hashFilePrefix(blob, payload.length, abortedHasher, {
    shouldAbort: () => blocksRead >= 1,
    onBlock: () => { blocksRead++; },
  });
  assert.equal(aborted, false);
  assert.equal(blocksRead, 1);
});

test('pickedFiles filtra, ordena y deduplica indices validos', () => {
  assert.equal(pickedFiles(null, 3), null);
  assert.deepEqual(pickedFiles([2, 0, 2, -1, 5, '1', 1], 3), [0, 1, 2]);
});
