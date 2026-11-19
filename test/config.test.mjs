// Tests E2E de `drop config` (menu interactivo, asistente init, subcomandos,
// persistencia en config.json, precedencia CLI > env > config > default y flags inversos).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { startServer, spawnCli, cliSpawnTarget } from './helpers.mjs';

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

function makeTmpDir(prefix = 'drop-cfg-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runSync(args, { env = {}, input } = {}) {
  const [cmd, cmdArgs] = cliSpawnTarget(args);
  const res = spawnSync(cmd, cmdArgs, {
    encoding: 'utf8',
    env: { ...process.env, DROP_NO_UPNP: '1', ...env },
    input,
    timeout: 15_000,
  });
  return {
    status: res.status,
    stdout: stripAnsi(res.stdout || ''),
    stderr: stripAnsi(res.stderr || ''),
  };
}

test('drop config path, set, get, unset, show y reset funcionan con DROP_CONFIG y validación', () => {
  const tmp = makeTmpDir();
  const cfgPath = path.join(tmp, 'sub', 'config.json');
  const env = { DROP_CONFIG: cfgPath };

  try {
    // path respeta DROP_CONFIG y no pinta ANSI
    const pRes = runSync(['config', 'path'], { env });
    assert.equal(pRes.status, 0);
    assert.equal(pRes.stdout.trim(), cfgPath);

    // path respeta DROP_CONFIG_DIR
    const dirRes = runSync(['config', 'path'], { env: { DROP_CONFIG: '', DROP_CONFIG_DIR: tmp } });
    assert.equal(dirRes.status, 0);
    assert.equal(dirRes.stdout.trim(), path.join(tmp, 'config.json'));

    // show sin archivo muestra valores por defecto
    const showEmpty = runSync(['config', 'show'], { env });
    assert.equal(showEmpty.status, 0);
    assert.match(showEmpty.stdout, /aún no creado/);
    assert.match(showEmpty.stdout, /https:\/\/drop\.oloxx\.dev/);

    // set válido con alias kebab-case y normalización de URL
    assert.equal(runSync(['config', 'set', 'server', 'http://127.0.0.1:4321/'], { env }).status, 0);
    assert.equal(runSync(['config', 'set', 'no-qr', 'true'], { env }).status, 0);
    assert.equal(runSync(['config', 'set', 'limit', '5M'], { env }).status, 0);
    assert.equal(runSync(['config', 'set', 'expire', '10m'], { env }).status, 0);

    // get devuelve los valores guardados
    const gSrv = runSync(['config', 'get', 'server'], { env });
    assert.equal(gSrv.status, 0);
    assert.equal(gSrv.stdout.trim(), 'http://127.0.0.1:4321');

    const gQr = runSync(['config', 'get', 'no_qr'], { env });
    assert.equal(gQr.status, 0);
    assert.equal(gQr.stdout.trim(), 'true');

    // show refleja origen (config) y (env) cuando DROP_SERVER sobrescribe
    const showEnv = runSync(['config', 'show'], {
      env: { ...env, DROP_SERVER: 'http://127.0.0.1:9999' },
    });
    assert.equal(showEnv.status, 0);
    assert.match(showEnv.stdout, /http:\/\/127\.0\.0\.1:9999.*\(env\)/);
    assert.match(showEnv.stdout, /5M.*\(config\)/);

    // validaciones rechazan valores incorrectos
    for (const [k, v] of [
      ['server', 'ftp://bad.example'],
      ['limit', 'rapido'],
      ['expire', 'siempre'],
      ['port', '70000'],
      ['serve_port', '0'],
      ['relay', 'quizas'],
      ['clave_inexistente', '1'],
    ]) {
      const bad = runSync(['config', 'set', k, v], { env });
      assert.equal(bad.status, 1, `set ${k} ${v} debería fallar`);
    }

    // unset restablece clave y get devuelve 1
    assert.equal(runSync(['config', 'unset', 'limit'], { env }).status, 0);
    const gUnset = runSync(['config', 'get', 'limit'], { env });
    assert.equal(gUnset.status, 1);
    assert.equal(gUnset.stdout.trim(), '');

    // reset -y borra el archivo
    assert.equal(runSync(['config', 'reset', '-y'], { env }).status, 0);
    assert.equal(fs.existsSync(cfgPath), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('menú interactivo `drop config` permite alternar opciones, editar texto y guardar', () => {
  const tmp = makeTmpDir();
  const cfgPath = path.join(tmp, 'config.json');
  const dlDir = path.join(tmp, 'descargas');
  const env = { DROP_CONFIG: cfgPath, DROP_FORCE_PROMPT: '1' };

  try {
    // 1. Abrir menu, activar once (6), activar no_qr (8), editar out (9) -> dlDir, salir sin guardar (q)
    const discard = runSync(['config'], {
      env,
      input: `6\n8\n9\n${dlDir}\nq\n`,
    });
    assert.equal(discard.status, 0);
    assert.match(discard.stdout, /Cambios descartados/);
    assert.equal(fs.existsSync(cfgPath), false);

    // 2. Abrir menu, activar once (6), activar overwrite (10), editar limit (3) con intento invalido + valido, editar out (9), guardar (g)
    const saved = runSync(['config'], {
      env,
      input: `6\n10\n3\nmalo\n8M\n9\n${dlDir}\ng\n`,
    });
    assert.equal(saved.status, 0);
    assert.match(saved.stdout, /Límite no válido/);
    assert.match(saved.stdout, /Configuración guardada/);

    const json = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    assert.equal(json.once, true);
    assert.equal(json.overwrite, true);
    assert.equal(json.limit, '8M');
    assert.equal(json.out, dlDir);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('asistente inicial `drop config init` guía paso a paso y guarda config.json', () => {
  const tmp = makeTmpDir();
  const cfgPath = path.join(tmp, 'config.json');
  const dlDir = path.join(tmp, 'inbox');
  const env = { DROP_CONFIG: cfgPath };

  try {
    // Pasos:
    // 1 server (invalido -> reintento valido)
    // 2 out
    // 3 overwrite (s)
    // 4 no_resume (Enter -> default false)
    // 5 yes (s)
    // 6 once (s)
    // 7 expire (15m)
    // 8 no_qr (s)
    // 9 limit (Enter -> sin limite)
    // 10 relay (Enter -> default false)
    // avanzadas (n)
    // confirmar guardar (Enter -> S)
    const answers = [
      'no-url',
      'https://mi-drop.test/',
      dlDir,
      's',
      '',
      's',
      's',
      '15m',
      's',
      '',
      '',
      'n',
      '',
    ].join('\n') + '\n';

    const res = runSync(['config', 'init'], { env, input: answers });
    assert.equal(res.status, 0);
    assert.match(res.stdout, /URL de servidor no válida/);
    assert.match(res.stdout, /Configuración guardada/);

    const json = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    assert.equal(json.version, 1);
    assert.equal(json.server, 'https://mi-drop.test');
    assert.equal(json.out, dlDir);
    assert.equal(json.overwrite, true);
    assert.equal(json.no_resume, undefined);
    assert.equal(json.yes, true);
    assert.equal(json.once, true);
    assert.equal(json.expire, '15m');
    assert.equal(json.no_qr, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('transferencia E2E usa config.json por defecto y respeta precedencia CLI > env > config', { timeout: 60_000 }, async () => {
  const srv = await startServer();
  const tmp = makeTmpDir();
  const cfgPath = path.join(tmp, 'config.json');
  const srcFile = path.join(tmp, 'nota.txt');
  const outDir = path.join(tmp, 'downloads');
  const content = Buffer.from('contenido enviado usando config.json sin flags\n');
  fs.writeFileSync(srcFile, content);
  fs.mkdirSync(outDir, { recursive: true });
  // Archivo previo para comprobar overwrite desde config y --no-overwrite desde CLI
  fs.writeFileSync(path.join(outDir, 'nota.txt'), 'contenido viejo');

  try {
    // Guardar preferencias por defecto en config.json
    fs.writeFileSync(cfgPath, JSON.stringify({
      version: 1,
      server: srv.http,
      relay: true,
      once: true,
      no_qr: true,
      out: outDir,
      overwrite: true,
      limit: '10M',
    }, null, 2));

    // 1. send y recv SIN pasar -s, --relay, --once, -o ni --overwrite en CLI
    const sender1 = spawnCli(['send', srcFile], { DROP_CONFIG: cfgPath });
    try {
      const code = (await sender1.waitFor(/(\d{4}(?:-[a-z]+){4})/, 15_000))[1];
      const recv1 = spawnCli(['recv', code], { DROP_CONFIG: cfgPath });
      assert.equal(await recv1.exited, 0, recv1.output());

      // `overwrite: true` en config sobrescribio el archivo existente en `outDir`
      assert.deepEqual(fs.readFileSync(path.join(outDir, 'nota.txt')), content);
      // `once: true` en config cerro el emisor tras la 1ª descarga
      assert.equal(await sender1.exited, 0, sender1.output());
    } finally {
      sender1.kill();
    }

    // 2. Flags inversos en CLI anulan config.json:
    //    - `--no-once` mantiene el emisor abierto para 2 descargas
    //    - `--no-overwrite` guarda como `nota (2).txt` en vez de sobrescribir
    //    - `--limit 0` desactiva el limite de config.json
    //    - `DROP_SERVER` env anula un `server` muerto en config.json
    fs.writeFileSync(cfgPath, JSON.stringify({
      version: 1,
      server: 'http://127.0.0.1:1',
      relay: true,
      once: true,
      no_qr: true,
      out: outDir,
      overwrite: true,
      limit: '1M',
    }, null, 2));

    const sender2 = spawnCli(['send', srcFile, '--no-once', '--limit', '0'], {
      DROP_CONFIG: cfgPath,
      DROP_SERVER: srv.http,
    });
    try {
      const code = (await sender2.waitFor(/(\d{4}(?:-[a-z]+){4})/, 15_000))[1];

      // 1ª descarga con --no-overwrite (y --server CLI anulando DROP_SERVER muerto)
      const recvA = spawnCli(['recv', code, '--no-overwrite', '--server', srv.http], {
        DROP_CONFIG: cfgPath,
        DROP_SERVER: 'http://127.0.0.1:1',
      });
      assert.equal(await recvA.exited, 0, recvA.output());
      assert.equal(fs.existsSync(path.join(outDir, 'nota (2).txt')), true);
      assert.deepEqual(fs.readFileSync(path.join(outDir, 'nota (2).txt')), content);

      // Como se paso --no-once, una 2ª descarga tambien funciona (y --no-config ignora out/server rotos)
      const altOut = path.join(tmp, 'alt-out');
      fs.mkdirSync(altOut, { recursive: true });
      const recvB = spawnCli(['recv', code, '--no-config', '--relay', '--server', srv.http, '-o', altOut], {
        DROP_CONFIG: cfgPath,
      });
      assert.equal(await recvB.exited, 0, recvB.output());
      assert.deepEqual(fs.readFileSync(path.join(altOut, 'nota.txt')), content);
    } finally {
      sender2.kill();
    }
  } finally {
    srv.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('config.json corrupto avisa sin bloquear --no-config ni `drop config reset -y`', () => {
  const tmp = makeTmpDir();
  const cfgPath = path.join(tmp, 'config.json');
  fs.writeFileSync(cfgPath, '{ json roto');
  const env = { DROP_CONFIG: cfgPath };

  try {
    // Comando normal emite aviso por stderr (y falla por archivo inexistente, no por panic)
    const warn = runSync(['send', path.join(tmp, 'no-existe.txt')], { env });
    assert.equal(warn.status, 1);
    assert.match(warn.stderr, /Error leyendo la configuración/);

    // Con --no-config no emite aviso de config corrupto
    const clean = runSync(['send', path.join(tmp, 'no-existe.txt'), '--no-config'], { env });
    assert.equal(clean.status, 1);
    assert.doesNotMatch(clean.stderr, /Error leyendo la configuración/);

    // `drop config reset -y` repara eliminando el archivo corrupto
    const reset = runSync(['config', 'reset', '-y'], { env });
    assert.equal(reset.status, 0);
    assert.equal(fs.existsSync(cfgPath), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
