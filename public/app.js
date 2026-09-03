// Drop — envio de archivos P2P sobre WebRTC DataChannel.
//
// El servidor solo empareja (SDP/ICE). Los bytes van navegador -> navegador.
// Protocolo sobre el DataChannel:
//   texto  -> mensajes de control JSON: manifest | accept | start | end | done | ack
//   binario-> trozos del archivo en curso, en orden
//
// El emisor mide el progreso con los `ack` del receptor: `bufferedAmount` solo
// dice lo que hemos entregado a SCTP, no lo que ha llegado al otro lado.
//
// CADENA DE REENVIO
// Con varios receptores el uplink del emisor se reparte entre todos: N receptores
// eran N copias completas por el mismo tubo. En vez de eso los encadenamos --
// emisor -> A -> B -> C -- y cada uno reenvia los trozos segun le llegan. El
// emisor sube una sola copia y el limite pasa a ser el peor uplink de la cadena.
//
// El flujo se parte en dos por eso:
//   - en banda, por la cadena: los trozos binarios y `start`/`end`/`done`, que
//     tienen que llegar en orden respecto a los datos que delimitan.
//   - directo con el emisor, siempre: `manifest`, `accept`, `ack`, `complete`,
//     `bye`, `relay`, `resume`. Cada receptor mantiene su canal con el emisor
//     aunque los bytes le lleguen por otro sitio, asi que el progreso y la
//     cancelacion siguen funcionando igual que antes.
// `hold`/`go` son contrapresion y solo viajan un salto hacia arriba: un receptor
// no puede frenar lo que le entra, asi que avisa a quien le alimenta y el aviso
// sube hasta el emisor.

const $ = (sel, root = document) => root.querySelector(sel);

const CHUNK = 64 * 1024;              // 64 KiB: suelo seguro si SCTP no dice otra cosa
const MAX_CHUNK = 256 * 1024;         // techo: lo que anuncian hoy Chrome, Firefox y Safari
const HIGH_WATER = 8 * 1024 * 1024;   // pausamos el envio por encima de esto
const LOW_WATER = 1 * 1024 * 1024;    // y reanudamos aqui
const ACK_EVERY = 2 * 1024 * 1024;    // el receptor confirma cada 2 MB (menos sobrecarga JSON)

// Solo se pueden encadenar receptores que empiezan a la vez: un reenviador no
// guarda nada, pasa lo que va viendo. Tras el primer `accept` el emisor espera
// como mucho esto por si hay mas gente a punto de aceptar; si ya han aceptado
// todos los conectados, arranca sin esperar.
const RELAY_WINDOW = 1500;

// Si un eslabon no levanta en este tiempo (NAT, TURN caido) deshacemos la cadena
// y servimos a todos en directo: lento, pero es lo que habia antes y funciona.
const RELAY_LINK_TIMEOUT = 8000;

const PATH_EVERY = 3000;   // cada cuanto refrescamos camino y latencia en la fila

// ---------------------------------------------------------------- utilidades

function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
  return (n < 10 ? n.toFixed(1) : Math.round(n)) + ' ' + units[i];
}

function fmtEta(seconds) {
  if (!isFinite(seconds) || seconds < 0) return '';
  if (seconds < 60) return Math.ceil(seconds) + 's';
  const m = Math.floor(seconds / 60);
  if (m < 60) return m + 'm ' + Math.round(seconds % 60) + 's';
  return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
}

function safeName(name) {
  return String(name).replace(/[\/:*?"<>|]/g, '_').replace(/^\.+/, '_').slice(0, 180) || 'file';
}

function setStatus(text, kind = '') {
  const el = $('#status');
  el.textContent = text;
  el.className = 'status ' + kind;
}

function showView(name) {
  document.body.dataset.view = name;
}

// -------------------------------------------------------------- señalizacion

let ws = null;
let iceConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

fetch('/config')
  .then((r) => r.json())
  .then((cfg) => { if (cfg.iceServers) iceConfig = cfg; })
  .catch(() => { /* nos quedamos con el STUN por defecto */ });

function connectSignaling() {
  return new Promise((resolve, reject) => {
    if (ws && ws.readyState === WebSocket.OPEN) return resolve();
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { setStatus('uplink ok', 'live'); resolve(); };
    ws.onerror = () => reject(new Error('No route to the server'));
    ws.onclose = () => setStatus('uplink lost', 'bad');
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') {
        onChunk(ev.data);
        return;
      }
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      handleSignal(msg);
    };
  });
}

