// Arranque de servidores TCP: un puerto ocupado o sin permisos tiene que dar una
// frase, no un volcado de pila. Este fichero no necesita el servidor levantado.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import { listenOrExplain, explainListenError, watchServerErrors } from '../cli/src/listen.js';

function listen(server, port, host) {
  return new Promise((resolve) => server.listen(port, host, () => resolve(server.address().port)));
}

test('un puerto ocupado rechaza con un mensaje legible, no con una excepcion suelta', async () => {
  const ocupante = net.createServer();
  const port = await listen(ocupante, 0, '127.0.0.1');

  const nuestro = net.createServer();
  await assert.rejects(
    () => listenOrExplain(nuestro, port, '127.0.0.1'),
    (err) => {
      assert.equal(err.code, 'EADDRINUSE');
      assert.match(err.message, /ya está en uso/);
      assert.match(err.message, new RegExp(String(port)));
      return true;
    }
  );

  nuestro.close();
  ocupante.close();
});

test('listenOrExplain resuelve y deja el servidor escuchando', async () => {
  const server = net.createServer();
  await listenOrExplain(server, 0, '127.0.0.1');
  assert.ok(server.address().port > 0);
  // El listener de `error` del arranque tiene que haberse quitado: si se queda,
  // un fallo posterior intenta rechazar una promesa ya resuelta y se pierde.
  assert.equal(server.listenerCount('error'), 0);
  server.close();
});

test('explainListenError traduce EACCES sin perder el code', () => {
  const err = explainListenError(Object.assign(new Error('listen EACCES'), { code: 'EACCES' }), 80);
  assert.equal(err.code, 'EACCES');
  assert.match(err.message, /permisos/);
  assert.match(err.message, /1024/);
  assert.match(err.message, /80/);
});

test('explainListenError deja pasar tal cual lo que no sabe traducir', () => {
  const original = Object.assign(new Error('vete a saber'), { code: 'EWHATEVER' });
  assert.equal(explainListenError(original, 1234), original);
});

test('watchServerErrors recoge los errores posteriores al bind', async () => {
  const server = net.createServer();
  await listenOrExplain(server, 0, '127.0.0.1');

  const visto = new Promise((resolve) => watchServerErrors(server, resolve));
  server.emit('error', Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' }));

  const err = await visto;
  assert.equal(err.code, 'EADDRINUSE');
  assert.match(err.message, /ya está en uso/);
  server.close();
});
