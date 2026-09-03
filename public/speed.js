// Prueba de velocidad entre dos peers, sobre el mismo canal que usaria una
// transferencia real: mismo servidor de emparejamiento, mismo RTCDataChannel,
// mismo troceado y control de flujo. Lo que sale aqui es lo que veras al enviar.
//
// Se duplica a proposito la fontaneria de senalizacion de app.js en vez de
// extraerla: app.js esta en produccion y funcionando, y son ~70 lineas.
//
// Fases, dirigidas siempre por el anfitrion:
//   ping  ->  emite el anfitrion (h2g)  ->  emite el invitado (g2h)  ->  fin
//
// Las dos direcciones se muestran como "outbound" e "inbound" y cada lado las
// mapea segun su papel: lo que para uno sale, para el otro entra.

const $ = (sel) => document.querySelector(sel);

const CHUNK = 64 * 1024;
const HIGH_WATER = 8 * 1024 * 1024;
const LOW_WATER = 1 * 1024 * 1024;
const PHASE_MS = 7000;        // por direccion
const PINGS = 12;

const PAYLOAD = new Uint8Array(CHUNK);   // se reenvia el mismo buffer, no se reserva por trozo

// ------------------------------------------------------------------ formato

const fmtRate = (bps) => (bps / (1024 * 1024)).toFixed(1) + ' MB/s';
const fmtBits = (bps) => Math.round(bps * 8 / (1024 * 1024)) + ' Mbit/s';
// Por debajo de 10 ms un entero se queda en "0 ms" y parece que no ha medido.
const fmtMs = (ms) => (ms < 10 ? ms.toFixed(1) : Math.round(ms)) + ' ms';

function setStatus(text, kind = '') {
  const el = $('#status');
  el.textContent = text;
  el.className = 'status ' + kind;
}

function metric(id, text) {
  const el = $(id);
  el.textContent = text;
  el.classList.remove('pending');
}

function showError(text) {
  $('#error').hidden = false;
  $('#error').textContent = text;
  $('#live').hidden = true;
  setStatus('offline', 'bad');
}

// ------------------------------------------------------------- señalizacion

let ws = null;
let iceConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

fetch('/config')
  .then((r) => r.json())
  .then((cfg) => { if (cfg.iceServers) iceConfig = cfg; })
  .catch(() => {});

function connectSignaling() {
  return new Promise((resolve, reject) => {
    if (ws && ws.readyState === WebSocket.OPEN) return resolve();
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host);
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('no route to the server'));
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      handleSignal(msg);
    };
  });
}

const wsSend = (obj) => ws && ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(obj));

const conn = { pc: null, dc: null, pendingIce: [], guestId: null, isHost: false };

function handleSignal(msg) {
  switch (msg.t) {
    case 'hosted':     onHosted(msg.token); break;
    case 'guest':      onGuestJoined(msg.guestId); break;
    case 'joined':     onJoined(); break;
    case 'signal':     applySignal(msg.data); break;
    case 'error':      showError('This link is dead — the other side closed their tab.'); break;
    case 'host-gone':
    case 'guest-gone': onPeerGone(); break;
  }
}

async function applySignal(data) {
  const { pc } = conn;
  if (!pc) return;
  if (data.sdp) {
    await pc.setRemoteDescription(data.sdp);
    if (data.sdp.type === 'offer') {
      await pc.setLocalDescription(await pc.createAnswer());
      sendSignal({ sdp: pc.localDescription });
    }
    for (const cand of conn.pendingIce.splice(0)) await pc.addIceCandidate(cand).catch(() => {});
  } else if (data.ice) {
    if (pc.remoteDescription) await pc.addIceCandidate(data.ice).catch(() => {});
    else conn.pendingIce.push(data.ice);
  }
}

function sendSignal(data) {
  wsSend(conn.isHost ? { t: 'signal', to: conn.guestId, data } : { t: 'signal', data });
}

function newPeerConnection() {
  const pc = new RTCPeerConnection(iceConfig);
  pc.onicecandidate = (e) => { if (e.candidate) sendSignal({ ice: e.candidate }); };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') showError('Connection failed — no path between you two.');
  };
  return pc;
}

function onPeerGone() {
  if (!state.finished) showError('The other side dropped out mid-test.');
}

