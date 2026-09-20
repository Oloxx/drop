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
//
// CODIGO DE SALA
// El codigo es `4271-lemon-radar-tiger-orbit`. Al servidor solo sube `4271`; las
// cuatro palabras se quedan en esta pestania. Como acertar 4 digitos es cuestion
// de probar, el emisor no ensenia el manifiesto de archivos a nadie que no
// demuestre antes que conoce las palabras: manda un nonce (`challenge`) y espera
// un sha256 de nonce+secreto (`proof`). Ese hash es rapido de calcular, asi que
// es un verificador offline del secreto -- aqui es aceptable porque viaja por el
// DataChannel, que ya va cifrado por DTLS, y el codigo es de un solo uso. El
// CLI no manda nunca esta prueba por el camino TCP directo, donde si hay AES
// nuestro que proteger. Diseno completo en shared/codes.js.
//
// EMISOR CLI (relay por el servidor)
// Cuando quien envia es `drop send` los bytes no van por WebRTC: pasan por el
// WebSocket del servidor. Ahi la prueba de conocimiento y el cifrado son otros:
// esta pestania deriva la MISMA clave scrypt que el CLI (shared/scrypt.js), la
// prueba es un HMAC con esa clave (no un hash del secreto, que el servidor
// podria atacar offline) y cada trozo y cada marco de control llegan cifrados
// con AES-256-GCM. El servidor reenvia ruido. Detalle en shared/e2ee.js.

import { parseCode, randomSecretWords, formatCode, CodeError } from './shared/codes.js';
import { sasInput, sasWords, formatSas, dtlsFingerprints } from './shared/sas.js';
import { Sha256, sha256Hex } from './shared/sha256.js';
import { PROTOCOL_VERSION } from './shared/protocol.js';
import { encodeQr, qrToSvg, ECL } from './shared/qr.js';
import { deriveRoomKey, proofFromKey, sasFromKeyBytes, openBox, openerFor, unsealFrame, sealBox, sealFrame } from './shared/e2ee.js';

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

/** Misma formula que `secretProof` de cli/src/crypto.js: los dos extremos deben coincidir. */
function secretProof(nonce, secret) {
  return sha256Hex(`drop-proof-v2|${nonce}|${secret}`);
}

function fmtBytes(n) {
  // `null` es "no se sabe": un emisor CLI leyendo de stdin no tiene total.
  if (!Number.isFinite(n)) return '?';
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

// ------------------------------------------------------------------ avisos
//
// Una transferencia grande dura minutos y la gente se va a otra pestania. Al
// terminar suena una campanita corta sintetizada con la Web Audio API (ningun
// .mp3: la pagina sigue sin pedir nada a nadie) y, si la pestania no esta a la
// vista, se lanza una notificacion del sistema.
//
// El AudioContext se crea y el permiso se pide DENTRO de un click (aceptar la
// descarga, abrir el canal): fuera de un gesto del usuario el navegador deja el
// contexto suspendido y la peticion de permiso ni aparece.
const alerts = {
  enabled: true,
  ctx: null,
};
try { alerts.enabled = localStorage.getItem('drop.alerts') !== 'off'; } catch { /* sin storage: activado */ }

function paintAlertsToggle() {
  const el = $('#alerts-toggle');
  if (!el) return;
  el.textContent = alerts.enabled ? 'alerts on' : 'alerts off';
  el.classList.toggle('off', !alerts.enabled);
}

function armAlerts() {
  if (!alerts.enabled) return;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx && !alerts.ctx) alerts.ctx = new Ctx();
    if (alerts.ctx && alerts.ctx.state === 'suspended') alerts.ctx.resume().catch(() => {});
  } catch { /* sin audio: solo notificacion */ }
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {});
  }
}

/** Dos notas ascendentes (D5 -> A5), medio segundo, bajito. */
function chime() {
  const ctx = alerts.ctx;
  if (!ctx) return;
  try {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    const t = ctx.currentTime;
    osc.frequency.setValueAtTime(587.33, t);
    osc.frequency.exponentialRampToValueAtTime(880, t + 0.15);
    gain.gain.setValueAtTime(0.12, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.6);
    osc.start(t);
    osc.stop(t + 0.6);
  } catch { /* un aviso que falla no puede romper nada */ }
}

/** Fin de una transferencia (bien o mal): campanita, y notificacion si no nos ven. */
function alertFinished(text) {
  if (!alerts.enabled) return;
  chime();
  if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    try {
      const n = new Notification('drop', { body: text, tag: 'drop-transfer' });
      n.onclick = () => { window.focus(); n.close(); };
    } catch { /* idem */ }
  }
}

// -------------------------------------------------------------- señalizacion

let ws = null;
let iceConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

// Las credenciales del TURN caducan (las firma el servidor con una marca de
// tiempo dentro), asi que una pestana abierta muchas horas tiene que refrescarlas
// o se quedaria sin relay justo cuando lo necesita. Se relee de fondo: `iceConfig`
// sigue siendo la misma variable y crear la conexion sigue siendo sincrono.
function loadIceConfig() {
  return fetch('/config')
    .then((r) => r.json())
    .then((cfg) => { if (cfg.iceServers) iceConfig = cfg; })
    .catch(() => { /* nos quedamos con el STUN por defecto */ });
}

loadIceConfig();
setInterval(loadIceConfig, 60 * 60 * 1000);