function wsSend(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function handleSignal(msg) {
  switch (msg.t) {
    case 'hosted':   onHosted(msg.token); break;
    case 'guest':    onGuestJoined(msg.guestId); break;
    case 'guest-gone': dropPeer(msg.guestId, 'gone'); break;
    case 'joined':   onJoined(msg.guestId); break;
    case 'host-gone': onHostGone(); break;
    case 'error':    onJoinError(msg.reason); break;
    case 'signal':   routeSignal(msg.from, msg.data); break;
  }
}

// ----------------------------------------------------- conexiones (comun)

/**
 * Aplica SDP/ICE sobre una RTCPeerConnection. Las candidatas que llegan antes
 * que la descripcion remota se guardan en cola: si no, addIceCandidate falla.
 */
async function applySignal(conn, data) {
  const { pc } = conn;
  if (data.sdp) {
    await pc.setRemoteDescription(data.sdp);
    if (data.sdp.type === 'offer') {
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      conn.sendSignal({ sdp: pc.localDescription });
    }
    for (const cand of conn.pendingIce.splice(0)) {
      await pc.addIceCandidate(cand).catch(() => {});
    }
  } else if (data.ice) {
    if (pc.remoteDescription) await pc.addIceCandidate(data.ice).catch(() => {});
    else conn.pendingIce.push(data.ice);
  }
}

// ------------------------------------------------------------ interfaz: fila

function makeProgressRow(container, title) {
  const el = document.createElement('div');
  el.className = 'peer';
  el.innerHTML =
    '<div class="peer-head"><span class="who"></span><span class="state"></span></div>' +
    '<div class="bar"><i></i></div>' +
    '<div class="peer-file"><span class="grow"></span><span class="rate"></span></div>';

  // Guardamos los nodos una vez: progress() se llama por cada trozo recibido y
  // buscarlos cada vez cuesta un ~10% del rendimiento de la transferencia.
  const elState = el.querySelector('.state');
  const elBar = el.querySelector('.bar > i');
  const elGrow = el.querySelector('.grow');
  const elRate = el.querySelector('.rate');
  const elWho = el.querySelector('.who');
  elWho.textContent = title;
  container.appendChild(el);

  let lastBytes = 0;
  let lastTime = performance.now();
  let rate = 0;
  let pending = null;   // ultimo progreso sin pintar
  let frame = 0;

  // Los trozos llegan mucho mas rapido que los fotogramas: acumulamos el ultimo
  // valor y tocamos el DOM una vez por frame en vez de una vez por trozo.
  function paint() {
    frame = 0;
    if (!pending) return;
    const { done, total } = pending;
    const now = performance.now();
    const dt = (now - lastTime) / 1000;
    if (dt > 0.4) {
      const inst = (done - lastBytes) / dt;
      rate = rate ? rate * 0.7 + inst * 0.3 : inst;   // suavizado exponencial
      lastBytes = done;
      lastTime = now;
    }
    const pct = total ? (done / total) * 100 : 0;
    elBar.style.width = pct.toFixed(1) + '%';
    elState.textContent =
      Math.floor(pct) + '% · ' + fmtBytes(done) + ' / ' + fmtBytes(total);
    elRate.textContent =
      rate > 0 ? fmtBytes(rate) + '/s · ' + fmtEta((total - done) / rate) : '';
  }

  // Un paint pendiente pisaria el texto final: lo cancelamos al cerrar la fila.
  function stopPainting() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    pending = null;
  }

  const api = {
    el,
    closed: false,      // ya no cambia: el sondeo del camino la puede saltar
    state(text, cls) {
      elState.textContent = text;
      if (cls) el.classList.add(cls);
    },
    file(text) { elGrow.textContent = text; },
    // Por donde van los bytes de verdad. Va pegado al nombre, no al estado, que
    // lo repinta progress() en cada fotograma.
    path(text) { elWho.textContent = text ? title + ' · ' + text : title; },
    progress(done, total) {
      pending = { done, total };
      if (!frame) frame = requestAnimationFrame(paint);
    },
    finish(text) {
      stopPainting();
      api.closed = true;
      el.classList.add('done');
      elBar.style.width = '100%';
      elState.textContent = text;
      elRate.textContent = '';
    },
    fail(text) {
      stopPainting();
      api.closed = true;
      el.classList.add('failed');
      elState.textContent = text;
      elRate.textContent = '';
    },
  };
  return api;
}

// -------------------------------------------------- diagnostico: por donde va

/**
 * Que camino esta usando esta conexion. El tipo de candidato es lo unico que
 * distingue ir directo de rebotar por el TURN, y esa diferencia pesa mas en la
 * velocidad que ve la gente que cualquier ajuste que podamos hacer aqui dentro.
 */
async function describePath(pc) {
  try {
    const stats = await pc.getStats();
    let pair = null;
    stats.forEach((r) => {
      if (r.type === 'candidate-pair' && r.state === 'succeeded' && (r.nominated || !pair)) pair = r;
    });
    if (!pair) return '';
    const local = stats.get(pair.localCandidateId);
    const remote = stats.get(pair.remoteCandidateId);
    const relayed = [local && local.candidateType, remote && remote.candidateType]
      .includes('relay');
    const rtt = pair.currentRoundTripTime;
    return (relayed ? 'turn' : 'direct')
      + (rtt ? ' ' + Math.round(rtt * 1000) + 'ms' : '');
  } catch {
    return '';   // getStats no es critico: si no hay dato, la fila se queda como estaba
  }
}

let pathTimer = 0;

function watchPaths() {
  if (pathTimer) return;
  pathTimer = setInterval(probePaths, PATH_EVERY);
  probePaths();
}

function probePaths() {
  let active = 0;
  if (document.body.dataset.view === 'send') {
    for (const conn of out.peers.values()) {
      if (conn.row.closed) continue;
      active++;
      // A un receptor encadenado no le mandamos los bytes nosotros, asi que
      // nuestra latencia con el no dice nada de por donde le llegan: su camino
      // real es el que tiene con su eslabon, y ese solo lo ve el.
      if (conn.relayed) conn.row.path('via ' + labelFor(conn.relayFrom));
      else describePath(conn.pc).then((text) => conn.row.path(text));
    }
  } else if (rx.row && !rx.row.closed) {
    active++;
    if (rx.up) {
      const via = rx.up.peerId ? 'via peer · ' : '';
      describePath(rx.up.pc).then((text) => rx.row.path(via + text));
    }
  }
  if (!active) { clearInterval(pathTimer); pathTimer = 0; }
}

