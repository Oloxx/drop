// IPv6 en las rutas directas (issue #37, primera mitad): las direcciones IPv6
// globales y unicas locales entran en las candidatas de la oferta, el emisor
// escucha en las dos familias y el receptor las ordena y sondea junto a las
// IPv4. El descubrimiento por multicast IPv6 queda para otra.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  getLocalIPv6s, getCandidateIPs, rankCandidates, isLocalAddress, plainAddress, isLinkLocalV6, probeCandidateIPs,
} from '../cli/src/discovery.js';
import { listenAnyFamily } from '../cli/src/listen.js';
import { createSenderServer, receiveFiles } from '../cli/src/transfer.js';
import { newCode, randomRoomId } from '../public/shared/codes.js';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** Si el sistema no tiene IPv6 (CI raro, contenedor), los tests de socket se saltan. */
async function hasLoopbackV6() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(0, '::1', () => srv.close(() => resolve(true)));
  });
}

test('rankCandidates: loopback, misma subred, privadas, IPv6 y al final lo publico', () => {
  const local = ['192.168.1.10', '2001:db8:1:2::10'];
  const ranked = rankCandidates(
    ['8.8.8.8', '2001:db8:9::1', 'fd7a:115c::1', '10.0.0.5', '192.168.1.20', '2001:db8:1:2::20', '127.0.0.1', '192.168.1.20'],
    local,
  );
  assert.deepEqual(ranked, [
    '127.0.0.1',          // loopback
    '192.168.1.20',       // misma /24 que una interfaz nuestra
    '2001:db8:1:2::20',   // misma /64 que una interfaz nuestra
    '10.0.0.5',           // privada IPv4
    'fd7a:115c::1',       // unica local IPv6 (VPN, LAN)
    '2001:db8:9::1',      // global IPv6
    '8.8.8.8',            // publica IPv4
  ]);
  // Sin duplicados: cada IP se sondea una vez.
  assert.equal(new Set(ranked).size, ranked.length);
});

test('isLocalAddress entiende IPv4 por socket dual (::ffff:) y las privadas IPv6', () => {
  assert.equal(plainAddress('::ffff:192.168.1.5'), '192.168.1.5');
  assert.equal(plainAddress('2001:db8::1'), '2001:db8::1');
  for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '192.168.0.9', '::ffff:10.1.2.3', '172.16.0.1', '172.31.255.1', 'fd7a:115c:a1e0::1', 'FC00::1']) {
    assert.ok(isLocalAddress(ip), `${ip} deberia ser local`);
  }
  for (const ip of ['8.8.8.8', '::ffff:8.8.8.8', '2001:db8::1', '172.15.0.1', '172.32.0.1', undefined]) {
    assert.ok(!isLocalAddress(ip), `${ip} no deberia ser local`);
  }
});

test('las candidatas IPv6 no llevan enlace local ni indice de zona', () => {
  // Una `fe80::…%eth0` no sirve en el otro extremo: el indice es de esta
  // maquina. Y sin el indice, tampoco.
  assert.ok(isLinkLocalV6('fe80::1'));
  assert.ok(isLinkLocalV6('FEBF::1'));
  assert.ok(!isLinkLocalV6('fec0::1'));
  for (const ip of getLocalIPv6s()) {
    assert.ok(ip.includes(':'), `${ip} no es IPv6`);
    assert.ok(!ip.includes('%'), `${ip} lleva indice de zona`);
    assert.ok(!isLinkLocalV6(ip), `${ip} es de enlace`);
    assert.notEqual(ip, '::1');
  }
  // La oferta lleva primero las IPv4: un receptor viejo de red solo IPv4 las
  // sondea antes y no pierde tiempo.
  const all = getCandidateIPs();
  const firstV6 = all.findIndex((ip) => ip.includes(':'));
  const lastV4 = all.map((ip) => ip.includes('.')).lastIndexOf(true);
  assert.ok(firstV6 === -1 || lastV4 < firstV6);
});

test('listenAnyFamily acepta conexiones por IPv6 y por IPv4 en el mismo puerto', async (t) => {
  if (!await hasLoopbackV6()) { t.skip('sin IPv6 en este sistema'); return; }
  const server = net.createServer((s) => s.end('hola'));
  await listenAnyFamily(server, 0);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  for (const host of ['::1', '127.0.0.1']) {
    const got = await new Promise((resolve, reject) => {
      const c = net.connect({ host, port });
      let data = '';
      c.on('data', (d) => { data += d; });
      c.on('end', () => resolve(data));
      c.on('error', reject);
    });
    assert.equal(got, 'hola', `por ${host}`);
  }
});

test('el sondeo escalonado conecta por una IPv6 y la transferencia va por ella', async (t) => {
  if (!await hasLoopbackV6()) { t.skip('sin IPv6 en este sistema'); return; }
  const body = crypto.randomBytes(256 * 1024);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drop-ipv6-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const src = path.join(dir, 'v6.bin');
  fs.writeFileSync(src, body);
  const code = newCode(randomRoomId(crypto.randomBytes), crypto.randomBytes);

  const server = createSenderServer([{ path: src, size: body.length }], code, null, null);
  await listenAnyFamily(server, 0);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();

  // Solo la IPv6 en la oferta: es lo que veria un receptor en una red sin IPv4.
  const probe = await probeCandidateIPs(rankCandidates(['::1']), port, 2500);
  assert.ok(probe, 'la IPv6 no ha respondido al sondeo');
  assert.equal(probe.ip, '::1');
  probe.socket.destroy();

  const out = path.join(dir, 'out');
  fs.mkdirSync(out);
  const received = await receiveFiles(probe.ip, port, code, out);
  assert.ok(received[0].verified);
  assert.equal(sha256(fs.readFileSync(path.join(out, 'v6.bin'))), sha256(body));
});
