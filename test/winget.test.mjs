// Pruebas del generador y envio de manifiestos WinGet (`scripts/winget.mjs`).
//
// Vigila tres invariantes:
// 1. Que `scripts/winget.mjs` nunca genere un manifiesto si falta `SHA256SUMS.minisig`
//    o si la firma no valida con la clave publica empotrada en `cli/src/cli.rs`.
// 2. Que la estructura de directorio (`manifests/o/Oloxx/drop/<ver>/`) y los campos
//    YAML cumplan el esquema 1.12.0 (validado tambien por `winget validate` en Windows).
// 3. Que `--submit` solo modifique los 3 ficheros del manifiesto, evite duplicados y
//    escoja bien entre `New package` y `New version`.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { ROOT } from './helpers.mjs';
import { generateKeyPair, signContent } from '../scripts/minisign.mjs';
import {
  PUBLIC_KEY,
  WINGET_WARNING_EXIT_CODE,
  buildManifests,
  generateWingetManifests,
  parseSums,
  submitWingetPr,
  validateWingetManifest,
} from '../scripts/winget.mjs';

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function startMockServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const bodyText = Buffer.concat(chunks).toString('utf8');
      let jsonBody = null;
      if (bodyText) {
        try {
          jsonBody = JSON.parse(bodyText);
        } catch {}
      }
      await handler(req, res, jsonBody);
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

test('PUBLIC_KEY de scripts/winget.mjs coincide con cli/src/cli.rs', () => {
  const cliSrc = fs.readFileSync(path.join(ROOT, 'cli', 'src', 'cli.rs'), 'utf8');
  const m = cliSrc.match(/pub const PUBLIC_KEY:\s*&str\s*=\s*"([^"]+)"/);
  assert.ok(m, 'No se encontro PUBLIC_KEY en cli/src/cli.rs');
  assert.equal(PUBLIC_KEY, m[1]);
});

test('parseSums y buildManifests generan estructura y campos WinGet validos', () => {
  const sha = 'a1b2c3d4'.repeat(8);
  const sums = [
    `${'0'.repeat(64)}  drop-v1.0.0-linux-x64.tar.gz`,
    `${sha}  *./drop-v1.0.0-windows-x64.exe`,
  ].join('\n');
  const parsed = parseSums(sums);
  assert.equal(parsed.get('drop-v1.0.0-windows-x64.exe'), sha);

  const manifest = buildManifests({
    version: '1.0.0',
    sha256: sha,
    releaseDate: '2026-11-15',
  });
  assert.equal(manifest.relDir, 'manifests/o/Oloxx/drop/1.0.0');
  assert.deepEqual(Object.keys(manifest.files), [
    'Oloxx.drop.yaml',
    'Oloxx.drop.installer.yaml',
    'Oloxx.drop.locale.en-US.yaml',
  ]);
  assert.match(manifest.files['Oloxx.drop.yaml'], /ManifestVersion: 1\.12\.0/);
  assert.match(manifest.files['Oloxx.drop.installer.yaml'], /InstallerType: portable/);
  assert.match(manifest.files['Oloxx.drop.installer.yaml'], /- drop\b/);
  assert.match(manifest.files['Oloxx.drop.installer.yaml'], new RegExp(`InstallerSha256: ${sha.toUpperCase()}`));
  assert.match(
    manifest.files['Oloxx.drop.installer.yaml'],
    /InstallerUrl: https:\/\/github\.com\/Oloxx\/drop\/releases\/download\/v1\.0\.0\/drop-v1\.0\.0-windows-x64\.exe/,
  );
  assert.match(manifest.files['Oloxx.drop.locale.en-US.yaml'], /PackageUrl: https:\/\/github\.com\/Oloxx\/drop/);

  assert.throws(() => buildManifests({ version: 'bad', sha256: sha, releaseDate: '2026-11-15' }), /Version no valida/);
  assert.throws(() => buildManifests({ version: '1.0.0', sha256: 'zz', releaseDate: '2026-11-15' }), /SHA-256 no valido/);
});

