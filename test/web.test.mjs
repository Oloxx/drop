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
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

import { startServer, findChrome, CHROME_ARGS, ROOT } from './helpers.mjs';
import { crc32Update } from '../public/shared/zip.js';

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
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: CHROME_ARGS });
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
  // Accesible: la barra dice su valor y el final se anuncia aunque nadie mire.
  assert.equal(await receiver.getAttribute('.peer .bar', 'role'), 'progressbar');
  assert.equal(await receiver.getAttribute('.peer .bar', 'aria-valuenow'), '100');
  await receiver.waitForFunction(() => /inbound: received/.test(document.getElementById('announce').textContent), null, { timeout: 5_000 });

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
  await receiver.goto(link, { waitUntil: 'domcontentloaded' });
  await receiver.waitForSelector('#accept:visible', { timeout: 20_000 });
  return { sender, receiver, body };
}

test('web: los cortes conocidos acaban con un mensaje, no en un handshake eterno', { skip: !CHROME && !REQUIRED && 'sin Chrome (CHROME_PATH)', timeout: 120_000 }, async (t) => {
  assert.ok(CHROME, 'DROP_REQUIRE_CHROME=1 pero no hay Chrome: indicalo con CHROME_PATH');
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: CHROME_ARGS });
  t.after(() => browser.close());

  // 1. El emisor cierra la pestana antes de que el receptor acepte: la oferta
  //    se retira y se explica, con el cuadro para teclear otro codigo.
  {
    const srv = await startServer();
    // Aunque el caso falle: un servidor hijo vivo deja `node --test` esperando.
    t.after(() => srv.stop());
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
    t.after(() => srv.stop());
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
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: CHROME_ARGS });
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

