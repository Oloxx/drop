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

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const CLI = path.join(ROOT, 'cli', 'src', 'cli.js');

test('`drop --version` dice lo que dice el package.json', () => {
  const out = execFileSync(process.execPath, [CLI, '--version'], { encoding: 'utf8' });
  assert.equal(out.trim(), `drop v${pkg.version}`);
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
