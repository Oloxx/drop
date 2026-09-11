// Cabeceras de seguridad, y lo que la CSP obliga a no escribir en el HTML.
//
// La CSP solo vale si nadie la afloja para desatascar algo. Un `style="..."` en
// una plantilla y ya hace falta 'unsafe-inline', que deja la politica en un
// adorno: con 'unsafe-inline' cualquier HTML inyectado puede volver a ejecutar
// lo que quiera. Por eso aqui hay dos cosas: que las cabeceras salgan, y que el
// HTML siga sin nada en linea que las obligue a ceder.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT, startServer } from './helpers.mjs';

const PUBLIC = path.join(ROOT, 'public');

test('la web se sirve con las cabeceras de seguridad', async () => {
  const srv = await startServer();
  try {
    const res = await fetch(`${srv.http}/`);
    assert.equal(res.status, 200);

    const csp = res.headers.get('content-security-policy');
    assert.ok(csp, 'deberia haber Content-Security-Policy');
    for (const directiva of [
      "default-src 'self'",
      "script-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
    ]) {
      assert.ok(csp.includes(directiva), `falta ${directiva} en la CSP`);
    }

    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.match(res.headers.get('permissions-policy') || '', /camera=\(\)/);
    // Express lo anuncia por defecto y solo sirve para decirle a quien mire con
    // que esta hecho esto.
    assert.equal(res.headers.get('x-powered-by'), null);
  } finally {
    srv.stop();
  }
});

test('la CSP no lleva ningun escape', async () => {
  const srv = await startServer();
  try {
    const csp = (await fetch(`${srv.http}/`)).headers.get('content-security-policy');
    for (const escape of ["'unsafe-inline'", "'unsafe-eval'", "data: 'self' *", ' *']) {
      assert.ok(!csp.includes(escape), `la CSP no deberia tener ${escape}`);
    }
  } finally {
    srv.stop();
  }
});

// Lo que caza este caso paso de verdad: un `style="color: var(--red)"` en
// index.html que el navegador bloqueo en cuanto se puso la CSP.
test('el HTML no tiene estilos, scripts ni manejadores en linea', () => {
  for (const nombre of fs.readdirSync(PUBLIC).filter((f) => f.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(PUBLIC, nombre), 'utf8');

    assert.equal(html.match(/\sstyle\s*=\s*["']/), null, `${nombre} tiene un atributo style en linea`);
    assert.equal(html.match(/\son[a-z]+\s*=\s*["']/i), null, `${nombre} tiene un manejador en linea`);

    // Un <script> sin src es codigo en linea; con src, no.
    for (const etiqueta of html.match(/<script[^>]*>/g) || []) {
      assert.match(etiqueta, /\ssrc\s*=/, `${nombre} tiene un <script> en linea`);
    }
  }
});
