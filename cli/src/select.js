// `drop recv --only <patrones>`: bajar solo parte del lote.
//
// Los patrones van separados por comas y se comparan con la ruta de cada
// archivo del manifiesto (`path` si viene de una carpeta, si no `name`), con
// reglas parecidas a las de un .gitignore:
//
//   - un patron SIN `/` se compara con el nombre suelto, este donde este:
//     `*.jpg` coge `foto.jpg` y `viaje/dia1/foto.jpg`.
//   - un patron CON `/` se compara con el final de la ruta, empezando en una
//     carpeta: `fotos/*.jpg` coge `fotos/a.jpg` y `viaje/fotos/a.jpg`, pero no
//     `fotos/2024/a.jpg`. Es lo que hace falta con `drop send <carpeta>`, donde
//     todo va debajo del nombre de la carpeta y quien recibe no tiene por que
//     saberlo.
//   - con `/` delante se ancla a la raiz del envio: `/fotos/**` solo coge la
//     carpeta `fotos` de arriba del todo.
//   - `*` es cualquier cosa menos `/`, `?` un caracter que no sea `/`, y `**`
//     cualquier cosa, `/` incluida: `fotos/**` es la carpeta entera.
//
// Sin distinguir mayusculas: `*.JPG` y `*.jpg` son lo mismo, que es lo que
// espera quien pide "las fotos" desde Windows o macOS.
//
// El resultado son indices del manifiesto, que es lo que viaja en `ready` (TCP)
// y en `cli-accept` (relay) como `files`. El emisor solo manda esos.

function escapeRegex(ch) {
  return /[\\^$.*+?()[\]{}|]/.test(ch) ? '\\' + ch : ch;
}

/** Traduce un patron a una expresion regular anclada. */
export function globToRegex(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` al principio o en medio tambien vale por "ninguna carpeta":
        // `**/foto.jpg` coge `foto.jpg` en la raiz.
        if (pattern[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else {
      re += escapeRegex(ch);
    }
  }
  return new RegExp('^' + re + '$', 'i');
}

/** `"*.jpg, docs/**"` -> `['*.jpg', 'docs/**']`. Vacios fuera; `./x` es `/x`. */
export function parsePatterns(text) {
  return String(text ?? '')
    .split(',')
    .map((p) => p.trim().replace(/\\/g, '/').replace(/^\.\//, '/'))
    .filter((p) => p && p !== '/');
}

/**
 * Indices de los archivos del manifiesto que casan con algun patron, en orden.
 * `patterns` vacio o ausente es "todos" y devuelve `null`, que en el protocolo
 * es no mandar `files`.
 */
export function selectFiles(entries, patterns) {
  if (!patterns || !patterns.length) return null;
  const tests = patterns.map((p) => {
    if (p.startsWith('/')) {
      const re = globToRegex(p.slice(1));
      return (full) => re.test(full);
    }
    if (p.includes('/')) {
      const re = globToRegex('**/' + p);
      return (full) => re.test(full);
    }
    const re = globToRegex(p);
    return (full) => re.test(full.slice(full.lastIndexOf('/') + 1));
  });
  const picked = [];
  entries.forEach((entry, i) => {
    const full = String(entry.path || entry.name || '');
    if (tests.some((t) => t(full))) picked.push(i);
  });
  return picked;
}