test('generateWingetManifests exige firma Minisign valida antes de escribir ficheros', async () => {
  const keys = generateKeyPair();
  const otherKeys = generateKeyPair();
  const exeSha = 'deadbeef'.repeat(8);
  const sumsContent = `${exeSha}  drop-v0.13.0-windows-x64.exe\n`;
  const validSig = signContent({ content: sumsContent, secretKey: keys.secretKey });
  const wrongKeySig = signContent({ content: sumsContent, secretKey: otherKeys.secretKey });

  let mode = 'ok';
  const { server, url } = await startMockServer((req, res) => {
    if (req.url === '/repos/Oloxx/drop/releases/tags/v0.13.0') {
      const assets = [{ name: 'SHA256SUMS', browser_download_url: `${url}/dl/SHA256SUMS` }];
      if (mode !== 'missing-sig') {
        assets.push({ name: 'SHA256SUMS.minisig', browser_download_url: `${url}/dl/SHA256SUMS.minisig` });
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        tag_name: 'v0.13.0',
        published_at: '2026-11-15T14:02:46Z',
        assets,
      }));
      return;
    }
    if (req.url === '/dl/SHA256SUMS') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(mode === 'tampered-sums' ? sumsContent.replace('deadbeef', 'cafebabe') : sumsContent);
      return;
    }
    if (req.url === '/dl/SHA256SUMS.minisig') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(mode === 'wrong-key' ? wrongKeySig : validSig);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const tmp = makeTempDir('drop-winget-sec-');
  try {
    // 1. Firma valida -> escribe los 3 YAML y valida con `winget validate` en Windows.
    const outOk = path.join(tmp, 'ok');
    const res = await generateWingetManifests({
      tag: 'v0.13.0',
      outDir: outOk,
      githubApi: url,
      publicKey: keys.publicKey,
      token: null,
    });
    assert.equal(res.sha256, exeSha.toUpperCase());
    assert.ok(fs.existsSync(path.join(res.manifestDir, 'Oloxx.drop.yaml')));
    assert.ok(fs.existsSync(path.join(res.manifestDir, 'Oloxx.drop.installer.yaml')));
    assert.ok(fs.existsSync(path.join(res.manifestDir, 'Oloxx.drop.locale.en-US.yaml')));

    if (process.platform === 'win32') {
      const hasWinget = spawnSync('winget', ['--version'], { encoding: 'utf8' }).status === 0;
      if (hasWinget) {
        const val = validateWingetManifest(res.manifestDir);
        assert.equal(val.ok, true);
      }
    }

    // 2. Sin .minisig -> rechazado sin crear ficheros.
    mode = 'missing-sig';
    const outMissing = path.join(tmp, 'missing');
    await assert.rejects(
      () => generateWingetManifests({ tag: 'v0.13.0', outDir: outMissing, githubApi: url, publicKey: keys.publicKey, token: null }),
      /SHA256SUMS\.minisig/,
    );
    assert.equal(fs.existsSync(outMissing), false);

    // 3. SHA256SUMS alterado respecto a la firma -> rechazado sin crear ficheros.
    mode = 'tampered-sums';
    const outTampered = path.join(tmp, 'tampered');
    await assert.rejects(
      () => generateWingetManifests({ tag: 'v0.13.0', outDir: outTampered, githubApi: url, publicKey: keys.publicKey, token: null }),
      /Firma Minisign NO VALIDA/,
    );
    assert.equal(fs.existsSync(outTampered), false);

    // 4. Firma de otra clave -> rechazado sin crear ficheros.
    mode = 'wrong-key';
    const outWrongKey = path.join(tmp, 'wrong-key');
    await assert.rejects(
      () => generateWingetManifests({ tag: 'v0.13.0', outDir: outWrongKey, githubApi: url, publicKey: keys.publicKey, token: null }),
      /Firma Minisign NO VALIDA/,
    );
    assert.equal(fs.existsSync(outWrongKey), false);

    // 5. Modo local `--from-dist` con firma valida y manipulada.
    const distOk = path.join(tmp, 'dist-ok');
    fs.mkdirSync(distOk, { recursive: true });
    fs.writeFileSync(path.join(distOk, 'SHA256SUMS'), sumsContent);
    fs.writeFileSync(path.join(distOk, 'SHA256SUMS.minisig'), validSig);
    const fromDistOut = path.join(tmp, 'from-dist-out');
    const localRes = await generateWingetManifests({
      fromDist: distOk,
      tag: 'v0.13.0',
      releaseDate: '2026-11-15',
      outDir: fromDistOut,
      publicKey: keys.publicKey,
    });
    assert.equal(localRes.version, '0.13.0');
  } finally {
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('submitWingetPr crea rama limpia con los 3 manifiestos y evita PR duplicadas', async () => {
  let hasUpstreamPkg = false;
  let hasFork = false;
  let openPulls = [];
  let recordedTree = null;
  let recordedPr = null;

  const { server, url } = await startMockServer((req, res, body) => {
    const reqUrl = new URL(req.url, url);
    if (req.method === 'GET' && reqUrl.pathname === '/user') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ login: 'TestOwner' }));
      return;
    }
    if (req.method === 'GET' && reqUrl.pathname === '/repos/microsoft/winget-pkgs/contents/manifests/o/Oloxx/drop') {
      if (!hasUpstreamPkg) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'Not Found' }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([{ name: '0.12.0' }]));
      }
      return;
    }
    if (req.method === 'GET' && reqUrl.pathname === '/repos/microsoft/winget-pkgs/pulls') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(openPulls));
      return;
    }
    if (req.method === 'GET' && reqUrl.pathname === '/search/issues') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ items: openPulls }));
      return;
    }
    if (req.method === 'GET' && reqUrl.pathname === '/repos/microsoft/winget-pkgs') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ default_branch: 'master' }));
      return;
    }
    if (req.method === 'GET' && reqUrl.pathname === '/repos/TestOwner/winget-pkgs') {
      res.writeHead(hasFork ? 200 : 404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(hasFork ? { default_branch: 'master' } : { message: 'Not Found' }));
      return;
    }
    if (req.method === 'POST' && reqUrl.pathname === '/repos/microsoft/winget-pkgs/forks') {
      hasFork = true;
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ full_name: 'TestOwner/winget-pkgs' }));
      return;
    }
    if (req.method === 'GET' && reqUrl.pathname === '/repos/TestOwner/winget-pkgs/git/ref/heads/master') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: { sha: 'base-commit-sha' } }));
      return;
    }
    if (req.method === 'POST' && reqUrl.pathname === '/repos/TestOwner/winget-pkgs/merge-upstream') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ merge_type: 'none' }));
      return;
    }
    if (req.method === 'GET' && reqUrl.pathname === '/repos/TestOwner/winget-pkgs/git/commits/base-commit-sha') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ tree: { sha: 'base-tree-sha' } }));
      return;
    }
    if (req.method === 'POST' && reqUrl.pathname === '/repos/TestOwner/winget-pkgs/git/blobs') {
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sha: `blob-${Math.random().toString(16).slice(2, 8)}` }));
      return;
    }
    if (req.method === 'POST' && reqUrl.pathname === '/repos/TestOwner/winget-pkgs/git/trees') {
      recordedTree = body;
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sha: 'new-tree-sha' }));
      return;
    }
    if (req.method === 'POST' && reqUrl.pathname === '/repos/TestOwner/winget-pkgs/git/commits') {
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sha: 'new-commit-sha' }));
      return;
    }
    if (req.method === 'POST' && reqUrl.pathname === '/repos/TestOwner/winget-pkgs/git/refs') {
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ref: body.ref }));
      return;
    }
    if (req.method === 'POST' && reqUrl.pathname === '/repos/microsoft/winget-pkgs/pulls') {
      recordedPr = body;
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ number: 1234, html_url: 'https://github.com/microsoft/winget-pkgs/pull/1234' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const manifest = buildManifests({
    version: '0.13.0',
    sha256: '52be83a12b1aff2f162ec27bf48c29db2fd7f24bf718494ad6c8eeda878964ab',
    releaseDate: '2026-11-15',
  });

  try {
    // Caso 1: paquete nuevo -> titulo "New package: ..." y solo los 3 ficheros en el tree.
    const r1 = await submitWingetPr(manifest, { githubApi: url, token: 'test-token' });
    assert.equal(r1.created, true);
    assert.equal(recordedPr.title, 'New package: Oloxx.drop version 0.13.0');
    assert.equal(recordedPr.head, 'TestOwner:Oloxx.drop-0.13.0');
    assert.equal(recordedPr.base, 'master');
    assert.equal(recordedTree.base_tree, 'base-tree-sha');
    assert.deepEqual(
      recordedTree.tree.map((e) => e.path),
      [
        'manifests/o/Oloxx/drop/0.13.0/Oloxx.drop.yaml',
        'manifests/o/Oloxx/drop/0.13.0/Oloxx.drop.installer.yaml',
        'manifests/o/Oloxx/drop/0.13.0/Oloxx.drop.locale.en-US.yaml',
      ],
    );

    // Caso 2: paquete ya existente en upstream -> titulo "New version: ...".
    hasUpstreamPkg = true;
    recordedPr = null;
    const r2 = await submitWingetPr(manifest, { githubApi: url, token: 'test-token' });
    assert.equal(r2.created, true);
    assert.equal(recordedPr.title, 'New version: Oloxx.drop version 0.13.0');

    // Caso 3: ya existe PR abierta -> no abre otra.
    openPulls = [{ number: 1234, html_url: 'https://github.com/microsoft/winget-pkgs/pull/1234' }];
    recordedPr = null;
    const r3 = await submitWingetPr(manifest, { githubApi: url, token: 'test-token' });
    assert.equal(r3.existing, true);
    assert.equal(r3.number, 1234);
    assert.equal(recordedPr, null);
  } finally {
    server.close();
  }
});