function labelFor(guestId) {
  const conn = out.peers.get(guestId);
  return conn ? conn.label : 'peer';
}

// ============================================================== EMISOR (host)

const out = {
  files: [],
  token: null,
  peers: new Map(),   // guestId -> conn
  nextLabel: 1,
  ready: [],          // han aceptado y esperan a que se forme la cadena
  batchTimer: 0,
};

function totalBytes() {
  return out.files.reduce((sum, f) => sum + f.size, 0);
}

function renderFileList() {
  const list = $('#file-list');
  list.innerHTML = '';
  for (const [i, file] of out.files.entries()) {
    const li = document.createElement('li');
    li.innerHTML =
      '<span class="name"></span><span class="size"></span>' +
      (out.token ? '' : '<button class="drop-one" title="Remove">×</button>');
    li.querySelector('.name').textContent = file.name;
    li.querySelector('.size').textContent = fmtBytes(file.size);
    const del = li.querySelector('.drop-one');
    if (del) del.onclick = () => { out.files.splice(i, 1); renderFileList(); };
    list.appendChild(li);
  }
  $('#send-actions').hidden = out.files.length === 0 || !!out.token;
  $('#drop').hidden = !!out.token;
}

function addFiles(fileList) {
  for (const file of fileList) {
    const dup = out.files.some((f) => f.name === file.name && f.size === file.size);
    if (!dup) out.files.push(file);
  }
  renderFileList();
}

async function createLink() {
  if (!out.files.length) return;
  $('#create-link').disabled = true;
  try {
    await connectSignaling();
    wsSend({ t: 'host' });
  } catch (err) {
    $('#create-link').disabled = false;
    setStatus('no route to the server', 'bad');
  }
}

function shareUrl() {
  return location.origin + location.pathname + '#' + out.token;
}

function onHosted(token) {
  out.token = token;
  $('#ticket').hidden = false;
  $('#link-out').value = shareUrl();
  renderFileList();
  setStatus('channel open · waiting for peer', 'live');
}

function onGuestJoined(guestId) {
  const label = 'peer ' + out.nextLabel++;
  const row = makeProgressRow($('#peers'), label);
  row.state('handshake…');

  const conn = {
    guestId,
    label,
    pc: new RTCPeerConnection(iceConfig),
    dc: null,
    pendingIce: [],
    row,
    acked: 0,
    cancelled: false,
    started: false,     // ya le estamos sirviendo (directo o por cadena)
    relayed: false,     // recibe los bytes de otro receptor, no de nosotros
    relayTo: null,      // a quien reenvia
    relayFrom: null,    // de quien come
    paused: false,      // nos ha pedido `hold`
    wake: null,         // resolve() del await que lo tiene parado
    sendSignal: (data) => wsSend({ t: 'signal', to: guestId, data }),
  };
  out.peers.set(guestId, conn);

  conn.dc = conn.pc.createDataChannel('drop', { ordered: true });
  conn.dc.binaryType = 'arraybuffer';
  conn.dc.bufferedAmountLowThreshold = LOW_WATER;

  conn.pc.onicecandidate = (e) => { if (e.candidate) conn.sendSignal({ ice: e.candidate }); };
  conn.pc.onconnectionstatechange = () => {
    const st = conn.pc.connectionState;
    // Si se cae mientras esta en `hold`, el bucle de envio se quedaria dormido
    // para siempre: lo despertamos para que vea `cancelled` y salga.
    if (st === 'failed') { conn.cancelled = true; resumePeer(conn); row.fail('link failed'); }
    if (st === 'disconnected') row.state('link unstable…');
  };

  conn.dc.onopen = () => {
    row.state('awaiting ack…');
    conn.dc.send(JSON.stringify({
      k: 'manifest',
      files: out.files.map((f) => ({ name: f.name, size: f.size, type: f.type })),
    }));
  };

  conn.dc.onmessage = (ev) => {
    if (typeof ev.data !== 'string') return;
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.k === 'accept') queueForStart(conn);
    else if (msg.k === 'ack') { conn.acked = msg.bytes; row.progress(msg.bytes, totalBytes()); }
    else if (msg.k === 'complete') { conn.acked = totalBytes(); row.file(''); row.finish('delivered'); }
    else if (msg.k === 'bye') { conn.cancelled = true; resumePeer(conn); row.fail('aborted by peer'); }
    else if (msg.k === 'hold') conn.paused = true;
    else if (msg.k === 'go') resumePeer(conn);
    else if (msg.k === 'linked') onLinked(conn);
    // Se le ha caido quien le reenviaba: retomamos nosotros desde donde se quedo.
    else if (msg.k === 'resume') {
      conn.relayed = false;
      sendAllFiles(conn, msg.index | 0, Math.max(0, msg.offset | 0));
    }
  };

  conn.pc.createOffer()
    .then((offer) => conn.pc.setLocalDescription(offer))
    .then(() => conn.sendSignal({ sdp: conn.pc.localDescription }));

  watchPaths();
}

