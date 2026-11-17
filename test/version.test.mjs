// La version del CLI sale del package.json (via cli-rs/build.rs), y de ningun otro sitio.
//
// No es cosmetico: `drop update` compara la release de GitHub contra VERSION,
// asi que una constante desincronizada deja al CLI creyendose desactualizado
// para siempre -- reinstalando en bucle -- o sin enterarse de una release nueva.
//
// Estos casos vigilan Cargo.toml vs package.json, que cli.rs use env!("DROP_VERSION"),
// que los enlaces del README coincidan, y que cada flag salga en `--help` y completion.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

import { ROOT, CLI_BIN, cliSpawnTarget } from './helpers.mjs';

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const CLI_RS = path.join(ROOT, 'cli-rs', 'src', 'cli.rs');
const CARGO_TOML = path.join(ROOT, 'cli-rs', 'Cargo.toml');
const COMPLETION_RS = path.join(ROOT, 'cli-rs', 'src', 'completion.rs');
const SHELLS = ['bash', 'zsh', 'fish', 'powershell'];

function execCli(args) {
  const [cmd, cmdArgs] = cliSpawnTarget(args);
  return execFileSync(cmd, cmdArgs, { encoding: 'utf8' });
}

function readCompletionMeta() {
  const src = fs.readFileSync(COMPLETION_RS, 'utf8');
  const cmdsBlock = src.match(/pub const COMMANDS:[^=]*=\s*&\[([\s\S]*?)\n\];/)?.[1] || '';
  const commands = [...cmdsBlock.matchAll(/\(\s*"([^"]+)"\s*,/g)].map((m) => m[1]);
  const flagsBlock = src.match(/pub const FLAGS:[^=]*=\s*&\[([\s\S]*?)\n\];/)?.[1] || '';
  const flags = [...flagsBlock.matchAll(/flag:\s*"([^"]+)"/g)].map((m) => m[1]);
  return { commands, flags };
}

test('`drop --version` y Cargo.toml coinciden con package.json', () => {
  const cargoToml = fs.readFileSync(CARGO_TOML, 'utf8');
  const cargoVer = cargoToml.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  assert.equal(cargoVer, pkg.version, 'cli-rs/Cargo.toml debe tener la misma versión que package.json');

  const out = execCli(['--version']);
  assert.equal(out.trim(), `drop v${pkg.version}`);
});

test('`drop --help` arranca y menciona las opciones', () => {
  const out = execCli(['--help']);
  assert.match(out, /--no-resume/);
  assert.match(out, /--overwrite/);
});

test('cli.rs lee la version de env!("DROP_VERSION") y no tiene literal a mano', () => {
  const source = fs.readFileSync(CLI_RS, 'utf8');
  assert.match(source, /pub const VERSION:\s*&str\s*=\s*env!\("DROP_VERSION"\)/);
  assert.equal(source.match(/const VERSION\s*:\s*&str\s*=\s*"[0-9]/), null, 'la version no debe ser un literal');
});

// Los enlaces de descarga son los unicos sitios del README donde la version es
// la que se publica: las menciones en prosa ("a partir de la v0.5.2") hablan de
// una version concreta a proposito y no se tocan.
test('los enlaces de descarga del README apuntan a la version actual', () => {
  for (const file of ['README.md', 'README.es.md']) {
    const readme = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const links = [...readme.matchAll(/releases\/download\/v([0-9][^/]*)\//g)].map((m) => m[1]);

    assert.ok(links.length > 0, `${file} deberia tener enlaces de descarga`);
    for (const version of new Set(links)) {
      assert.equal(version, pkg.version, `${file} enlaza a la v${version} y el package.json dice ${pkg.version}`);
    }
  }
});

// Todo flag que el parser de cli.rs reconoce tiene que salir en `--help` y en
// la tabla del autocompletado: un flag nuevo sin documentar debe fallar aqui.
function parsedFlags() {
  const source = fs.readFileSync(CLI_RS, 'utf8').split('pub async fn run_cli')[1] || '';
  const flags = new Set();
  for (const m of source.matchAll(/\b(?:a|arg)\s*==\s*"(--?[a-z][a-z-]*)"/g)) flags.add(m[1]);
  const updateBlock = source.match(/const UPDATE_FLAGS:[^=]*=\s*&\[([^\]]+)\]/)?.[1] || '';
  for (const m of updateBlock.matchAll(/"(--?[a-z][a-z-]*)"/g)) flags.add(m[1]);
  return [...flags];
}

test('todo flag del parser sale en --help y en el autocompletado', () => {
  const help = execCli(['--help']);
  const { commands, flags: completionFlags } = readCompletionMeta();
  const known = new Set(completionFlags);
  const flags = parsedFlags();
  assert.ok(flags.length >= 20, `el extractor no ha encontrado flags: ${flags}`);
  for (const f of flags) {
    assert.ok(help.includes(f), `${f} no aparece en drop --help`);
    assert.ok(known.has(f), `${f} no esta en FLAGS de cli-rs/src/completion.rs`);
  }
  for (const cmd of commands) assert.ok(help.includes(`drop ${cmd}`), `drop ${cmd} no aparece en la ayuda`);
});

test('drop completion imprime un script por shell, sin colores', () => {
  const { commands } = readCompletionMeta();
  for (const shell of SHELLS) {
    const out = execCli(['completion', shell]);
    assert.ok(out.length > 50, `${shell}: script vacío`);
    assert.doesNotMatch(out, /\[/, `${shell}: un eval no quiere codigos ANSI`);
    for (const cmd of commands) assert.ok(out.includes(cmd), `${shell}: falta la orden ${cmd}`);
    assert.ok(out.includes('no-resume'), `${shell}: faltan los flags`);
  }
  const bad = spawnSync(...cliSpawnTarget(['completion', 'nope']), { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Shell no reconocido/);
});

function runCli(args) {
  const [cmd, cmdArgs] = cliSpawnTarget(args);
  return spawnSync(cmd, cmdArgs, { encoding: 'utf8' });
}

test('--help funciona también detrás de cualquier suborden', () => {
  for (const cmd of ['serve', 'verify-web', 'update', 'completion', 'install', 'uninstall']) {
    const res = runCli([cmd, '--help']);
    assert.equal(res.status, 0, `${cmd} --help debería salir con 0`);
    assert.match(res.stdout, /USO:/);
  }
});

test('rechaza opciones desconocidas, valores faltantes y puertos o tiempos inválidos', () => {
  for (const args of [
    ['--no-existe'],
    ['send', 'algo.txt', '--no-existe'],
    ['update', '--no-existe'],
    ['--once'],
  ]) {
    const res = runCli(args);
    assert.equal(res.status, 1, `${args.join(' ')} debería fallar`);
    assert.doesNotMatch(res.stderr, /TypeError/, 'no debe lanzar errores internos');
  }

  for (const flag of ['-s', '--server', '-o', '--out', '-p', '--port', '-t', '--time', '--only', '--limit', '--expire']) {
    const res = runCli(['send', flag]);
    assert.equal(res.status, 1, `${flag} sin valor debería fallar`);
    assert.match(res.stderr, /necesita un valor/);
  }

  for (const badPort of ['abc', '70000']) {
    const res = runCli(['send', '-p', badPort, 'a.txt']);
    assert.equal(res.status, 1, `-p ${badPort} debería fallar`);
    assert.match(res.stderr, /Puerto no válido/);
  }

  for (const badTime of ['0', 'abc']) {
    const res = runCli(['speed', '-t', badTime]);
    assert.equal(res.status, 1, `-t ${badTime} debería fallar`);
    assert.match(res.stderr, /Duración no válida/);
  }
});

test('`drop send install` no activa la suborden install', () => {
  const res = runCli(['send', 'install']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /El archivo no existe/);
});

function readPeImportedDlls(exePath) {
  const buf = fs.readFileSync(exePath);
  const peOff = buf.readUInt32LE(0x3c);
  assert.equal(buf.toString('ascii', peOff, peOff + 4), 'PE\0\0', `${exePath} no es un PE valido`);
  const numSections = buf.readUInt16LE(peOff + 6);
  const optSize = buf.readUInt16LE(peOff + 20);
  const optOff = peOff + 24;
  const magic = buf.readUInt16LE(optOff);
  const ddOff = optOff + (magic === 0x20b ? 112 : 96);
  const importRva = buf.readUInt32LE(ddOff + 8);
  assert.ok(importRva > 0, `${exePath} no tiene tabla de importaciones`);

  const secOff = optOff + optSize;
  const sections = [];
  for (let i = 0; i < numSections; i++) {
    const o = secOff + i * 40;
    sections.push({
      va: buf.readUInt32LE(o + 12),
      vsize: buf.readUInt32LE(o + 8),
      raw: buf.readUInt32LE(o + 20),
      rsize: buf.readUInt32LE(o + 16),
    });
  }
  const rvaToOff = (rva) => {
    const s = sections.find((sec) => rva >= sec.va && rva < sec.va + Math.max(sec.vsize, sec.rsize));
    assert.ok(s, `RVA 0x${rva.toString(16)} fuera de secciones`);
    return rva - s.va + s.raw;
  };
  const readCStr = (off) => {
    let end = off;
    while (end < buf.length && buf[end] !== 0) end++;
    return buf.toString('ascii', off, end);
  };

  const dlls = [];
  for (let off = rvaToOff(importRva); ; off += 20) {
    const ilt = buf.readUInt32LE(off);
    const nameRva = buf.readUInt32LE(off + 12);
    const iat = buf.readUInt32LE(off + 16);
    if (!ilt && !nameRva && !iat) break;
    dlls.push(readCStr(rvaToOff(nameRva)));
  }
  return dlls;
}

test('el binario de Windows enlaza el CRT estaticamente sin VCRUNTIME*.dll', () => {
  if (process.platform !== 'win32') return;
  assert.ok(fs.existsSync(CLI_BIN), `Falta el binario en ${CLI_BIN}`);
  const dlls = readPeImportedDlls(CLI_BIN);
  assert.ok(dlls.length > 0, 'Tabla de importaciones vacia');
  const forbidden = dlls.filter((dll) => /^(vcruntime|msvcp|concrt|ucrtbase)/i.test(dll));
  assert.deepEqual(forbidden, [], `Importaciones dinamicas de MSVC CRT no deseadas: ${forbidden.join(', ')} (todas: ${dlls.join(', ')})`);
});
