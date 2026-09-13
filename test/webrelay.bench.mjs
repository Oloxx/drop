/**
 * Transferencia real CLI -> navegador por el relay del servidor, cifrada de
 * extremo a extremo: `drop send --relay` en un proceso y una pestana de Chrome
 * de verdad recibiendo. Comprueba el SHA-256 de lo descargado.
 *
 *   npm run bench:webrelay          # levanta su propio servidor
 *   SIZE_MB=64 npm run bench:webrelay
 *   HEADED=1 npm run bench:webrelay
 *
 * Es un bench y no un test de la suite porque necesita Chrome instalado
 * (playwright-core no lo descarga). Es la unica forma de ejercitar el receptor
 * web del relay -- scrypt en el navegador, WebCrypto abriendo lo que cierra
 * node:crypto, el orden de la cola -- contra el emisor de verdad.
 */
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

import { startServer, ROOT } from './helpers.mjs';

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

async function main() {
  // La pestana abre http://127.0.0.1:<puerto>, que el servidor ya acepta por
  // defecto para su propio puerto.
  const srv = await startServer();

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'drop-webrelay-'));
  const body = crypto.randomBytes(SIZE_MB * 1024 * 1024);
  const src = path.join(work, 'payload.bin');
  fs.writeFileSync(src, body);

  const sender = spawn(process.execPath, [CLI, 'send', src, '--server', srv.http, '--relay', '--yes'], {
    env: { ...process.env, DROP_NO_UPNP: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  sender.stdout.on('data', (d) => { out += stripAnsi(d.toString()); });
  sender.stderr.on('data', (d) => { out += stripAnsi(d.toString()); });

  const browser = await chromium.launch({ executablePath: findChrome(), headless: HEADLESS });
  const context = await browser.newContext({ acceptDownloads: true });
  try {
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`sin codigo:\n${out}`)), 20_000);
      const poll = setInterval(() => {
        const m = out.match(/Código:\s+(\d{4}(?:-[a-z]+){4})/);
        if (m) { clearInterval(poll); clearTimeout(timer); resolve(m[1]); }
      }, 50);
    });

    const page = await context.newPage();
    await page.addInitScript(() => { delete window.showDirectoryPicker; });
    page.on('console', (m) => { if (m.type() === 'error') console.log('  [chrome]', m.text()); });

    const downloaded = new Promise((resolve) => page.on('download', resolve));
    const t0 = Date.now();
    await page.goto(`${srv.http}/#${code}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#accept:visible', { timeout: 30_000 });
    const handshake = (Date.now() - t0) / 1000;

    const sas = await page.textContent('#offer-sas');
    const senderSas = out.match(/Huella:\s+(\S+)/)?.[1];
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
    const mbps = body.length / seconds / (1024 * 1024);
    console.log('');
    console.log('  payload      %d MB, CLI -> Chrome por relay cifrado', SIZE_MB);
    console.log('  huella       %s (coincide en los dos lados)', senderSas);
    console.log('  handshake    %s s   (scrypt en el navegador + prueba + manifiesto)', handshake.toFixed(2));
    console.log('  transferido  %s s   (%s MB/s)', seconds.toFixed(2), mbps.toFixed(1));
    console.log('  SHA-256      ok');
    console.log('');
    return 0;
  } finally {
    await browser.close();
    sender.kill('SIGKILL');
    srv.stop();
    fs.rmSync(work, { recursive: true, force: true });
  }
}

main().then((code) => process.exit(code), (err) => {
  console.error(err.message);
  process.exit(1);
});
