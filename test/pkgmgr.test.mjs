// Deteccion de gestor de paquetes (cli/src/pkgmgr.js): con Homebrew o Scoop el
// CLI no se instala ni se actualiza solo, porque dejaria dos copias.
import test from 'node:test';
import assert from 'node:assert/strict';

import { packageManagerOf } from '../cli/src/pkgmgr.js';

test('reconoce las rutas de Homebrew y de Scoop, y nada mas', () => {
  const name = (p) => packageManagerOf(p)?.name ?? null;
  assert.equal(name('/opt/homebrew/Cellar/drop/1.0.0/bin/drop'), 'Homebrew');
  assert.equal(name('/usr/local/Cellar/drop/1.0.0/bin/drop'), 'Homebrew');
  assert.equal(name('/opt/homebrew/bin/drop'), 'Homebrew');
  assert.equal(name('/home/linuxbrew/.linuxbrew/bin/drop'), 'Homebrew');
  assert.equal(name(String.raw`C:\Users\ana\scoop\apps\drop\current\drop.exe`), 'Scoop');
  assert.equal(name(String.raw`C:\Users\ana\scoop\shims\drop.exe`), 'Scoop');
  // `current` resuelto, y una raiz de Scoop que no se llama scoop.
  assert.equal(name(String.raw`D:\tools\apps\drop\1.0.0\drop.exe`), 'Scoop');
  assert.equal(packageManagerOf('/opt/homebrew/bin/drop').upgrade, 'brew upgrade drop');
  assert.equal(packageManagerOf(String.raw`C:\scoop\apps\drop\current\drop.exe`).upgrade, 'scoop update drop');

  // Las instalaciones propias de drop no son de ningun gestor.
  assert.equal(name(String.raw`C:\Users\ana\AppData\Local\Programs\drop\drop.exe`), null);
  assert.equal(name('/home/ana/.local/bin/drop'), null);
  assert.equal(name('/usr/local/bin/drop'), null);
  assert.equal(name(String.raw`C:\Users\ana\Downloads\drop-v1.0.0-windows-x64.exe`), null);
});
