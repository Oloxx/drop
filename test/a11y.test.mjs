// Accesibilidad basica de la web: contraste de la paleta, marcado que un lector
// de pantalla necesita y que todo se alcance con el teclado.
//
// El contraste se calcula de los tokens de `:root` en style.css con la formula
// de WCAG 2.x: cambiar un color por otro "que queda mejor" y bajar de 4,5:1 en
// texto falla aqui, no en los ojos de alguien.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT, startServer, findChrome } from './helpers.mjs';

const css = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
const html = (name) => fs.readFileSync(path.join(ROOT, 'public', name), 'utf8');
const CHROME = findChrome();
const REQUIRED = process.env.DROP_REQUIRE_CHROME === '1';

function tokens() {
  const root = css.match(/:root\s*\{([\s\S]*?)\}/)[1];
  return Object.fromEntries([...root.matchAll(/--([a-z-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2]]));
}

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test('todo color de texto llega a 4,5:1 sobre los fondos donde se usa (WCAG AA)', () => {
  const t = tokens();
  for (const bg of ['bg', 'raised', 'sunken']) {
    for (const fg of ['fg', 'fg-dim', 'muted', 'blue', 'cyan', 'green', 'red']) {
      const ratio = contrast(t[fg], t[bg]);
      assert.ok(ratio >= 4.5, `--${fg} sobre --${bg}: ${ratio.toFixed(2)}:1`);
    }
  }
  // El boton principal: texto --sunken sobre --blue, y --cyan al pasar por encima.
  assert.ok(contrast(t.sunken, t.blue) >= 4.5);
  assert.ok(contrast(t.sunken, t.cyan) >= 4.5);
});

test('el marcado tiene lo que un lector de pantalla necesita', () => {
  const index = html('index.html');
  // El selector de archivos no puede estar `hidden`: saldria del orden de Tab.
  assert.match(index, /<input type="file" id="file-input" class="sr-only"[^>]*aria-label=/);
  assert.match(index, /id="status"[^>]*role="status"/);
  assert.match(index, /id="announce"[^>]*aria-live="polite"/);
  for (const id of ['code-error', 'join-error', 'verify-error-msg']) {
    assert.match(index, new RegExp(`id="${id}"[^>]*role="alert"`), `#${id} deberia ser role="alert"`);
  }
  // Todo input de texto lleva nombre accesible.
  for (const file of ['index.html', 'speed.html']) {
    for (const m of html(file).matchAll(/<input\b[^>]*>/g)) {
      if (/type="file"[^>]*webkitdirectory/.test(m[0])) continue;   // lo abre un <button>
      assert.match(m[0], /aria-label=|id="[^"]+"[^>]*>\s*<\/label>/, `${file}: input sin nombre: ${m[0]}`);
    }
  }
  assert.match(css, /prefers-reduced-motion[\s\S]*animation: none/);
});

test('web: con el teclado se llega a elegir archivos y los botones tienen nombre', { skip: !CHROME && !REQUIRED && 'sin Chrome (CHROME_PATH)', timeout: 60_000 }, async (t) => {
  assert.ok(CHROME, 'DROP_REQUIRE_CHROME=1 pero no hay Chrome: indicalo con CHROME_PATH');
  const { chromium } = await import('playwright-core');
  const srv = await startServer();
  t.after(() => srv.stop());
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(srv.http, { waitUntil: 'domcontentloaded' });

  // Tab desde el principio hasta el selector de archivos, y que se vea donde esta.
  let reached = false;
  for (let i = 0; i < 10 && !reached; i++) {
    await page.keyboard.press('Tab');
    reached = await page.evaluate(() => document.activeElement?.id === 'file-input');
  }
  assert.ok(reached, 'el selector de archivos no se alcanza con Tab');
  const outline = await page.evaluate(() => getComputedStyle(document.getElementById('drop')).outlineStyle);
  assert.equal(outline, 'solid', 'la zona de soltar deberia marcar el foco');

  // El × de cada archivo dice que quita y cual.
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['hola'], 'a.txt'));
    const input = document.getElementById('file-input');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  assert.equal(await page.getAttribute('.drop-one', 'aria-label'), 'Remove a.txt');
});
