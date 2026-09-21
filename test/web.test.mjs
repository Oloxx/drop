// El cliente web, de extremo a extremo: dos pestanas de Chrome contra la app
// de verdad, un archivo, SHA-256 al final. Es la version corta de `npm run
// bench`, metida en la suite para que un cambio en app.js lo pille el CI y no
// el primero que lo pruebe a mano.
//
// Necesita Chrome instalado (playwright-core no lo descarga). Sin Chrome el
// caso se salta, salvo con DROP_REQUIRE_CHROME=1, que es lo que pone el CI para
// que un runner sin navegador falle en vez de pasar en silencio.
//
// Lo que NO mide: velocidad. Las dos pestanas comparten una CPU y eso es lo que
// dice el numero; para eso esta `npm run bench` (ver CLAUDE.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';

import { startServer, findChrome } from './helpers.mjs';

const CHROME = findChrome();
const REQUIRED = process.env.DROP_REQUIRE_CHROME === '1';
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// 6 MB: mas de una ventana de acuses (ACK_EVERY, 2 MB) y de un `HIGH_WATER`
// bajo, para que el control de flujo y los acuses tengan que actuar de verdad.
const SIZE = 6 * 1024 * 1024;

test('web -> web: un archivo llega entero y verificado entre dos pestanas', { skip: !CHROME && !REQUIRED && 'sin Chrome (CHROME_PATH)', timeout: 120_000 }, async (t) => {
  assert.ok(CHROME, 'DROP_REQUIRE_CHROME=1 pero no hay Chrome: indicalo con CHROME_PATH');
  const { chromium } = await import('playwright-core');
  const srv = await startServer();
  t.after(() => srv.stop());
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ acceptDownloads: true });

  const body = crypto.randomBytes(SIZE);
  const errors = [];
  const watch = (page, tag) => page.on('console', (m) => {
    if (m.type() === 'error' && !/404/.test(m.text())) errors.push(`[${tag}] ${m.text()}`);
  });

  // ---------------------------------------------------------------- emisor
  const sender = await context.newPage();
  watch(sender, 'emisor');
  await sender.goto(srv.http, { waitUntil: 'domcontentloaded' });
  await sender.evaluate((b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], 'carga.bin', { type: 'application/octet-stream' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = document.getElementById('file-input');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, body.toString('base64'));
  await sender.click('#create-link');
  await sender.waitForFunction(() => document.getElementById('link-out').value.includes('#'), null, { timeout: 15_000 });
  const link = await sender.inputValue('#link-out');
  assert.match(link, /#\d{4}(-[a-z]+){4}$/, 'el enlace lleva el codigo en el fragmento');

  // -------------------------------------------------------------- receptor
  const receiver = await context.newPage();
  watch(receiver, 'receptor');
  // Sin esto Chrome abriria un dialogo nativo de carpeta que nadie puede cerrar.
  await receiver.addInitScript(() => { delete window.showDirectoryPicker; });
  const downloaded = new Promise((resolve) => receiver.on('download', resolve));
  await receiver.goto(link, { waitUntil: 'domcontentloaded' });
  await receiver.waitForSelector('#accept:visible', { timeout: 20_000 });
  assert.match(await receiver.textContent('#offer-title'), /1 file · 6\.0 MB/);

  // Las dos pestanas ensenan la misma huella: es lo que se compara de viva voz.
  await sender.waitForSelector('.peer .peer-sas:visible', { timeout: 20_000 });
  const words = (s) => (s.match(/[a-z]+-[a-z]+-[a-z]+/) || [])[0];
  const senderSas = words(await sender.textContent('.peer .peer-sas'));
  const receiverSas = words(await receiver.textContent('#offer-sas'));
  assert.ok(senderSas && receiverSas, 'las dos pestanas deberian ensenar la huella');
  assert.equal(senderSas, receiverSas, 'la huella no cuadra entre emisor y receptor');

  await receiver.click('#accept');

  // El emisor marca "delivered" cuando el receptor confirma el ultimo byte, y
  // el receptor "received" con el hash ya comprobado.
  await sender.waitForFunction(
    () => /delivered/.test(document.querySelector('.peer .state')?.textContent || ''),
    null, { timeout: 60_000 });
  await receiver.waitForFunction(
    () => /received/.test(document.querySelector('.peer .state')?.textContent || ''),
    null, { timeout: 60_000 });
  assert.match(await receiver.textContent('.peer .state'), /verified/);

  const dl = await downloaded;
  assert.equal(dl.suggestedFilename(), 'carga.bin');
  const got = fs.readFileSync(await dl.path());
  assert.equal(got.length, body.length);
  assert.equal(sha256(got), sha256(body), 'lo descargado no es lo que se envio');
  assert.deepEqual(errors, [], 'la consola no deberia tener errores');
});