function connectSignaling() {
  return new Promise((resolve, reject) => {
    if (ws && ws.readyState === WebSocket.OPEN) return resolve();
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { setStatus('uplink ok', 'live'); resolve(); };
    ws.onerror = () => reject(new Error('No route to the server'));
    ws.onclose = () => {
      setStatus('uplink lost', 'bad');
      if (rx.isCli && rx.row && rxIncomplete()) {
        rx.row.fail('uplink lost');
      }
    };
    ws.onmessage = (ev) => {
      // Binario por el websocket solo lo manda un emisor CLI: es un trozo
      // cifrado del relay. Los trozos WebRTC llegan por el DataChannel.
      if (typeof ev.data !== 'string') {
        cliInbound(ev.data);
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
    case 'guest':    onGuestJoined(msg.guestId, msg.name); break;
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
    reportSas(conn);
  } else if (data.ice) {
    if (pc.remoteDescription) await pc.addIceCandidate(data.ice).catch(() => {});
    else conn.pendingIce.push(data.ice);
  }
}

/**
 * Huella corta de la sesion, atada a los fingerprints DTLS de los dos extremos.
 *
 * ESTO ES LO QUE DETECTA UN MITM. El SDP pasa por el servidor, asi que un servidor
 * comprometido puede sustituir los fingerprints y hablar DTLS con cada lado por
 * separado. Si lo hace, cada extremo ve el certificado del intruso y no el del
 * otro: las huellas dejan de coincidir y basta con leerlas en voz alta para verlo.
 *
 * Por eso la huella NO viaja por el cable: se calcula aqui, con lo que ya hay en
 * las dos descripciones. Detalle completo en shared/sas.js.
 */
function reportSas(conn) {
  if (!conn.onSas) return;
  const fps = [
    ...dtlsFingerprints(conn.pc.localDescription && conn.pc.localDescription.sdp),
    ...dtlsFingerprints(conn.pc.remoteDescription && conn.pc.remoteDescription.sdp),
  ];
  if (fps.length < 2) return;      // todavia no estan las dos mitades
  try {
    conn.onSas(formatSas(sasWords(sha256Hex(sasInput('webrtc', fps)))));
  } catch {
    // Una huella que no se puede calcular no puede romper la transferencia.
  }
}

// ------------------------------------------------------------ interfaz: fila

function makeProgressRow(container, title) {
  const el = document.createElement('div');
  el.className = 'peer';
  el.innerHTML =
    '<div class="peer-head"><span class="who"></span><span class="state"></span></div>' +
    '<div class="bar"><i></i></div>' +
    '<div class="peer-file"><span class="grow"></span><span class="rate"></span></div>' +
    '<div class="peer-sas" hidden></div>';

  // Guardamos los nodos una vez: progress() se llama por cada trozo recibido y
  // buscarlos cada vez cuesta un ~10% del rendimiento de la transferencia.
  const elState = el.querySelector('.state');
  const elBar = el.querySelector('.bar > i');
  const elGrow = el.querySelector('.grow');
  const elRate = el.querySelector('.rate');
  const elWho = el.querySelector('.who');
  const elSas = el.querySelector('.peer-sas');
  elWho.textContent = title;
  container.appendChild(el);

  let lastBytes = 0;
  let lastTime = performance.now();
  let rate = 0;
  let pending = null;   // ultimo progreso sin pintar
  let frame = 0;
  let files = null;     // manifiesto, para decir en que archivo va (solo con varios)

  // En que archivo va y cuanto lleva de el, a partir del acumulado: los archivos
  // van en orden y sin huecos, asi que el total ya lo dice. Igual que fileAt en
  // cli/src/ui.js.
  function fileAt(done) {
    let offset = 0;
    for (let i = 0; i < files.length; i++) {
      const size = files[i].size || 0;
      if (done < offset + size || i === files.length - 1) {
        return { index: i, count: files.length, name: files[i].name, size, done: Math.max(0, Math.min(size, done - offset)) };
      }
      offset += size;
    }
    return null;
  }

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
    // Sin total (el emisor lee de stdin) no hay porcentaje ni ETA: solo lo que
    // ha llegado y a que ritmo. Una barra al 0% que no se mueve parece colgada.
    if (total == null) {
      elBar.style.width = '100%';
      elBar.classList.add('unknown');
      elState.textContent = fmtBytes(done) + ' · size unknown';
      elRate.textContent = rate > 0 ? fmtBytes(rate) + '/s' : '';
      return;
    }
    const pct = total ? (done / total) * 100 : 0;
    elBar.style.width = pct.toFixed(1) + '%';
    elState.textContent =
      Math.floor(pct) + '% · ' + fmtBytes(done) + ' / ' + fmtBytes(total);
    elRate.textContent =
      rate > 0 ? fmtBytes(rate) + '/s · ' + fmtEta((total - done) / rate) : '';
    // Con varios archivos, cual va y cuanto lleva: con un lote grande la barra
    // total parece parada y no dice ni cual es ni cuantos quedan.
    if (files && files.length > 1 && done < total) {
      const f = fileAt(done);
      if (f) {
        const fpct = f.size ? Math.min(100, Math.floor((f.done / f.size) * 100)) : 100;
        elGrow.textContent = `[${f.index + 1}/${f.count}] ${f.name} · ${fpct}% · ${fmtBytes(f.done)} / ${fmtBytes(f.size)}`;
      }
    }
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
    // El manifiesto: a partir de aqui progress() pinta tambien el archivo en curso.
    files(list) { files = list; },
    // Huella de la sesion: se compara de viva voz con la del otro extremo.
    sas(words) {
      elSas.textContent = 'fingerprint: ' + words;
      elSas.hidden = false;
    },
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
      elBar.classList.remove('unknown');
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
      if (conn.cli) continue;     // su camino es fijo: el relay del servidor
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
  roomId: null,       // identificador publico: es lo unico que sabe el servidor
  secret: null,       // las cuatro palabras: no salen de esta pestania
  code: null,         // `roomId-palabras`, lo que ve y dicta el usuario
  peers: new Map(),   // guestId -> conn
  nextLabel: 1,
  ready: [],          // han aceptado y esperan a que se forme la cadena
  batchTimer: 0,
  // Solo si entra un receptor CLI: la clave scrypt de la sala, con la que se le
  // cifra todo por el relay del servidor. Se deriva una vez, al primero.
  key: null,
  opener: null,
  keyPromise: null,
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
      '<span class="name"></span><span class="size"></span><span class="badge" hidden></span>' +
      (out.code ? '' : '<button class="drop-one" title="Remove">×</button>');
    li.querySelector('.name').textContent = relPathOf(file) || file.name;
    li.querySelector('.size').textContent = fmtBytes(file.size);
    if (file.sha256) {
      const badge = li.querySelector('.badge');
      badge.hidden = false;
      badge.className = 'badge verified';
      badge.textContent = '✔ SHA-256';
    }
    const del = li.querySelector('.drop-one');
    if (del) del.onclick = () => { out.files.splice(i, 1); renderFileList(); };
    list.appendChild(li);
  }
  $('#send-actions').hidden = out.files.length === 0 || !!out.code;
  $('#drop').hidden = !!out.code;
  $('#join-box').hidden = !!out.code;
}

/** Ruta relativa de un archivo dentro de la carpeta que se solto o eligio, o ''. */
function relPathOf(file) {
  return file.relPath || file.webkitRelativePath || '';
}

function addFiles(fileList) {
  for (const file of fileList) {
    const dup = out.files.some((f) => f.name === file.name && f.size === file.size && relPathOf(f) === relPathOf(file));
    if (!dup) out.files.push(file);
  }
  renderFileList();
}

/**
 * Una carpeta arrastrada llega como `FileSystemDirectoryEntry`: hay que bajar
 * por ella y pedir cada archivo. `readEntries` devuelve por tandas y hay que
 * seguir llamando hasta que venga una vacia, o Chrome deja la mitad fuera. A
 * cada File se le cuelga `relPath` (`carpeta/sub/archivo`), que es lo que
 * viaja en el manifiesto y lo que el receptor recrea.
 */
async function filesFromEntry(entry, prefix) {
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    file.relPath = prefix ? prefix + '/' + entry.name : '';
    return [file];
  }
  if (!entry.isDirectory) return [];
  const reader = entry.createReader();
  const all = [];
  for (;;) {
    const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) break;
    all.push(...batch);
  }
  const files = [];
  for (const child of all) files.push(...await filesFromEntry(child, prefix ? prefix + '/' + entry.name : entry.name));
  return files;
}

async function addDropped(dataTransfer) {
  const items = [...(dataTransfer.items || [])];
  const entries = items.map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null));
  if (!entries.some((e) => e && e.isDirectory)) {
    if (dataTransfer.files.length) addFiles(dataTransfer.files);
    return;
  }
  const files = [];
  for (const entry of entries) if (entry) files.push(...await filesFromEntry(entry, ''));
  addFiles(files);
}

async function createLink() {
  if (!out.files.length) return;
  $('#create-link').disabled = true;
  armAlerts();
  try {
    await connectSignaling();
    // `v:2` pide un identificador de sala de 4 digitos: las palabras las
    // sorteamos aqui y el servidor no las ve nunca.
    wsSend({ t: 'host', v: 2 });
  } catch (err) {
    $('#create-link').disabled = false;
    setStatus('no route to the server', 'bad');
  }
}

