import dgram from 'node:dgram';
import net from 'node:net';
import crypto from 'node:crypto';
import os from 'node:os';
import { splitForKey } from '../../public/shared/codes.js';

const BROADCAST_PORT = 42424;

/**
 * Etiqueta que va en el paquete UDP de descubrimiento en la LAN.
 *
 * Sale SOLO del identificador publico de sala, nunca de las palabras. El paquete
 * se emite a la subred entera cada 600 ms, asi que cualquiera con la tarjeta de
 * red en la misma Wi-Fi lo ve. Lo que aprende es: "hay una sala 4271 escuchando
 * en 192.168.1.5:51234". Puede conectar por TCP, pero sin el secreto AES-GCM le
 * rechaza el primer paquete, asi que el emparejamiento real lo valida la clave.
 *
 * Si se emitiese un hash del codigo completo, ese hash seria un verificador
 * offline de un secreto de 44 bits regalado a toda la LAN cada 600 ms: se rompe
 * con SHA-256 en minutos. Por eso el secreto no entra aqui de ninguna forma.
 *
 * Con codigos v0.3.5 el identificador de sala ES el token entero, asi que el hash
 * sale byte a byte igual que antes y los binarios viejos se siguen encontrando.
 */
export function roomHash(code) {
  const { roomId } = splitForKey(code);
  return crypto.createHash('sha256').update(roomId).digest('hex').slice(0, 16);
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

// Obtiene todas las direcciones de difusión (broadcast) calculadas por interfaz
export function getBroadcastAddresses() {
  const targets = new Set(['255.255.255.255']);
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal && iface.address && iface.netmask) {
        try {
          const ipParts = iface.address.split('.').map(Number);
          const maskParts = iface.netmask.split('.').map(Number);
          if (ipParts.length === 4 && maskParts.length === 4) {
            const bcast = ipParts.map((p, i) => (p | (~maskParts[i] & 255))).join('.');
            targets.add(bcast);
          }
        } catch {}
      }
    }
  }
  return [...targets];
}

/**
 * Emite periódicamente pings de descubrimiento en la subred local (UDP broadcast).
 */
export function startBroadcasting(code, tcpPort) {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const hash = roomHash(code);
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

    const targets = getBroadcastAddresses();

    timer = setInterval(() => {
      for (const target of targets) {
        try {
          socket.send(payload, 0, payload.length, BROADCAST_PORT, target);
        } catch {}
      }
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
 * Escucha pings en la red local para encontrar al emisor por su identificador de sala.
 */
export function listenForLAN(code, timeoutMs = 3000) {
  if (process.env.DROP_NO_LAN) return Promise.resolve(null);
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const hash = roomHash(code);
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

/**
 * Prueba en paralelo (con escalonamiento estilo Happy Eyeballs) una lista de IPs candidatas
 * y devuelve el primer socket TCP conectado con éxito.
 */
export function probeCandidateIPs(candidateIPs, port, timeoutMs = 2500) {
  if (!candidateIPs || !candidateIPs.length || !port) return Promise.resolve(null);
  return new Promise((resolve) => {
    let resolved = false;
    const sockets = [];
    let pending = candidateIPs.length;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        for (const s of sockets) {
          try { s.destroy(); } catch {}
        }
        resolve(null);
      }
    }, timeoutMs);

    for (let i = 0; i < candidateIPs.length; i++) {
      const ip = candidateIPs[i];
      const delay = Math.min(i * 100, 300);
      setTimeout(() => {
        if (resolved) return;
        const s = net.connect({ host: ip, port });
        s.setNoDelay(true);
        sockets.push(s);

        s.on('connect', () => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            for (const other of sockets) {
              if (other !== s) {
                try { other.destroy(); } catch {}
              }
            }
            resolve({ socket: s, ip });
          } else {
            try { s.destroy(); } catch {}
          }
        });

        const onFail = () => {
          pending--;
          if (pending <= 0 && !resolved) {
            resolved = true;
            clearTimeout(timer);
            resolve(null);
          }
        };

        s.on('error', onFail);
        s.on('timeout', onFail);
      }, delay);
    }
  });
}

