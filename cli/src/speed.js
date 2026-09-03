import net from 'node:net';
import crypto from 'node:crypto';
import { c, fmtBytes, fmtSpeed, fmtDuration, fmtMs } from './ui.js';
import { deriveKey, encryptChunk, decryptChunk } from './crypto.js';
import { getLocalIPs, startBroadcasting, listenForLAN } from './discovery.js';
import { connectSignaling, createRoom, joinRoom } from './signaling.js';

const TCP_CHUNK_SIZE = 256 * 1024;    // 256 KB por bloque para máxima velocidad en TCP
const RELAY_CHUNK_SIZE = 64 * 1024;   // 64 KB por bloque para streaming óptimo en WebSocket
const DUMMY_RAW_TCP = Buffer.alloc(TCP_CHUNK_SIZE, 0x5a);
const DUMMY_RAW_RELAY = Buffer.alloc(RELAY_CHUNK_SIZE, 0x5a);

/**
 * Empaqueta un buffer con prefijo de longitud de 4 bytes (UInt32BE)
 */
function frame(buf) {
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(buf.length, 0);
  return Buffer.concat([header, buf]);
}

/**
 * Genera un conjunto rotativo de paquetes cifrados para evitar recalcular
 * AES-GCM repetidamente durante el bucle de envío y maximizar la saturación del ancho de banda.
 */
function createTcpPacketPool(key, count = 8) {
  const pool = [];
  for (let i = 0; i < count; i++) {
    const data = Buffer.concat([Buffer.from([1]), DUMMY_RAW_TCP]);
    const enc = encryptChunk(data, key);
    pool.push(frame(enc));
  }
  return pool;
}

function createRelayPacketPool(guestId, isHost, count = 8) {
  const pool = [];
  for (let i = 0; i < count; i++) {
    if (isHost) {
      const header = Buffer.allocUnsafe(4);
      header.writeUInt32BE(guestId, 0);
      pool.push(Buffer.concat([header, DUMMY_RAW_RELAY]));
    } else {
      pool.push(DUMMY_RAW_RELAY);
    }
  }
  return pool;
}

/**
 * Canal de prueba de velocidad sobre conexión TCP directa
 */
export class TcpSpeedChannel {
  constructor(socket, token, isHost, pathDesc) {
    this.socket = socket;
    this.token = token;
    this.key = deriveKey(token);
    this.isHost = isHost;
    this.pathDesc = pathDesc;
    this.type = 'tcp';
    this.controlListeners = new Set();
    this.onPayloadHandler = null;
    this.closeListeners = new Set();
    this.buffer = Buffer.alloc(0);
    this.isClosed = false;
    this.packetPool = createTcpPacketPool(this.key, 8);
    this.poolIndex = 0;

    socket.setNoDelay(true);
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => this._handleClose());
    socket.on('error', () => this._handleClose());
  }

  _handleClose() {
    if (this.isClosed) return;
    this.isClosed = true;
    for (const fn of [...this.closeListeners]) {
      try { fn(); } catch {}
    }
  }

  _onData(chunk) {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const len = this.buffer.readUInt32BE(0);
      if (this.buffer.length < 4 + len) break;
      const packet = this.buffer.subarray(4, 4 + len);
      this.buffer = this.buffer.subarray(4 + len);

      try {
        const decrypted = decryptChunk(packet, this.key);
        if (!decrypted.length) continue;
        const type = decrypted[0];

        if (type === 0) { // Control JSON
          const payload = decrypted.subarray(1);
          const msg = JSON.parse(payload.toString('utf-8'));
          for (const listener of [...this.controlListeners]) {
            try { listener(msg); } catch {}
          }
        } else if (type === 1) { // Payload
          if (this.onPayloadHandler) {
            this.onPayloadHandler(decrypted.length - 1);
          }
        }
      } catch {}
    }

    if (this.buffer.length === 0) {
      this.buffer = Buffer.alloc(0);
    } else if (this.buffer.length < 4) {
      this.buffer = Buffer.from(this.buffer);
    }
  }

  sendControl(obj) {
    if (this.isClosed || this.socket.destroyed) return;
    try {
      const jsonBuf = Buffer.from(JSON.stringify(obj), 'utf-8');
      const data = Buffer.concat([Buffer.from([0]), jsonBuf]);
      const enc = encryptChunk(data, this.key);
      const framed = frame(enc);
      this.socket.write(framed);
    } catch {}
  }

  async sendPayload() {
    if (this.isClosed || this.socket.destroyed) return false;
    const packet = this.packetPool[this.poolIndex++ % this.packetPool.length];
    try {
      if (!this.socket.write(packet)) {
        await new Promise((resolve) => {
          const onDrain = () => { cleanup(); resolve(); };
          const onClose = () => { cleanup(); resolve(); };
          const cleanup = () => {
            this.socket.removeListener('drain', onDrain);
            this.socket.removeListener('close', onClose);
            this.socket.removeListener('error', onClose);
          };
          this.socket.once('drain', onDrain);
          this.socket.once('close', onClose);
          this.socket.once('error', onClose);
        });
      }
      return !this.isClosed && !this.socket.destroyed;
    } catch {
      return false;
    }
  }

  async drain() {
    if (this.isClosed || this.socket.destroyed) return;
    if (this.socket.writableLength > 0) {
      await new Promise((resolve) => {
        const onDrain = () => { cleanup(); resolve(); };
        const onClose = () => { cleanup(); resolve(); };
        const timer = setTimeout(() => { cleanup(); resolve(); }, 3000);
        const cleanup = () => {
          clearTimeout(timer);
          this.socket.removeListener('drain', onDrain);
          this.socket.removeListener('close', onClose);
          this.socket.removeListener('error', onClose);
        };
        this.socket.once('drain', onDrain);
        this.socket.once('close', onClose);
        this.socket.once('error', onClose);
      });
    }
  }

  onControl(fn) {
    this.controlListeners.add(fn);
    return () => this.controlListeners.delete(fn);
  }

  onPayload(fn) {
    this.onPayloadHandler = fn;
  }

  onClose(fn) {
    this.closeListeners.add(fn);
  }

  close() {
    this.isClosed = true;
    try { this.socket.destroy(); } catch {}
  }
}

