// Prueba del servidor de emparejamiento: codigos, reenvio de SDP/ICE y desconexiones.
// Ejecutar con:  npm test   (necesita el servidor levantado en PORT o 3000)
import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';

const URL = process.env.DROP_URL || 'ws://localhost:3000';

function open() {
  const ws = new WebSocket(URL);
  ws.queue = [];
  ws.waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    const waiter = ws.waiters.shift();
    if (waiter) waiter(msg);
    else ws.queue.push(msg);
  });
  ws.next = () => new Promise((resolve) => {
    if (ws.queue.length) resolve(ws.queue.shift());
    else ws.waiters.push(resolve);
  });
  ws.say = (obj) => ws.send(JSON.stringify(obj));
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

test('el emisor recibe un token y el receptor puede unirse', async () => {
  const host = await open();
  host.say({ t: 'host' });
  const hosted = await host.next();
  assert.equal(hosted.t, 'hosted');
  assert.match(hosted.token, /^[A-Za-z0-9_-]{16}$/);           // 96 bits en base64url

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
  host.say({ t: 'host' });
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

test('un token inexistente devuelve NOT_FOUND', async () => {
  const guest = await open();
  guest.say({ t: 'join', token: 'no-existe-este0' });
  const msg = await guest.next();
  assert.equal(msg.t, 'error');
  assert.equal(msg.reason, 'NOT_FOUND');
  guest.close();
});

test('la sala desaparece cuando el emisor se va', async () => {
  const host = await open();
  host.say({ t: 'host' });
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
  host.say({ t: 'host' });
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
  host1.say({ t: 'host' });
  const t1 = (await host1.next()).token;
  const host2 = await open();
  host2.say({ t: 'host' });
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