// Reanudar Web -> CLI (#58): un `drop recv` que se corta a medias deja su
// `.part`; al relanzarlo, el emisor web comprueba el prefijo y sigue desde ahi.
// Y un `.part` que no es de este archivo no se cose: va entero a otro nombre.
test('web -> CLI: un drop recv cortado sigue desde su .part', { skip: !CHROME && !REQUIRED && 'sin Chrome (CHROME_PATH)', timeout: 180_000 }, async (t) => {
  assert.ok(CHROME, 'DROP_REQUIRE_CHROME=1 pero no hay Chrome: indicalo con CHROME_PATH');
  const { chromium } = await import('playwright-core');
  const { spawn } = await import('node:child_process');
  const path = await import('node:path');
  const os = await import('node:os');
  const { ROOT } = await import('./helpers.mjs');
  const CLI = path.join(ROOT, 'cli', 'src', 'cli.js');
  const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
  const runCli = (args) => {
    const p = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, DROP_NO_UPNP: '1' } });
    p.out = '';
    p.stdout.on('data', (d) => { p.out += strip(String(d)); });
    p.stderr.on('data', (d) => { p.out += strip(String(d)); });
    p.exited = new Promise((resolve) => p.on('exit', resolve));
    t.after(() => p.kill('SIGKILL'));
    return p;
  };

  const srv = await startServer();
  t.after(() => srv.stop());
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: CHROME_ARGS });
  t.after(() => browser.close());
  const context = await browser.newContext();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'drop-web-resume-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));

  const body = crypto.randomBytes(24 * 1024 * 1024);
  const sender = await context.newPage();
  await sender.goto(srv.http, { waitUntil: 'domcontentloaded' });
  await sender.evaluate((b64) => {
    const bin = atob(b64);
    const dt = new DataTransfer();
    dt.items.add(new File([Uint8Array.from(bin, (ch) => ch.charCodeAt(0))], 'grande.bin'));
    const input = document.getElementById('file-input');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, body.toString('base64'));
  await sender.click('#create-link');
  await sender.waitForFunction(() => document.getElementById('code-out').value.length > 10, null, { timeout: 15_000 });
  const code = await sender.inputValue('#code-out');

  // 1. Primer intento, frenado para poder cortarlo a medias.
  const out = path.join(work, 'destino');
  const part = path.join(out, 'grande.bin.part');
  const first = runCli(['recv', code, '--server', srv.http, '-o', out, '--limit', '4M']);
  const deadline = Date.now() + 60_000;
  while (!(fs.existsSync(part) && fs.statSync(part).size >= 6 * 1024 * 1024)) {
    assert.ok(Date.now() < deadline, `el primer intento no llega a 6 MB:\n${first.out}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  first.kill('SIGKILL');
  await first.exited;
  const kept = fs.statSync(part).size;
  assert.ok(kept > 0 && kept < body.length);

  // 2. El mismo comando: pide el prefijo, el emisor web lo acepta y sigue.
  const second = runCli(['recv', code, '--server', srv.http, '-o', out]);
  assert.equal(await second.exited, 0, `el segundo intento falló:\n${second.out}`);
  assert.match(second.out, /Reanudando grande\.bin desde/);
  assert.equal(sha256(fs.readFileSync(path.join(out, 'grande.bin'))), sha256(body));
  assert.equal(fs.existsSync(part), false, 'el .part pasa a ser el archivo');
  await sender.waitForFunction(
    () => [...document.querySelectorAll('.peer .state')].some((el) => /delivered/.test(el.textContent)),
    null, { timeout: 15_000 });

  // 3. Un .part de otra cosa con el mismo nombre: el emisor lo rechaza, llega
  //    entero a `grande (2).bin` y el .part se queda como estaba.
  const other = path.join(work, 'otro');
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, 'grande.bin.part'), crypto.randomBytes(1024 * 1024));
  const third = runCli(['recv', code, '--server', srv.http, '-o', other]);
  assert.equal(await third.exited, 0, `el tercer intento falló:\n${third.out}`);
  assert.equal(sha256(fs.readFileSync(path.join(other, 'grande (2).bin'))), sha256(body));
  assert.equal(fs.statSync(path.join(other, 'grande.bin.part')).size, 1024 * 1024);
});

function readZip(buf) {
  let eocdOff = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocdOff = i; break; }
  }
  assert.ok(eocdOff >= 0, 'el archivo descargado no tiene cabecera EOCD de ZIP');
  const count = buf.readUInt16LE(eocdOff + 10);
  let p = buf.readUInt32LE(eocdOff + 16);
  const out = {};
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const crc = buf.readUInt32LE(p + 16);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const lfhOff = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;

    const lfhNameLen = buf.readUInt16LE(lfhOff + 26);
    const lfhExtraLen = buf.readUInt16LE(lfhOff + 28);
    const start = lfhOff + 30 + lfhNameLen + lfhExtraLen;
    const data = buf.subarray(start, start + size);
    assert.equal(crc32Update(0, data), crc, `CRC-32 corrupto en ${name}`);
    out[name] = data;
  }
  return out;
}

// Empaquetado en .zip al vuelo en el receptor web:
//   1. Un lote grande (>= 4 archivos y > SW_MIN, 34 MB) marca .zip por defecto
//      y baja en streaming por el Service Worker como `drop-files.zip`.
//   2. Con pocos archivos sueltos la casilla empieza desmarcada y al marcarla
//      se juntan en `drop-files.zip`.
//   3. CLI -> web enviando una carpeta sigue llegando intacta en `<carpeta>.zip`.
test('web: lotes de archivos bajan en streaming como .zip', { skip: !CHROME && !REQUIRED && 'sin Chrome (CHROME_PATH)', timeout: 180_000 }, async (t) => {
  assert.ok(CHROME, 'DROP_REQUIRE_CHROME=1 pero no hay Chrome: indicalo con CHROME_PATH');
  const { chromium } = await import('playwright-core');
  const srv = await startServer();
  t.after(() => srv.stop());
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: CHROME_ARGS });
  t.after(() => browser.close());

  const fillDeterministic = (len, seed) => {
    const out = Buffer.allocUnsafe(len);
    let x = seed >>> 0;
    for (let i = 0; i < len; i += 4) {
      x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
      const rem = Math.min(4, len - i);
      for (let j = 0; j < rem; j++) out[i + j] = (x >>> (j * 8)) & 0xff;
    }
    return out;
  };

  // ----------------------------------------- 1. Web -> Web lote 34 MB (SW)
  {
    const context = await browser.newContext({ acceptDownloads: true });
    t.after(() => context.close());
    const errors = [];
    const watch = (p, tag) => p.on('console', (m) => {
      if (m.type() === 'error' && !/404/.test(m.text())) errors.push(`[${tag}] ${m.text()}`);
    });

    const s1 = 18 * 1024 * 1024;
    const s2 = 16 * 1024 * 1024;
    const sender = await context.newPage();
    watch(sender, 'emisor');
    await sender.goto(srv.http, { waitUntil: 'domcontentloaded' });
    assert.equal(await sender.$('#folder-input'), null, 'la web no deberia tener selector de carpetas');
    assert.equal(await sender.$('#pick-folder'), null, 'la web no deberia ofrecer elegir carpetas');
    await sender.evaluate(([len1, len2]) => {
      const make = (len, seed) => {
        const bytes = new Uint8Array(len);
        let x = seed >>> 0;
        for (let i = 0; i < len; i += 4) {
          x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
          const rem = Math.min(4, len - i);
          for (let j = 0; j < rem; j++) bytes[i + j] = (x >>> (j * 8)) & 0xff;
        }
        return bytes;
      };
      const dt = new DataTransfer();
      dt.items.add(new File([make(len1, 101)], 'parte1.bin'));
      dt.items.add(new File([make(len2, 202)], 'parte2.bin'));
      dt.items.add(new File(['hola\n'], 'nota.txt'));
      dt.items.add(new File([new Uint8Array(0)], 'vacio.bin'));
      const input = document.getElementById('file-input');
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, [s1, s2]);
    await sender.click('#create-link');
    await sender.waitForFunction(() => document.getElementById('link-out').value.includes('#'), null, { timeout: 15_000 });
    const link = await sender.inputValue('#link-out');

    const receiver = await context.newPage();
    watch(receiver, 'receptor');
    const downloaded = new Promise((resolve) => receiver.on('download', resolve));
    await receiver.goto(link, { waitUntil: 'domcontentloaded' });
    await receiver.waitForSelector('#as-zip:visible', { timeout: 20_000 });
    assert.equal(await receiver.isChecked('#as-zip'), true, 'un lote de >= 4 archivos deberia marcar .zip por defecto');
    await receiver.waitForFunction(() => /Streamed as a single \.zip/.test(document.getElementById('offer-hint').textContent), null, { timeout: 10_000 });

    await receiver.click('#accept');
    await sender.waitForFunction(() => /delivered/.test(document.querySelector('.peer .state')?.textContent || ''), null, { timeout: 90_000 });
    await receiver.waitForFunction(() => /received/.test(document.querySelector('.peer .state')?.textContent || ''), null, { timeout: 90_000 });

    const dl = await downloaded;
    assert.equal(dl.suggestedFilename(), 'drop-files.zip');
    const entries = readZip(fs.readFileSync(await dl.path()));
    assert.deepEqual(Object.keys(entries).sort(), ['nota.txt', 'parte1.bin', 'parte2.bin', 'vacio.bin']);
    assert.equal(entries['nota.txt'].toString('utf8'), 'hola\n');
    assert.equal(entries['vacio.bin'].length, 0);
    assert.equal(sha256(entries['parte1.bin']), sha256(fillDeterministic(s1, 101)));
    assert.equal(sha256(entries['parte2.bin']), sha256(fillDeterministic(s2, 202)));
    assert.deepEqual(errors, []);
  }

  // ------------------------- 2. Web -> Web archivos sueltos con toggle manual
  {
    const context = await browser.newContext({ acceptDownloads: true });
    t.after(() => context.close());
    const a = crypto.randomBytes(64 * 1024);
    const b = crypto.randomBytes(32 * 1024);
    const sender = await context.newPage();
    await sender.goto(srv.http, { waitUntil: 'domcontentloaded' });
    await sender.evaluate(([b1, b2]) => {
      const toFile = (b64, name) => new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], name);
      const dt = new DataTransfer();
      dt.items.add(toFile(b1, 'uno.bin'));
      dt.items.add(toFile(b2, 'dos.bin'));
      const input = document.getElementById('file-input');
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, [a.toString('base64'), b.toString('base64')]);
    await sender.click('#create-link');
    await sender.waitForFunction(() => document.getElementById('link-out').value.includes('#'), null, { timeout: 15_000 });
    const link = await sender.inputValue('#link-out');

    const receiver = await context.newPage();
    const downloaded = new Promise((resolve) => receiver.on('download', resolve));
    await receiver.goto(link, { waitUntil: 'domcontentloaded' });
    await receiver.waitForSelector('#as-zip:visible', { timeout: 20_000 });
    assert.equal(await receiver.isChecked('#as-zip'), false, 'dos archivos sueltos no deberian forzar .zip por defecto');
    await receiver.click('#zip-opt');
    assert.equal(await receiver.isChecked('#as-zip'), true);

    await receiver.click('#accept');
    await receiver.waitForFunction(() => /received/.test(document.querySelector('.peer .state')?.textContent || ''), null, { timeout: 60_000 });
    const dl = await downloaded;
    assert.equal(dl.suggestedFilename(), 'drop-files.zip');
    const entries = readZip(fs.readFileSync(await dl.path()));
    assert.deepEqual(Object.keys(entries).sort(), ['dos.bin', 'uno.bin']);
    assert.equal(sha256(entries['uno.bin']), sha256(a));
    assert.equal(sha256(entries['dos.bin']), sha256(b));
  }

  // ------------------------------ 3. CLI send <carpeta> -> Web como .zip
  {
    const context = await browser.newContext({ acceptDownloads: true });
    t.after(() => context.close());
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'drop-web-zip-'));
    t.after(() => fs.rmSync(work, { recursive: true, force: true }));
    const src = path.join(work, 'proyecto');
    fs.mkdirSync(path.join(src, 'src'), { recursive: true });
    const readme = Buffer.from('# Hola España\n');
    const code = crypto.randomBytes(80 * 1024);
    fs.writeFileSync(path.join(src, 'README.md'), readme);
    fs.writeFileSync(path.join(src, 'vacio.txt'), Buffer.alloc(0));
    fs.writeFileSync(path.join(src, 'src', 'index.js'), code);

    const cli = spawn(process.execPath, [path.join(ROOT, 'cli', 'src', 'cli.js'), 'send', src, '--server', srv.http, '--relay', '--no-qr'],
      { env: { ...process.env, DROP_NO_UPNP: '1' } });
    t.after(() => cli.kill('SIGKILL'));
    let out = '';
    cli.stdout.on('data', (d) => { out += String(d).replace(/\x1b\[[0-9;]*m/g, ''); });
    const t0 = Date.now();
    while (!/Enlace:\s+\S+/.test(out)) {
      assert.ok(Date.now() - t0 < 20_000, out);
      await new Promise((r) => setTimeout(r, 100));
    }
    const cliLink = out.match(/Enlace:\s+(\S+)/)[1];

    const receiver = await context.newPage();
    const downloaded = new Promise((resolve) => receiver.on('download', resolve));
    await receiver.goto(cliLink, { waitUntil: 'domcontentloaded' });
    await receiver.waitForSelector('#as-zip:visible', { timeout: 30_000 });
    assert.equal(await receiver.isChecked('#as-zip'), true);
    await receiver.click('#accept');
    await receiver.waitForFunction(() => /received/.test(document.querySelector('.peer .state')?.textContent || ''), null, { timeout: 60_000 });

    const dl = await downloaded;
    assert.equal(dl.suggestedFilename(), 'proyecto.zip');
    const entries = readZip(fs.readFileSync(await dl.path()));
    assert.deepEqual(Object.keys(entries).sort(), ['proyecto/README.md', 'proyecto/src/index.js', 'proyecto/vacio.txt']);
    assert.ok(entries['proyecto/README.md'].equals(readme));
    assert.equal(entries['proyecto/vacio.txt'].length, 0);
    assert.equal(sha256(entries['proyecto/src/index.js']), sha256(code));
  }
});