/**
 * Un receptor acaba de aceptar. No arrancamos al instante: si hay mas gente a
 * punto de aceptar los encadenamos y subimos una sola copia. En cuanto han
 * aceptado todos los que estan conectados no hay a quien esperar y salimos ya,
 * asi que con un solo receptor esto no anade ni un milisegundo.
 */
function queueForStart(conn) {
  if (conn.started || conn.cancelled || out.ready.includes(conn)) return;
  out.ready.push(conn);
  conn.row.state('queued…');
  maybeStartBatch();
}

function maybeStartBatch() {
  if (!out.ready.length) return;
  const idle = [...out.peers.values()].filter((c) => !c.started && !c.cancelled);
  if (out.ready.length >= idle.length) return startBatch();
  if (!out.batchTimer) out.batchTimer = setTimeout(startBatch, RELAY_WINDOW);
}

function startBatch() {
  clearTimeout(out.batchTimer);
  out.batchTimer = 0;

  const batch = out.ready.splice(0)
    .filter((c) => !c.cancelled && c.dc && c.dc.readyState === 'open');
  if (!batch.length) return;
  for (const conn of batch) conn.started = true;
  if (batch.length === 1) return sendAllFiles(batch[0]);

  // La cadena: cada uno reenvia al siguiente y solo el primero come de nosotros.
  // El orden es el de aceptacion; no sabemos nada de sus uplinks como para
  // afinar mas, y cualquier orden ya es mejor que N copias por nuestro tubo.
  const chain = { batch, waiting: batch.length - 1, timer: 0, launched: false };
  for (let i = 0; i < batch.length - 1; i++) {
    batch[i].chain = chain;
    batch[i].relayTo = batch[i + 1].guestId;
    batch[i + 1].relayFrom = batch[i].guestId;
    batch[i].dc.send(JSON.stringify({ k: 'relay', to: batch[i + 1].guestId }));
    batch[i + 1].relayed = true;
    batch[i + 1].row.state('via peer…');
  }

  // No mandamos nada hasta que los eslabones confirmen. Si empezasemos antes, el
  // primero reenviaria a un canal a medio abrir y el segundo se perderia el
  // principio del archivo -- que ya no vuelve, porque nadie guarda nada.
  chain.timer = setTimeout(() => launchChain(chain, true), RELAY_LINK_TIMEOUT);
}

function onLinked(conn) {
  const chain = conn.chain;
  if (chain && !chain.launched && --chain.waiting <= 0) launchChain(chain, false);
}

function launchChain(chain, timedOut) {
  if (chain.launched) return;
  chain.launched = true;
  clearTimeout(chain.timer);

  const live = chain.batch.filter((c) => !c.cancelled && c.dc && c.dc.readyState === 'open');
  if (!live.length) return;

  if (!timedOut) return sendAllFiles(live[0]);

  // Algun eslabon no ha llegado a abrirse. Deshacemos la cadena entera en vez de
  // adivinar donde esta rota: cada uno vuelve a comer directamente de nosotros.
  console.warn('drop: la cadena no levanto, servimos en directo');
  for (const conn of live) {
    conn.relayed = false;
    if (conn.chain === chain) conn.dc.send(JSON.stringify({ k: 'unrelay' }));
    sendAllFiles(conn);
  }
}

/** El receptor pide `hold` cuando su reenvio se atasca; `go` lo suelta. */
function waitForResume(conn) {
  return new Promise((resolve) => { conn.wake = resolve; });
}

function resumePeer(conn) {
  conn.paused = false;
  const wake = conn.wake;
  conn.wake = null;
  if (wake) wake();
}

/**
 * Trozo mas grande que admite esta conexion. SCTP negocia el maximo por mensaje
 * y el receptor solo cuenta bytes, asi que subirlo no toca el protocolo: son
 * menos mensajes para el mismo volumen (~7% medido). Si el otro extremo anuncia
 * menos de 64 KiB, mandamos lo que acepte.
 */
function chunkFor(pc) {
  const max = pc.sctp && pc.sctp.maxMessageSize;
  if (!max) return CHUNK;
  return Math.max(1024, Math.min(max, MAX_CHUNK));
}

/** Espera a que el buffer de salida baje: sin esto, un archivo grande revienta la memoria. */
function waitForDrain(dc) {
  return new Promise((resolve) => {
    dc.addEventListener('bufferedamountlow', resolve, { once: true });
  });
}

/**
 * Envia el lote a un receptor. `fromIndex`/`fromOffset` solo se usan al retomar
 * una transferencia cuyo reenviador se cayo: el receptor nos dice cuanto tiene
 * escrito y seguimos por ahi, sin repetirle lo que ya guardo en disco.
 */
