import dgram from 'node:dgram';
import http from 'node:http';
import { getLocalIPs } from './discovery.js';

/**
 * Módulo nativo ligero de UPnP (IGD) para mapeo automático de puertos en routers residenciales.
 * Permite establecer conexiones TCP directas peer-to-peer a través de Internet sin configuración manual.
 */

/**
 * Módulo nativo ligero de UPnP (IGD) para mapeo automático de puertos en routers residenciales.
 * Permite establecer conexiones TCP directas peer-to-peer a través de Internet sin configuración manual.
 */

/**
 * Busca el router compatible con UPnP IGD en todas las interfaces de red locales.
 */
export function discoverRouter(timeoutMs = 4500) {
  return new Promise((resolve) => {
    const localIPs = getLocalIPs();
    if (!localIPs.length) return resolve(null);

    const sockets = [];
    let resolved = false;

    const cleanup = () => {
      if (!resolved) {
        resolved = true;
        for (const s of sockets) {
          try { s.close(); } catch {}
        }
      }
    };

    const timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);

    const onLocation = async (location, rinfo, ifaceIp) => {
      if (resolved) return;
      try {
        const res = await fetch(location, { signal: AbortSignal.timeout(3000) });
        if (!res.ok) return;
        const xml = await res.text();

        const serviceBlocks = xml.match(/<service>[\s\S]*?<\/service>/gi) || [];
        let serviceType = null;
        let controlPath = null;

        for (const block of serviceBlocks) {
          const typeMatch = block.match(/<serviceType>\s*(urn:schemas-upnp-org:service:WAN(?:IP|PPP)Connection:[^<]+)\s*<\/serviceType>/i);
          const urlMatch = block.match(/<controlURL>\s*([^<]+)\s*<\/controlURL>/i);
          if (typeMatch && urlMatch) {
            serviceType = typeMatch[1].trim();
            controlPath = urlMatch[1].trim();
            break;
          }
        }

        if (serviceType && controlPath && !resolved) {
          clearTimeout(timer);
          cleanup();
          const controlUrl = new URL(controlPath, location).href;

          resolve({
            controlUrl,
            serviceType,
            routerIp: rinfo.address,
            clientLanIp: ifaceIp
          });
        }
      } catch {}
    };

    const queries = [
      [
        'M-SEARCH * HTTP/1.1',
        'HOST: 239.255.255.250:1900',
        'MAN: "ssdp:discover"',
        'MX: 1',
        'ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1',
        '',
        ''
      ].join('\r\n'),
      [
        'M-SEARCH * HTTP/1.1',
        'HOST: 239.255.255.250:1900',
        'MAN: "ssdp:discover"',
        'MX: 1',
        'ST: urn:schemas-upnp-org:service:WANIPConnection:1',
        '',
        ''
      ].join('\r\n')
    ];

    for (const ifaceIp of localIPs) {
      const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      sockets.push(s);

      s.on('error', () => {});
      s.on('message', (msg, rinfo) => {
        const text = msg.toString();
        const locMatch = text.match(/LOCATION:\s*([^\r\n]+)/i);
        if (locMatch) {
          onLocation(locMatch[1].trim(), rinfo, ifaceIp);
        }
      });

      s.bind(0, ifaceIp, () => {
        try { s.setBroadcast(true); } catch {}
        try { s.setMulticastInterface(ifaceIp); } catch {}

        for (const q of queries) {
          s.send(q, 1900, '239.255.255.250', () => {});
        }

        // Unicast a la posible puerta de enlace (.1)
        const parts = ifaceIp.split('.');
        if (parts.length === 4) {
          const gw = `${parts[0]}.${parts[1]}.${parts[2]}.1`;
          for (const q of queries) {
            s.send(q, 1900, gw, () => {});
          }
        }
      });
    }
  });
}

/**
 * Consulta la IP pública WAN al router mediante UPnP.
 */
export async function getRouterExternalIP(controlUrl, serviceType) {
  try {
    const soap = `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
<s:Body>
  <u:GetExternalIPAddress xmlns:u="${serviceType}">
  </u:GetExternalIPAddress>
</s:Body>
</s:Envelope>`;

    const res = await fetch(controlUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        'SOAPAction': `"${serviceType}#GetExternalIPAddress"`
      },
      body: soap,
      signal: AbortSignal.timeout(5000)
    });

    if (!res.ok) return null;
    const text = await res.text();
    const match = text.match(/<NewExternalIPAddress>\s*([^<]+)\s*<\/NewExternalIPAddress>/i);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

/**
 * Abre un puerto TCP en el router a través de UPnP IGD.
 *
 * @param {number} internalPort Puerto local en el que escucha Drop
 * @param {number} [preferredExternalPort] Puerto externo preferido (por defecto igual al interno)
 * @param {string} [description='drop-p2p'] Descripción de la regla en el router
 * @param {number} [leaseSec=7200] Duración del mapeo en segundos (0 = indefinido)
 * @returns {Promise<{success: boolean, externalPort?: number, publicIp?: string, routerIp?: string, clientLanIp?: string, unmap?: () => Promise<void>}>}
 */
export async function mapPort(internalPort, preferredExternalPort = internalPort, description = 'drop-p2p', leaseSec = 7200) {
  if (process.env.DROP_NO_UPNP) {
    return { success: false, reason: 'UPnP disabled by environment' };
  }

  const router = await discoverRouter(4500);
  if (!router) {
    return { success: false, reason: 'No UPnP router found' };
  }

  const { controlUrl, serviceType, routerIp, clientLanIp } = router;
  const externalPort = preferredExternalPort || internalPort;

  try {
    const soapAdd = `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
<s:Body>
  <u:AddPortMapping xmlns:u="${serviceType}">
    <NewRemoteHost></NewRemoteHost>
    <NewExternalPort>${externalPort}</NewExternalPort>
    <NewProtocol>TCP</NewProtocol>
    <NewInternalPort>${internalPort}</NewInternalPort>
    <NewInternalClient>${clientLanIp}</NewInternalClient>
    <NewEnabled>1</NewEnabled>
    <NewPortMappingDescription>${description}</NewPortMappingDescription>
    <NewLeaseDuration>${leaseSec}</NewLeaseDuration>
  </u:AddPortMapping>
</s:Body>
</s:Envelope>`;

    const res = await fetch(controlUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        'SOAPAction': `"${serviceType}#AddPortMapping"`
      },
      body: soapAdd,
      signal: AbortSignal.timeout(5000)
    });

    if (!res.ok) {
      return { success: false, reason: `HTTP ${res.status} from router` };
    }

    const publicIp = await getRouterExternalIP(controlUrl, serviceType);

    let unmapped = false;
    const unmap = async () => {
      if (unmapped) return;
      unmapped = true;
      try {
        const soapDel = `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
<s:Body>
  <u:DeletePortMapping xmlns:u="${serviceType}">
    <NewRemoteHost></NewRemoteHost>
    <NewExternalPort>${externalPort}</NewExternalPort>
    <NewProtocol>TCP</NewProtocol>
  </u:DeletePortMapping>
</s:Body>
</s:Envelope>`;

        await fetch(controlUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'text/xml; charset="utf-8"',
            'SOAPAction': `"${serviceType}#DeletePortMapping"`
          },
          body: soapDel,
          signal: AbortSignal.timeout(3000)
        });
      } catch {}
    };

    return {
      success: true,
      externalPort,
      publicIp,
      routerIp,
      clientLanIp,
      unmap
    };
  } catch (err) {
    return { success: false, reason: err.message };
  }
}