// ----------------------------------------------------------------- anfitrion

async function start() {
  $('#start').disabled = true;
  try {
    await connectSignaling();
    conn.isHost = true;
    wsSend({ t: 'host' });
  } catch (err) {
    $('#start').disabled = false;
    showError(err.message);
  }
}

function onHosted(token) {
  $('#start-row').hidden = true;
  $('#ticket').hidden = false;
  $('#link-out').value = location.origin + location.pathname + '#' + token;
  setStatus('channel open · waiting for peer', 'live');
}

function onGuestJoined(guestId) {
  conn.guestId = guestId;
  conn.pc = newPeerConnection();
  const dc = conn.pc.createDataChannel('bench', { ordered: true });
  wireChannel(dc);
  conn.pc.createOffer()
    .then((o) => conn.pc.setLocalDescription(o))
    .then(() => sendSignal({ sdp: conn.pc.localDescription }));
}

// ------------------------------------------------------------------ invitado

async function join(token) {
  $('#start-row').hidden = true;
  $('#lead').textContent = 'Measuring the connection between the two of you, both directions.';
  try {
    await connectSignaling();
    wsSend({ t: 'join', token });
    setStatus('locating peer…');
  } catch (err) {
    showError(err.message);
  }
}

function onJoined() {
  conn.pc = newPeerConnection();
  conn.pc.ondatachannel = (e) => wireChannel(e.channel);
}

// -------------------------------------------------------------------- estado

const state = {
  rxBytes: 0,
  rxStart: 0,
  lastTick: 0,
  receiving: false,
  finished: false,
  rtt: null,
  pingsLeft: 0,
  pingSent: 0,
};

/** 'h2g' es del anfitrion al invitado. Cada lado la ve como suya o ajena. */
const iAmSender = (dir) => (dir === 'h2g') === conn.isHost;
const slotFor = (dir) => (iAmSender(dir) ? '#m-out' : '#m-in');
const labelFor = (dir) => (iAmSender(dir) ? 'outbound · you → them' : 'inbound · them → you');

function wireChannel(dc) {
  conn.dc = dc;
  dc.binaryType = 'arraybuffer';
  dc.bufferedAmountLowThreshold = LOW_WATER;

  const opened = () => {
    setStatus('channel up', 'live');
    $('#metrics').hidden = false;
    if (conn.isHost) runPings();
  };
  dc.onopen = opened;
  if (dc.readyState === 'open') opened();   // pudo abrirse antes de engancharnos

  dc.onmessage = (ev) => {
    if (typeof ev.data !== 'string') return onPayload(ev.data.byteLength);
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    onControl(msg);
  };
}

const ctrl = (obj) => conn.dc && conn.dc.readyState === 'open' && conn.dc.send(JSON.stringify(obj));

// ------------------------------------------------------------------ protocolo

function onControl(msg) {
  switch (msg.k) {
    case 'ping': ctrl({ k: 'pong' }); break;

    case 'pong': {
      const rtt = performance.now() - state.pingSent;
      state.rtt = state.rtt === null ? rtt : Math.min(state.rtt, rtt);
      if (--state.pingsLeft > 0) return sendPing();
      metric('#m-rtt', fmtMs(state.rtt));
      ctrl({ k: 'rtt', ms: state.rtt });
      beginPhase('h2g');
      break;
    }

    case 'rtt': metric('#m-rtt', fmtMs(msg.ms)); break;

    case 'incoming':
      state.rxBytes = 0;
      state.rxStart = 0;
      state.receiving = true;
      showLive(labelFor(msg.dir), 'receiving payload');
      break;

    case 'tick':
      renderLive(msg.rate, msg.elapsed);
      break;

    // El emisor termino. El receptor es quien tiene el numero de verdad.
    case 'sent-done': {
      state.receiving = false;
      const seconds = (performance.now() - state.rxStart) / 1000;
      const rate = seconds > 0 ? state.rxBytes / seconds : 0;
      ctrl({ k: 'result', dir: msg.dir, rate });
      recordResult(msg.dir, rate);
      if (msg.dir === 'h2g' && !conn.isHost) beginPhase('g2h');
      break;
    }

    case 'result': recordResult(msg.dir, msg.rate); break;

    case 'finished': finish(); break;
  }
}