/**
 * Canal de prueba de velocidad sobre WebSocket Relay (servidor de señalización)
 */
export class RelaySpeedChannel {
  constructor(ws, guestId, isHost, pathDesc) {
    this.ws = ws;
    this.guestId = guestId;
    this.isHost = isHost;
    this.pathDesc = pathDesc;
    this.type = 'relay';
    this.controlListeners = new Set();
    this.onPayloadHandler = null;
    this.closeListeners = new Set();
    this.isClosed = false;
    this.packetPool = createRelayPacketPool(guestId, isHost, 8);
    this.poolIndex = 0;

    ws.binaryType = 'arraybuffer';
    this._onMsg = (ev) => this._onMessage(ev);
    this._onCls = () => this._handleClose();
    ws.addEventListener('message', this._onMsg);
    ws.addEventListener('close', this._onCls);
    ws.addEventListener('error', this._onCls);
  }

  _handleClose() {
    if (this.isClosed) return;
    this.isClosed = true;
    for (const fn of [...this.closeListeners]) {
      try { fn(); } catch {}
    }
  }

  _onMessage(ev) {
    if (typeof ev.data !== 'string') {
      let byteLen = 0;
      if (Buffer.isBuffer(ev.data)) {
        byteLen = ev.data.length;
      } else if (ev.data instanceof ArrayBuffer) {
        byteLen = ev.data.byteLength;
      }
      if (this.onPayloadHandler) {
        this.onPayloadHandler(byteLen);
      }
      return;
    }

    try {
      const msg = JSON.parse(ev.data);
      if (msg.t === 'signal' && msg.data) {
        for (const listener of [...this.controlListeners]) {
          try { listener(msg.data); } catch {}
        }
      }
    } catch {}
  }

  sendControl(obj) {
    if (this.isClosed || this.ws.readyState !== 1) return;
    try {
      const payload = {
        t: 'signal',
        ...(this.isHost ? { to: this.guestId } : {}),
        data: obj
      };
      this.ws.send(JSON.stringify(payload));
    } catch {}
  }