function shareUrl() {
  return location.origin + location.pathname + '#' + out.code;
}

function onHosted(roomId) {
  // El servidor nos ha dado la sala; las palabras las sorteamos aqui con
  // `crypto.getRandomValues` y nunca se las mandamos de vuelta.
  out.roomId = roomId;
  out.secret = randomSecretWords().join('-');
  out.code = formatCode(roomId, out.secret.split('-'));
  $('#ticket').hidden = false;
  $('#code-out').value = out.code;
  $('#link-out').value = shareUrl();
  $('#qr-box').hidden = true;
  $('#qr-box').innerHTML = '';
  $('#show-qr').setAttribute('aria-expanded', 'false');
  renderFileList();
  setStatus('channel open · waiting for peer', 'live');
}

function onGuestJoined(guestId, name) {
  // Un `drop recv` no habla WebRTC: se presenta como `cli` y se le sirve por
  // el relay del servidor, cifrado. Todo lo de abajo es para navegadores.
  if (name === 'cli') return onCliGuest(guestId);
  const label = 'peer ' + out.nextLabel++;
  const row = makeProgressRow($('#peers'), label);
  row.files(out.files);
  row.state('handshake…');

  const conn = {
    guestId,
    label,
    pc: new RTCPeerConnection(iceConfig),
    dc: null,
    pendingIce: [],
    row,
    onSas: (words) => row.sas(words),
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
    // Todavia no le ensenamos que archivos hay: primero que demuestre que sabe
    // las palabras. Acertar la sala son 4 digitos, y los nombres de archivo ya
    // son informacion. El nonce es nuevo por receptor.
    row.state('verifying code…');
    conn.nonce = [...crypto.getRandomValues(new Uint8Array(16))]
      .map((b) => b.toString(16).padStart(2, '0')).join('');
    conn.dc.send(JSON.stringify({ k: 'challenge', nonce: conn.nonce }));
  };

  conn.dc.onmessage = (ev) => {
    if (typeof ev.data !== 'string') return;
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.k === 'proof') {
      if (!conn.nonce) return;
      if (msg.proof !== secretProof(conn.nonce, out.secret)) {
        // No sabe las palabras: se le echa y se avisa al servidor, que quema la
        // sala si esto se repite (alguien esta probando codigos contra ella).
        conn.nonce = null;
        conn.cancelled = true;
        conn.rejected = true;
        row.fail('wrong code');
        wsSend({ t: 'bad-guest', guestId });
        try { conn.dc.close(); } catch { /* ya estaba cerrado */ }
        return;
      }
      conn.nonce = null;
      row.state('awaiting ack…');
      conn.dc.send(JSON.stringify({
        k: 'manifest',
        files: out.files.map((f) => ({ name: f.name, size: f.size, type: f.type, path: relPathOf(f) || undefined })),
      }));
      return;
    }
    if (conn.nonce) return;      // nada de protocolo antes de la prueba
    if (msg.k === 'accept') queueForStart(conn);
    else if (msg.k === 'ack') { conn.acked = msg.bytes; row.progress(msg.bytes, totalBytes()); }
    else if (msg.k === 'complete') {
      conn.acked = totalBytes(); row.file(''); row.finish('delivered');
      alertFinished(label + ' received the payload');
    }
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
  const idle = [...out.peers.values()].filter((c) => !c.started && !c.cancelled && !c.cli);
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
  console.warn('drop: relay chain did not come up, serving everyone directly');
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
        k: 'start', index, name: file.name, size: file.size, type: file.type, from, path: relPathOf(file) || undefined,
      }));

      const hasher = new Sha256();
      if (from > 0 && !file.sha256) {
        const prefixBuf = await file.slice(0, from).arrayBuffer();
        hasher.update(prefixBuf);
      }

      const READ_BLOCK = 2 * 1024 * 1024;
      let offset = from;
      while (offset < file.size) {
        if (conn.cancelled || conn.epoch !== epoch || dc.readyState !== 'open') return;
        if (conn.paused) await waitForResume(conn);
        if (dc.bufferedAmount > HIGH_WATER) await waitForDrain(dc);

        const blockEnd = Math.min(offset + READ_BLOCK, file.size);
        const blockBuf = await file.slice(offset, blockEnd).arrayBuffer();
        if (conn.cancelled || conn.epoch !== epoch || dc.readyState !== 'open') return;

        if (!file.sha256) hasher.update(blockBuf);

        for (let blockOff = 0; blockOff < blockBuf.byteLength; blockOff += chunk) {
          if (conn.cancelled || conn.epoch !== epoch || dc.readyState !== 'open') return;
          if (conn.paused) await waitForResume(conn);
          if (dc.bufferedAmount > HIGH_WATER) await waitForDrain(dc);
          const slice = blockBuf.slice(blockOff, Math.min(blockOff + chunk, blockBuf.byteLength));
          dc.send(slice);
        }
        offset = blockEnd;
      }
      const sha256 = file.sha256 || hasher.digest();
      file.sha256 = sha256;
      renderFileList();
      dc.send(JSON.stringify({ k: 'end', index, sha256 }));
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
  // A quien echamos por no saber el codigo ya le hemos puesto su motivo: si lo
  // pisamos con 'gone' el emisor no llega a ver por que se fue.
  else if (!conn.rejected) conn.row.fail(why);
  if (conn.pc) conn.pc.close();
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

// ===================================================== EMISOR -> receptor CLI
//
// Un `drop recv` no habla WebRTC. Cuando entra en la sala se presenta como
// `cli` (el `name` del join) y se le sirve por el relay del servidor con el
// mismo protocolo que usa `drop send` hacia un navegador -- descrito entero en
// cli/src/transfer.js, encima de receiveFromRelay -- y el mismo cifrado
// (shared/e2ee.js): reto y prueba HMAC con la clave scrypt, manifiesto y marcos
// de control sellados, trozos en AES-256-GCM y la ventana de acuses que mueve el
// envio. Es lo que completa la matriz: cualquiera recibe de cualquiera.
//
// El servidor reenvia los frames binarios al receptor que diga la cabecera de
// 4 bytes (guestId) y se la quita; para el son ruido con destino.

const CLI_CHUNK = 64 * 1024;                 // como el CLI: cabe de sobra en maxPayload
const CLI_MAX_IN_FLIGHT = 8 * 1024 * 1024;   // sin confirmar por acuse
const CLI_WS_HIGH = 4 * 1024 * 1024;         // bufferedAmount del websocket
const CLI_IDLE_TIMEOUT = 60_000;             // sin acuses ni drenado: se da por perdido

function hostKey() {
  if (!out.keyPromise) {
    out.keyPromise = deriveRoomKey(out.roomId, out.secret).then(async (key) => {
      out.key = key;
      out.opener = await openerFor(key);
      return out.opener;
    });
  }
  return out.keyPromise;
}

