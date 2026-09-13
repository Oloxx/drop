// Progreso por archivo ademas del total (CLI). Este fichero no necesita servidor.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { fileAt, renderProgressBar, renderProgressBarComplete, setProgressStream } from '../cli/src/ui.js';
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

const FILES = [{ name: 'a.bin', size: 100 }, { name: 'b.bin', size: 50 }, { name: 'c.bin', size: 0 }, { name: 'd.bin', size: 10 }];

test('fileAt saca el archivo en curso del acumulado', () => {
  assert.deepEqual(fileAt(FILES, 0), { index: 0, count: 4, name: 'a.bin', size: 100, done: 0 });
  assert.deepEqual(fileAt(FILES, 99), { index: 0, count: 4, name: 'a.bin', size: 100, done: 99 });
  assert.deepEqual(fileAt(FILES, 100), { index: 1, count: 4, name: 'b.bin', size: 50, done: 0 });
  assert.deepEqual(fileAt(FILES, 149), { index: 1, count: 4, name: 'b.bin', size: 50, done: 49 });
  // Un archivo vacio no puede ser "el que va": se salta al siguiente.
  assert.deepEqual(fileAt(FILES, 150), { index: 3, count: 4, name: 'd.bin', size: 10, done: 0 });
  // Al final, o mas alla, se queda en el ultimo y con el completo.
  assert.deepEqual(fileAt(FILES, 160), { index: 3, count: 4, name: 'd.bin', size: 10, done: 10 });
  assert.deepEqual(fileAt(FILES, 999), { index: 3, count: 4, name: 'd.bin', size: 10, done: 10 });
  assert.equal(fileAt([], 5), null);
});

/** Un stream de mentira que acumula lo escrito. */
function fakeStream(columns = 120) {
  return { columns, chunks: [], write(s) { this.chunks.push(s); return true; }, text() { return this.chunks.join(''); } };
}

test('con varios archivos la barra lleva una linea con el archivo en curso; con uno, no', () => {
  const s = fakeStream();
  setProgressStream(s);
  try {
    renderProgressBar(120, 160, 1000, 30, FILES);
    const plain = stripAnsi(s.text());
    assert.match(plain, /\[2\/4\] b\.bin 40% · 20 B \/ 50 B/);
    assert.match(plain, /75% · 120 B \/ 160 B/);
    // Dos lineas y el cursor vuelve arriba para el siguiente repintado.
    assert.ok(s.text().includes('\n'));
    assert.ok(s.text().endsWith('\x1b[1A'));

    s.chunks.length = 0;
    renderProgressBar(60, 100, 1000, 30, [{ name: 'solo.bin', size: 100 }]);
    assert.doesNotMatch(stripAnsi(s.text()), /\[1\/1\]/);
    assert.ok(!s.text().includes('\n'));

    // Al terminar tras una linea de archivo, esta se cierra y la barra final va debajo.
    s.chunks.length = 0;
    renderProgressBar(159, 160, 1000, 30, FILES);
    renderProgressBarComplete(160, 1, 160);
    const fin = stripAnsi(s.text());
    assert.match(fin, /\[4\/4\] d\.bin/);
    assert.match(fin, /todos los archivos/);
    assert.match(fin, /100% · 160 B \/ 160 B/);
  } finally {
    setProgressStream(process.stdout);
  }
});

test('un nombre largo se recorta a la anchura de la terminal', () => {
  const s = fakeStream(60);
  setProgressStream(s);
  try {
    renderProgressBar(5, 200, 1, 30, [{ name: 'x'.repeat(200) + '.bin', size: 100 }, { name: 'y', size: 100 }]);
    const line = stripAnsi(s.text()).split('\n')[0];
    assert.ok(line.includes('…'), line);
    assert.ok(line.length <= 60 + 5, `demasiado larga: ${line.length}`);
  } finally {
    setProgressStream(process.stdout);
  }
});

test('los receptores pasan el manifiesto a la barra con cada progreso', async () => {
  const { receiveFromRelay } = await import('../cli/src/transfer.js');
  const { deriveKey, encryptChunk, sealFrame } = await import('../cli/src/crypto.js');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'drop-progress-'));
  const key = deriveKey('4271-lemon-radar-tiger-orbit');
  const listeners = new Map();
  const ws = {
    readyState: 1,
    addEventListener(t, fn) { listeners.set(t, [...(listeners.get(t) || []), fn]); },
    removeEventListener(t, fn) { listeners.set(t, (listeners.get(t) || []).filter((f) => f !== fn)); },
    send() {},
    emit(t, ev) { for (const fn of [...(listeners.get(t) || [])]) fn(ev); },
  };
  const manifest = [{ name: 'uno.bin', size: 300 }, { name: 'dos.bin', size: 300 }];
  const seen = [];
  const done = receiveFromRelay(ws, manifest, out, (cur, total, speed, list) => seen.push({ cur, total, list }), { key });
  const sealed = (obj) => ({ data: JSON.stringify({ t: 'signal', data: sealFrame(obj, key) }) });

  const uno = crypto.randomBytes(300);
  const dos = crypto.randomBytes(300);
  ws.emit('message', sealed({ type: 'cli-start', index: 0, name: 'uno.bin', size: 300 }));
  ws.emit('message', { data: encryptChunk(uno, key) });
  // El progreso se reporta como mucho cada 150 ms: se deja pasar ese tiempo.
  await new Promise((r) => setTimeout(r, 200));
  ws.emit('message', sealed({ type: 'cli-end', index: 0, sha256: crypto.createHash('sha256').update(uno).digest('hex') }));
  ws.emit('message', sealed({ type: 'cli-start', index: 1, name: 'dos.bin', size: 300 }));
  ws.emit('message', { data: encryptChunk(dos, key) });
  await new Promise((r) => setTimeout(r, 200));
  ws.emit('message', sealed({ type: 'cli-end', index: 1, sha256: crypto.createHash('sha256').update(dos).digest('hex') }));
  ws.emit('message', sealed({ type: 'cli-done' }));
  await done;

  assert.ok(seen.length >= 1, 'no hubo ningun progreso');
  for (const p of seen) assert.equal(p.list, manifest, 'la barra no recibe el manifiesto');
  // Y con ese manifiesto, la barra sabe decir en que archivo va.
  assert.equal(fileAt(seen.at(-1).list, seen.at(-1).cur).name, 'dos.bin');
  fs.rmSync(out, { recursive: true, force: true });
});