  async sendPayload() {
    if (this.isClosed || this.ws.readyState !== 1) return false;
    const packet = this.packetPool[this.poolIndex++ % this.packetPool.length];
    while (this.ws.readyState === 1 && this.ws.bufferedAmount > 2 * 1024 * 1024) {
      await new Promise((r) => setTimeout(r, 10));
    }
    if (this.ws.readyState !== 1) return false;
    try {
      this.ws.send(packet);
      return true;
    } catch {
      return false;
    }
  }

  async drain() {
    const t0 = performance.now();
    while (this.ws.readyState === 1 && this.ws.bufferedAmount > 0 && performance.now() - t0 < 3000) {
      await new Promise((r) => setTimeout(r, 15));
    }
  }

  onControl(fn) {
    this.controlListeners.add(fn);
    return () => this.controlListeners.delete(fn);
  }

  onPayload(fn) {
    this.onPayloadHandler = fn;
  }

  onClose(fn) {
    this.closeListeners.add(fn);
  }

  close() {
    this.isClosed = true;
    try {
      this.ws.removeEventListener('message', this._onMsg);
      this.ws.removeEventListener('close', this._onCls);
      this.ws.removeEventListener('error', this._onCls);
      this.ws.close();
    } catch {}
  }
}

// ------------------------------------------------------------------ Renderizado UI

export function renderSpeedBar(direction, currentSec, totalSec, speedBps, bytesTransferred) {
  const cols = process.stdout.columns || 80;
  const barWidth = Math.max(10, Math.min(24, cols - 66));
  const pct = totalSec > 0 ? Math.min(1, currentSec / totalSec) : 0;
  const filled = Math.round(barWidth * pct);
  const empty = barWidth - filled;
  const bar = `${c.cyan}${'█'.repeat(filled)}${c.dim}${'░'.repeat(empty)}${c.reset}`;
  const pctStr = `${Math.round(pct * 100)}%`.padStart(4);
  const timeStr = `${currentSec.toFixed(1)}s / ${totalSec.toFixed(1)}s`;
  const speedStr = fmtSpeed(speedBps);
  const bytesStr = fmtBytes(bytesTransferred);
  const dirTag = direction === 'outbound'
    ? `${c.yellow}Subida (outbound)${c.reset}`
    : `${c.magenta}Bajada (inbound) ${c.reset}`;

  process.stdout.write(`\r  ${dirTag} ${bar} ${pctStr} · ${timeStr} · ${speedStr} · ${bytesStr}   \x1b[K`);
}

export function renderSpeedBarComplete(direction, avgSpeedBps, totalBytes, totalSec) {
  const dirTag = direction === 'outbound'
    ? `${c.green}✔ Subida (outbound)${c.reset}`
    : `${c.green}✔ Bajada (inbound) ${c.reset}`;
  const speedStr = fmtSpeed(avgSpeedBps);
  const bytesStr = fmtBytes(totalBytes);
  const durStr = `${totalSec.toFixed(1)}s`;
  process.stdout.write(`\r  ${dirTag} ${speedStr} · ${bytesStr} transferidos en ${durStr}   \x1b[K\n`);
}

export function printSpeedReport({ pathDesc, rttMs, outRate, inRate, outBytes, inBytes, outSec, inSec }) {
  const isDirect = !pathDesc.toLowerCase().includes('relay');
  const pathTag = isDirect ? `${c.green}${pathDesc}${c.reset}` : `${c.yellow}${pathDesc}${c.reset}`;
  const rttStr = `${c.cyan}${fmtMs(rttMs)}${c.reset}`;
  const outStr = `${fmtSpeed(outRate)} ${c.dim}(${fmtBytes(outBytes)} en ${outSec.toFixed(1)}s)${c.reset}`;
  const inStr = `${fmtSpeed(inRate)} ${c.dim}(${fmtBytes(inBytes)} en ${inSec.toFixed(1)}s)${c.reset}`;

  console.log(`\n${c.bold}================================================================${c.reset}`);
  console.log(`  ${c.cyan}drop speed${c.reset} — ${c.bold}Resultados del Test de Conexión P2P${c.reset}`);
  console.log(`${c.bold}================================================================${c.reset}`);
  console.log(`  ${c.bold}Ruta de red:${c.reset}       ${pathTag}`);
  console.log(`  ${c.bold}Latencia (RTT):${c.reset}    ${rttStr}`);
  console.log(`  ${c.bold}Subida (outbound):${c.reset} ${outStr}`);
  console.log(`  ${c.bold}Bajada (inbound):${c.reset}  ${inStr}`);
  console.log(`${c.bold}----------------------------------------------------------------${c.reset}`);
  if (isDirect) {
    console.log(`  ${c.green}✔ Conexión directa P2P nativa a máxima velocidad.${c.reset}`);
    console.log(`    ${c.dim}Los datos viajan directamente entre ambos clientes mediante sockets TCP.${c.reset}`);
  } else {
    console.log(`  ${c.yellow}⚠ Conexión enrutada a través del servidor de retransmisión (Relay).${c.reset}`);
    console.log(`    ${c.dim}Las restricciones de NAT/firewall impidieron una conexión TCP directa.${c.reset}`);
  }
  console.log(`${c.bold}================================================================${c.reset}\n`);
}

