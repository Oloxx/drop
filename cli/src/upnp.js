import dgram from 'node:dgram';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { getLocalIPs } from './discovery.js';

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

export function buildAddPortMappingSoap(serviceType, externalPort, internalPort, clientLanIp, description, leaseSec) {
  return `<?xml version="1.0"?>
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
}

export function buildDeletePortMappingSoap(serviceType, externalPort) {
  return `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
<s:Body>
  <u:DeletePortMapping xmlns:u="${serviceType}">
    <NewRemoteHost></NewRemoteHost>
    <NewExternalPort>${externalPort}</NewExternalPort>
    <NewProtocol>TCP</NewProtocol>
  </u:DeletePortMapping>
</s:Body>
</s:Envelope>`;
}

export function isConflictError(status, bodyText) {
  if (!bodyText) return false;
  return /ConflictInMappingEntry/i.test(bodyText) ||
         /<errorCode>\s*718\s*<\/errorCode>/i.test(bodyText) ||
         (bodyText.includes('718') && /UPnPError|Fault/i.test(bodyText));
}

export function getNextCandidatePort(basePort, attempt, triedPorts = new Set()) {
  if (attempt <= 3) {
    const candidate = basePort + attempt;
    if (candidate >= 1024 && candidate <= 65535 && !triedPorts.has(candidate)) {
      return candidate;
    }
  }

  for (let i = 0; i < 100; i++) {
    const candidate = crypto.randomInt(10240, 65536);
    if (!triedPorts.has(candidate)) {
      return candidate;
    }
  }

  return basePort + attempt;
}

export function sendDeletePortMappingSync(controlUrl, serviceType, soapDel) {
  try {
    const curlBin = process.platform === 'win32' ? 'curl.exe' : 'curl';
    const res = spawnSync(curlBin, [
      '-s',
      '-m', '3',
      '-X', 'POST',
      '-H', 'Content-Type: text/xml; charset="utf-8"',
      '-H', `SOAPAction: "${serviceType}#DeletePortMapping"`,
      '--data', soapDel,
      controlUrl
    ], { timeout: 3500, windowsHide: true });
    if (res.status === 0) return true;
  } catch {}

  try {
    const script = `fetch(${JSON.stringify(controlUrl)}, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        'SOAPAction': ${JSON.stringify(`"${serviceType}#DeletePortMapping"`)},
      },
      body: ${JSON.stringify(soapDel)},
      signal: AbortSignal.timeout(3000)
    }).catch(() => {});`;
    spawnSync(process.execPath, ['-e', script], { timeout: 3500, windowsHide: true });
    return true;
  } catch {}
  return false;
}

export const activeMappings = new Set();
let processHooksInstalled = false;

function ensureProcessHooks() {
  if (processHooksInstalled) return;
  processHooksInstalled = true;

  process.on('exit', () => {
    for (const mapping of [...activeMappings]) {
      try {
        mapping.unmapSync();
      } catch {}
    }
  });

  process.on('uncaughtExceptionMonitor', () => {
    for (const mapping of [...activeMappings]) {
      try {
        mapping.unmapSync();
      } catch {}
    }
  });
}

/**
 * Abre un puerto TCP en el router a través de UPnP IGD.
 *
 * @param {number} internalPort Puerto local en el que escucha Drop
 * @param {number} [preferredExternalPort] Puerto externo preferido (por defecto igual al interno)
 * @param {string} [description='drop-p2p'] Descripción de la regla en el router
 * @param {number|object} [leaseSec=7200] Duración del mapeo en segundos (0 = indefinido) u objeto de opciones
 * @param {object} [options={}] Opciones adicionales ({ autoRenew, maxRetries, onRenewError, onRenewSuccess, router })
 * @returns {Promise<{success: boolean, externalPort?: number, publicIp?: string, routerIp?: string, clientLanIp?: string, unmap?: () => Promise<void>, unmapSync?: () => void, renew?: () => Promise<boolean>, reason?: string}>}
 */
export async function mapPort(internalPort, preferredExternalPort = internalPort, description = 'drop-p2p', leaseSec = 7200, options = {}) {
  if (typeof leaseSec === 'object' && leaseSec !== null) {
    options = leaseSec;
    leaseSec = options.leaseSec ?? 7200;
  }
  const autoRenew = options.autoRenew ?? true;
  const maxRetries = options.maxRetries ?? 10;

  if (process.env.DROP_NO_UPNP) {
    return { success: false, reason: 'UPnP disabled by environment' };
  }

  const router = options.router || await discoverRouter(options.discoverTimeoutMs || 4500);
  if (!router) {
    return { success: false, reason: 'No UPnP router found' };
  }

  const { controlUrl, serviceType, routerIp, clientLanIp } = router;
  let externalPort = null;
  const triedPorts = new Set();
  let lastReason = '';

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const candidatePort = attempt === 0
      ? (preferredExternalPort || internalPort)
      : getNextCandidatePort(preferredExternalPort || internalPort, attempt, triedPorts);

    triedPorts.add(candidatePort);

    const soapAdd = buildAddPortMappingSoap(
      serviceType,
      candidatePort,
      internalPort,
      clientLanIp,
      description,
      leaseSec
    );

    let res;
    try {
      res = await fetch(controlUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset="utf-8"',
          'SOAPAction': `"${serviceType}#AddPortMapping"`
        },
        body: soapAdd,
        signal: AbortSignal.timeout(5000)
      });
    } catch (err) {
      return { success: false, reason: err.message };
    }

    if (res.ok) {
      externalPort = candidatePort;
      break;
    }

    const bodyText = await res.text().catch(() => '');
    if (isConflictError(res.status, bodyText)) {
      lastReason = `ConflictInMappingEntry (error 718) on port ${candidatePort}`;
      continue;
    }

    // Si el router no soporta leases temporales (error 725), reintentar una vez con leaseSec = 0
    if (/725|OnlyPermanentLeasesSupported/i.test(bodyText) && leaseSec !== 0) {
      leaseSec = 0;
      attempt--;
      continue;
    }

    return { success: false, reason: `HTTP ${res.status} from router: ${bodyText.slice(0, 200)}` };
  }

  if (!externalPort) {
    return { success: false, reason: lastReason || 'All port mapping attempts conflicted' };
  }

  const publicIp = await getRouterExternalIP(controlUrl, serviceType);

  let unmapped = false;
  let renewTimer = null;
  const soapDel = buildDeletePortMappingSoap(serviceType, externalPort);

  const renew = async () => {
    if (unmapped) return false;
    try {
      const soapRenew = buildAddPortMappingSoap(
        serviceType,
        externalPort,
        internalPort,
        clientLanIp,
        description,
        leaseSec
      );
      const res = await fetch(controlUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset="utf-8"',
          'SOAPAction': `"${serviceType}#AddPortMapping"`
        },
        body: soapRenew,
        signal: AbortSignal.timeout(5000)
      });
      return res.ok;
    } catch {
      return false;
    }
  };

  const renewIntervalMs = Math.max(1000, Math.floor((leaseSec * 1000) / 2));

  const scheduleRenew = (delayMs) => {
    if (unmapped) return;
    renewTimer = setTimeout(async () => {
      if (unmapped) return;
      const ok = await renew();
      if (!ok) {
        if (options.onRenewError) {
          try { options.onRenewError(new Error(`UPnP lease renewal failed for port ${externalPort}`)); } catch {}
        }
        const retryDelay = Math.min(60_000, Math.max(1000, Math.floor((leaseSec * 1000) / 4)));
        scheduleRenew(retryDelay);
      } else {
        if (options.onRenewSuccess) {
          try { options.onRenewSuccess({ externalPort, leaseSec }); } catch {}
        }
        scheduleRenew(renewIntervalMs);
      }
    }, delayMs);

    if (renewTimer?.unref) {
      renewTimer.unref();
    }
  };

  const unmapSync = () => {
    if (unmapped) return;
    unmapped = true;
    activeMappings.delete(mappingEntry);
    if (renewTimer) {
      clearTimeout(renewTimer);
      renewTimer = null;
    }
    sendDeletePortMappingSync(controlUrl, serviceType, soapDel);
  };

  const unmap = async () => {
    if (unmapped) return;
    unmapped = true;
    activeMappings.delete(mappingEntry);
    if (renewTimer) {
      clearTimeout(renewTimer);
      renewTimer = null;
    }
    try {
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

  const mappingEntry = {
    externalPort,
    controlUrl,
    serviceType,
    unmap,
    unmapSync,
    renew
  };

  activeMappings.add(mappingEntry);
  ensureProcessHooks();

  if (autoRenew && leaseSec > 0) {
    scheduleRenew(renewIntervalMs);
  }

  return {
    success: true,
    externalPort,
    publicIp,
    routerIp,
    clientLanIp,
    unmap,
    unmapSync,
    renew
  };
}