function onCliGuest(guestId) {
  const label = 'peer ' + out.nextLabel++;
  const row = makeProgressRow($('#peers'), label);
  row.files(out.files);
  row.state('deriving key…');
  row.path('cli · relayed · e2e');

  const conn = {
    guestId,
    label,
    cli: true,
    row,
    acked: 0,
    sent: 0,
    total: 0,
    cancelled: false,
    started: false,
    nonce: null,
    notify: null,
    lastProgress: 0,
    lastBuffered: 0,
  };
  out.peers.set(guestId, conn);

  hostKey().then(() => {
    if (conn.cancelled) return;
    // Mismo reto que a un navegador, pero la prueba que esperamos es el HMAC
    // con la clave: esta cruza el servidor y un hash del secreto seria un
    // verificador offline barato (shared/e2ee.js).
    conn.nonce = [...crypto.getRandomValues(new Uint8Array(16))]
      .map((b) => b.toString(16).padStart(2, '0')).join('');
    row.state('verifying code…');
    wsSend({
      t: 'signal', to: guestId,
      data: { type: 'cli-offer', v: PROTOCOL_VERSION, ips: [], port: 0, upnp: false, nonce: conn.nonce, web: true },
    });
  }).catch((err) => { console.error('key', err); row.fail('key error'); });
}

async function sealedTo(conn, obj) {
  wsSend({ t: 'signal', to: conn.guestId, data: await sealFrame(out.opener, obj) });
}

function wakeCli(conn) {
  const notify = conn.notify;
  conn.notify = null;
  if (notify) notify();
}

function onCliSignal(from, data) {
  const conn = out.peers.get(from);
  if (!conn || !conn.cli) return;
  const { row } = conn;
  switch (data.type) {
    case 'cli-proof': {
      if (!conn.nonce) return;
      const nonce = conn.nonce;
      conn.nonce = null;
      // Otra version es otra prueba y otro cifrado: no es alguien probando
      // codigos, asi que no se denuncia; se le dice que actualice.
      if (data.v !== PROTOCOL_VERSION) {
        row.fail('old drop · ask them to update');
        wsSend({ t: 'signal', to: from, data: { type: 'cli-denied', reason: 'VERSION', v: PROTOCOL_VERSION } });
        return;
      }
      if (data.proof !== proofFromKey(out.key, nonce)) {
        conn.cancelled = true;
        conn.rejected = true;
        row.fail('wrong code');
        wsSend({ t: 'bad-guest', guestId: from });
        return;
      }
      row.state('awaiting ack…');
      sealedTo(conn, {
        type: 'cli-manifest',
        v: PROTOCOL_VERSION,
        manifest: out.files.map((f) => ({
          name: f.name, size: f.size, type: f.type || 'application/octet-stream', path: relPathOf(f) || undefined,
        })),
      });
      return;
    }
    case 'cli-accept':
      streamToCli(conn);
      return;
    case 'cli-ack':
      conn.acked = Math.max(conn.acked, data.bytes | 0);
      conn.lastProgress = Date.now();
      wakeCli(conn);
      row.progress(Math.min(conn.acked, conn.total), conn.total);
      return;
    case 'cli-complete':
      // Solo llega con todo escrito y verificado al otro lado.
      conn.acked = conn.total;
      wakeCli(conn);
      row.file('');
      row.finish('delivered');
      alertFinished(conn.label + ' (cli) received the payload');
      return;
    case 'cli-error':
      conn.cancelled = true;
      wakeCli(conn);
      row.fail('aborted by peer');
      return;
    default:
      // `cli-retry` lo manda solo el receptor web hacia un emisor CLI; un
      // receptor CLI no reintenta. Cualquier otra cosa se ignora.
  }
}

/** Espera a que haya hueco en la ventana de acuses y en el buffer del websocket. */
function cliWindow(conn) {
  return new Promise((resolve) => {
    const check = () => {
      if (conn.cancelled) return resolve();
      // El buffer vaciandose tambien es senal de vida: en un enlace lento los
      // acuses tardan, pero mientras salgan bytes no hay nada roto.
      if (ws.bufferedAmount < conn.lastBuffered) conn.lastProgress = Date.now();
      conn.lastBuffered = ws.bufferedAmount;
      if (Date.now() - conn.lastProgress > CLI_IDLE_TIMEOUT) {
        conn.cancelled = true;
        conn.row.fail('peer stalled');
        return resolve();
      }
      if (conn.sent - conn.acked <= CLI_MAX_IN_FLIGHT && ws.bufferedAmount <= CLI_WS_HIGH) return resolve();
      conn.notify = check;
      setTimeout(check, 50);
    };
    check();
  });
}

async function streamToCli(conn) {
  if (conn.started || conn.cancelled) return;
  conn.started = true;
  const { row } = conn;
  conn.total = totalBytes();
  conn.lastProgress = Date.now();
  row.state('transmitting…');

  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, conn.guestId);

  try {
    for (const [index, file] of out.files.entries()) {
      if (conn.cancelled) return;
      row.file(file.name);
      await sealedTo(conn, {
        type: 'cli-start', index, name: file.name, size: file.size, mime: file.type || 'application/octet-stream',
        path: relPathOf(file) || undefined,
      });

      const hasher = new Sha256();
      const READ_BLOCK = 2 * 1024 * 1024;
      for (let offset = 0; offset < file.size;) {
        const blockBuf = await file.slice(offset, Math.min(offset + READ_BLOCK, file.size)).arrayBuffer();
        if (conn.cancelled) return;
        if (!file.sha256) hasher.update(blockBuf);
        for (let off = 0; off < blockBuf.byteLength; off += CLI_CHUNK) {
          await cliWindow(conn);
          if (conn.cancelled || !ws || ws.readyState !== WebSocket.OPEN) return;
          const slice = new Uint8Array(blockBuf, off, Math.min(CLI_CHUNK, blockBuf.byteLength - off));
          const box = await sealBox(out.opener, slice);
          const packet = new Uint8Array(4 + box.length);
          packet.set(header, 0);
          packet.set(box, 4);
          ws.send(packet);
          conn.sent += slice.byteLength;
        }
        offset += blockBuf.byteLength;
      }
      const sha256 = file.sha256 || hasher.digest();
      file.sha256 = sha256;
      renderFileList();
      await sealedTo(conn, { type: 'cli-end', index, sha256 });
    }
    await sealedTo(conn, { type: 'cli-done' });
    row.file('');
    row.progress(Math.min(conn.acked, conn.total), conn.total);
    row.state('flushing…');
  } catch (err) {
    console.error(err);
    row.fail('read error');
  }
}

// =========================================================== RECEPTOR (guest)

const rx = {
  guestId: 0,
  secret: null,       // las palabras del codigo: solo viven aqui
  roomId: null,
  code: null,
  // Solo con emisor CLI: la clave de la sala, el descifrador ya importado y la
  // cola que mantiene en orden marcos y trozos mientras se descifran.
  key: null,
  opener: null,
  sas: null,
  cliQueue: Promise.resolve(),
  cliBroken: false,
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
  fileHasher: null,
  hasIntegrityError: false,
};

/**
 * Un enlace con otro navegador. `peerId` 0 es el emisor; cualquier otro es un
 * receptor de la misma sala, y entonces la senalizacion va dirigida por id.
 */