async function sendAllFiles(conn, fromIndex = 0, fromOffset = 0) {
  const { dc, row } = conn;
  const total = totalBytes();
  const chunk = chunkFor(conn.pc);
  conn.epoch = (conn.epoch || 0) + 1;
  const epoch = conn.epoch;              // un `resume` tardio invalida este bucle
  resumePeer(conn);                      // y despierta al que invalidamos, si dormia
  row.state(fromIndex || fromOffset ? 'resuming…' : 'transmitting…');

  try {
    for (const [index, file] of out.files.entries()) {
      if (index < fromIndex) continue;
      if (conn.cancelled || conn.epoch !== epoch) return;
      row.file(file.name);
      const from = index === fromIndex ? Math.min(fromOffset, file.size) : 0;
      dc.send(JSON.stringify({
        k: 'start', index, name: file.name, size: file.size, type: file.type, from,
      }));

      const READ_BLOCK = 2 * 1024 * 1024;
      let offset = from;
      while (offset < file.size) {
        if (conn.cancelled || conn.epoch !== epoch || dc.readyState !== 'open') return;
        if (conn.paused) await waitForResume(conn);
        if (dc.bufferedAmount > HIGH_WATER) await waitForDrain(dc);

        const blockEnd = Math.min(offset + READ_BLOCK, file.size);
        const blockBuf = await file.slice(offset, blockEnd).arrayBuffer();
        if (conn.cancelled || conn.epoch !== epoch || dc.readyState !== 'open') return;

        for (let blockOff = 0; blockOff < blockBuf.byteLength; blockOff += chunk) {
          if (conn.cancelled || conn.epoch !== epoch || dc.readyState !== 'open') return;
          if (conn.paused) await waitForResume(conn);
          if (dc.bufferedAmount > HIGH_WATER) await waitForDrain(dc);
          const slice = blockBuf.slice(blockOff, Math.min(blockOff + chunk, blockBuf.byteLength));
          dc.send(slice);
        }
        offset = blockEnd;
      }
      dc.send(JSON.stringify({ k: 'end', index }));
    }
    dc.send(JSON.stringify({ k: 'done' }));
    row.file('');
    row.progress(conn.acked, total);
    row.state('flushing…');
  } catch (err) {
    console.error(err);
    row.fail('read error');
  }
}

function dropPeer(guestId, why) {
  const conn = out.peers.get(guestId);
  if (!conn) return;
  conn.cancelled = true;
  resumePeer(conn);
  const queued = out.ready.indexOf(conn);
  if (queued !== -1) out.ready.splice(queued, 1);
  if (conn.acked >= totalBytes() && totalBytes() > 0) conn.row.finish('delivered');
  else conn.row.fail(why);
  conn.pc.close();
  out.peers.delete(guestId);
  repairChain(conn);
  // Si el que se va era el ultimo que faltaba por aceptar, ya no hay que esperarle.
  maybeStartBatch();
}

/**
 * Se ha ido un eslabon. Sus vecinos pueden tardar medio minuto en enterarse por
 * su cuenta -- una pestana cerrada de golpe no cierra el DataChannel, se queda
 * en `open` hasta que ICE se rinde -- pero nosotros lo sabemos ya por el
 * websocket. Se lo decimos: el de abajo nos pedira desde donde seguir.
 */
function repairChain(dead) {
  const up = out.peers.get(dead.relayFrom);
  if (up && up.dc && up.dc.readyState === 'open') {
    up.relayTo = null;
    up.dc.send(JSON.stringify({ k: 'unrelay' }));
  }
  const down = out.peers.get(dead.relayTo);
  if (down && down.dc && down.dc.readyState === 'open') {
    down.relayFrom = null;
    down.dc.send(JSON.stringify({ k: 'orphaned' }));
  }
}

// =========================================================== RECEPTOR (guest)

const rx = {
  guestId: 0,
  links: new Map(),   // peerId -> conn  (0 es el emisor)
  host: null,         // dc de control con el emisor: nunca se sustituye
  up: null,           // conn por la que nos entran los bytes (emisor u otro receptor)
  down: null,         // conn a la que se los reenviamos, si somos eslabon
  manifest: null,
  total: 0,
  received: 0,
  lastAck: 0,
  fileIndex: -1,      // archivo en curso y cuanto suyo llevamos: hace falta para
  fileGot: 0,         // poder retomar si se cae quien nos reenvia
  sink: null,
  makeSink: null,
  writes: Promise.resolve(),   // cadena que serializa las escrituras a disco
  row: null,
  accepted: false,
  finished: false,
  recovering: false,  // ya hemos pedido `resume` y esperamos el `start`
};

/**
 * Un enlace con otro navegador. `peerId` 0 es el emisor; cualquier otro es un
 * receptor de la misma sala, y entonces la senalizacion va dirigida por id.
 */
function makeLink(peerId) {
  const conn = {
    peerId,
    pc: new RTCPeerConnection(iceConfig),
    dc: null,
    pendingIce: [],
    held: false,
    maxMsg: MAX_CHUNK,   // lo que admite por mensaje, cuando abra el canal
    sendSignal: (data) =>
      wsSend(peerId ? { t: 'signal', to: peerId, data } : { t: 'signal', data }),
  };
  conn.pc.onicecandidate = (e) => { if (e.candidate) conn.sendSignal({ ice: e.candidate }); };
  rx.links.set(peerId, conn);
  return conn;
}

async function joinRoom(token) {
  $('#join-error').hidden = true;
  try {
    await connectSignaling();
    wsSend({ t: 'join', token });
    setStatus('locating peer…');
  } catch {
    onJoinError('NO_SERVER');
  }
}

function onJoinError(reason) {
  $('#recv-title').textContent = 'dead link';
  const el = $('#join-error');
  el.hidden = false;
  el.textContent = reason === 'NOT_FOUND'
    ? 'Channel closed: the sender shut their tab. Ask them for a new link.'
    : 'No route to the server.';
  setStatus('offline', 'bad');
}

