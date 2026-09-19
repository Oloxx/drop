// Prueba del servidor de emparejamiento: codigos, reenvio de SDP/ICE y desconexiones.
// Ejecutar con:  npm test
//
// La suite arranca su propio servidor en un puerto efimero y lo apaga al acabar,
// asi que no hace falta levantar nada a mano. `DROP_URL` sigue sirviendo para
// apuntar a uno externo: en ese caso hay que darle tambien un
// `DROP_ALLOWED_ORIGINS` que incluya el origen que se prueba mas abajo.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';

import { startServer, open as openSocket } from './helpers.mjs';

let server = null;
let URL = process.env.DROP_URL || '';
// El origen que el servidor acepta por defecto, derivado de su puerto.
let ALLOWED_ORIGIN = process.env.DROP_TEST_ORIGIN || '';

before(async () => {
  if (URL) {                          // servidor externo: no levantamos nada
    if (!ALLOWED_ORIGIN) ALLOWED_ORIGIN = `http://localhost:${URL.split(':')[2] || '80'}`;
    return;
  }
  server = await startServer();
  URL = server.ws;
  if (!ALLOWED_ORIGIN) ALLOWED_ORIGIN = server.origin;
});

after(() => { server?.stop(); });

const open = (options) => openSocket(URL, options);

test('el emisor recibe un identificador de sala y el receptor puede unirse', async () => {
  const host = await open();
  host.say({ t: 'host', v: 2 });
  const hosted = await host.next();
  assert.equal(hosted.t, 'hosted');
  // Codigo v0.4.0: el servidor solo reparte el identificador PUBLICO de sala.
  // Las palabras del codigo las genera el cliente y no llegan hasta aqui.
  assert.match(hosted.token, /^[0-9]{4}$/);
  assert.equal(hosted.room, hosted.token);
  assert.equal(hosted.v, 2);

  const guest = await open();
  guest.say({ t: 'join', token: hosted.token });
  assert.equal((await guest.next()).t, 'joined');

  const notice = await host.next();
  assert.equal(notice.t, 'guest');
  assert.ok(notice.guestId > 0);

  // SDP/ICE del emisor hacia ese receptor concreto
  host.say({ t: 'signal', to: notice.guestId, data: { sdp: { type: 'offer', sdp: 'x' } } });
  const toGuest = await guest.next();
  assert.equal(toGuest.t, 'signal');
  assert.equal(toGuest.from, 0);
  assert.equal(toGuest.data.sdp.type, 'offer');

  // ...y la respuesta de vuelta, etiquetada con el id del receptor
  guest.say({ t: 'signal', data: { ice: { candidate: 'y' } } });
  const toHost = await host.next();
  assert.equal(toHost.from, notice.guestId);
  assert.equal(toHost.data.ice.candidate, 'y');

  guest.close();
  assert.equal((await host.next()).t, 'guest-gone');
  host.close();
});

test('varios receptores en la misma sala reciben senales independientes', async () => {
  const host = await open();
  host.say({ t: 'host', v: 2 });
  const { token } = await host.next();

  const a = await open();
  a.say({ t: 'join', token });
  await a.next();
  const idA = (await host.next()).guestId;

  const b = await open();
  b.say({ t: 'join', token });
  await b.next();
  const idB = (await host.next()).guestId;

  assert.notEqual(idA, idB);
  host.say({ t: 'signal', to: idB, data: { tag: 'solo-para-b' } });
  assert.equal((await b.next()).data.tag, 'solo-para-b');
  assert.equal(a.queue.length, 0);

  host.close();
  assert.equal((await a.next()).t, 'host-gone');
  assert.equal((await b.next()).t, 'host-gone');
  a.close(); b.close();
});

test('una sala inexistente devuelve NOT_FOUND', async () => {
  const guest = await open();
  guest.say({ t: 'join', token: 'no-existe-este0' });
  const msg = await guest.next();
  assert.equal(msg.t, 'error');
  assert.equal(msg.reason, 'NOT_FOUND');
  guest.close();
});

// Hasta la v0.7.x un `host` sin `v:2` recibia el token largo de la v0.3.5, que
// para aquellos binarios era la clave de cifrado entera. Ese camino ya no existe:
// si volviese a dar un token, un binario viejo se creeria emparejado con AES
// derivado de un formato que nadie mas habla. Mejor un `VERSION` explicito.
test('un cliente sin v:2 recibe VERSION y se le cierra el socket', async () => {
  const host = await open();
  host.say({ t: 'host' });
  const msg = await host.next();
  assert.equal(msg.t, 'error');
  assert.equal(msg.reason, 'VERSION');
  await new Promise((r) => host.on('close', r));
});

// /speed no dicta codigo: comparte un enlace y no tiene mas secreto que el
// identificador, asi que tiene que pedir uno largo con `link:true`. Con 4 digitos
// cualquiera podria colarse en una medicion ajena barriendo el espacio.
test('host con link:true recibe un identificador largo e inadivinable', async () => {
  const host = await open();
  host.say({ t: 'host', v: 2, link: true });
  const hosted = await host.next();
  assert.match(hosted.token, /^[A-Za-z0-9_-]{16}$/);           // 96 bits en base64url

  const guest = await open();
  guest.say({ t: 'join', token: hosted.token });
  assert.equal((await guest.next()).t, 'joined');
  guest.close(); host.close();
});

