/**
 * Mide que le cuesta al emisor repartir a VARIOS receptores, que es lo que la
 * cadena de reenvio viene a arreglar.
 *
 *   npm run bench:fanout                 # 3 receptores, 64 MB
 *   PEERS=5 SIZE_MB=128 npm run bench:fanout
 *   MAX_COPIES=1.5 npm run bench:fanout  # falla si el emisor sube de ahi
 *
 * QUE MIDE: las copias que sale por el uplink del emisor, contadas con
 * getStats() sobre sus propias conexiones. Ese es el mecanismo de la mejora y no
 * depende de la maquina: antes eran N copias para N receptores, con la cadena es
 * una. El tiempo tambien se imprime, pero con todas las pestanas en el mismo
 * equipo va limitado por CPU y no dice nada del ancho de banda de nadie.
 */
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';

const URL_BASE = process.env.DROP_URL || 'http://localhost:3000';
const SIZE_MB = Number(process.env.SIZE_MB || 64);
const PEERS = Number(process.env.PEERS || 3);
// Con varios archivos se prueba lo que mas facil se rompe de la cadena: que
// `start`/`end` bajen en banda con los datos y no adelanten a los ultimos trozos.
const FILES = Number(process.env.FILES || 1);
const MAX_COPIES = process.env.MAX_COPIES ? Number(process.env.MAX_COPIES) : null;
const HEADLESS = process.env.HEADED !== '1';

// STAGGER_MS separa los `accept` para que no se agrupen: es el camino de antes,
// N copias por el uplink, y sirve de referencia contra la que comparar.
const STAGGER_MS = Number(process.env.STAGGER_MS || 0);
// KILL_HEAD cierra a mitad la pestana que come del emisor, para comprobar que
// los de abajo se recuperan pidiendo `resume` en vez de quedarse a medias.
const KILL_HEAD = process.env.KILL_HEAD === '1';

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

const fmt = (n, d = 1) => n.toFixed(d).padStart(6);

// Bytes que han salido de verdad por las conexiones del emisor.
const HOST_BYTES = `(async () => {
  let total = 0;
  for (const conn of window.__drop.out.peers.values()) {
    const stats = await conn.pc.getStats();
    stats.forEach((r) => { if (r.type === 'transport' && r.bytesSent) total += r.bytesSent; });
  }
  return total;
})()`;