function onJoined(guestId) {
  rx.guestId = guestId || 0;
  setStatus('handshake…', 'live');
  $('#recv-title').textContent = 'handshake…';
  const conn = makeLink(0);
  conn.pc.onconnectionstatechange = () => {
    if (conn.pc.connectionState === 'failed' && rx.row && !rx.finished) rx.row.fail('link failed');
  };
  conn.pc.ondatachannel = (e) => attachInbound(conn, e.channel);
}

function onHostGone() {
  setStatus('peer dropped', 'bad');
  // La sala muere con el emisor, pero los canales P2P no: si nos alimenta otro
  // receptor puede quedarle cola por entregarnos y esto todavia puede acabar.
  if (rx.up && rx.up.peerId !== 0) return;
  if (rx.row && !rx.finished && rx.received < rx.total) rx.row.fail('severed');
}

/** Canal por el que nos llega algo: el del emisor, o el del eslabon de arriba. */
function attachInbound(conn, dc) {
  conn.dc = dc;
  dc.binaryType = 'arraybuffer';
  if (conn.peerId === 0) rx.host = dc;
  dc.onmessage = (ev) => onInbound(conn, ev);
  dc.onclose = () => onUpstreamLost(conn);
}

function onInbound(conn, ev) {
  if (typeof ev.data === 'string') {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    // `start`/`end`/`done` delimitan los datos, asi que bajan por la cadena en
    // banda con ellos: por el canal directo adelantarian a los ultimos trozos y
    // el de abajo cerraria el archivo a medias.
    if (msg.k === 'start' || msg.k === 'end' || msg.k === 'done') {
      if (msg.k === 'start') rx.up = conn;
      forward(ev.data);
    }
    onControl(msg);
  } else {
    rx.up = conn;
    forward(ev.data);      // reenviamos antes de escribir: es un salto menos de latencia
    onChunk(ev.data);
  }
}

/** Somos un tubo: lo que entra sale hacia el siguiente de la cadena. */
function forward(data) {
  const down = rx.down;
  if (!down || !down.dc || down.dc.readyState !== 'open') return;
  // El trozo viene medido para el enlace de arriba. Si el de abajo anuncia menos
  // por mensaje hay que partirlo, o SCTP lo tira sin decir nada. Cortar no toca
  // el protocolo: el que recibe solo cuenta bytes, los limites le dan igual.
  if (typeof data !== 'string' && data.byteLength > down.maxMsg) {
    for (let off = 0; off < data.byteLength; off += down.maxMsg) {
      down.dc.send(data.slice(off, off + down.maxMsg));
    }
  } else {
    down.dc.send(data);
  }
  // No hay forma de frenar lo que nos entra, asi que si el de abajo no traga
  // se lo pedimos a quien nos alimenta y el aviso sube hasta el emisor.
  if (!down.held && down.dc.bufferedAmount > HIGH_WATER) {
    down.held = true;
    sendUp({ k: 'hold' });
  }
}

function sendUp(obj) {
  const up = rx.up;
  if (up && up.dc && up.dc.readyState === 'open') up.dc.send(JSON.stringify(obj));
}

/** El emisor nos ha nombrado eslabon: abrimos el canal hacia el siguiente. */
function openRelay(peerId) {
  if (!peerId || (rx.down && rx.down.peerId === peerId)) return;
  const conn = rx.links.get(peerId) || makeLink(peerId);
  const dc = conn.pc.createDataChannel('drop', { ordered: true });
  dc.binaryType = 'arraybuffer';
  dc.bufferedAmountLowThreshold = LOW_WATER;
  conn.dc = dc;
  conn.held = false;
  rx.down = conn;

  // El emisor no arranca hasta que confirmamos: hasta aqui el canal no traga.
  dc.onopen = () => {
    conn.maxMsg = chunkFor(conn.pc);
    sendHost({ k: 'linked' });
  };
  dc.onbufferedamountlow = () => { conn.held = false; sendUp({ k: 'go' }); };
  dc.onclose = () => { if (rx.down === conn) rx.down = null; };
  dc.onmessage = (ev) => {
    if (typeof ev.data !== 'string') return;
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    // La contrapresion del de abajo no la podemos atender nosotros: la pasamos.
    if (msg.k === 'hold' || msg.k === 'go') sendUp(msg);
  };
  conn.pc.onconnectionstatechange = () => {
    const st = conn.pc.connectionState;
    if ((st === 'failed' || st === 'closed') && rx.down === conn) rx.down = null;
  };

  conn.pc.createOffer()
    .then((offer) => conn.pc.setLocalDescription(offer))
    .then(() => conn.sendSignal({ sdp: conn.pc.localDescription }))
    .catch((err) => console.error('relay', err));
}

/**
 * Se ha caido el eslabon que nos alimentaba. La cadena por debajo se queda sin
 * fuente igual, asi que la soltamos -- cada uno pedira lo suyo -- y le decimos
 * al emisor por donde ibamos para que siga desde ahi.
 */
function onUpstreamLost(conn) {
  if (conn !== rx.up || conn.peerId === 0) return;
  recoverUpstream();
}

