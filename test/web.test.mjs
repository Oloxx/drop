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

// Montaje comun de los casos de corte: emisor con un archivo pequeno y receptor
// con la oferta a la vista (DataChannel abierto, sin aceptar todavia).
async function offerReady(t, srv, context, size = 512 * 1024) {
  const body = crypto.randomBytes(size);
  const sender = await context.newPage();
  await sender.goto(srv.http, { waitUntil: 'domcontentloaded' });
  await sender.evaluate((b64) => {
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'corte.bin'));
    const input = document.getElementById('file-input');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, body.toString('base64'));
  await sender.click('#create-link');
  await sender.waitForFunction(() => document.getElementById('link-out').value.includes('#'), null, { timeout: 15_000 });
  const link = await sender.inputValue('#link-out');
  const receiver = await context.newPage();
  await receiver.addInitScript(() => { delete window.showDirectoryPicker; });
  await receiver.goto(link, { waitUntil: 'domcontentloaded' });
  await receiver.waitForSelector('#accept:visible', { timeout: 20_000 });
  return { sender, receiver, body };
}

test('web: los cortes conocidos acaban con un mensaje, no en un handshake eterno', { skip: !CHROME && !REQUIRED && 'sin Chrome (CHROME_PATH)', timeout: 120_000 }, async (t) => {
  assert.ok(CHROME, 'DROP_REQUIRE_CHROME=1 pero no hay Chrome: indicalo con CHROME_PATH');
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  t.after(() => browser.close());

  // 1. El emisor cierra la pestana antes de que el receptor acepte: la oferta
  //    se retira y se explica, con el cuadro para teclear otro codigo.
  {
    const srv = await startServer();
    const context = await browser.newContext({ acceptDownloads: true });
    const { sender, receiver } = await offerReady(t, srv, context);
    await sender.close();
    await receiver.waitForSelector('#join-error:visible', { timeout: 20_000 });
    assert.match(await receiver.textContent('#join-error'), /sender closed the channel/);
    assert.equal(await receiver.isVisible('#accept'), false, 'la oferta no deberia seguir a la vista');
    assert.equal(await receiver.isVisible('#retry-box'), true);
    await context.close();
    srv.stop();
  }

  // 2. El servidor cae con el DataChannel ya abierto: la transferencia no lo
  //    necesita y tiene que terminar igual. Es la promesa de "el servidor solo
  //    empareja", puesta a prueba.
  {
    const srv = await startServer();
    const context = await browser.newContext({ acceptDownloads: true });
    const { sender, receiver, body } = await offerReady(t, srv, context);
    const downloaded = new Promise((resolve) => receiver.on('download', resolve));
    srv.proc.kill('SIGKILL');
    await receiver.waitForFunction(() => /uplink lost/.test(document.getElementById('status').textContent), null, { timeout: 10_000 });
    assert.equal(await receiver.isVisible('#accept'), true, 'con el canal abierto la oferta sigue valiendo');
    await receiver.click('#accept');
    await sender.waitForFunction(
      () => /delivered/.test(document.querySelector('.peer .state')?.textContent || ''),
      null, { timeout: 60_000 });
    const got = fs.readFileSync(await (await downloaded).path());
    assert.equal(sha256(got), sha256(body));
    await context.close();
  }
});

// Seleccion en la oferta (#10): de tres archivos se desmarca uno, llegan los
// otros dos y el emisor da por entregado lo pedido, no el lote.
test('web -> web: el receptor elige que archivos baja', { skip: !CHROME && !REQUIRED && 'sin Chrome (CHROME_PATH)', timeout: 120_000 }, async (t) => {
  assert.ok(CHROME, 'DROP_REQUIRE_CHROME=1 pero no hay Chrome: indicalo con CHROME_PATH');
  const { chromium } = await import('playwright-core');
  const srv = await startServer();
  t.after(() => srv.stop());
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ acceptDownloads: true });

  const bodies = {
    'uno.bin': crypto.randomBytes(300 * 1024),
    'dos.bin': crypto.randomBytes(200 * 1024),
    'tres.bin': crypto.randomBytes(100 * 1024),
  };
  const sender = await context.newPage();
  await sender.goto(srv.http, { waitUntil: 'domcontentloaded' });
  await sender.evaluate((list) => {
    const dt = new DataTransfer();
    for (const [name, b64] of list) {
      const bin = atob(b64);
      dt.items.add(new File([Uint8Array.from(bin, (ch) => ch.charCodeAt(0))], name));
    }
    const input = document.getElementById('file-input');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, Object.entries(bodies).map(([name, body]) => [name, body.toString('base64')]));
  await sender.click('#create-link');
  await sender.waitForFunction(() => document.getElementById('link-out').value.includes('#'), null, { timeout: 15_000 });
  const link = await sender.inputValue('#link-out');

  const receiver = await context.newPage();
  await receiver.addInitScript(() => { delete window.showDirectoryPicker; });
  const downloads = [];
  receiver.on('download', (d) => downloads.push(d));
  await receiver.goto(link, { waitUntil: 'domcontentloaded' });
  await receiver.waitForSelector('#accept:visible', { timeout: 20_000 });
  assert.match(await receiver.textContent('#offer-title'), /^3 files/);

  // `select none` y marcar dos, pulsando en el nombre (es el <label>).
  await receiver.click('#pick-all');
  assert.equal(await receiver.isDisabled('#accept'), true, 'sin nada marcado no se puede aceptar');
  await receiver.click('#offer-list label:text("uno.bin")');
  await receiver.click('#offer-list label:text("tres.bin")');
  assert.match(await receiver.textContent('#offer-title'), /^2 of 3 files · 400 KB/);
  assert.equal((await receiver.textContent('#accept')).trim(), 'receive 2');

  await receiver.click('#accept');
  await sender.waitForFunction(
    () => /delivered/.test(document.querySelector('.peer .state')?.textContent || ''),
    null, { timeout: 60_000 });
  await receiver.waitForFunction(
    () => /received/.test(document.querySelector('.peer .state')?.textContent || ''),
    null, { timeout: 60_000 });
  // El no elegido queda tachado en la lista.
  assert.equal(await receiver.getAttribute('#offer-list li:nth-child(2)', 'class'), 'skipped');

  const deadline = Date.now() + 10_000;
  while (downloads.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  const got = Object.fromEntries(await Promise.all(downloads.map(async (d) => [d.suggestedFilename(), fs.readFileSync(await d.path())])));
  assert.deepEqual(Object.keys(got).sort(), ['tres.bin', 'uno.bin']);
  assert.equal(sha256(got['uno.bin']), sha256(bodies['uno.bin']));
  assert.equal(sha256(got['tres.bin']), sha256(bodies['tres.bin']));
});
