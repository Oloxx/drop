// STUN por UDP (RFC 5389) para descubrir la IP publica IPv4 aunque UPnP no
// responda o la senalizacion haya entrado por IPv6.
import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { startServer, open, cliSpawnTarget } from './helpers.mjs';

const STUN_MAGIC_COOKIE = 0x2112a442;

function buildStunResponse(txId, { ip, port, xor = true, v6 = false }) {
  const addrBytes = v6
    ? Buffer.from(ip.split(':').flatMap((g) => {
      const n = parseInt(g || '0', 16);
      return [(n >> 8) & 0xff, n & 0xff];
    }))
    : Buffer.from(ip.split('.').map(Number));

  const attrLen = 4 + addrBytes.length;
  const attr = Buffer.alloc(4 + attrLen);
  attr.writeUInt16BE(xor ? 0x0020 : 0x0001, 0);
  attr.writeUInt16BE(attrLen, 2);
  attr[4] = 0;
  attr[5] = v6 ? 2 : 1;
  attr.writeUInt16BE(xor ? (port ^ (STUN_MAGIC_COOKIE >>> 16)) : port, 6);

  if (xor) {
    const mask = Buffer.alloc(16);
    mask.writeUInt32BE(STUN_MAGIC_COOKIE, 0);
    txId.copy(mask, 4);
    for (let i = 0; i < addrBytes.length; i++) addrBytes[i] ^= mask[i];
  }
  addrBytes.copy(attr, 8);

  const header = Buffer.alloc(20);
  header.writeUInt16BE(0x0101, 0);
  header.writeUInt16BE(attr.length, 2);
  header.writeUInt32BE(STUN_MAGIC_COOKIE, 4);
  txId.copy(header, 8);
  return Buffer.concat([header, attr]);
}

async function startMockStun(t, handler) {
  const sock = dgram.createSocket('udp4');
  await new Promise((resolve) => sock.bind(0, '127.0.0.1', resolve));
  t.after(() => { try { sock.close(); } catch {} });
  sock.on('message', (msg, rinfo) => handler(sock, msg, rinfo));
  return { host: '127.0.0.1', port: sock.address().port };
}

test('`drop send` incluye en `cli-offer` la IP descubierta por STUN sin UPnP', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());

  const stun = await startMockStun(t, (sock, msg, rinfo) => {
    const txId = msg.subarray(8, 20);
    const resp = buildStunResponse(txId, { ip: '198.51.100.88', port: rinfo.port });
    sock.send(resp, rinfo.port, rinfo.address);
  });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drop-stun-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'hola.txt');
  fs.writeFileSync(file, 'hola');

  const [cmd, cmdArgs] = cliSpawnTarget(['send', file, '-s', srv.http, '--no-qr']);
  const sender = spawn(cmd, cmdArgs, {
    env: {
      ...process.env,
      DROP_NO_UPNP: '1',
      DROP_STUN_SERVER: `127.0.0.1:${stun.port}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { try { sender.kill(); } catch {} });

  let out = '';
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`sender no dio codigo:\n${out}`)), 10_000);
    sender.stdout.on('data', (d) => {
      out += d.toString();
      const m = out.match(/\b(\d{4}-[a-z]+-[a-z]+-[a-z]+-[a-z]+)\b/);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    sender.stderr.on('data', (d) => { out += d.toString(); });
    sender.on('exit', (c) => { clearTimeout(timer); reject(new Error(`sender salio (${c}):\n${out}`)); });
  });

  const roomId = code.split('-')[0];
  const guest = await open(srv.ws);
  t.after(() => guest.close());
  guest.say({ t: 'join', token: roomId, name: 'cli' });
  const joined = await guest.until((m) => m.t === 'joined');
  assert.ok(joined.guestId);
  const sig = await guest.until((m) => m.t === 'signal' && m.data?.type === 'cli-offer');
  assert.ok(sig.data.ips.includes('198.51.100.88'), `esperaba IP STUN en ${JSON.stringify(sig.data.ips)}`);
});