function recoverUpstream() {
  if (rx.finished || !rx.accepted || rx.recovering) return;
  if (rx.up && rx.up.peerId === 0) return;    // ya comemos del emisor
  // Ojo: `rx.up` puede ser null y aun asi haber que pedir. Pasa si el eslabon
  // cae antes de pasarnos el primer byte; si saliesemos aqui, a este receptor no
  // volveria a mandarle nadie nada y se quedaria esperando para siempre.
  rx.recovering = true;
  rx.up = rx.links.get(0) || null;

  if (rx.down) {
    try { rx.down.dc.close(); } catch { /* ya estaba cerrado */ }
    rx.down = null;
  }
  if (rx.row) rx.row.state('relay lost · resuming…');

  // Lo ya encolado se escribe igualmente: pedimos desde ahi y no desde donde iba
  // el contador, o dejariamos un hueco a mitad del archivo.
  rx.writes = rx.writes.then(async () => {
    if (rx.sink && rx.sink.flush) await rx.sink.flush();
    sendHost({ k: 'resume', index: rx.fileIndex, offset: rx.fileGot });
  });
}

function onControl(msg) {
  switch (msg.k) {
    case 'manifest':
      rx.manifest = msg.files;
      rx.total = msg.files.reduce((sum, f) => sum + f.size, 0);
      showOffer(msg.files);
      break;

    // El emisor nos coloca en la cadena antes de mandar el primer byte.
    case 'relay':
      openRelay(msg.to);
      break;

    // Se ha caido quien nos reenviaba y el emisor nos avisa antes de que se
    // entere nuestro propio canal, que puede tardar muchisimo.
    case 'orphaned':
      recoverUpstream();
      break;

    // ...o se arrepiente porque algun eslabon no llego a abrirse.
    case 'unrelay':
      if (rx.down) {
        try { rx.down.dc.close(); } catch { /* ya estaba cerrado */ }
        rx.down = null;
      }
      break;

    case 'start':
      rx.recovering = false;
      rx.fileIndex = msg.index;
      rx.fileGot = msg.from || 0;
      rx.writes = rx.writes.then(async () => {
        // Al retomar seguimos escribiendo donde estabamos: crear el destino otra
        // vez truncaria lo que ya hay guardado.
        if (!msg.from) rx.sink = await rx.makeSink(msg);
        if (rx.row) rx.row.file(msg.name);
      });
      break;

    case 'end':
      rx.writes = rx.writes.then(async () => {
        if (rx.sink) await rx.sink.close();
        rx.sink = null;
      });
      break;

    case 'done':
      rx.finished = true;
      rx.writes = rx.writes.then(() => {
        if (rx.isCli) {
          wsSend({ t: 'signal', data: { type: 'cli-complete' } });
        } else {
          sendHost({ k: 'complete' });
        }
        if (rx.row) { rx.row.file(''); rx.row.finish('received'); }
        setStatus('transfer complete', 'live');
      });
      break;
  }
}

function onChunk(buffer) {
  rx.received += buffer.byteLength;
  rx.fileGot += buffer.byteLength;
  rx.writes = rx.writes.then(() => rx.sink && rx.sink.write(buffer));
  if (rx.row) rx.row.progress(rx.received, rx.total);
  if (rx.isCli) {
    if (rx.received - rx.lastAck >= ACK_EVERY || rx.received >= rx.total) {
      rx.lastAck = rx.received;
      wsSend({ t: 'signal', data: { type: 'cli-ack', bytes: rx.received } });
    }
    return;
  }
  if (rx.received - rx.lastAck >= ACK_EVERY || rx.received >= rx.total) {
    rx.lastAck = rx.received;
    sendHost({ k: 'ack', bytes: rx.received });
  }
}

// El control siempre va por el canal directo con el emisor, aunque los bytes nos
// esten llegando por la cadena: asi el progreso y la cancelacion no dependen de
// que el eslabon de arriba siga vivo.
function sendHost(obj) {
  if (rx.host && rx.host.readyState === 'open') rx.host.send(JSON.stringify(obj));
}

function showOffer(files) {
  $('#recv-title').textContent = 'incoming payload';
  $('#offer').hidden = false;
  $('#offer-title').textContent =
    files.length + (files.length === 1 ? ' file' : ' files') + ' · ' + fmtBytes(rx.total);
  const list = $('#offer-list');
  list.innerHTML = '';
  for (const file of files) {
    const li = document.createElement('li');
    li.innerHTML = '<span class="name"></span><span class="size"></span>';
    li.querySelector('.name').textContent = file.name;
    li.querySelector('.size').textContent = fmtBytes(file.size);
    list.appendChild(li);
  }
  $('#offer-hint').textContent = supportsDirectPicker(files)
    ? 'You will be asked for a folder. Written straight to disk, no buffering.'
    : 'Downloads start on their own once complete.';
  setStatus('channel up', 'live');
}

// Con varios archivos o mucho volumen escribimos a disco en streaming; para un
// archivo pequeño la descarga normal del navegador es más cómoda (y funciona en
// Firefox y Safari, que no tienen la File System Access API).
function supportsDirectPicker(files) {
  const total = files.reduce((sum, f) => sum + f.size, 0);
  return !!window.showDirectoryPicker && (files.length > 1 || total > 128 * 1024 * 1024);
}