async function main() {
  const bytes = SIZE_MB * 1024 * 1024;
  const payload = bytes * FILES;
  // Contenido que depende de la posicion: con ceros, un `resume` que se saltase
  // o repitiese un tramo daria el mismo hash y no nos enterariamos.
  const wantHash = [];
  for (let f = 0; f < FILES; f++) {
    const h = createHash('sha256');
    const block = Buffer.alloc(1024 * 1024);
    for (let i = 0; i < bytes; i += block.length) {
      for (let j = 0; j < block.length; j++) block[j] = (f + i + j) % 251;
      h.update(block);
    }
    wantHash.push(h.digest('hex'));
  }

  const browser = await chromium.launch({ executablePath: findChrome(), headless: HEADLESS });
  const context = await browser.newContext({ acceptDownloads: true });

  try {
    const sender = await context.newPage();
    await sender.goto(URL_BASE, { waitUntil: 'domcontentloaded' });
    await sender.evaluate(({ mb, files }) => {
      const dt = new DataTransfer();
      for (let f = 0; f < files; f++) {
        const buf = new Uint8Array(mb * 1024 * 1024);
        for (let i = 0; i < buf.length; i++) buf[i] = (f + i) % 251;
        dt.items.add(new File([buf], 'fanout-' + f + '.bin',
          { type: 'application/octet-stream' }));
      }
      const input = document.getElementById('file-input');
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, { mb: SIZE_MB, files: FILES });

    await sender.click('#create-link');
    await sender.waitForFunction(() => document.getElementById('link-out').value.includes('#'),
      null, { timeout: 15_000 });
    const link = await sender.inputValue('#link-out');

    // Todos los receptores en la sala antes de que nadie acepte: la cadena solo
    // agrupa a quien acepta dentro de la misma ventana.
    const peers = [];
    const downloads = new Map();
    for (let i = 0; i < PEERS; i++) {
      const page = await context.newPage();
      await page.addInitScript(() => { delete window.showDirectoryPicker; });
      const got = [];
      page.on('download', (d) => got.push(d));
      downloads.set(page, got);
      await page.goto(link, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#accept:visible', { timeout: 20_000 });
      peers.push(page);
    }

    const before = await sender.evaluate(HOST_BYTES);
    const tStart = Date.now();
    if (STAGGER_MS) {
      for (const p of peers) {
        await p.click('#accept');
        await new Promise((r) => setTimeout(r, STAGGER_MS));
      }
    } else {
      await Promise.all(peers.map((p) => p.click('#accept')));
    }

    let alive = peers;
    if (KILL_HEAD) {
      // Esperamos a que la cadena este corriendo de verdad antes de cortarla.
      await peers[0].waitForFunction(() => window.__drop.rx.received > 4 * 1024 * 1024,
        null, { timeout: 60_000 });
      const heads = [];
      for (const p of peers) {
        const isHead = await p.evaluate(() =>
          !!window.__drop.rx.down && window.__drop.rx.up && window.__drop.rx.up.peerId === 0);
        if (isHead) heads.push(p);
      }
      if (!heads.length) throw new Error('no hay cabeza de cadena que matar');
      console.log('  ...cerrando la pestana que come del emisor');
      await heads[0].close();
      alive = peers.filter((p) => !heads.includes(p));
    }

    await sender.waitForFunction(
      (n) => [...document.querySelectorAll('.peer .state')]
        .filter((r) => /delivered/.test(r.textContent)).length >= n,
      alive.length, { timeout: 15 * 60_000 });
    const seconds = (Date.now() - tStart) / 1000;
    const sent = (await sender.evaluate(HOST_BYTES)) - before;

    // Cada receptor tiene que tener el archivo entero, venga de donde venga.
    const got = await Promise.all(alive.map((p) => p.evaluate(() => ({
      received: window.__drop.rx.received,
      total: window.__drop.rx.total,
      via: window.__drop.rx.up ? window.__drop.rx.up.peerId : null,
      relaying: !!window.__drop.rx.down,
    }))));

    // Lo que de verdad importa: que el archivo que sale por el otro lado sea el
    // mismo. El contador de bytes no distingue un hueco de un tramo repetido.
    const hashes = [];
    for (const page of alive) {
      const got = downloads.get(page);
      // El navegador dispara la descarga al cerrar el archivo, que es antes de
      // que el emisor cante "delivered", pero el evento puede llegar despues.
      const deadline = Date.now() + 120_000;
      while (got.length < FILES && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200));
      }
      const seen = [];
      for (const dl of got) {
        const file = await dl.path();
        seen.push(createHash('sha256').update(await readFile(file)).digest('hex'));
        await rm(file, { force: true });
      }
      // Se descargan en el orden en que se cierran, que es el del manifiesto.
      hashes.push(seen.length === FILES && seen.every((h, i) => h === wantHash[i]));
    }
    const corrupt = hashes.filter((ok) => !ok);

    const copies = sent / payload;
    const chained = got.filter((g) => g.via).length;
    const short = got.filter((g) => g.received !== g.total);
    const n = alive.length;

    console.log('');
    console.log('  destino      %s', URL_BASE);
    console.log('  payload      %s MB (%s archivo(s)) x %s receptores%s',
      SIZE_MB * FILES, FILES, PEERS, KILL_HEAD ? ' (uno cerrado a mitad)' : '');
    console.log('  transferido  %s s   (%s MB/s agregados)',
      fmt(seconds, 2), fmt(payload * n / seconds / (1024 * 1024)));
    console.log('  el emisor    subio %s MB  =  %s copias del payload',
      fmt(sent / (1024 * 1024), 0).trim(), fmt(copies, 2).trim());
    console.log('  la cadena    %s de %s receptores comieron de otro receptor',
      chained, n);
    for (const [i, g] of got.entries()) {
      console.log('    receptor %s  %s / %s MB  %s  %s', i + 1,
        fmt(g.received / (1024 * 1024), 0).trim(), fmt(g.total / (1024 * 1024), 0).trim(),
        hashes[i] ? 'sha ok  ' : 'SHA MAL ',
        g.via ? 'via peer ' + g.via : 'directo del emisor');
    }
    console.log('');

    if (corrupt.length) {
      console.error('FALLO: %s receptor(es) guardaron un archivo distinto al original',
        corrupt.length);
      return 1;
    }
    if (short.length) {
      console.error('FALLO: %s receptor(es) no recibieron el archivo entero', short.length);
      return 1;
    }
    if (MAX_COPIES !== null && copies > MAX_COPIES) {
      console.error('FALLO: el emisor subio %s copias, el maximo exigido es %s',
        copies.toFixed(2), MAX_COPIES);
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
