export function getSignalingUrl(serverUrl = process.env.DROP_SERVER || 'https://drop.oloxx.dev') {
  const url = new URL(serverUrl);
  const proto = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${url.host}`;
}

export function connectSignaling(serverUrl) {
  const target = getSignalingUrl(serverUrl);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(target);
    ws.onopen = () => resolve(ws);
    ws.onerror = (err) => reject(new Error(`No se pudo conectar al servidor de señalización: ${target}`));
  });
}

export function createRoom(ws) {
  return new Promise((resolve, reject) => {
    function onMsg(ev) {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.t === 'hosted') {
          ws.removeEventListener('message', onMsg);
          resolve(msg.token);
        }
      } catch (err) {
        reject(err);
      }
    }
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ t: 'host' }));
  });
}

export function joinRoom(ws, token) {
  return new Promise((resolve, reject) => {
    function onMsg(ev) {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.t === 'joined') {
          ws.removeEventListener('message', onMsg);
          resolve(msg.guestId);
        } else if (msg.t === 'error') {
          ws.removeEventListener('message', onMsg);
          reject(new Error(msg.reason === 'NOT_FOUND' ? 'Enlace caducado o no encontrado' : msg.reason));
        }
      } catch (err) {
        reject(err);
      }
    }
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ t: 'join', token }));
  });
}
