import dgram from 'node:dgram';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';

const STUN_BINDING_REQUEST = 0x0001;
const STUN_BINDING_RESPONSE = 0x0101;
const STUN_MAGIC_COOKIE = 0x2112a442;
const ATTR_MAPPED_ADDRESS = 0x0001;
const ATTR_XOR_MAPPED_ADDRESS = 0x0020;

export const DEFAULT_STUN_SERVERS = [
  { host: 'stun.l.google.com', port: 19302 },
  { host: 'stun1.l.google.com', port: 19302 },
  { host: 'stun.cloudflare.com', port: 3478 },
];

/**
 * Construye una peticion STUN Binding Request (RFC 5389, 20 bytes).
 */
export function buildBindingRequest(transactionId = crypto.randomBytes(12)) {
  if (!Buffer.isBuffer(transactionId) || transactionId.length !== 12) {
    throw new Error('transactionId STUN debe tener 12 bytes');
  }
  const buf = Buffer.alloc(20);
  buf.writeUInt16BE(STUN_BINDING_REQUEST, 0);
  buf.writeUInt16BE(0, 2);
  buf.writeUInt32BE(STUN_MAGIC_COOKIE, 4);
  transactionId.copy(buf, 8);
  return buf;
}

function formatAddress(family, raw) {
  if (family === 1 && raw.length === 4) {
    return `${raw[0]}.${raw[1]}.${raw[2]}.${raw[3]}`;
  }
  if (family === 2 && raw.length === 16) {
    const groups = [];
    for (let i = 0; i < 16; i += 2) {
      groups.push(raw.readUInt16BE(i).toString(16));
    }
    // `new URL` normaliza al formato RFC 5952 (comprime `::`) sin escribirlo a mano.
    return new URL(`http://[${groups.join(':')}]`).hostname.slice(1, -1);
  }
  return null;
}

function parseAddressAttr(val, xor, transactionId) {
  if (val.length < 4) return null;
  const family = val[1];
  const addrLen = family === 1 ? 4 : family === 2 ? 16 : 0;
  if (!addrLen || val.length < 4 + addrLen) return null;

  const rawPort = val.readUInt16BE(2);
  const port = xor ? (rawPort ^ (STUN_MAGIC_COOKIE >>> 16)) : rawPort;

  const rawAddr = Buffer.from(val.subarray(4, 4 + addrLen));
  if (xor) {
    const mask = Buffer.alloc(16);
    mask.writeUInt32BE(STUN_MAGIC_COOKIE, 0);
    transactionId.copy(mask, 4);
    for (let i = 0; i < addrLen; i++) rawAddr[i] ^= mask[i];
  }

  const ip = formatAddress(family, rawAddr);
  return ip ? { ip, port } : null;
}

/**
 * Lee una respuesta STUN Binding Success (RFC 5389) y devuelve `{ ip, port }`.
 * Prefiere `XOR-MAPPED-ADDRESS` (lo que pasan los NAT sin corromper) y cae a
 * `MAPPED-ADDRESS` si el servidor es antiguo.
 */
export function parseBindingResponse(buf, transactionId) {
  if (!Buffer.isBuffer(buf) || buf.length < 20) return null;
  if (buf.readUInt16BE(0) !== STUN_BINDING_RESPONSE) return null;
  if (buf.readUInt32BE(4) !== STUN_MAGIC_COOKIE) return null;
  if (transactionId && !buf.subarray(8, 20).equals(transactionId)) return null;

  const msgLen = buf.readUInt16BE(2);
  const end = Math.min(buf.length, 20 + msgLen);
  let offset = 20;
  let fallback = null;

  while (offset + 4 <= end) {
    const attrType = buf.readUInt16BE(offset);
    const attrLen = buf.readUInt16BE(offset + 2);
    const valStart = offset + 4;
    if (valStart + attrLen > end) break;
    const val = buf.subarray(valStart, valStart + attrLen);

    if (attrType === ATTR_XOR_MAPPED_ADDRESS) {
      const parsed = parseAddressAttr(val, true, buf.subarray(8, 20));
      if (parsed) return parsed;
    } else if (attrType === ATTR_MAPPED_ADDRESS && !fallback) {
      fallback = parseAddressAttr(val, false, buf.subarray(8, 20));
    }

    offset = valStart + ((attrLen + 3) & ~3);
  }
  return fallback;
}

/**
 * Acepta `host:port`, `stun:host:port` o `[ipv6]:port`.
 */