function makeLink(peerId) {
  const conn = {
    peerId,
    // Solo interesa la huella del enlace con el emisor: los eslabones de la cadena
    // reenvian bytes que ya vienen del emisor y no aportan nada que comparar.
    onSas: peerId === 0 ? showSas : null,
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

/**
 * Entra en una sala a partir del codigo completo. Al servidor solo sube el
 * identificador publico: las palabras se guardan aqui para responder al reto del
 * emisor y no se mandan por ningun sitio.
 */
function joinWithCode(code) {
  // Lanza CodeError si no cuadra, antes de tocar la red. En ingles: es lo que
  // habla esta pagina, y el mensaje se ensena tal cual.
  const parsed = parseCode(code, { lang: 'en' });
  rx.code = parsed.code;
  rx.secret = parsed.secret;
  rx.roomId = parsed.roomId;
  showView('recv');
  return connectAndJoin(parsed);
}

async function connectAndJoin(parsed) {
  $('#recv-title').textContent = 'handshake…';
  $('#join-error').hidden = true;
  $('#retry-box').hidden = true;
  try {
    await connectSignaling();
    wsSend({ t: 'join', token: parsed.roomId });
    setStatus('locating peer…');
  } catch {
    onJoinError('NO_SERVER');
  }
}

const JOIN_ERRORS = {
  NOT_FOUND: 'Channel closed: the sender shut their tab, or the code is wrong. Ask for a fresh one.',
  RATE_LIMITED: 'Too many failed attempts from this network. Wait a minute and try again.',
  BAD_SECRET: 'The sender rejected the code: the words do not match.',
  BURNED: 'The room was closed after several wrong codes.',
  ROOM_FULL: 'This channel already has all the receivers it takes. Ask the sender to open another.',
  TOO_MANY_ROOMS: 'Too many channels opened from this network. Wait a minute and try again.',
  EXPIRED: 'Channel expired: it sat idle too long. Ask for a fresh one.',
  FLOOD: 'The server cut the connection: too many messages.',
  VERSION: 'This page is too old for the server. Reload it.',
};

// Lo que ve el emisor cuando el servidor le cierra la sala por su cuenta.
const HOST_ERRORS = {
  BURNED: 'room closed · wrong codes tried',
  EXPIRED: 'channel expired · idle',
  TOO_MANY_ROOMS: 'too many channels · wait a minute',
  FLOOD: 'disconnected · too many messages',
  VERSION: 'page too old · reload',
};

function onJoinError(reason) {
  if (out.code) {
    // Somos el emisor: el servidor nos avisa de que ha cerrado la sala.
    setStatus(HOST_ERRORS[reason] || 'server error', 'bad');
    return;
  }
  $('#recv-title').textContent = 'dead link';
  const el = $('#join-error');
  el.hidden = false;
  el.textContent = JOIN_ERRORS[reason] || 'No route to the server.';
  $('#retry-box').hidden = false;
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
  if (rx.finished) return;
  setStatus('peer dropped', 'bad');
  // La sala muere con el emisor, pero los canales P2P no: si nos alimenta otro
  // receptor puede quedarle cola por entregarnos y esto todavia puede acabar.
  if (rx.up && rx.up.peerId !== 0) return;
  if (rx.row && rxIncomplete()) rx.row.fail('severed');
}

/**
 * Sigue llegando algo. Con un total conocido es que faltan bytes; sin total
 * (emisor CLI leyendo de stdin, `size: null`) lo unico que dice que ha
 * terminado es el `done` del emisor.
 */
function rxIncomplete() {
  if (rx.finished) return false;
  return rx.total == null || rx.received < rx.total;
}

/** Suma del manifiesto, o `null` si algun archivo no trae tamano. */
function totalOf(files) {
  let total = 0;
  for (const f of files) {
    if (!Number.isFinite(f.size)) return null;
    total += f.size;
  }
  return total;
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
    // El emisor no ensenia nada hasta que demostramos que sabemos las palabras.
    case 'challenge':
      sendHost({ k: 'proof', proof: secretProof(msg.nonce, rx.secret || '') });
      break;

    case 'manifest':
      rx.manifest = msg.files;
      rx.total = totalOf(msg.files);
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
      if (!msg.from || !rx.fileHasher) {
        rx.fileHasher = new Sha256();
      }
      rx.writes = rx.writes.then(async () => {
        // Al retomar seguimos escribiendo donde estabamos: crear el destino otra
        // vez truncaria lo que ya hay guardado.
        if (!msg.from) rx.sink = await rx.makeSink(msg);
        if (rx.row) rx.row.file(msg.name);
      });
      break;

    case 'end':
      rx.writes = rx.writes.then(async () => {
        const calculated = rx.fileHasher ? rx.fileHasher.digest() : null;
        const expected = msg.sha256;
        const verified = !expected || (calculated === expected);

        if (!verified) {
          console.error(`SHA-256 mismatch for file ${msg.index}: expected ${expected}, got ${calculated}`);
          rx.hasIntegrityError = true;
          if (rx.sink && rx.sink.abort) await rx.sink.abort();
          else if (rx.sink) await rx.sink.close();
          rx.sink = null;
          handleIntegrityFailure(msg.index, expected, calculated);
          return;
        }

        if (rx.sink) await rx.sink.close();
        rx.sink = null;
        handleFileVerified(msg.index, calculated || expected);
      });
      break;

    case 'done':
      rx.writes = rx.writes.then(() => {
        if (rx.hasIntegrityError) return;
        rx.finished = true;
        if (rx.isCli) {
          wsSend({ t: 'signal', data: { type: 'cli-complete' } });
        } else {
          sendHost({ k: 'complete' });
        }
        if (rx.row) { rx.row.file(''); rx.row.finish('received · ✔ verified (SHA-256)'); }
        setStatus('transfer complete', 'live');
        alertFinished('transfer complete · ' + fmtBytes(rx.received) + ' verified');
      });
      break;
  }
}

function onChunk(buffer) {
  rx.received += buffer.byteLength;
  rx.fileGot += buffer.byteLength;
  if (rx.fileHasher) rx.fileHasher.update(buffer);
  rx.writes = rx.writes.then(() => rx.sink && rx.sink.write(buffer));
  if (rx.row) rx.row.progress(rx.received, rx.total);
  // Sin total conocido el ultimo acuse lo da el `cli-complete` del `done`.
  const atEnd = rx.total != null && rx.received >= rx.total;
  if (rx.isCli) {
    if (rx.received - rx.lastAck >= ACK_EVERY || atEnd) {
      rx.lastAck = rx.received;
      wsSend({ t: 'signal', data: { type: 'cli-ack', bytes: rx.received } });
    }
    return;
  }
  if (rx.received - rx.lastAck >= ACK_EVERY || atEnd) {
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

/**
 * Pinta la huella en el bloque de la oferta, para poder compararla ANTES de
 * aceptar la descarga.
 */
function showSas(words) {
  const el = $('#offer-sas');
  el.textContent = 'session fingerprint: ' + words + ' — must match the sender';
  el.hidden = false;
}

function showOffer(files) {
  $('#recv-title').textContent = 'incoming payload';
  $('#offer').hidden = false;
  $('#offer-title').textContent =
    files.length + (files.length === 1 ? ' file' : ' files') + ' · ' + (rx.total == null ? 'size unknown' : fmtBytes(rx.total));
  const list = $('#offer-list');
  list.innerHTML = '';
  for (const file of files) {
    const li = document.createElement('li');
    li.innerHTML = '<span class="name"></span><span class="size"></span><span class="badge" hidden></span>';
    li.querySelector('.name').textContent = file.path || file.name;
    li.querySelector('.size').textContent = Number.isFinite(file.size) ? fmtBytes(file.size) : 'stream';
    list.appendChild(li);
  }
  $('#offer-hint').textContent = supportsDirectPicker(files)
    ? 'You will be asked for a folder. Written straight to disk, no buffering.'
    : 'Downloads start on their own once complete.';
  // Si el worker esta, lo grande no se acumula en memoria: se dice, porque es
  // lo que decide si alguien se atreve con un video en el movil.
  if (!supportsDirectPicker(files)) {
    swReady.then((reg) => {
      if (reg && files.some((f) => f.size == null || f.size >= SW_MIN)) {
        $('#offer-hint').textContent = 'Streamed to your downloads folder as it arrives.';
      }
    });
  }
  setStatus('channel up', 'live');
}

function handleFileVerified(index, hash) {
  const items = document.querySelectorAll('#offer-list li');
  if (items[index]) {
    const badge = items[index].querySelector('.badge');
    if (badge) {
      badge.hidden = false;
      badge.className = 'badge verified';
      badge.textContent = '✔ verified (SHA-256)';
    }
  }
  if (rx.row) {
    const name = rx.manifest && rx.manifest[index] ? rx.manifest[index].name : '';
    rx.row.file(name ? `${name} · ✔ verified (SHA-256)` : '✔ verified (SHA-256)');
  }
}

function handleIntegrityFailure(index, expected, calculated) {
  const items = document.querySelectorAll('#offer-list li');
  if (items[index]) {
    const badge = items[index].querySelector('.badge');
    if (badge) {
      badge.hidden = false;
      badge.className = 'badge failed';
      badge.textContent = '✖ integrity failed (SHA-256)';
    }
  }
  const name = rx.manifest && rx.manifest[index] ? rx.manifest[index].name : 'file';
  if (rx.row) {
    rx.row.fail('SHA-256 integrity error');
  }
  alertFinished('integrity check failed on ' + name);
  const alertEl = $('#verify-alert');
  if (alertEl) {
    alertEl.hidden = false;
    const msgEl = $('#verify-error-msg');
    if (msgEl) {
      msgEl.textContent = `Integrity mismatch in "${name}". Expected hash: ${expected?.slice(0, 12)}… got: ${calculated?.slice(0, 12)}…`;
    }
    const retryBtn = $('#retry-transfer');
    if (retryBtn) {
      retryBtn.textContent = `retry ${name}`;
      retryBtn.onclick = () => retryFile(index);
    }
  }
  setStatus('integrity discrepancy', 'bad');
}

function retryFile(index) {
  const alertEl = $('#verify-alert');
  if (alertEl) alertEl.hidden = true;
  rx.hasIntegrityError = false;
  rx.finished = false;
  rx.fileIndex = index;
  rx.fileGot = 0;
  rx.fileHasher = new Sha256();
  rx.sink = null;
  if (rx.row) {
    rx.row.closed = false;
    rx.row.el.classList.remove('failed');
    rx.row.state('retrying…');
  }
  if (rx.isCli) {
    wsSend({ t: 'signal', data: { type: 'cli-retry', index } });
  } else {
    sendHost({ k: 'resume', index, offset: 0 });
  }
}

// Con varios archivos o mucho volumen escribimos a disco en streaming; para un
// archivo pequeño la descarga normal del navegador es más cómoda (y funciona en
// Firefox y Safari, que no tienen la File System Access API).
function supportsDirectPicker(files) {
  const total = totalOf(files);
  // Una carpeta solo se puede recrear escribiendo a disco: sin la API, cada
  // archivo baja suelto con su nombre (el navegador no crea carpetas en Descargas).
  const hasFolders = files.some((f) => f.path && f.path.includes('/'));
  // Sin tamano (stdin del CLI) puede ser cualquier cosa: mejor a disco.
  return !!window.showDirectoryPicker && (files.length > 1 || hasFolders || total == null || total > 128 * 1024 * 1024);
}

// ------------------------------------------ descarga en streaming por Service Worker
//
// Sin File System Access (Firefox, Safari, todo iOS) el receptor acumulaba
// cada archivo entero en memoria y lo soltaba como Blob al final: con un video
// de 2 GB hacia un iPhone la pestana moria sin mensaje. Con el worker
// (public/sw.js) la descarga es una respuesta HTTP en streaming que el
// navegador escribe a disco segun llega, con memoria constante. A partir de
// SW_MIN bytes -- o sin tamano conocido -- se usa si esta disponible; por
// debajo la descarga normal por Blob es mas comoda y esta mas probada.

const SW_MIN = 32 * 1024 * 1024;

// Registro del worker. Solo en contexto seguro (HTTPS o localhost) y solo si el
// navegador lo tiene: si falla, `swReady` resuelve a null y se cae al Blob.
const swReady = (async () => {
  if (!window.isSecureContext || !('serviceWorker' in navigator) || typeof ReadableStream === 'undefined') return null;
  try {
    const reg = await navigator.serviceWorker.register('sw.js', { scope: './' });
    // `register` devuelve antes de que el worker controle la pagina; la primera
    // descarga tiene que esperar a que este activo o el iframe iria a la red.
    const sw = reg.active || reg.waiting || reg.installing;
    if (!sw) return null;
    if (sw.state !== 'activated') {
      await new Promise((resolve) => {
        const check = () => { if (sw.state === 'activated' || sw.state === 'redundant') resolve(); };
        sw.addEventListener('statechange', check);
        check();
      });
    }
    if (sw.state !== 'activated') return null;
    if (!navigator.serviceWorker.controller) {
      // Primera visita: el worker se ha activado pero esta pagina todavia no
      // esta bajo su control hasta que `clients.claim()` termina.
      await new Promise((resolve) => {
        if (navigator.serviceWorker.controller) return resolve();
        navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true });
        setTimeout(resolve, 3000);
      });
    }
    return navigator.serviceWorker.controller ? reg : null;
  } catch (err) {
    console.warn('service worker', err);
    return null;
  }
})();

// Pings al worker mientras haya descargas en curso: algunos navegadores lo
// matan si lleva un rato sin atender peticiones, y con el se iria el stream.
let swPinger = null;
let swDownloads = 0;
function swKeepAlive(delta) {
  swDownloads += delta;
  if (swDownloads > 0 && !swPinger) {
    swPinger = setInterval(() => { fetch('__drop-download/ping', { cache: 'no-store' }).catch(() => {}); }, 10_000);
  } else if (swDownloads <= 0 && swPinger) {
    clearInterval(swPinger);
    swPinger = null;
    swDownloads = 0;
  }
}

function swSink(reg, meta) {
  const id = crypto.randomUUID();
  const { port1, port2 } = new MessageChannel();
  let credits = 0;
  let wake = null;
  let cancelled = false;
  let ready = null;
  const readyPromise = new Promise((resolve) => { ready = resolve; });

  port1.onmessage = (ev) => {
    const msg = ev.data;
    if (!msg) return;
    if (msg.type === 'ready') { credits = msg.credits; ready(); }
    else if (msg.type === 'pull') { credits++; if (wake) { const w = wake; wake = null; w(); } }
    else if (msg.type === 'cancel') { cancelled = true; if (wake) { const w = wake; wake = null; w(); } }
  };

  // Una carpeta baja archivo a archivo: el navegador no crea carpetas en
  // Descargas, asi que va el nombre suelto.
  const name = safeName(meta.name);
  const size = Number.isFinite(meta.size) ? meta.size : null;
  reg.active.postMessage({ type: 'drop-stream', id, name, size, mime: meta.type || '' }, [port2]);

  // El iframe es lo que dispara el dialogo de descarga: navega a la URL que
  // solo el worker sabe contestar. Se quita al terminar, o al fallar.
  const frame = document.createElement('iframe');
  frame.hidden = true;
  frame.setAttribute('aria-hidden', 'true');
  const opened = readyPromise.then(() => {
    frame.src = '__drop-download/' + id;
    document.body.appendChild(frame);
    swKeepAlive(+1);
  });
  const cleanup = () => {
    swKeepAlive(-1);
    setTimeout(() => frame.remove(), 5000);
    port1.close();
  };

  return {
    write: async (chunk) => {
      await opened;
      while (credits <= 0 && !cancelled) await new Promise((resolve) => { wake = resolve; });
      if (cancelled) throw new Error('download cancelled in the browser');
      credits--;
      // Se copia (structured clone), no se transfiere: el trozo puede estar
      // reenviandose a otro receptor de la cadena. Una vista sobre un buffer
      // mayor se recorta antes, o el clon se llevaria el buffer entero.
      const data = chunk instanceof ArrayBuffer ? chunk
        : (chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength) ? chunk.buffer
          : chunk.slice().buffer;
      port1.postMessage({ type: 'chunk', data });
    },
    abort: async () => {
      await opened;
      port1.postMessage({ type: 'abort' });
      cleanup();
    },
    close: async () => {
      await opened;
      port1.postMessage({ type: 'end' });
      cleanup();
    },
  };
}

function memorySink(meta) {
  let parts = [];
  return {
    write: (chunk) => { parts.push(chunk); },
    abort: () => { parts = []; },
    close: () => {
      if (!parts.length && meta.size > 0) return;
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
  // Con carpetas se baja tramo a tramo creando lo que falte. Cada tramo pasa
  // por safeName, que ademas convierte `..` en `_`: no hay forma de subir.
  let dir = dirHandle;
  const parts = String(meta.path || '').split('/').filter(Boolean);
  for (const seg of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(safeName(seg), { create: true });
  const leaf = parts.length ? parts[parts.length - 1] : meta.name;
  const handle = await dir.getFileHandle(safeName(leaf), { create: true });
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
    abort: async () => {
      pending = [];
      try { await writable.abort(); } catch {}
    },
    close: async () => {
      await flush();
      await writable.close();
    },
  };
}

async function acceptTransfer() {
  $('#accept').disabled = true;
  armAlerts();

  rx.makeSink = (meta) => memorySink(meta);
  // Sin carpeta elegida, los archivos grandes (o de tamano desconocido) van por
  // el worker en streaming si lo hay; el resto, por Blob como siempre.
  const reg = await swReady;
  if (reg) {
    rx.makeSink = (meta) => ((meta.size == null || meta.size >= SW_MIN) ? swSink(reg, meta) : memorySink(meta));
  }
  if (supportsDirectPicker(rx.manifest)) {
    try {
      const dir = await window.showDirectoryPicker({ mode: 'readwrite', id: 'drop' });
      rx.makeSink = (meta) => diskSink(dir, meta);
    } catch {
      const isHuge = rx.total == null || rx.total > 500 * 1024 * 1024;
      $('#offer-hint').textContent = reg
        ? 'No folder chosen. Streamed to your downloads folder as it arrives.'
        : isHuge
          ? 'Warning: large file held in RAM. Choosing a folder is recommended to avoid browser crashes.'
          : 'No folder chosen. Held in memory until the transfer completes.';
    }
  }

  const actions = $('#offer-actions');
  if (actions) actions.hidden = true;
  const hint = $('#offer-hint');
  if (hint) hint.hidden = true;
  rx.accepted = true;
  rx.row = makeProgressRow($('#recv-progress'), 'inbound');
  rx.row.files(rx.manifest);
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

// Lado RECEPTOR WEB del protocolo de relay del CLI (los mensajes `cli-*`): el
// emisor es un `drop send` y los bytes pasan por el servidor porque el
// navegador no habla el TCP del CLI. El protocolo esta descrito entero en
// cli/src/transfer.js, encima de receiveFromRelay; aqui hay que mantener sobre
// todo el `cli-ack` cada ACK_EVERY, que es lo que mueve la ventana del emisor.
//
// Descifrar es asincrono y el orden entre marcos y trozos ES el protocolo (un
// `cli-start` va delante de sus bytes, un `cli-end` detras del ultimo): por eso
// todo lo que llega del emisor CLI pasa por una sola cola, en fila. Un fallo de
// autenticacion la para: o lo ha tocado alguien por el camino o la clave no es
// la misma, y en los dos casos lo que toca es cortar, no adivinar.
function cliEnqueue(job) {
  rx.cliQueue = rx.cliQueue.then(() => (rx.cliBroken ? null : job())).catch((err) => {
    console.error('cli relay', err);
    rx.cliBroken = true;
    if (rx.row && !rx.finished) rx.row.fail('decrypt error');
    setStatus('relay frame failed to authenticate', 'bad');
    wsSend({ t: 'signal', data: { type: 'cli-error', message: String((err && err.message) || err) } });
  });
}

/** Trozo binario del relay: se descifra y sigue el camino de siempre. */
function cliInbound(packet) {
  cliEnqueue(async () => {
    if (!rx.opener) throw new Error('chunk before key');
    onChunk(await openBox(rx.opener, packet));
  });
}

// Lo demas que pasa por aqui es la senializacion normal de WebRTC entre pares.
function routeSignal(from, data) {
  // Como EMISOR, todo `cli-*` viene de un receptor CLI al que servimos nosotros.
  if (document.body.dataset.view === 'send' && typeof data.type === 'string' && data.type.startsWith('cli-')) {
    onCliSignal(from, data);
    return;
  }
  if (data.type === 'cli-offer') {
    rx.isCli = true;
    // La oferta es lo unico que llega en claro y trae la version. Otra version
    // es otro cifrado y otra prueba: no se intenta entender a medias.
    if (data.v !== PROTOCOL_VERSION) {
      const theirs = data.v == null ? '0 (drop before 0.5.0)' : data.v;
      $('#recv-title').textContent = 'version mismatch';
      $('#join-error').hidden = false;
      $('#join-error').textContent =
        `The sender runs protocol v${theirs} and this page speaks v${PROTOCOL_VERSION}. Ask them to run \`drop update\`.`;
      setStatus('incompatible sender', 'bad');
      return;
    }
    // La clave se deriva con scrypt aqui mismo (~0,3 s, cede el hilo): con ella
    // se responde al reto y se abrira todo lo que el emisor mande despues.
    setStatus('deriving key…', 'live');
    cliEnqueue(async () => {
      const key = await deriveRoomKey(rx.roomId, rx.secret || '');
      rx.key = key;
      rx.opener = await openerFor(key);
      rx.sas = sasFromKeyBytes(key, rx.roomId);
      setStatus('verifying code…', 'live');
      wsSend({ t: 'signal', data: { type: 'cli-proof', v: PROTOCOL_VERSION, proof: proofFromKey(key, data.nonce || '') } });
    });
    return;
  }
  // Todo lo demas que manda un emisor CLI viene sellado con la clave de la sala.
  // Se abre en la cola, detras de lo que ya hubiera, y se despacha con su tipo.
  if (data.type === 'cli-sealed') {
    cliEnqueue(async () => routeSignal(from, await unsealFrame(rx.opener, data)));
    return;
  }
  // El emisor ha dicho que no. El codigo era correcto: esto no es un fallo de
  // emparejamiento, asi que se dice tal cual.
  if (data.type === 'cli-denied') {
    setStatus('sender declined', 'error');
    $('#join-error').hidden = false;
    $('#join-error').textContent = data.reason === 'VERSION'
      ? `The sender runs protocol v${data.v} and this page speaks v${PROTOCOL_VERSION}. Ask them to run \`drop update\`.`
      : 'The sender did not authorize this download.';
    return;
  }
  if (data.type === 'cli-manifest') {
    rx.manifest = data.manifest || [];
    rx.total = totalOf(rx.manifest);
    showOffer(rx.manifest);
    // La huella sale de la clave, y ahora por relay se cifra con esa misma
    // clave: significa lo mismo que por TCP directo entre dos CLI.
    $('#offer-sas').textContent = 'session fingerprint: ' + rx.sas + ' — must match the sender';
    $('#offer-sas').hidden = false;
    setStatus('channel ready · CLI host', 'live');
    return;
  }
  if (data.type === 'cli-start') {
    onControl({ k: 'start', index: data.index, name: data.name, size: data.size, type: data.mime || '', from: 0, path: data.path });
    return;
  }
  if (data.type === 'cli-end') {
    onControl({ k: 'end', index: data.index, sha256: data.sha256 });
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
  addDropped(e.dataTransfer).catch((err) => console.error('drop', err));
});
$('#folder-input').onchange = (e) => { addFiles(e.target.files); e.target.value = ''; };
// El selector de carpeta es otro <input>: un solo input no puede ser las dos cosas.
$('#pick-folder').onclick = (e) => { e.preventDefault(); e.stopPropagation(); $('#folder-input').click(); };

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

// El QR lleva el enlace entero, palabras incluidas: es el atajo para el movil,
// que enfoca la pantalla en vez de teclear. Se genera aqui, sin pedir nada a
// nadie (shared/qr.js), y solo cuando se pide: es lo unico de la pagina que
// no cabe en una pantalla estrecha sin hacerse notar.
$('#show-qr').onclick = (e) => {
  const box = $('#qr-box');
  const open = box.hidden;
  if (open && !box.innerHTML) {
    try {
      box.innerHTML = qrToSvg(encodeQr(shareUrl(), { ecl: ECL.M }));
      const hint = document.createElement('small');
      hint.textContent = 'scan to open the link on a phone';
      box.appendChild(hint);
    } catch (err) {
      console.error('qr', err);
      return;
    }
  }
  box.hidden = !open;
  e.currentTarget.setAttribute('aria-expanded', String(open));
  e.currentTarget.textContent = open ? 'hide qr' : 'qr';
};
$('#link-out').onclick = (e) => e.currentTarget.select();
$('#restart').onclick = () => location.reload();
$('#accept').onclick = acceptTransfer;

// ------------------------------------------------------- entrada del codigo

/** Enseña el error de un codigo mal escrito donde el usuario lo esta tecleando. */
function showCodeError(el, err) {
  if (!(err instanceof CodeError)) { console.error('drop:', err); return; }
  el.hidden = false;
  el.textContent = err.message;
}

$('#join-form').onsubmit = (e) => {
  e.preventDefault();
  const errEl = $('#code-error');
  errEl.hidden = true;
  try {
    joinWithCode($('#code-in').value);
  } catch (err) {
    showCodeError(errEl, err);
  }
};

$('#retry-form').onsubmit = (e) => {
  e.preventDefault();
  const errEl = $('#join-error');
  errEl.hidden = true;
  try {
    joinWithCode($('#retry-code').value);
  } catch (err) {
    showCodeError(errEl, err);
  }
};

$('#copy-code').onclick = (e) => copy(out.code, e.currentTarget, 'Copy the code:');
$('#code-out').onclick = (e) => e.currentTarget.select();

paintAlertsToggle();
$('#alerts-toggle').onclick = () => {
  alerts.enabled = !alerts.enabled;
  try { localStorage.setItem('drop.alerts', alerts.enabled ? 'on' : 'off'); } catch { /* se recuerda solo en esta pestania */ }
  paintAlertsToggle();
  // Encenderlo ya es un click: se aprovecha para pedir permiso y desbloquear el audio.
  if (alerts.enabled) { armAlerts(); chime(); }
};

// El codigo viaja en el fragmento (#...), que el navegador nunca manda al
// servidor: no queda en sus logs ni en el Referer. Y ahi va ENTERO, palabras
// incluidas, porque el enlace es justo el atajo para no tener que dictarlas.
// Si lo hay, esto es una descarga.
// El filtro deja pasar letras, digitos y guiones: el formato nuevo
// (`4271-lemon-radar-tiger-orbit`) y el token base64url viejo. `parseCode` ya
// normaliza mayusculas, acentos y separadores raros.
let fragment = location.hash.slice(1);
try { fragment = decodeURIComponent(fragment); } catch { /* %-escapes rotos: se usa tal cual */ }
fragment = fragment.replace(/[^A-Za-z0-9_\- ]/g, '');

// Sin `RTCPeerConnection` no hay nada que hacer: la pagina cargaria, dejaria
// soltar un archivo y reventaria al abrir el canal con un `ReferenceError` que
// nadie ve. Tor Browser y un Firefox con `media.peerconnection.enabled=false`
// llegan aqui. Si venia un codigo en el enlace se ensenia, que es lo unico que
// hace falta para abrirlo en otro navegador o con el CLI.
if (typeof RTCPeerConnection === 'undefined') {
  showView('unsupported');
  setStatus('unsupported', 'bad');
  if (fragment) {
    const el = $('#unsupported-code');
    el.hidden = false;
    el.textContent = `code in this link: ${fragment}`;
  }
  fragment = '';
  // Dejar el estado montado (`window.__drop`) sigue siendo util para el bench.
}

if (fragment) {
  showView('recv');
  try {
    joinWithCode(fragment);
  } catch (err) {
    // Enlace con el codigo mal copiado: se enseña el motivo y se deja el campo
    // relleno para que solo haya que arreglar la palabra que falla.
    if (!(err instanceof CodeError)) throw err;
    $('#recv-title').textContent = 'bad code';
    const el = $('#join-error');
    el.hidden = false;
    el.textContent = err.message;
    $('#retry-box').hidden = false;
    $('#retry-code').value = fragment;
    setStatus('offline', 'bad');
  }
}

// Enganche para el bench (app.js es un modulo: sin esto no hay forma de mirar el
// estado desde fuera). No expone nada que no este ya en la propia pagina.
window.__drop = { out, rx };

// Aviso si se cierra la pestaña con una transferencia a medias.
window.addEventListener('beforeunload', (e) => {
  const sending = [...out.peers.values()].some((c) => !c.cancelled && c.acked < totalBytes());
  const receiving = rx.row && rx.received > 0 && rxIncomplete();
  // Aunque ya hayamos terminado podemos seguir siendo el eslabon de alguien.
  const relaying = rx.down && rx.down.dc && rx.down.dc.readyState === 'open';
  if (sending || receiving || relaying) { e.preventDefault(); e.returnValue = ''; }
});