// ----------------------------------------------------------- Ejecución del Test

export async function runSpeedTest(channel, isHost, durationSec = 5) {
  const results = {
    pathDesc: channel.pathDesc,
    rttMs: null,
    outRate: 0,
    inRate: 0,
    outBytes: 0,
    inBytes: 0,
    outSec: 0,
    inSec: 0,
  };

  let rxBytes = 0;
  let rxStart = 0;
  let lastReport = 0;
  let lastBytes = 0;
  let smoothedSpeed = 0;
  let isReceiving = false;
  let testFinished = false;

  channel.onClose(() => {
    if (!testFinished) {
      console.error(`\n\n  ${c.red}✖ El otro cliente CLI se ha desconectado antes de completar el test.${c.reset}\n`);
      process.exit(1);
    }
  });

  channel.onPayload((bytes) => {
    if (!isReceiving) return;
    if (!rxStart) {
      rxStart = performance.now();
      lastReport = rxStart;
      lastBytes = 0;
      smoothedSpeed = 0;
    }
    rxBytes += bytes;

    const now = performance.now();
    const dt = (now - lastReport) / 1000;
    if (dt >= 0.15) {
      const inst = (rxBytes - lastBytes) / dt;
      smoothedSpeed = smoothedSpeed ? smoothedSpeed * 0.7 + inst * 0.3 : inst;
      lastBytes = rxBytes;
      lastReport = now;
      const elapsed = (now - rxStart) / 1000;
      channel.sendControl({ k: 'tick', rate: smoothedSpeed, elapsed, bytes: rxBytes });
      renderSpeedBar('inbound', elapsed, durationSec, smoothedSpeed, rxBytes);
    }
  });

  channel.onControl((msg) => {
    if (msg.k === 'tick') {
      renderSpeedBar('outbound', msg.elapsed, durationSec, msg.rate, msg.bytes);
    }
  });

  async function streamPhase(dir) {
    channel.sendControl({ k: 'incoming', dir, duration: durationSec });
    renderSpeedBar('outbound', 0, durationSec, 0, 0);

    const until = performance.now() + durationSec * 1000;
    while (performance.now() < until && !channel.isClosed) {
      const ok = await channel.sendPayload();
      if (!ok) break;
    }

    await channel.drain();
    channel.sendControl({ k: 'sent-done', dir });
  }

  if (isHost) {
    // 1. Latencia (RTT) mediante pings
    process.stdout.write(`  ${c.dim}Midiendo latencia de red (RTT)...${c.reset}`);
    const PINGS = 10;
    const rtts = [];

    for (let i = 0; i < PINGS; i++) {
      const t0 = performance.now();
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 1000);
        const unsub = channel.onControl((msg) => {
          if (msg.k === 'pong' && msg.seq === i) {
            clearTimeout(timer);
            unsub();
            rtts.push(performance.now() - t0);
            resolve();
          }
        });
        channel.sendControl({ k: 'ping', seq: i });
      });
      await new Promise((r) => setTimeout(r, 25));
    }

    const minRtt = rtts.length ? Math.min(...rtts) : 1;
    results.rttMs = minRtt;
    channel.sendControl({ k: 'rtt', ms: minRtt });
    process.stdout.write(`\r  ${c.bold}Latencia (RTT):${c.reset} ${c.cyan}${fmtMs(minRtt)}${c.reset}\n\n`);

    // 2. Fase 1: Host emite (h2g) -> Outbound para Host
    let resolveH2G;
    const h2gPromise = new Promise((r) => { resolveH2G = r; });
    const unsubH2G = channel.onControl((msg) => {
      if (msg.k === 'result' && msg.dir === 'h2g') {
        unsubH2G();
        resolveH2G(msg);
      }
    });

    await streamPhase('h2g');
    const h2gResult = await h2gPromise;

    results.outRate = h2gResult.rate;
    results.outBytes = h2gResult.bytes;
    results.outSec = h2gResult.duration;
    renderSpeedBarComplete('outbound', h2gResult.rate, h2gResult.bytes, h2gResult.duration);

    await new Promise((r) => setTimeout(r, 200));

    // 3. Fase 2: Guest emite (g2h) -> Inbound para Host
    let resolveIncoming;
    const incomingPromise = new Promise((r) => { resolveIncoming = r; });
    let resolveSentDone;
    const sentDonePromise = new Promise((r) => { resolveSentDone = r; });

    const unsubPhase2 = channel.onControl((msg) => {
      if (msg.k === 'incoming' && msg.dir === 'g2h') {
        rxBytes = 0;
        rxStart = 0;
        lastReport = 0;
        lastBytes = 0;
        smoothedSpeed = 0;
        isReceiving = true;
        renderSpeedBar('inbound', 0, durationSec, 0, 0);
        resolveIncoming();
      } else if (msg.k === 'sent-done' && msg.dir === 'g2h') {
        isReceiving = false;
        resolveSentDone();
      }
    });

    await incomingPromise;
    await sentDonePromise;
    unsubPhase2();

    const totalSec = Math.max(0.001, (performance.now() - rxStart) / 1000);
    const avgRate = rxBytes / totalSec;
    results.inRate = avgRate;
    results.inBytes = rxBytes;
    results.inSec = totalSec;

    channel.sendControl({ k: 'result', dir: 'g2h', rate: avgRate, bytes: rxBytes, duration: totalSec });
    renderSpeedBarComplete('inbound', avgRate, rxBytes, totalSec);

    // Pequeño retardo antes de finished para asegurar que el receptor procesó el resultado
    await new Promise((r) => setTimeout(r, 50));
    channel.sendControl({ k: 'finished' });
  } else {
    // Si somos Guest:
    channel.onControl((msg) => {
      if (msg.k === 'ping') {
        channel.sendControl({ k: 'pong', seq: msg.seq });
      } else if (msg.k === 'rtt') {
        results.rttMs = msg.ms;
        console.log(`  ${c.bold}Latencia (RTT):${c.reset} ${c.cyan}${fmtMs(msg.ms)}${c.reset}\n`);
      }
    });

    // 1. Fase 1: Host emite (h2g) -> Inbound para Guest
    let resolveIncomingH2G;
    const incomingH2GPromise = new Promise((r) => { resolveIncomingH2G = r; });
    let resolveSentDoneH2G;
    const sentDoneH2GPromise = new Promise((r) => { resolveSentDoneH2G = r; });

    const unsubPhase1Guest = channel.onControl((msg) => {
      if (msg.k === 'incoming' && msg.dir === 'h2g') {
        rxBytes = 0;
        rxStart = 0;
        lastReport = 0;
        lastBytes = 0;
        smoothedSpeed = 0;
        isReceiving = true;
        renderSpeedBar('inbound', 0, durationSec, 0, 0);
        resolveIncomingH2G();
      } else if (msg.k === 'sent-done' && msg.dir === 'h2g') {
        isReceiving = false;
        resolveSentDoneH2G();
      }
    });

    await incomingH2GPromise;
    await sentDoneH2GPromise;
    unsubPhase1Guest();

    const totalSec = Math.max(0.001, (performance.now() - rxStart) / 1000);
    const avgRate = rxBytes / totalSec;
    results.inRate = avgRate;
    results.inBytes = rxBytes;
    results.inSec = totalSec;
    channel.sendControl({ k: 'result', dir: 'h2g', rate: avgRate, bytes: rxBytes, duration: totalSec });
    renderSpeedBarComplete('inbound', avgRate, rxBytes, totalSec);

    await new Promise((r) => setTimeout(r, 200));

    // 2. Fase 2: Guest emite (g2h) -> Outbound para Guest
    let resolveG2HResult;
    const g2hResultPromise = new Promise((r) => { resolveG2HResult = r; });
    let resolveFinished;
    const finishedPromise = new Promise((r) => { resolveFinished = r; });

    const unsubPhase2Guest = channel.onControl((msg) => {
      if (msg.k === 'result' && msg.dir === 'g2h') {
        resolveG2HResult(msg);
      } else if (msg.k === 'finished') {
        resolveFinished();
      }
    });

    await streamPhase('g2h');
    const g2hResult = await g2hResultPromise;

    results.outRate = g2hResult.rate;
    results.outBytes = g2hResult.bytes;
    results.outSec = g2hResult.duration;
    renderSpeedBarComplete('outbound', g2hResult.rate, g2hResult.bytes, g2hResult.duration);

    await finishedPromise;
    unsubPhase2Guest();
  }

  testFinished = true;
  printSpeedReport(results);
}

