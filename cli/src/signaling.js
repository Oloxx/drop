export function getSignalingUrl(serverUrl = process.env.DROP_SERVER || 'https://drop.oloxx.dev') {
  const url = new URL(serverUrl);
  const proto = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${url.host}`;
}

const ERRORS = {
  NOT_FOUND: 'Sala no encontrada: el codigo ha caducado o el emisor ha cerrado.',
  RATE_LIMITED: 'Demasiados intentos fallidos desde esta IP. Espera un minuto.',
  BAD_SECRET: 'El emisor ha rechazado el codigo: las palabras no coinciden.',
  BURNED: 'La sala se ha cerrado tras varios intentos con codigos incorrectos.',
  ROOM_FULL: 'La sala esta llena: ya tiene todos los receptores que admite.',
  TOO_MANY_ROOMS: 'Demasiadas salas abiertas desde esta IP. Espera un minuto.',
  EXPIRED: 'La sala ha caducado por inactividad.',
  FLOOD: 'El servidor ha cortado la conexion: demasiados mensajes seguidos.',
  VERSION: 'El servidor ya no admite esta version del CLI. Ejecuta `drop update`.',
};

export function connectSignaling(serverUrl) {
  const target = getSignalingUrl(serverUrl);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(target);
    // A partir del `open` manda el llamante: si se deja este `onerror` puesto, un
    // corte posterior intentaria rechazar una promesa ya resuelta y se perderia.
    ws.onopen = () => { ws.onerror = null; resolve(ws); };
    ws.onerror = () => reject(new Error(`No se pudo conectar al servidor de señalización: ${target}`));
  });
}

/**
 * Pide una sala. Devuelve solo el IDENTIFICADOR PUBLICO (4 digitos): la parte
 * secreta del codigo la genera el cliente y no pasa por aqui.
 * `v:2` le dice al servidor que entendemos codigos memorizables; sin eso (un
 * binario anterior a la v0.4.0) contesta `VERSION` y cierra.
 */
export function createRoom(ws) {
  return new Promise((resolve, reject) => {
    function onMsg(ev) {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.t === 'hosted') {
          if (msg.publicIp) ws.publicIp = msg.publicIp;
          ws.removeEventListener('message', onMsg);
          resolve(msg.room || msg.token);
        } else if (msg.t === 'error') {
          ws.removeEventListener('message', onMsg);
          reject(new Error(msg.reason === 'NO_ROOMS'
            ? 'El servidor no tiene salas libres ahora mismo. Prueba en unos segundos.'
            : msg.reason));
        }
      } catch (err) {
        reject(err);
      }
    }
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ t: 'host', v: 2 }));
  });
}

/**
 * Denuncia a un receptor que no ha sabido demostrar que conoce el secreto. El
 * servidor no puede comprobarlo (no ve el secreto), solo cuenta: a los pocos
 * avisos quema la sala para que probar identificadores no sirva de nada.
 */
export function reportBadGuest(ws, guestId) {
  try { ws.send(JSON.stringify({ t: 'bad-guest', guestId })); } catch {}
}

/**
 * Se une a una sala. `roomId` es el identificador publico, nunca el codigo entero.
 *
 * `name` es lo unico que el emisor sabe de nosotros antes de hablarnos, y el
 * emisor web lo usa para decidir COMO hablarnos: a un navegador le manda una
 * oferta WebRTC, a un `cli` le sirve por el relay del servidor, cifrado, porque
 * el CLI no habla WebRTC. Sin ese nombre, un receptor CLI en una sala abierta
 * desde la web se quedaba esperando una oferta que no llegaba nunca.
 */
export function joinRoom(ws, roomId, { name = '' } = {}) {
  return new Promise((resolve, reject) => {
    function onMsg(ev) {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.t === 'joined') {
          if (msg.publicIp) ws.publicIp = msg.publicIp;
          ws.removeEventListener('message', onMsg);
          resolve(msg.guestId);
        } else if (msg.t === 'error') {
          ws.removeEventListener('message', onMsg);
          reject(new Error(ERRORS[msg.reason] || msg.reason));
        }
      } catch (err) {
        reject(err);
      }
    }
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ t: 'join', token: roomId, ...(name ? { name } : {}) }));
  });
}
