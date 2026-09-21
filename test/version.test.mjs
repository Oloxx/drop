// La version del CLI sale del package.json, y de ningun otro sitio.
//
// Estuvo escrita a mano en dos: `const VERSION` en cli/src/cli.js y el
// package.json. No es cosmetico: `drop update` compara la release de GitHub
// contra esa constante, asi que una constante vieja deja al CLI creyendose
// desactualizado para siempre -- reinstalando en bucle -- o al reves, sin
// enterarse nunca de una version nueva.
//
// Estos casos vigilan que no vuelva a haber una segunda copia, y que los
// enlaces de descarga del README apunten a la version que se va a publicar,
// que es la otra cosa que se quedaba atras al sacar una release con prisa.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { ROOT } from './helpers.mjs';
import { FLAGS, COMMANDS, SHELLS, completionScript } from '../cli/src/completion.js';

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const CLI = path.join(ROOT, 'cli', 'src', 'cli.js');

test('`drop --version` dice lo que dice el package.json', () => {
  const out = execFileSync(process.execPath, [CLI, '--version'], { encoding: 'utf8' });
  assert.equal(out.trim(), `drop v${pkg.version}`);
});

// La ayuda es un template literal enorme: un acento grave suelto dentro (un
// `.part` con formato de Markdown) lo parte en dos y `node --check` no lo ve,
// porque sigue siendo sintaxis valida. La v0.7.0 salio con los cinco binarios
// reventando en `--help` por eso; el workflow de release lo caza, pero mas
// vale cazarlo aqui.
test('`drop --help` arranca y menciona las opciones', () => {
  const out = execFileSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
  assert.match(out, /--no-resume/);
  assert.match(out, /--overwrite/);
});

test('cli.js no tiene una version escrita a mano', () => {
  const source = fs.readFileSync(CLI, 'utf8');
  const hardcoded = source.match(/const VERSION\s*=\s*['"`]/);
  assert.equal(hardcoded, null, 'la version tiene que salir del package.json, no de un literal');
});

// Los enlaces de descarga son los unicos sitios del README donde la version es
// la que se publica: las menciones en prosa ("a partir de la v0.5.2") hablan de
// una version concreta a proposito y no se tocan.
test('los enlaces de descarga del README apuntan a la version actual', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const links = [...readme.matchAll(/releases\/download\/v([0-9][^/]*)\//g)].map((m) => m[1]);

  assert.ok(links.length > 0, 'el README deberia tener enlaces de descarga');
  for (const version of new Set(links)) {
    assert.equal(version, pkg.version, `el README enlaza a la v${version} y el package.json dice ${pkg.version}`);
  }
});

// Todo flag que el parser de cli.js reconoce tiene que salir en `--help` y en
// la tabla del autocompletado: el roadmap de la 1.0 pide una ayuda completa, y
// la forma de que se quede completa es que un flag nuevo sin documentar falle.
function parsedFlags() {
  const source = fs.readFileSync(CLI, 'utf8');
  const flags = new Set();
  for (const m of source.matchAll(/argv(?:\[i\])?(?:\.includes\(| === )'(--?[a-z][a-z-]*)'/g)) flags.add(m[1]);
  return [...flags];
}

test('todo flag del parser sale en --help y en el autocompletado', () => {
  const help = execFileSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
  const known = new Set(FLAGS.map(([f]) => f));
  const flags = parsedFlags();
  assert.ok(flags.length >= 20, `el extractor no ha encontrado flags: ${flags}`);
  for (const f of flags) {
    assert.ok(help.includes(f), `${f} no aparece en drop --help`);
    assert.ok(known.has(f), `${f} no esta en FLAGS de cli/src/completion.js`);
  }
  for (const [cmd] of COMMANDS) assert.ok(help.includes(`drop ${cmd}`), `drop ${cmd} no aparece en la ayuda`);
});

test('drop completion imprime un script por shell, sin colores', () => {
  for (const shell of SHELLS) {
    const out = execFileSync(process.execPath, [CLI, 'completion', shell], { encoding: 'utf8' });
    assert.equal(out, completionScript(shell));
    assert.doesNotMatch(out, /\[/, `${shell}: un eval no quiere codigos ANSI`);
    for (const [cmd] of COMMANDS) assert.ok(out.includes(cmd), `${shell}: falta la orden ${cmd}`);
    assert.ok(out.includes('no-resume'), `${shell}: faltan los flags`);
  }
  assert.throws(() => completionScript('nope'), (err) => err.code === 'UNKNOWN_SHELL');
});