// ------------------------------------------------------------- Modos Host y Guest

export async function runSpeedHost(options = {}) {
  const durationSec = Math.max(1, parseInt(options.time || 5, 10));
  const serverUrl = options.server || process.env.DROP_SERVER || 'https://drop.oloxx.dev';

  console.log(`\n${c.bold}================================================================${c.reset}`);
  console.log(`  ${c.cyan}drop speed${c.reset} — ${c.bold}Medidor de Velocidad de Transferencia P2P${c.reset}`);
  console.log(`${c.bold}================================================================${c.reset}\n`);

  let broadcaster = null;
  let ws = null;
  let token = null;

  const tcpServer = net.createServer();
  await new Promise((resolve) => tcpServer.listen(0, '0.0.0.0', resolve));
  const tcpPort = tcpServer.address().port;

  try {
    ws = await connectSignaling(serverUrl);
    token = await createRoom(ws);
  } catch (err) {
    token = Math.random().toString(36).slice(2, 10);
    console.log(`  ${c.yellow}Aviso: Sin conexión con el servidor. Operando en modo LAN local pura.${c.reset}`);
  }

  if (!options.relay) {
    broadcaster = startBroadcasting(token, tcpPort);
  }

  console.log(`  ${c.green}✔ Canal de prueba abierto.${c.reset}`);
  console.log(`  ${c.bold}Código:${c.reset}  ${c.cyan}${token}${c.reset}`);
  console.log(`  ${c.bold}Comando en el segundo cliente:${c.reset}`);
  console.log(`    ${c.yellow}drop speed ${token}${options.relay ? ' --relay' : ''}${c.reset}\n`);
  console.log(`  ${c.dim}Esperando a que el segundo cliente CLI se conecte...${c.reset}\n`);

  let activeChannel = null;

  const channel = await new Promise((resolve) => {
    let resolved = false;

    tcpServer.on('connection', (socket) => {
      if (resolved || options.relay) {
        socket.destroy();
        return;
      }
      socket.setNoDelay(true);

      const isLocal = socket.remoteAddress?.includes('127.0.0.1') || socket.remoteAddress?.includes('::1') || socket.remoteAddress?.startsWith('192.168.') || socket.remoteAddress?.startsWith('10.');
      const pathDesc = isLocal
        ? `Directa TCP (LAN/Loopback - ${socket.remoteAddress})`
        : `Directa TCP (${socket.remoteAddress})`;

      const ch = new TcpSpeedChannel(socket, token, true, pathDesc);

      // Esperar handshake 'hello' del cliente para validar el token
      const handshakeTimer = setTimeout(() => {
        ch.close();
      }, 3500);

      const unsub = ch.onControl((msg) => {
        if (msg.k === 'hello' && msg.token === token) {
          clearTimeout(handshakeTimer);
          unsub();
          ch.sendControl({ k: 'welcome' });
          resolved = true;
          if (broadcaster) broadcaster.stop();
          console.log(`  ${c.green}✔ Cliente conectado:${c.reset} ${pathDesc}\n`);
          resolve(ch);
        }
      });
    });

    if (ws) {
      const localIPs = getLocalIPs();
      ws.addEventListener('message', (ev) => {
        if (resolved) return;
        try {
          const msg = JSON.parse(ev.data);
          if (msg.t === 'guest') {
            ws.send(JSON.stringify({
              t: 'signal',
              to: msg.guestId,
              data: {
                type: 'cli-speed-offer',
                ips: localIPs,
                port: tcpPort,
              }
            }));
          } else if (msg.t === 'signal' && msg.data?.type === 'cli-speed-accept') {
            resolved = true;
            if (broadcaster) broadcaster.stop();
            try { tcpServer.close(); } catch {}
            const pathDesc = `Relay por servidor (${new URL(serverUrl).host})`;
            console.log(`  ${c.cyan}✔ Cliente conectado:${c.reset} ${pathDesc}\n`);
            ws.send(JSON.stringify({
              t: 'signal',
              to: msg.from,
              data: { type: 'cli-speed-ready' }
            }));
            resolve(new RelaySpeedChannel(ws, msg.from, true, pathDesc));
          }
        } catch {}
      });
    }
  });

  activeChannel = channel;

  const onExit = () => {
    if (broadcaster) broadcaster.stop();
    if (ws) try { ws.close(); } catch {}
    try { tcpServer.close(); } catch {}
    if (activeChannel) activeChannel.close();
    process.exit(0);
  };
  process.on('SIGINT', onExit);
  process.on('SIGTERM', onExit);

  try {
    await runSpeedTest(channel, true, durationSec);
  } finally {
    if (broadcaster) broadcaster.stop();
    if (ws) try { ws.close(); } catch {}
    try { tcpServer.close(); } catch {}
    channel.close();
  }
}

