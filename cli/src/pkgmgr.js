// ¿Lo ha instalado un gestor de paquetes?
//
// Con Homebrew o Scoop el binario es del gestor: `drop update` escribiendose
// encima, o el autoinstalador copiandose a ~/.local/bin o %LOCALAPPDATA%, dejan
// dos copias y un gestor que ya no sabe que version tiene. En ese caso el CLI no
// se instala ni se actualiza solo: dice que orden usar.
//
// Se mira la ruta REAL del ejecutable: en Homebrew `/opt/homebrew/bin/drop` es
// un enlace a `.../Cellar/drop/<version>/bin/drop`, y en Scoop el `drop.exe` de
// `shims` lanza el de `apps/drop/current`.
import fs from 'node:fs';

export function packageManagerOf(execPath) {
  let real = execPath;
  try { real = fs.realpathSync(execPath); } catch { /* se mira la ruta tal cual */ }
  const p = String(real).replace(/\\/g, '/').toLowerCase();
  if (/\/cellar\/drop\//.test(p) || /\/(homebrew|linuxbrew)\//.test(p)) {
    return { name: 'Homebrew', upgrade: 'brew upgrade drop', uninstall: 'brew uninstall drop' };
  }
  // `apps/drop/current/` es la forma de Scoop aunque su raiz no se llame scoop;
  // `current` es una junction, y resuelta es `apps/drop/<version>/`.
  if (/\/scoop\/(apps|shims)\//.test(p) || /\/apps\/drop\/(current|\d[^/]*)\//.test(p)) {
    return { name: 'Scoop', upgrade: 'scoop update drop', uninstall: 'scoop uninstall drop' };
  }
  return null;
}
