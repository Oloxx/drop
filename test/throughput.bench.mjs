/**
 * Mide la velocidad real de una transferencia entre dos peers, conduciendo dos
 * pestanas de Chrome contra la app de verdad.
 *
 *   npm run bench                                  # contra localhost:3000
 *   DROP_URL=https://drop.oloxx.dev npm run bench  # contra produccion
 *   SIZE_MB=256 npm run bench                      # payload mas grande
 *   MIN_MBPS=20 npm run bench                      # falla si baja de ahi
 *
 * QUE MIDE: con las dos pestanas en la misma maquina, WebRTC conecta por
 * candidatos locales. El numero es el techo de la app -- troceado, cifrado DTLS,
 * SCTP y control de flujo -- no el ancho de banda entre dos casas. Sirve para
 * detectar regresiones (bajar el tamano de chunk, romper la contrapresion), no
 * para prometerle velocidad a nadie.
 */
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';

const URL_BASE = process.env.DROP_URL || 'http://localhost:3000';
const SIZE_MB = Number(process.env.SIZE_MB || 64);
const MIN_MBPS = process.env.MIN_MBPS ? Number(process.env.MIN_MBPS) : null;
const HEADLESS = process.env.HEADED !== '1';

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
  if (!hit) {
    throw new Error('No encuentro Chrome. Indicalo con CHROME_PATH=/ruta/a/chrome');
  }
  return hit;
}

const fmt = (n, d = 1) => n.toFixed(d).padStart(6);

async function main() {
  const bytes = SIZE_MB * 1024 * 1024;
  const browser = await chromium.launch({ executablePath: findChrome(), headless: HEADLESS });
  const context = await browser.newContext({ acceptDownloads: true });

  // La descarga final no forma parte de la medida; la tiramos segun llega.
  context.on('page', (p) => p.on('download', (d) => d.delete().catch(() => {})));

  try {
    // ---------------------------------------------------------------- emisor
    const sender = await context.newPage();
    await sender.goto(URL_BASE, { waitUntil: 'domcontentloaded' });

    await sender.evaluate((mb) => {
      const file = new File([new Uint8Array(mb * 1024 * 1024)], 'bench.bin',
        { type: 'application/octet-stream' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const input = document.getElementById('file-input');
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, SIZE_MB);

    await sender.click('#create-link');
    await sender.waitForFunction(() => document.getElementById('link-out').value.includes('#'),
      null, { timeout: 15_000 });
    const link = await sender.inputValue('#link-out');

    // -------------------------------------------------------------- receptor
    const receiver = await context.newPage();
    // Sin esto Chrome abriria un dialogo nativo de carpeta que nadie puede cerrar.
    await receiver.addInitScript(() => { delete window.showDirectoryPicker; });

    const tOpen = Date.now();
    await receiver.goto(link, { waitUntil: 'domcontentloaded' });
    await receiver.waitForSelector('#accept:visible', { timeout: 20_000 });
    const handshake = (Date.now() - tOpen) / 1000;

    // ----------------------------------------------------------- transferencia
    const tStart = Date.now();
    await receiver.click('#accept');

    // El emisor marca "delivered" cuando el receptor confirma el ultimo byte.
    await sender.waitForFunction(
      () => /delivered/.test(document.querySelector('.peer .state')?.textContent || ''),
      null, { timeout: 10 * 60_000 });
    const seconds = (Date.now() - tStart) / 1000;

    const shown = await sender.textContent('.peer-file .rate').catch(() => '');
    const mbps = bytes / seconds / (1024 * 1024);

    console.log('');
    console.log('  destino      %s', URL_BASE);
    console.log('  payload      %s MB en un archivo', fmt(SIZE_MB, 0).trim());
    console.log('  handshake    %s s   (senalizacion + ICE + manifiesto)', fmt(handshake, 2));
    console.log('  transferido  %s s', fmt(seconds, 2));
    console.log('  velocidad    %s MB/s  (%s Mbit/s)', fmt(mbps), fmt(mbps * 8, 0).trim());
    if (shown) console.log('  la app decia %s', shown.trim());
    console.log('');

    if (MIN_MBPS !== null && mbps < MIN_MBPS) {
      console.error('FALLO: por debajo del minimo exigido de %s MB/s', MIN_MBPS);
      return 1;
    }
    return 0;
  } finally {
    await browser.close();
  }
}

main().then((code) => process.exit(code), (err) => {
  console.error(err.message);
  process.exit(1);
});
