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
};

export function connectSignaling(serverUrl) {
  const target = getSignalingUrl(serverUrl);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(target);
    ws.onopen = () => resolve(ws);
    ws.onerror = (err) => reject(new Error(`No se pudo conectar al servidor de señalización: ${target}`));
  });
}

/**
 * Pide una sala. Devuelve solo el IDENTIFICADOR PUBLICO (4 digitos): la parte
 * secreta del codigo la genera el cliente y no pasa por aqui.
 * `v:2` le dice al servidor que entendemos codigos memorizables; sin eso nos
 * daria un token largo de los de la v0.3.5.
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

/** Se une a una sala. `roomId` es el identificador publico, nunca el codigo entero. */
export function joinRoom(ws, roomId) {
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
    ws.send(JSON.stringify({ t: 'join', token: roomId }));
  });
}