function sendPing() {
  state.pingSent = performance.now();
  ctrl({ k: 'ping' });
}

function runPings() {
  state.pingsLeft = PINGS;
  showLive('latency', 'probing round trip');
  sendPing();
}

function onPayload(bytes) {
  if (!state.receiving) return;
  if (!state.rxStart) state.rxStart = performance.now();
  state.rxBytes += bytes;

  const now = performance.now();
  if (now - state.lastTick > 250) {
    state.lastTick = now;
    const elapsed = (now - state.rxStart) / 1000;
    const rate = elapsed > 0 ? state.rxBytes / elapsed : 0;
    renderLive(rate, elapsed);
    ctrl({ k: 'tick', rate, elapsed });
  }
}

/** Emite a toda velocidad durante PHASE_MS, respetando la contrapresion. */
async function beginPhase(dir) {
  const dc = conn.dc;
  ctrl({ k: 'incoming', dir });
  showLive(labelFor(dir), 'sending payload');

  const until = performance.now() + PHASE_MS;
  while (performance.now() < until) {
    if (!dc || dc.readyState !== 'open') return;
    if (dc.bufferedAmount > HIGH_WATER) {
      await new Promise((r) => dc.addEventListener('bufferedamountlow', r, { once: true }));
      continue;
    }
    dc.send(PAYLOAD);
  }
  // Vaciamos el buffer antes de cerrar la fase: si no, le cortamos la cola al receptor.
  while (dc.readyState === 'open' && dc.bufferedAmount > 0) {
    await new Promise((r) => setTimeout(r, 50));
  }
  ctrl({ k: 'sent-done', dir });
}

function recordResult(dir, rate) {
  metric(slotFor(dir), fmtRate(rate) + '  ·  ' + fmtBits(rate));
  if (dir === 'g2h') {
    if (conn.isHost) ctrl({ k: 'finished' });
    finish();
  }
}

// -------------------------------------------------------------------- pintado

function showLive(label, note) {
  $('#live').hidden = false;
  $('#live-label').textContent = label;
  $('#live-note').textContent = note;
  $('#live-bar').style.width = '0%';
}

function renderLive(rate, elapsed) {
  $('#live-rate').textContent = fmtRate(rate);
  $('#live-bar').style.width = Math.min(100, (elapsed / (PHASE_MS / 1000)) * 100).toFixed(0) + '%';
}

/** El tipo de candidato dice si vais directos o rebotando por el TURN. */
async function reportPath() {
  try {
    const stats = await conn.pc.getStats();
    let pair = null;
    stats.forEach((r) => {
      if (r.type === 'candidate-pair' && r.state === 'succeeded' && (r.nominated || !pair)) pair = r;
    });
    if (!pair) return;
    const local = stats.get(pair.localCandidateId);
    const remote = stats.get(pair.remoteCandidateId);
    const types = [local && local.candidateType, remote && remote.candidateType].filter(Boolean);
    const relayed = types.includes('relay');
    metric('#m-path', relayed ? 'relayed through TURN' : 'direct (' + types.join(' / ') + ')');
    $('#verdict').hidden = false;
    $('#verdict').textContent = relayed
      ? 'Your networks would not talk directly, so this bounced off the server. Real transfers '
        + 'between you two are capped by the same path.'
      : 'Straight peer to peer — nothing but the two of you on this path.';
  } catch { /* getStats no es critico */ }
}

function finish() {
  if (state.finished) return;
  state.finished = true;
  $('#live').hidden = true;
  $('#again-row').hidden = false;
  setStatus('test complete', 'live');
  reportPath();
}

// -------------------------------------------------------------------- arranque

$('#start').onclick = start;
$('#again').onclick = () => location.reload();
$('#copy-link').onclick = async (e) => {
  const btn = e.currentTarget;
  try {
    await navigator.clipboard.writeText($('#link-out').value);
    btn.textContent = 'copied';
    setTimeout(() => { btn.textContent = 'copy'; }, 1500);
  } catch {
    $('#link-out').select();
  }
};

const token = location.hash.slice(1).replace(/[^A-Za-z0-9_-]/g, '');
if (token) join(token);