function memorySink(meta) {
  const parts = [];
  return {
    write: (chunk) => { parts.push(chunk); },
    close: () => {
      const blob = new Blob(parts, { type: meta.type || 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = safeName(meta.name);
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    },
  };
}

async function diskSink(dirHandle, meta) {
  const handle = await dirHandle.getFileHandle(safeName(meta.name), { create: true });
  const writable = await handle.createWritable();
  const BATCH_SIZE = 2 * 1024 * 1024;
  let pending = [];
  let pendingBytes = 0;

  async function flush() {
    if (!pending.length) return;
    const blob = new Blob(pending);
    pending = [];
    pendingBytes = 0;
    await writable.write(blob);
  }

  return {
    write: async (chunk) => {
      pending.push(chunk);
      pendingBytes += chunk.byteLength;
      if (pendingBytes >= BATCH_SIZE) {
        await flush();
      }
    },
    flush,
    close: async () => {
      await flush();
      await writable.close();
    },
  };
}

async function acceptTransfer() {
  $('#accept').disabled = true;

  rx.makeSink = (meta) => memorySink(meta);
  if (supportsDirectPicker(rx.manifest)) {
    try {
      const dir = await window.showDirectoryPicker({ mode: 'readwrite', id: 'drop' });
      rx.makeSink = (meta) => diskSink(dir, meta);
    } catch {
      $('#offer-hint').textContent =
        'No folder chosen. Held in memory until the transfer completes.';
    }
  }

  $('#offer').hidden = true;
  rx.accepted = true;
  rx.row = makeProgressRow($('#recv-progress'), 'inbound');
  rx.row.state('arming…');
  if (rx.isCli) {
    rx.row.path('CLI stream');
    rx.row.state('downloading…');
    wsSend({ t: 'signal', data: { type: 'cli-accept' } });
    return;
  }
  watchPaths();
  sendHost({ k: 'accept' });
}

function routeSignal(from, data) {
  if (data.type === 'cli-offer') {
    rx.isCli = true;
    rx.manifest = data.manifest;
    rx.total = data.manifest.reduce((sum, f) => sum + f.size, 0);
    showOffer(data.manifest);
    setStatus('channel ready · CLI host', 'live');
    return;
  }
  if (data.type === 'cli-start') {
    onControl({ k: 'start', index: data.index, name: data.name, size: data.size, type: data.mime || '', from: 0 });
    return;
  }
  if (data.type === 'cli-end') {
    onControl({ k: 'end', index: data.index });
    return;
  }
  if (data.type === 'cli-done') {
    onControl({ k: 'done' });
    return;
  }
  if (document.body.dataset.view === 'send') {
    const conn = out.peers.get(from);
    if (conn) applySignal(conn, data).catch((err) => console.error('signal', err));
    return;
  }
  let conn = rx.links.get(from);
  if (!conn) {
    // Otro receptor de la sala se ofrece como nuestro eslabon de arriba.
    if (!data.sdp) return;      // ICE huerfano de un enlace que ya no existe
    conn = makeLink(from);
    conn.pc.ondatachannel = (e) => attachInbound(conn, e.channel);
    // Respaldo por si el aviso del emisor no llega (se ha ido el tambien).
    conn.pc.onconnectionstatechange = () => {
      const st = conn.pc.connectionState;
      if (st === 'failed' || st === 'closed') onUpstreamLost(conn);
    };
  }
  applySignal(conn, data).catch((err) => console.error('signal', err));
}

// ==================================================================== interfaz

const drop = $('#drop');
$('#file-input').onchange = (e) => { addFiles(e.target.files); e.target.value = ''; };
for (const evt of ['dragenter', 'dragover']) {
  drop.addEventListener(evt, (e) => { e.preventDefault(); drop.classList.add('over'); });
}
for (const evt of ['dragleave', 'drop']) {
  drop.addEventListener(evt, () => drop.classList.remove('over'));
}
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
});

$('#clear-files').onclick = () => { out.files = []; renderFileList(); };
$('#create-link').onclick = createLink;

async function copy(text, button, label) {
  try {
    await navigator.clipboard.writeText(text);
    const original = button.textContent;
    button.textContent = 'copied';
    setTimeout(() => { button.textContent = original; }, 1500);
  } catch {
    prompt(label, text);
  }
}
$('#copy-link').onclick = (e) => copy(shareUrl(), e.currentTarget, 'Copy the link:');
$('#link-out').onclick = (e) => e.currentTarget.select();
$('#restart').onclick = () => location.reload();
$('#accept').onclick = acceptTransfer;

// El token viaja en el fragmento (#...), que el navegador nunca manda al servidor:
// no queda en sus logs ni en el Referer. Si lo hay, esto es una descarga.
const token = location.hash.slice(1).replace(/[^A-Za-z0-9_-]/g, '');
if (token) {
  showView('recv');
  joinRoom(token);
}

// Enganche para el bench (app.js es un modulo: sin esto no hay forma de mirar el
// estado desde fuera). No expone nada que no este ya en la propia pagina.
window.__drop = { out, rx };

// Aviso si se cierra la pestaña con una transferencia a medias.
window.addEventListener('beforeunload', (e) => {
  const sending = [...out.peers.values()].some((c) => !c.cancelled && c.acked < totalBytes());
  const receiving = rx.row && rx.received > 0 && rx.received < rx.total;
  // Aunque ya hayamos terminado podemos seguir siendo el eslabon de alguien.
  const relaying = rx.down && rx.down.dc && rx.down.dc.readyState === 'open';
  if (sending || receiving || relaying) { e.preventDefault(); e.returnValue = ''; }
});
