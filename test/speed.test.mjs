import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { TcpSpeedChannel, runSpeedTest } from '../cli/src/speed.js';

test('TcpSpeedChannel exchanges encrypted control frames and payload', async () => {
  const code = '4271-lemon-radar-tiger-orbit';
  let serverChannel = null;
  let clientChannel = null;

  const server = net.createServer((socket) => {
    serverChannel = new TcpSpeedChannel(socket, code, true, 'Test-Direct');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const clientSocket = net.connect({ host: '127.0.0.1', port });
  await new Promise((resolve) => clientSocket.on('connect', resolve));
  clientChannel = new TcpSpeedChannel(clientSocket, code, false, 'Test-Direct');

  await new Promise((r) => setTimeout(r, 50));

  // Probar intercambio de mensaje de control
  const receivedMsg = await new Promise((resolve) => {
    serverChannel.onControl((msg) => {
      resolve(msg);
    });
    clientChannel.sendControl({ k: 'hello', val: 42 });
  });

  assert.equal(receivedMsg.k, 'hello');
  assert.equal(receivedMsg.val, 42);

  // Probar intercambio de payload
  let payloadBytes = 0;
  const receivedPayload = await new Promise((resolve) => {
    serverChannel.onPayload((len) => {
      payloadBytes += len;
      if (payloadBytes >= 1000) {
        resolve(payloadBytes);
      }
    });
    clientChannel.sendPayload();
  });

  assert.ok(receivedPayload > 0);

  clientChannel.close();
  serverChannel.close();
  server.close();
});

test('runSpeedTest completes bidirectional measurement between Host and Guest', async () => {
  const code = '5310-cargo-velvet-jungle-anchor';
  let serverChannel = null;
  let clientChannel = null;

  const server = net.createServer((socket) => {
    serverChannel = new TcpSpeedChannel(socket, code, true, 'Loopback TCP');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const clientSocket = net.connect({ host: '127.0.0.1', port });
  await new Promise((resolve) => clientSocket.on('connect', resolve));
  clientChannel = new TcpSpeedChannel(clientSocket, code, false, 'Loopback TCP');

  await new Promise((r) => setTimeout(r, 50));

  // Ejecutar test de 1 segundo por fase
  const [hostRes, guestRes] = await Promise.all([
    runSpeedTest(serverChannel, true, 1),
    runSpeedTest(clientChannel, false, 1),
  ]);

  clientChannel.close();
  serverChannel.close();
  server.close();
});