// El identificador de sala son 4 digitos publicos: sin esto, barrer los 10.000 a
// ritmo de red seria cuestion de segundos.
test('la sala se quema cuando el emisor denuncia varios secretos incorrectos', async () => {
  const host = await open();
  host.say({ t: 'host', v: 2 });
  const { token } = await host.next();

  // Cinco receptores que aciertan la sala pero fallan el secreto: el emisor los
  // denuncia y a la quinta el servidor cierra la sala.
  for (let i = 0; i < 5; i++) {
    const bad = await open();
    bad.say({ t: 'join', token });
    await bad.until((m) => m.t === 'joined');
    const notice = await host.until((m) => m.t === 'guest');
    host.say({ t: 'bad-guest', guestId: notice.guestId });
    assert.equal((await bad.until((m) => m.t === 'error')).reason, 'BAD_SECRET');
    bad.close();
  }

  assert.equal((await host.until((m) => m.t === 'error')).reason, 'BURNED');

  const late = await open();
  late.say({ t: 'join', token });
  assert.equal((await late.next()).reason, 'NOT_FOUND');
  late.close(); host.close();
});

test('la sala desaparece cuando el emisor se va', async () => {
  const host = await open();
  host.say({ t: 'host', v: 2 });
  const { token } = await host.next();
  host.close();
  await new Promise((r) => setTimeout(r, 100));

  const late = await open();
  late.say({ t: 'join', token });
  assert.equal((await late.next()).reason, 'NOT_FOUND');
  late.close();
});

test('dos receptores de la misma sala pueden senalizarse entre ellos', async () => {
  const host = await open();
  host.say({ t: 'host', v: 2 });
  const { token } = await host.next();

  const a = await open();
  a.say({ t: 'join', token });
  await a.next();
  const idA = (await host.next()).guestId;

  const b = await open();
  b.say({ t: 'join', token });
  await b.next();
  const idB = (await host.next()).guestId;

  // El eslabon de la cadena: A ofrece a B, y B contesta.
  a.say({ t: 'signal', to: idB, data: { sdp: { type: 'offer', sdp: 'cadena' } } });
  const toB = await b.next();
  assert.equal(toB.from, idA);                 // etiquetado con quien lo manda
  assert.equal(toB.data.sdp.sdp, 'cadena');

  b.say({ t: 'signal', to: idA, data: { sdp: { type: 'answer', sdp: 'vale' } } });
  const toA = await a.next();
  assert.equal(toA.from, idB);
  assert.equal(toA.data.sdp.type, 'answer');

  // Sin `to` se sigue hablando con el emisor, como siempre.
  a.say({ t: 'signal', data: { ice: { candidate: 'z' } } });
  assert.equal((await host.next()).from, idA);

  host.close(); a.close(); b.close();
});

test('un receptor no alcanza a otro de una sala distinta', async () => {
  const host1 = await open();
  host1.say({ t: 'host', v: 2 });
  const t1 = (await host1.next()).token;
  const host2 = await open();
  host2.say({ t: 'host', v: 2 });
  const t2 = (await host2.next()).token;

  const a = await open();
  a.say({ t: 'join', token: t1 });
  await a.next();
  await host1.next();

  const b = await open();
  b.say({ t: 'join', token: t2 });
  await b.next();
  const idB = (await host2.next()).guestId;

  // A tiene un id valido de otra sala: el servidor no debe puentearlo.
  a.say({ t: 'signal', to: idB, data: { tag: 'colado' } });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(b.queue.length, 0);

  host1.close(); host2.close(); a.close(); b.close();
});

test('el servidor rechaza un origen que no esta en la lista', async () => {
  // Una pagina no puede falsear su Origin, asi que esto es lo que impide que una
  // web cualquiera abra salas con el navegador de quien la visita.
  const err = await new Promise((resolve) => {
    const ws = new WebSocket(URL, { origin: 'https://no-soy-drop.example' });
    ws.on('error', resolve);
    ws.on('open', () => { ws.close(); resolve(null); });
  });
  assert.ok(err, 'la conexion deberia haber sido rechazada');
  assert.match(err.message, /403/);
});

test('un origen de la lista blanca conecta con normalidad', async () => {
  const host = await open({ origin: ALLOWED_ORIGIN });
  host.say({ t: 'host', v: 2 });
  assert.equal((await host.next()).t, 'hosted');
  host.close();
});

// Sin cabecera Origin (el CLI, curl, cualquier cosa que no sea un navegador) se
// acepta: lo cubre el resto de la suite, que conecta sin mandarla.

// ULTIMO A PROPOSITO: deja el cupo de esta IP agotado durante un minuto, asi que
// cualquier test posterior que espere un NOT_FOUND recibiria RATE_LIMITED. Un
// `join` acertado pone el contador a cero, por eso los tests de arriba siguen
// pasando aunque se relance la suite dentro de la misma ventana.
test('el servidor corta la fuerza bruta de identificadores de sala', async () => {
  const attacker = await open();
  let limited = false;

  // Identificadores que no pueden existir (el servidor solo reparte 4 digitos o
  // tokens de 16 caracteres): asi el test mide el limite y no la suerte.
  for (let attempt = 0; attempt < 40 && !limited; attempt++) {
    attacker.say({ t: 'join', token: `no-existe-${attempt}` });
    const msg = await attacker.next();
    if (msg.reason === 'RATE_LIMITED') limited = true;
    else assert.equal(msg.reason, 'NOT_FOUND');
  }

  assert.ok(limited, 'el servidor deberia haber cortado los intentos');

  // Y un `join` valido lo desbloquea, para no castigar a quien solo se equivoco.
  const host = await open();
  host.say({ t: 'host', v: 2 });
  const { token } = await host.next();
  const guest = await open();
  guest.say({ t: 'join', token });
  assert.equal((await guest.next()).t, 'joined');
  guest.close(); host.close(); attacker.close();
});
