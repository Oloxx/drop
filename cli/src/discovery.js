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
 */
export function roomHash(code) {
  const { roomId } = splitForKey(code);
  return crypto.createHash('sha256').update(roomId).digest('hex').slice(0, 16);
}

// Obtiene todas las direcciones IPv4 locales no internas. Sigue siendo solo
// IPv4 porque UPnP (SSDP) y el broadcast de LAN abren un socket udp4 por cada
// una; las candidatas de la oferta salen de `getCandidateIPs`.
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

/** `fe80::/10`: solo vale con indice de zona (`%eth0`), que no viaja. */
export function isLinkLocalV6(ip) {
  return /^fe[89ab][0-9a-f]:/i.test(ip);
}

/** `fc00::/7`: la direccion privada de IPv6 (la de Tailscale, por ejemplo). */
export function isUniqueLocalV6(ip) {
  return /^f[cd][0-9a-f]{2}:/i.test(ip);
}

/**
 * Direcciones IPv6 locales que un receptor puede usar para conectar: globales
 * y unicas locales. Las de enlace (`fe80::`) se quedan fuera porque sin el
 * indice de zona no sirven en el otro extremo, y el indice es local.
 */
export function getLocalIPv6s() {
  const ips = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv6' && !iface.internal && !isLinkLocalV6(iface.address)) {
        ips.push(iface.address.replace(/%.*$/, ''));
      }
    }
  }
  return ips;
}

/**
 * Lo que va en `ips` de la oferta (`cli-offer`): IPv4 y despues IPv6, como
 * cadenas sueltas sin distinguir familia. El receptor las ordena con
 * `rankCandidates` y las sondea escalonadas; una que no le vale (sin IPv6 en
 * su red) solo cuesta un intento que falla.
 */
export function getCandidateIPs() {
  return [...getLocalIPs(), ...getLocalIPv6s()];
}

/** `::ffff:192.168.1.5` (IPv4 por un socket dual) -> `192.168.1.5`. */
export function plainAddress(addr) {
  return typeof addr === 'string' ? addr.replace(/^::ffff:/i, '') : addr;
}

/** La otra punta esta en loopback o en una red privada: se dice "LAN". */
export function isLocalAddress(addr) {
  const ip = plainAddress(addr) || '';
  if (ip === '127.0.0.1' || ip === '::1') return true;
  if (/^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)) return true;
  return isUniqueLocalV6(ip);
}

/**
 * Ordena las IPs de una oferta de mas a menos probable, para que el sondeo
 * escalonado (`probeCandidateIPs`) pruebe primero lo que suele responder:
 * loopback, la misma subred que alguna interfaz nuestra, redes privadas, y al
 * final lo publico. IPv6 va entre medias: una unica local (fc00::/7) es una
 * VPN o una LAN, y una global puede ser directa sin NAT que atravesar.
 */
export function rankCandidates(ips, local = getCandidateIPs()) {
  const v4prefix = (ip) => ip.split('.').slice(0, 3).join('.');
  const v6prefix = (ip) => ip.toLowerCase().split(':').slice(0, 4).join(':');
  const localV4 = local.filter((ip) => ip.includes('.')).map(v4prefix);
  const localV6 = local.filter((ip) => ip.includes(':')).map(v6prefix);
  const score = (ip) => {
    if (ip === '127.0.0.1' || ip === '::1') return 100;
    if (ip.includes(':')) {
      if (localV6.includes(v6prefix(ip))) return 85;
      if (isUniqueLocalV6(ip)) return 65;
      return 55;
    }
    if (localV4.includes(v4prefix(ip))) return 90;
    if (ip.startsWith('192.168.')) return 80;
    if (ip.startsWith('10.')) return 70;
    if (ip.startsWith('172.')) return 60;
    return 50;
  };
  return [...new Set(ips)].sort((a, b) => score(b) - score(a));
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

