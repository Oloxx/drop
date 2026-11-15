// `drop verify-web` y `/version`: lo que sirve el servidor contra el arbol de
// `public/` del commit que dice servir. La API de GitHub es de mentira: sirve el
// arbol del directorio de trabajo, que es justo lo que sirve el servidor local.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

import { startServer, ROOT, cliSpawnTarget } from './helpers.mjs';

const COMMIT = 'c0ffee'.padEnd(40, '0');

function gitBlobSha(buf) {
  return crypto
    .createHash('sha1')
    .update(`blob ${buf.length}\0`)
    .update(buf)
    .digest('hex');
}

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

function runVerifyWebCli(url, githubApi) {
  return new Promise((resolve) => {
    const [cmd, cmdArgs] = cliSpawnTarget(['verify-web', url]);
    const p = spawn(cmd, cmdArgs, { env: { ...process.env, DROP_GITHUB_API: githubApi } });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('exit', (code) => resolve({ code, out: out.replace(/\x1b\[[0-9;]*m/g, '') }));
  });
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

  const apiGood = await fakeGithub(t);
  const ok = await runVerifyWebCli(srv.http, apiGood);
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /son idénticos a public\/ del commit c0ffee000000/);

  // El repositorio dice otra cosa de app.js: el servidor sirve algo distinto.
  const apiTampered = await fakeGithub(t, {
    tamper: (tree) => tree.map((e) => (e.path === 'public/app.js' ? { ...e, sha: '0'.repeat(40) } : e)),
  });
  const ko = await runVerifyWebCli(srv.http, apiTampered);
  assert.equal(ko.code, 1);
  assert.match(ko.out, /✖ app\.js/);
});

test('verify-web: sin commit, o con un commit que no es del repositorio, no da nada por bueno', async (t) => {
  const noCommit = await startServer();
  t.after(() => noCommit.stop());
  const res1 = await runVerifyWebCli(noCommit.http, await fakeGithub(t));
  assert.equal(res1.code, 1);
  assert.match(res1.out, /no dice qué commit sirve/);

  const srv = await startServer({ DROP_COMMIT: COMMIT });
  t.after(() => srv.stop());
  const res2 = await runVerifyWebCli(srv.http, await fakeGithub(t, { status: 404 }));
  assert.equal(res2.code, 1);
  assert.match(res2.out, /no está en github\.com/);
});
