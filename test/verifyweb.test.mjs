// `drop verify-web` y `/version`: lo que sirve el servidor contra el arbol de
// `public/` del commit que dice servir. La API de GitHub es de mentira: sirve el
// arbol del directorio de trabajo, que es justo lo que sirve el servidor local.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

import { gitBlobSha, verifyWeb } from '../cli/src/verifyweb.js';
import { startServer, ROOT } from './helpers.mjs';

const COMMIT = 'c0ffee'.padEnd(40, '0');
const CLI = path.join(ROOT, 'cli', 'src', 'cli.js');

function publicTree() {
  const out = [];
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else out.push({ path: `public/${r}`, type: 'blob', sha: gitBlobSha(fs.readFileSync(path.join(dir, e.name))) });
    }
  };
  walk(path.join(ROOT, 'public'), '');
  return out;
}

/** API de GitHub de mentira. `tamper(tree)` puede tocar el arbol antes de servirlo. */
async function fakeGithub(t, { tamper = (x) => x, status = 200 } = {}) {
  const server = http.createServer((req, res) => {
    if (req.url !== `/repos/Oloxx/drop/git/trees/${COMMIT}?recursive=1`) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ sha: COMMIT, truncated: false, tree: tamper(publicTree()) }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('gitBlobSha es el hash que da git a un blob', () => {
  const body = Buffer.from('hola\nmundo\n');
  const expected = execFileSync('git', ['hash-object', '--stdin', '--no-filters'], { input: body }).toString().trim();
  assert.equal(gitBlobSha(body), expected);
});

test('/version dice version y commit, y null si el despliegue no lo pasa', async (t) => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const withCommit = await startServer({ DROP_COMMIT: COMMIT });
  t.after(() => withCommit.stop());
  assert.deepEqual(await (await fetch(withCommit.http + '/version')).json(), { version: pkg.version, commit: COMMIT });

  const bogus = await startServer({ DROP_COMMIT: 'no es un commit' });
  t.after(() => bogus.stop());
  assert.equal((await (await fetch(bogus.http + '/version')).json()).commit, null);
});

test('verify-web: todo cuadra con el commit, y lo que no cuadra se dice por archivo', async (t) => {
  const srv = await startServer({ DROP_COMMIT: COMMIT });
  t.after(() => srv.stop());

  const good = await verifyWeb(srv.http, { githubApi: await fakeGithub(t) });
  assert.equal(good.commit, COMMIT);
  assert.ok(good.files.length >= 10);
  assert.deepEqual(good.files.filter((f) => !f.ok), []);
  assert.ok(good.files.some((f) => f.path === 'index.html'));
  assert.ok(good.files.some((f) => f.path === 'app.js'));

  // El repositorio dice otra cosa de app.js: el servidor sirve algo distinto.
  const api = await fakeGithub(t, {
    tamper: (tree) => tree.map((e) => (e.path === 'public/app.js' ? { ...e, sha: '0'.repeat(40) } : e)),
  });
  const bad = await verifyWeb(srv.http, { githubApi: api });
  assert.deepEqual(bad.files.filter((f) => !f.ok).map((f) => f.path), ['app.js']);

  // Por la orden, con su codigo de salida.
  const run = (githubApi) => new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, 'verify-web', srv.http], { env: { ...process.env, DROP_GITHUB_API: githubApi } });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('exit', (code) => resolve({ code, out: out.replace(/\x1b\[[0-9;]*m/g, '') }));
  });
  const ok = await run(await fakeGithub(t));
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /son idénticos a public\/ del commit c0ffee000000/);
  const ko = await run(api);
  assert.equal(ko.code, 1);
  assert.match(ko.out, /✖ app\.js/);
});

test('verify-web: sin commit, o con un commit que no es del repositorio, no da nada por bueno', async (t) => {
  const noCommit = await startServer();
  t.after(() => noCommit.stop());
  await assert.rejects(verifyWeb(noCommit.http, { githubApi: await fakeGithub(t) }), /no dice qué commit sirve/);

  const srv = await startServer({ DROP_COMMIT: COMMIT });
  t.after(() => srv.stop());
  await assert.rejects(verifyWeb(srv.http, { githubApi: await fakeGithub(t, { status: 404 }) }), /no está en github\.com/);
});
