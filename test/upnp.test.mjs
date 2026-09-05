import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Worker } from 'node:worker_threads';
import {
  mapPort,
  isConflictError,
  getNextCandidatePort,
  buildAddPortMappingSoap,
  buildDeletePortMappingSoap,
  activeMappings
} from '../cli/src/upnp.js';

function createMockRouter(onRequest) {
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }
    const action = (req.headers['soapaction'] || '').replace(/"/g, '');
    const handled = onRequest({ req, body, action, res });
    if (!handled) {
      res.writeHead(404);
      res.end();
    }
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const controlUrl = `http://127.0.0.1:${port}/upnp/control`;
      const serviceType = 'urn:schemas-upnp-org:service:WANIPConnection:1';
      resolve({
        server,
        router: {
          controlUrl,
          serviceType,
          routerIp: '127.0.0.1',
          clientLanIp: '127.0.0.1'
        },
        close: () => new Promise((cb) => server.close(cb))
      });
    });
  });
}

test('isConflictError detects 718 and ConflictInMappingEntry accurately', () => {
  assert.equal(isConflictError(500, '<errorCode>718</errorCode>'), true);
  assert.equal(isConflictError(500, '<errorDescription>ConflictInMappingEntry</errorDescription>'), true);
  assert.equal(isConflictError(500, '<UPnPError><errorCode>718</errorCode></UPnPError>'), true);
  assert.equal(isConflictError(500, '<UPnPError><errorCode>501</errorCode><errorDescription>ActionFailed</errorDescription></UPnPError>'), false);
  assert.equal(isConflictError(404, ''), false);
  assert.equal(isConflictError(200, '<u:AddPortMappingResponse/>'), false);
});

test('getNextCandidatePort generates sequential candidate ports and avoids tried ports', () => {
  const tried = new Set([50000]);
  const p1 = getNextCandidatePort(50000, 1, tried);
  assert.equal(p1, 50001);
  tried.add(p1);

  const p2 = getNextCandidatePort(50000, 2, tried);
  assert.equal(p2, 50002);
  tried.add(p2);

  const pRandom = getNextCandidatePort(50000, 5, tried);
  assert.ok(pRandom >= 1024 && pRandom <= 65535);
  assert.ok(!tried.has(pRandom));
});

test('buildAddPortMappingSoap and buildDeletePortMappingSoap create valid XML envelopes', () => {
  const addXml = buildAddPortMappingSoap('urn:test', 52145, 52145, '192.168.1.50', 'drop-test', 7200);
  assert.ok(addXml.includes('<NewExternalPort>52145</NewExternalPort>'));
  assert.ok(addXml.includes('<NewInternalPort>52145</NewInternalPort>'));
  assert.ok(addXml.includes('<NewInternalClient>192.168.1.50</NewInternalClient>'));
  assert.ok(addXml.includes('<NewLeaseDuration>7200</NewLeaseDuration>'));

  const delXml = buildDeletePortMappingSoap('urn:test', 52145);
  assert.ok(delXml.includes('<NewExternalPort>52145</NewExternalPort>'));
  assert.ok(delXml.includes('<u:DeletePortMapping'));
});

test('mapPort retries with another external port on ConflictInMappingEntry (error 718)', async () => {
  const requestedPorts = [];
  const mock = await createMockRouter(({ action, body, res }) => {
    if (action.includes('GetExternalIPAddress')) {
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end(`<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Body><u:GetExternalIPAddressResponse xmlns:u="urn:schemas-upnp-org:service:WANIPConnection:1">
    <NewExternalIPAddress>198.51.100.42</NewExternalIPAddress>
  </u:GetExternalIPAddressResponse></s:Body>
</s:Envelope>`);
      return true;
    }

    if (action.includes('AddPortMapping')) {
      const match = body.match(/<NewExternalPort>(\d+)<\/NewExternalPort>/);
      const port = match ? Number(match[1]) : 0;
      requestedPorts.push(port);

      // Simular conflicto (718) en el primer puerto pedido (50000)
      if (port === 50000) {
        res.writeHead(500, { 'Content-Type': 'text/xml' });
        res.end(`<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Body>
    <s:Fault>
      <faultcode>s:Client</faultcode>
      <faultstring>UPnPError</faultstring>
      <detail>
        <UPnPError xmlns="urn:schemas-upnp-org:control-1-0">
          <errorCode>718</errorCode>
          <errorDescription>ConflictInMappingEntry</errorDescription>
        </UPnPError>
      </detail>
    </s:Fault>
  </s:Body>
</s:Envelope>`);
        return true;
      }

      // El siguiente puerto (50001) tiene éxito
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end(`<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Body><u:AddPortMappingResponse xmlns:u="urn:schemas-upnp-org:service:WANIPConnection:1"/></s:Body>
</s:Envelope>`);
      return true;
    }

    if (action.includes('DeletePortMapping')) {
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end(`<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Body><u:DeletePortMappingResponse xmlns:u="urn:schemas-upnp-org:service:WANIPConnection:1"/></s:Body>
</s:Envelope>`);
      return true;
    }

    return false;
  });

  try {
    const result = await mapPort(50000, 50000, 'drop-test', 7200, {
      router: mock.router,
      autoRenew: false
    });

    assert.equal(result.success, true);
    assert.equal(result.externalPort, 50001);
    assert.equal(result.publicIp, '198.51.100.42');
    assert.deepEqual(requestedPorts, [50000, 50001]);

    // Limpieza
    await result.unmap();
  } finally {
    await mock.close();
  }
});