test('validateWingetManifest solo tolera aviso de URL de esquema 1.12.0 en winget antiguo', () => {
  // 1. Exito estricto a la primera.
  const calls1 = [];
  const ok = validateWingetManifest('C:/dummy', {
    spawnFn: (cmd, args) => {
      calls1.push([cmd, args]);
      return { status: 0, stdout: 'Manifest validation succeeded.\n', stderr: '' };
    },
  });
  assert.equal(ok.usedIgnoreWarnings, false);
  assert.equal(calls1.length, 1);

  // 2. Winget < 1.12: unico aviso esperado de SchemaHeader -> reintenta con --ignore-warnings y pasa.
  const calls2 = [];
  const legacyWarningOutput = [
    'Manifest validation succeeded with warnings.',
    'Manifest Warning: The schema header URL does not match the expected pattern. Value: # yaml-language-server: $schema=https://aka.ms/winget-manifest.installer.1.12.0.schema.json Line: 1, Column: 25 File: Oloxx.drop.installer.yaml',
    'Manifest Warning: The schema header URL does not match the expected pattern. Value: # yaml-language-server: $schema=https://aka.ms/winget-manifest.defaultLocale.1.12.0.schema.json Line: 1, Column: 25 File: Oloxx.drop.locale.en-US.yaml',
    'Manifest Warning: The schema header URL does not match the expected pattern. Value: # yaml-language-server: $schema=https://aka.ms/winget-manifest.version.1.12.0.schema.json Line: 1, Column: 25 File: Oloxx.drop.yaml',
  ].join('\n');
  const compat = validateWingetManifest('C:/dummy', {
    verbose: true,
    spawnFn: (cmd, args) => {
      calls2.push([cmd, args]);
      if (calls2.length === 1) {
        return { status: WINGET_WARNING_EXIT_CODE, stdout: legacyWarningOutput, stderr: '' };
      }
      return { status: 0, stdout: 'Manifest validation succeeded.\n', stderr: '' };
    },
  });
  assert.equal(compat.usedIgnoreWarnings, true);
  assert.deepEqual(calls2[0][1], ['validate', '--manifest', 'C:/dummy', '--verbose']);
  assert.deepEqual(calls2[1][1], ['validate', '--manifest', 'C:/dummy', '--verbose', '--ignore-warnings']);

  // 3. Cualquier otro aviso debe fallar sin reintentar.
  let calls3 = 0;
  assert.throws(
    () => validateWingetManifest('C:/dummy', {
      spawnFn: () => {
        calls3++;
        return {
          status: WINGET_WARNING_EXIT_CODE,
          stdout: `${legacyWarningOutput}\nManifest Warning: Unexpected warning`,
          stderr: '',
        };
      },
    }),
    /winget validate fallo/,
  );
  assert.equal(calls3, 1);

  // 4. Error de esquema aunque venga acompanado de avisos debe fallar sin reintentar.
  let calls4 = 0;
  assert.throws(
    () => validateWingetManifest('C:/dummy', {
      spawnFn: () => {
        calls4++;
        return {
          status: 2316632105,
          stdout: `Manifest Error: Schema Error.\n${legacyWarningOutput}`,
          stderr: '',
        };
      },
    }),
    /winget validate fallo/,
  );
  assert.equal(calls4, 1);
});