export function parseStunServer(spec) {
  if (spec && typeof spec === 'object' && spec.host) {
    return { host: spec.host, port: Number(spec.port) || 3478 };
  }
  const clean = String(spec || '').trim().replace(/^stun:/i, '');
  if (!clean) return null;
  const v6 = clean.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (v6) return { host: v6[1], port: Number(v6[2]) || 3478 };
  const idx = clean.lastIndexOf(':');
  if (idx > 0 && /^\d+$/.test(clean.slice(idx + 1))) {
    return { host: clean.slice(0, idx), port: Number(clean.slice(idx + 1)) };
  }
  return { host: clean, port: 3478 };
}

function resolveConfiguredServers(servers) {
  if (servers?.length) return servers.map(parseStunServer).filter(Boolean);
  if (process.env.DROP_STUN_SERVER) {
    const custom = process.env.DROP_STUN_SERVER.split(',').map(parseStunServer).filter(Boolean);
    if (custom.length) return custom;
  }
  return DEFAULT_STUN_SERVERS;
}

/**
 * Consulta un servidor STUN concreto por UDP y devuelve `{ ip, port, server }` o `null`.
 */
export async function queryStun(server, { timeoutMs = 1200, family = 4, signal = null } = {}) {
  const target = parseStunServer(server);
  if (!target || signal?.aborted) return null;

  let resolvedHost = target.host;
  try {
    const res = await dns.lookup(target.host, { family });
    resolvedHost = res.address;
  } catch {
    return null;
  }
  if (signal?.aborted) return null;

  return new Promise((resolve) => {
    const socket = dgram.createSocket(family === 6 ? 'udp6' : 'udp4');
    const txId = crypto.randomBytes(12);
    const req = buildBindingRequest(txId);
    let done = false;

    const onAbort = () => finish(null);
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      try { socket.close(); } catch {}
      resolve(result);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    socket.on('error', () => finish(null));
    socket.on('message', (msg) => {
      const parsed = parseBindingResponse(msg, txId);
      if (parsed) finish({ ...parsed, server: `${target.host}:${target.port}` });
    });

    socket.send(req, 0, req.length, target.port, resolvedHost, (err) => {
      if (err) finish(null);
    });
  });
}

/**
 * Descubre la IP publica (IPv4) mediante STUN para incluirla en `cli-offer`
 * cuando UPnP no responde o la senalizacion entro por IPv6. Nunca lanza y
 * respeta `DROP_NO_STUN` y `DROP_STUN_SERVER`.
 */
export async function discoverPublicIp({ servers, timeoutMs = 1200 } = {}) {
  if (process.env.DROP_NO_STUN) return null;
  const list = resolveConfiguredServers(servers);
  if (!list.length) return null;

  // Se lanzan a la vez y gana la primera respuesta valida; se abortan las
  // demas de inmediato para no dejar sockets UDP ni timers colgados.
  const ac = new AbortController();
  return new Promise((resolve) => {
    let settled = false;
    let pending = list.length;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ac.abort();
      resolve(result);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);

    for (const s of list) {
      queryStun(s, { timeoutMs, signal: ac.signal }).then((res) => {
        if (res) return finish(res);
        pending--;
        if (pending <= 0) finish(null);
      });
    }
  });
}

/**
 * Reune las IPs candidatas para `cli-offer` / `cli-speed-offer` combinando IPs
 * locales, UPnP, STUN y la IP vista por el servidor de senalizacion.
 */
export async function resolveOfferCandidates({
  localIPs = [],
  upnpResult = null,
  upnpPromise = null,
  stunResult = null,
  stunPromise = null,
  wsPublicIp = null,
  forceRelay = false,
  timeoutMs = 2000,
} = {}) {
  if (forceRelay) {
    return { candidateIps: [], upnp: null, stun: null };
  }

  const waitBounded = (promise, ms) => (
    promise
      ? Promise.race([promise, new Promise((r) => setTimeout(() => r(null), ms))])
      : Promise.resolve(null)
  );

  const [upnp, stun] = await Promise.all([
    upnpResult ? Promise.resolve(upnpResult) : waitBounded(upnpPromise, timeoutMs),
    stunResult ? Promise.resolve(stunResult) : waitBounded(stunPromise, Math.min(timeoutMs, 1000)),
  ]);

  const candidateIps = [...localIPs];
  for (const ip of [upnp?.publicIp, stun?.ip, wsPublicIp]) {
    if (ip && !candidateIps.includes(ip)) candidateIps.push(ip);
  }

  return { candidateIps, upnp, stun };
}