test('mapPort fails cleanly if all conflict retries are exhausted', async () => {
  const mock = await createMockRouter(({ action, res }) => {
    if (action.includes('AddPortMapping')) {
      res.writeHead(500, { 'Content-Type': 'text/xml' });
      res.end(`<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Body><s:Fault><detail><UPnPError><errorCode>718</errorCode></UPnPError></detail></s:Fault></s:Body>
</s:Envelope>`);
      return true;
    }
    return false;
  });

  try {
    const result = await mapPort(50000, 50000, 'drop-test', 7200, {
      router: mock.router,
      maxRetries: 3,
      autoRenew: false
    });

    assert.equal(result.success, false);
    assert.ok(result.reason.includes('ConflictInMappingEntry'));
  } finally {
    await mock.close();
  }
});

test('mapPort does not retry if the error is not a port conflict', async () => {
  let callCount = 0;
  const mock = await createMockRouter(({ action, res }) => {
    if (action.includes('AddPortMapping')) {
      callCount++;
      res.writeHead(500, { 'Content-Type': 'text/xml' });
      res.end(`<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Body><s:Fault><detail><UPnPError><errorCode>501</errorCode><errorDescription>ActionFailed</errorDescription></UPnPError></detail></s:Fault></s:Body>
</s:Envelope>`);
      return true;
    }
    return false;
  });

  try {
    const result = await mapPort(50000, 50000, 'drop-test', 7200, {
      router: mock.router,
      autoRenew: false
    });

    assert.equal(result.success, false);
    assert.equal(callCount, 1);
  } finally {
    await mock.close();
  }
});

test('mapPort periodically renews the lease and stops when unmapped', async () => {
  let addCount = 0;
  const mock = await createMockRouter(({ action, res }) => {
    if (action.includes('GetExternalIPAddress')) {
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end(`<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:GetExternalIPAddressResponse><NewExternalIPAddress>198.51.100.1</NewExternalIPAddress></u:GetExternalIPAddressResponse></s:Body></s:Envelope>`);
      return true;
    }
    if (action.includes('AddPortMapping')) {
      addCount++;
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end(`<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:AddPortMappingResponse/></s:Body></s:Envelope>`);
      return true;
    }
    if (action.includes('DeletePortMapping')) {
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end(`<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:DeletePortMappingResponse/></s:Body></s:Envelope>`);
      return true;
    }
    return false;
  });

  try {
    let renewalSuccesses = 0;
    // Usar leaseSec = 2 para que renueve cada 1 segundo (leaseSec * 1000 / 2)
    const result = await mapPort(51000, 51000, 'drop-renew', 2, {
      router: mock.router,
      autoRenew: true,
      onRenewSuccess: () => {
        renewalSuccesses++;
      }
    });

    assert.equal(result.success, true);
    assert.equal(addCount, 1);

    // Esperar a que el temporizador de renovación se ejecute al menos una vez (1.2s)
    await new Promise((r) => setTimeout(r, 1300));
    assert.ok(addCount >= 2, `Debería haber renovado al menos una vez (addCount = ${addCount})`);
    assert.ok(renewalSuccesses >= 1);

    // Desmapear debe parar las renovaciones
    await result.unmap();
    const countAfterUnmap = addCount;

    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(addCount, countAfterUnmap, 'No debe seguir renovando después de unmap');
  } finally {
    await mock.close();
  }
});

