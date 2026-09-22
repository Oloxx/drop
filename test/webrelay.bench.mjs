/**
 * Transferencias reales entre un CLI y una pestana de Chrome por el relay del
 * servidor, cifradas de extremo a extremo, en los dos sentidos:
 *
 *   1. `drop send --relay` -> Chrome recibe y descarga.
 *   2. Chrome abre el canal -> `drop recv` descarga.
 *
 * Comprueba el SHA-256 de lo recibido y que la huella coincide en los dos lados.
 *
 *   npm run bench:webrelay          # levanta su propio servidor
 *   SIZE_MB=64 npm run bench:webrelay
 *   HEADED=1 npm run bench:webrelay
 *
 * Es un bench y no un test de la suite porque necesita Chrome instalado
 * (playwright-core no lo descarga). Es la unica forma de ejercitar la mitad
 * web del relay -- scrypt en el navegador, WebCrypto abriendo y cerrando lo
 * que cierra y abre node:crypto, el orden de la cola, la ventana de acuses --
 * contra el CLI de verdad.
 */
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

import { startServer, ROOT, CHROME_ARGS } from './helpers.mjs';

const SIZE_MB = Number(process.env.SIZE_MB || 12);
const HEADLESS = process.env.HEADED !== '1';
const CLI = path.join(ROOT, 'cli', 'src', 'cli.js');

const CHROME_PATHS = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