export async function runSpeedGuest(input, options = {}) {
  const token = input.includes('#') ? input.split('#')[1].trim() : input.trim();
  const durationSec = Math.max(1, parseInt(options.time || 5, 10));
  const serverUrl = options.server || process.env.DROP_SERVER || 'https://drop.oloxx.dev';
  const directOnly = options.directOnly || false;

  console.log(`\n${c.bold}================================================================${c.reset}`);
  console.log(`  ${c.cyan}drop speed${c.reset} — ${c.bold}Medidor de Velocidad de Transferencia P2P${c.reset}`);
  console.log(`${c.bold}================================================================${c.reset}\n`);

  console.log(`  ${c.dim}Buscando anfitrión para el código:${c.reset} ${c.cyan}${token}${c.reset}`);

  const forceRelay = options.relay || Boolean(process.env.DROP_FORCE_RELAY);

  // 1. Probar descubrimiento LAN directo en <1.2s si no se fuerza relay
  let target = null;
  if (!forceRelay) {
    process.stdout.write(`  ${c.dim}Explorando red local (LAN)...${c.reset}`);
    target = await listenForLAN(token, 1200);
  }

  if (target) {
    process.stdout.write(`\r${' '.repeat(70)}\r`);
    const pathDesc = `Directa TCP (LAN - ${target.host}:${target.port})`;
    console.log(`  ${c.green}✔ Anfitrión encontrado en red local:${c.reset} ${pathDesc}\n`);

    const socket = net.connect({ host: target.host, port: target.port });
    await new Promise((resolve, reject) => {
      socket.on('connect', resolve);
      socket.on('error', reject);
    });

    const channel = new TcpSpeedChannel(socket, token, false, pathDesc);

    // Handshake de autenticación con el anfitrión
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timeout en handshake de autenticación TCP')), 3500);
      const unsub = channel.onControl((msg) => {
        if (msg.k === 'welcome') {
          clearTimeout(timer);
          unsub();
          resolve();
        }
      });
      channel.sendControl({ k: 'hello', token });
    });

    const onExit = () => { channel.close(); process.exit(0); };
    process.on('SIGINT', onExit);
    process.on('SIGTERM', onExit);

    try {
      await runSpeedTest(channel, false, durationSec);
    } finally {
      channel.close();
    }
    return;
  }

  // 2. Conectar al servidor de señalización
  process.stdout.write(`\r${' '.repeat(70)}\r`);
  console.log(`  ${c.dim}No detectado en LAN directa, conectando por servidor de señalización...${c.reset}`);

  let ws = null;
  let offer = null;
  try {
    ws = await connectSignaling(serverUrl);
    ws.binaryType = 'arraybuffer';
    await joinRoom(ws, token);

    offer = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Tiempo de espera agotado esperando datos del anfitrión')), 10000);
      const onMsg = (ev) => {
        try {
          if (typeof ev.data !== 'string') return;
          const msg = JSON.parse(ev.data);
          if (msg.t === 'signal' && msg.data?.type === 'cli-speed-offer') {
            clearTimeout(timeout);
            ws.removeEventListener('message', onMsg);
            resolve(msg.data);
          }
        } catch {}
      };
      ws.addEventListener('message', onMsg);
    });
  } catch (err) {
    if (ws) ws.close();
    console.error(`\n  ${c.red}Error de conexión:${c.reset} ${err.message}\n`);
    process.exit(1);
  }

  const { ips = [], port } = offer;

  // 3. Probar si alguna IP responde por TCP directo si no se fuerza relay
  const localIPs = getLocalIPs();
  const candidateIP = !forceRelay ? (ips.find((rip) => {
    if (rip === '127.0.0.1' || rip === '::1') return true;
    const rsub = rip.split('.').slice(0, 3).join('.');
    return localIPs.some((lip) => lip.split('.').slice(0, 3).join('.') === rsub);
  }) || ips[0]) : null;

  let tcpSocket = null;
  if (!forceRelay && candidateIP && port) {
    process.stdout.write(`  ${c.dim}Comprobando ruta TCP directa con ${candidateIP}:${port}...${c.reset}`);
    tcpSocket = await new Promise((resolve) => {
      const sock = net.connect({ host: candidateIP, port });
      const timer = setTimeout(() => {
        sock.destroy();
        resolve(null);
      }, 1500);
      sock.on('connect', () => {
        clearTimeout(timer);
        resolve(sock);
      });
      sock.on('error', () => {
        clearTimeout(timer);
        resolve(null);
      });
    });
  }

  if (tcpSocket) {
    process.stdout.write(`\r${' '.repeat(70)}\r`);
    if (ws) ws.close();
    const pathDesc = `Directa TCP (${candidateIP}:${port})`;
    console.log(`  ${c.green}✔ Conectado por TCP directo:${c.reset} ${pathDesc}\n`);
    const channel = new TcpSpeedChannel(tcpSocket, token, false, pathDesc);

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timeout en handshake de autenticación TCP')), 3500);
      const unsub = channel.onControl((msg) => {
        if (msg.k === 'welcome') {
          clearTimeout(timer);
          unsub();
          resolve();
        }
      });
      channel.sendControl({ k: 'hello', token });
    });

    const onExit = () => { channel.close(); process.exit(0); };
    process.on('SIGINT', onExit);
    process.on('SIGTERM', onExit);

    try {
      await runSpeedTest(channel, false, durationSec);
    } finally {
      channel.close();
    }
    return;
  }

  if (directOnly) {
    if (ws) ws.close();
    console.error(`\n  ${c.red}Error: No fue posible establecer conexión directa TCP y se especificó --direct-only.${c.reset}\n`);
    process.exit(1);
  }

  // 4. Fallback a Relay por servidor
  process.stdout.write(`\r${' '.repeat(70)}\r`);
  const pathDesc = `Relay por servidor (${new URL(serverUrl).host})`;
  console.log(`  ${c.cyan}[MODO RELAY]${c.reset} ${c.dim}Conexión directa no disponible, usando retransmisión por servidor...${c.reset}\n`);

  ws.send(JSON.stringify({
    t: 'signal',
    data: { type: 'cli-speed-accept' }
  }));

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout esperando confirmación Relay del anfitrión')), 8000);
    const onMsg = (ev) => {
      try {
        if (typeof ev.data !== 'string') return;
        const msg = JSON.parse(ev.data);
        if (msg.t === 'signal' && msg.data?.type === 'cli-speed-ready') {
          clearTimeout(timer);
          ws.removeEventListener('message', onMsg);
          resolve();
        }
      } catch {}
    };
    ws.addEventListener('message', onMsg);
  });

  const channel = new RelaySpeedChannel(ws, null, false, pathDesc);

  const onExit = () => { channel.close(); process.exit(0); };
  process.on('SIGINT', onExit);
  process.on('SIGTERM', onExit);

  try {
    await runSpeedTest(channel, false, durationSec);
  } finally {
    channel.close();
  }
}