test('mapPort tracks activeMappings and cleans up via unmap', async () => {
  let deletedPort = null;
  const mock = await createMockRouter(({ action, body, res }) => {
    if (action.includes('GetExternalIPAddress')) {
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end(`<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:GetExternalIPAddressResponse><NewExternalIPAddress>198.51.100.1</NewExternalIPAddress></u:GetExternalIPAddressResponse></s:Body></s:Envelope>`);
      return true;
    }
    if (action.includes('AddPortMapping')) {
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end(`<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:AddPortMappingResponse/></s:Body></s:Envelope>`);
      return true;
    }
    if (action.includes('DeletePortMapping')) {
      const match = body.match(/<NewExternalPort>(\d+)<\/NewExternalPort>/);
      deletedPort = match ? Number(match[1]) : null;
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end(`<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:DeletePortMappingResponse/></s:Body></s:Envelope>`);
      return true;
    }
    return false;
  });

  try {
    const initialActiveCount = activeMappings.size;
    const result = await mapPort(53000, 53000, 'drop-active', 7200, {
      router: mock.router,
      autoRenew: false
    });

    assert.equal(result.success, true);
    assert.equal(activeMappings.size, initialActiveCount + 1);

    await result.unmap();
    assert.equal(activeMappings.size, initialActiveCount);
    assert.equal(deletedPort, 53000);

    // Segundo unmap no hace nada (idempotente)
    await result.unmap();
    assert.equal(activeMappings.size, initialActiveCount);
  } finally {
    await mock.close();
  }
});

test('mapPort cleans up synchronously via unmapSync', async () => {
  const workerCode = `
    import { parentPort } from 'node:worker_threads';
    import http from 'node:http';

    let lastDeletedPort = null;
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        const action = (req.headers['soapaction'] || '').replace(/"/g, '');
        if (action.includes('GetExternalIPAddress')) {
          res.writeHead(200, { 'Content-Type': 'text/xml' });
          res.end('<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:GetExternalIPAddressResponse><NewExternalIPAddress>198.51.100.1</NewExternalIPAddress></u:GetExternalIPAddressResponse></s:Body></s:Envelope>');
          return;
        }
        if (action.includes('AddPortMapping')) {
          res.writeHead(200, { 'Content-Type': 'text/xml' });
          res.end('<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:AddPortMappingResponse/></s:Body></s:Envelope>');
          return;
        }
        if (action.includes('DeletePortMapping')) {
          const match = new RegExp('<NewExternalPort>(\\\\d+)</NewExternalPort>').exec(body);
          lastDeletedPort = match ? Number(match[1]) : null;
          res.writeHead(200, { 'Content-Type': 'text/xml' });
          res.end('<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:DeletePortMappingResponse/></s:Body></s:Envelope>');
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });

    server.listen(0, '127.0.0.1', () => {
      parentPort.postMessage({ type: 'ready', port: server.address().port });
    });

    parentPort.on('message', (msg) => {
      if (msg.type === 'getDeletedPort') {
        parentPort.postMessage({ type: 'deletedPort', port: lastDeletedPort });
      } else if (msg.type === 'close') {
        server.close(() => process.exit(0));
      }
    });
  `;

  const worker = new Worker(workerCode, { eval: true });
  const mock = await new Promise((resolve) => {
    worker.on('message', (msg) => {
      if (msg.type === 'ready') {
        resolve({
          router: {
            controlUrl: `http://127.0.0.1:${msg.port}/upnp/control`,
            serviceType: 'urn:schemas-upnp-org:service:WANIPConnection:1',
            routerIp: '127.0.0.1',
            clientLanIp: '127.0.0.1'
          }
        });
      }
    });
  });

  try {
    const initialActiveCount = activeMappings.size;
    const result = await mapPort(54000, 54000, 'drop-sync', 7200, {
      router: mock.router,
      autoRenew: false
    });

    assert.equal(result.success, true);
    assert.equal(activeMappings.size, initialActiveCount + 1);

    result.unmapSync();
    assert.equal(activeMappings.size, initialActiveCount);

    const deletedPort = await new Promise((resolve) => {
      const onMsg = (m) => {
        if (m.type === 'deletedPort') {
          worker.off('message', onMsg);
          resolve(m.port);
        }
      };
      worker.on('message', onMsg);
      worker.postMessage({ type: 'getDeletedPort' });
    });

    assert.equal(deletedPort, 54000);
  } finally {
    worker.postMessage({ type: 'close' });
    await worker.terminate();
  }
});