function findChrome() {
  const hit = CHROME_PATHS.find((p) => existsSync(p));
  if (!hit) throw new Error('No encuentro Chrome. Indicalo con CHROME_PATH=/ruta/a/chrome');
  return hit;
}

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function runCli(args) {
  const proc = spawn(process.execPath, [CLI, ...args], {
    env: { ...process.env, DROP_NO_UPNP: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.output = '';
  proc.stdout.on('data', (d) => { proc.output += stripAnsi(d.toString()); });
  proc.stderr.on('data', (d) => { proc.output += stripAnsi(d.toString()); });
  proc.waitFor = (re, ms) => new Promise((resolve, reject) => {
    const check = () => {
      const m = proc.output.match(re);
      if (m) { clearInterval(poll); clearTimeout(timer); resolve(m); }
    };
    const poll = setInterval(check, 50);
    const timer = setTimeout(() => {
      clearInterval(poll);
      reject(new Error(`no apareció ${re} en la salida:\n${proc.output}`));
    }, ms);
    check();
  });
  proc.exited = new Promise((resolve) => proc.on('exit', (code) => resolve(code)));
  return proc;
}

function report(title, { handshake, seconds, bytes, sas }) {
  console.log('');
  console.log('  %s', title);
  console.log('  payload      %d MB', SIZE_MB);
  console.log('  huella       %s (coincide en los dos lados)', sas);
  console.log('  handshake    %s s', handshake.toFixed(2));
  console.log('  transferido  %s s   (%s MB/s)', seconds.toFixed(2), (bytes / seconds / (1024 * 1024)).toFixed(1));
  console.log('  SHA-256      ok');
}

// ------------------------------------------------- 1. drop send -> Chrome

async function cliToChrome(srv, context, body, src) {
  const sender = runCli(['send', src, '--server', srv.http, '--relay', '--yes', '--no-qr']);
  try {
    const [, code] = await sender.waitFor(/Código:\s+(\d{4}(?:-[a-z]+){4})/, 20_000);
    const [, senderSas] = await sender.waitFor(/Huella:\s+(\S+)/, 5_000);

    const page = await context.newPage();
    await page.addInitScript(() => { delete window.showDirectoryPicker; });
    page.on('console', (m) => { if (m.type() === 'error' && !/404/.test(m.text())) console.log('  [chrome]', m.text()); });

    const downloaded = new Promise((resolve) => page.on('download', resolve));
    const t0 = Date.now();
    await page.goto(`${srv.http}/#${code}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#accept:visible', { timeout: 30_000 });
    const handshake = (Date.now() - t0) / 1000;

    const sas = await page.textContent('#offer-sas');
    if (!sas.includes(senderSas)) throw new Error(`la huella no cuadra: web "${sas}" vs CLI "${senderSas}"`);

    const t1 = Date.now();
    await page.click('#accept');
    const dl = await downloaded;
    const got = fs.readFileSync(await dl.path());
    const seconds = (Date.now() - t1) / 1000;
    await page.waitForFunction(
      () => /received/.test(document.querySelector('.peer .state')?.textContent || ''),
      null, { timeout: 30_000 });
    if (got.length !== body.length || sha256(got) !== sha256(body)) {
      throw new Error(`el archivo recibido no coincide (${got.length} bytes vs ${body.length})`);
    }
    await page.close();
    report('drop send -> Chrome (relay cifrado)', { handshake, seconds, bytes: body.length, sas: senderSas });
  } finally {
    sender.kill('SIGKILL');
  }
}

// ------------------------------------------------- 2. Chrome -> drop recv

async function chromeToCli(srv, context, body, outDir) {
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error' && !/404/.test(m.text())) console.log('  [chrome]', m.text()); });
  await page.goto(srv.http, { waitUntil: 'domcontentloaded' });
  await page.evaluate((bytes) => {
    const file = new File([new Uint8Array(bytes)], 'payload.bin', { type: 'application/octet-stream' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = document.getElementById('file-input');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, Array.from(body));
  await page.click('#create-link');
  await page.waitForFunction(() => document.getElementById('code-out').value.includes('-'), null, { timeout: 15_000 });
  const code = await page.inputValue('#code-out');

  const t0 = Date.now();
  const receiver = runCli(['recv', code, '--server', srv.http, '--relay', '-o', outDir]);
  try {
    const [, receiverSas] = await receiver.waitFor(/Huella de la sesión:\s+(\S+)/, 30_000);
    const handshake = (Date.now() - t0) / 1000;
    const t1 = Date.now();
    const exitCode = await receiver.exited;
    const seconds = (Date.now() - t1) / 1000;
    if (exitCode !== 0) throw new Error(`drop recv falló:\n${receiver.output}`);
    if (!/El emisor es un navegador/.test(receiver.output)) throw new Error('el receptor no ha reconocido al emisor web');

    const got = fs.readFileSync(path.join(outDir, 'payload.bin'));
    if (got.length !== body.length || sha256(got) !== sha256(body)) {
      throw new Error(`el archivo recibido no coincide (${got.length} bytes vs ${body.length})`);
    }
    await page.waitForFunction(
      () => /delivered/.test(document.querySelector('.peer .state')?.textContent || ''),
      null, { timeout: 30_000 });
    // La web no ensena la huella del relay al emisor (no hay un sitio para ella
    // sin un receptor concreto), asi que se contrasta con el CLI calculandola
    // igual: misma clave, misma sala.
    const { deriveKey, sasFromKey } = await import('../cli/src/crypto.js');
    const expected = sasFromKey(deriveKey(code), code.slice(0, 4));
    if (receiverSas !== expected) throw new Error(`la huella no cuadra: CLI "${receiverSas}" vs esperada "${expected}"`);
    await page.close();
    report('Chrome -> drop recv (relay cifrado)', { handshake, seconds, bytes: body.length, sas: receiverSas });
  } finally {
    receiver.kill('SIGKILL');
  }
}

async function main() {
  // La pestana abre http://127.0.0.1:<puerto>, que el servidor ya acepta por
  // defecto para su propio puerto.
  const srv = await startServer();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'drop-webrelay-'));
  const body = crypto.randomBytes(SIZE_MB * 1024 * 1024);
  const src = path.join(work, 'payload.bin');
  fs.writeFileSync(src, body);
  const outDir = path.join(work, 'recv');
  fs.mkdirSync(outDir);

  const browser = await chromium.launch({ executablePath: findChrome(), headless: HEADLESS, args: CHROME_ARGS });
  const context = await browser.newContext({ acceptDownloads: true });
  try {
    await cliToChrome(srv, context, body, src);
    await chromeToCli(srv, context, body, outDir);
    console.log('');
    return 0;
  } finally {
    await browser.close();
    srv.stop();
    fs.rmSync(work, { recursive: true, force: true });
  }
}

main().then((code) => process.exit(code), (err) => {
  console.error(err.message);
  process.exit(1);
});
