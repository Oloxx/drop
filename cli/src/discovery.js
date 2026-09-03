import dgram from 'node:dgram';
import crypto from 'node:crypto';
import os from 'node:os';

const BROADCAST_PORT = 42424;

export function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);
}

// Obtiene todas las direcciones IPv4 locales no internas
export function getLocalIPs() {
  const ips = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        ips.push(iface.address);
      }
    }
  }
  return ips;
}

/**
 * Emite periódicamente pings de descubrimiento en la subred local (UDP broadcast).
 */
export function startBroadcasting(token, tcpPort) {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const hash = tokenHash(token);
  let timer = null;

  socket.on('error', () => {
    // Si no se puede emitir broadcast por permisos de firewall, se continúa en modo WAN
  });

  socket.bind(() => {
    try {
      socket.setBroadcast(true);
    } catch {
      // Ignorar si el sistema no lo permite
    }

    const payload = Buffer.from(JSON.stringify({
      t: 'drop-lan',
      h: hash,
      p: tcpPort,
    }));

    timer = setInterval(() => {
      try {
        socket.send(payload, 0, payload.length, BROADCAST_PORT, '255.255.255.255');
      } catch {}
    }, 600);
  });

  return {
    stop: () => {
      if (timer) clearInterval(timer);
      try { socket.close(); } catch {}
    }
  };
}

/**
 * Escucha pings en la red local para encontrar al emisor por su token.
 */
export function listenForLAN(token, timeoutMs = 3000) {
  if (process.env.DROP_NO_LAN) return Promise.resolve(null);
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const hash = tokenHash(token);
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        try { socket.close(); } catch {}
        resolve(null);
      }
    }, timeoutMs);

    socket.on('error', () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve(null);
      }
    });

    socket.on('message', (msg, rinfo) => {
      try {
        const data = JSON.parse(msg.toString());
        if (data.t === 'drop-lan' && data.h === hash && data.p) {
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            try { socket.close(); } catch {}
            resolve({ host: rinfo.address, port: data.p });
          }
        }
      } catch {}
    });

    socket.bind(BROADCAST_PORT, () => {
      try {
        socket.setBroadcast(true);
      } catch {}
    });
  });
}
