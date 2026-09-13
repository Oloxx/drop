// Receptor de archivos: saneado de los nombres que manda el emisor, colisiones
// con lo que ya hay en el destino y version del protocolo.
// Este fichero no necesita el servidor levantado.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';

import { safeOutputPath, receiveFiles, createSenderServer, PROTOCOL_VERSION } from '../cli/src/transfer.js';
import { deriveKey, encryptChunk, sealFrame } from '../cli/src/crypto.js';
import { newCode, randomRoomId } from '../public/shared/codes.js';
import { createHash, randomBytes } from 'node:crypto';

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

// ------------------------------------------------------- saneado del nombre

test('safeOutputPath deja el archivo dentro del directorio de destino', () => {
  const out = tmpdir('drop-safe-');
  assert.equal(safeOutputPath(out, 'foto.jpg'), path.join(out, 'foto.jpg'));
  // Con ruta relativa o absoluta solo sobrevive el ultimo tramo.
  assert.equal(safeOutputPath(out, 'sub/dir/foto.jpg'), path.join(out, 'foto.jpg'));
  assert.equal(safeOutputPath(out, '/etc/passwd'), path.join(out, 'passwd'));
  assert.equal(safeOutputPath(out, '../../.zshrc'), path.join(out, '.zshrc'));
  // `\` separa en Windows y el emisor puede mandar cualquiera de las dos barras.
  assert.equal(safeOutputPath(out, '..\\..\\evil.txt'), path.join(out, 'evil.txt'));
  fs.rmSync(out, { recursive: true, force: true });
});

test('safeOutputPath rechaza los nombres que no dan un archivo', () => {
  const out = tmpdir('drop-safe-');
  for (const name of ['', '   ', '.', '..', '../..', 'sub/', 'mal\0nombre', null, undefined, 42]) {
    assert.throws(() => safeOutputPath(out, name), (err) => err.code === 'UNSAFE_NAME',
      `deberia rechazar ${JSON.stringify(name)}`);
  }
  fs.rmSync(out, { recursive: true, force: true });
});

// -------------------------------------------- emisor de mentira contra el receptor

/**
 * Emisor minimo, controlable trama a trama. No aplica el `path.basename` del
 * emisor honesto ni ninguna otra garantia: es justo el escenario del que
 * protege el receptor, porque la garantia no puede estar en el otro lado.
 *
 * `files` son las entradas del manifiesto; `bodies[i]` es el contenido del
 * archivo `i`. Opciones:
 *   - `version`: valor del campo `v` del manifiesto. `null` lo omite (emisor
 *     anterior a la 0.5.0).
 *   - `dataType`: byte de tipo de las tramas de datos (1 en un emisor sano).
 *   - `truncateAfter`: numero de archivos a cerrar con `k:'end'` antes de
 *     cortar la conexion a pelo, sin `k:'done'`.
 *   - `badHash`: manda un SHA-256 que no corresponde al cuerpo.
 */
function fakeSender(code, files, bodies, opts = {}) {
  const {
    version = PROTOCOL_VERSION,
    dataType = 1,
    truncateAfter = null,
    badHash = false,
  } = opts;

  const key = deriveKey(code);
  const frame = (buf) => {
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(buf.length, 0);
    return Buffer.concat([header, buf]);
  };
  const packet = (type, payload) => frame(encryptChunk(
    Buffer.concat([Buffer.from([type]), payload]), key));
  const control = (obj) => packet(0, Buffer.from(JSON.stringify(obj)));

  const manifest = { files };
  if (version !== null) manifest.v = version;

  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    socket.write(control(manifest));

    for (let i = 0; i < bodies.length; i++) {
      if (truncateAfter !== null && i >= truncateAfter) {
        socket.write(packet(dataType, bodies[i]));
        socket.end();
        return;
      }
      socket.write(packet(dataType, bodies[i]));
      socket.write(control({
        k: 'end',
        index: i,
        sha256: badHash ? sha256(Buffer.from('otra cosa')) : sha256(bodies[i]),
      }));
    }

    socket.write(control({ k: 'done' }));
    socket.end();
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/**
 * Levanta el emisor de mentira y garantiza que el servidor se cierra pase lo
 * que pase: sin esto un test que falla deja un socket escuchando y `node --test`
 * no termina nunca.
 */
async function withSender(t, code, files, bodies, opts) {
  const { server, port } = await fakeSender(code, files, bodies, opts);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return port;
}

function scratch(t, prefix) {
  const root = tmpdir(prefix);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const someCode = () => newCode(randomRoomId(randomBytes), randomBytes);

// ------------------------------------------------------------ path traversal

test('un manifiesto con ../ no escribe fuera del directorio de destino', async (t) => {
  const root = scratch(t, 'drop-traversal-');
  const out = path.join(root, 'a', 'b');
  fs.mkdirSync(out, { recursive: true });

  const code = someCode();
  const escaped = path.join(root, 'escapado.txt');
  const body = Buffer.from('PWNED');
  const port = await withSender(t, code, [{ name: '../../escapado.txt', size: body.length }], [body]);

  const received = await receiveFiles('127.0.0.1', port, code, out, () => {});

  // El escape se queda en un nombre de archivo normal dentro del destino.
  assert.equal(fs.existsSync(escaped), false, 'ha escrito fuera del directorio de destino');
  assert.deepEqual(fs.readdirSync(root), ['a']);
  assert.deepEqual(fs.readdirSync(out), ['escapado.txt']);
  assert.equal(received[0].path, path.join(out, 'escapado.txt'));
});

test('un manifiesto con un nombre imposible corta la transferencia sin escribir nada', async (t) => {
  const root = scratch(t, 'drop-traversal-');
  const out = path.join(root, 'destino');
  fs.mkdirSync(out, { recursive: true });

  const code = someCode();
  // Dos archivos, y el malo es el SEGUNDO: la validacion es de todo el manifiesto
  // de golpe, asi que no llega a escribirse ni el primero.
  const body = Buffer.from('DATA');
  const port = await withSender(
    t, code,
    [{ name: 'bueno.txt', size: 4 }, { name: '..', size: 4 }],
    [body, body]
  );

  await assert.rejects(
    receiveFiles('127.0.0.1', port, code, out, () => {}),
    (err) => err.code === 'UNSAFE_NAME'
  );
  assert.deepEqual(fs.readdirSync(out), []);
});

test('un manifiesto con ruta absoluta se guarda como un archivo suelto en el destino', async (t) => {
  const root = scratch(t, 'drop-traversal-');
  const out = path.join(root, 'destino');
  fs.mkdirSync(out, { recursive: true });

  const code = someCode();
  const body = Buffer.from('contenido');
  const port = await withSender(t, code, [{ name: '/tmp/absoluto.txt', size: body.length }], [body]);

  const received = await receiveFiles('127.0.0.1', port, code, out, () => {});
  assert.equal(received.length, 1);
  assert.equal(received[0].path, path.join(out, 'absoluto.txt'));
  assert.equal(fs.readFileSync(path.join(out, 'absoluto.txt'), 'utf-8'), 'contenido');
});

// ------------------------------------------------------- colisiones de nombre

test('no pisa un archivo que ya existe: lo guarda como "nombre (2)"', async (t) => {
  const out = scratch(t, 'drop-colision-');
  fs.writeFileSync(path.join(out, 'archivo.bin'), 'VIEJO');

  const code = someCode();
  const body = Buffer.from('NUEVO');
  const port = await withSender(t, code, [{ name: 'archivo.bin', size: body.length }], [body]);

  const received = await receiveFiles('127.0.0.1', port, code, out, () => {});

  assert.equal(fs.readFileSync(path.join(out, 'archivo.bin'), 'utf-8'), 'VIEJO');
  assert.equal(fs.readFileSync(path.join(out, 'archivo (2).bin'), 'utf-8'), 'NUEVO');
  assert.equal(received[0].path, path.join(out, 'archivo (2).bin'));
  // El sufijo va antes de la extension, no detras del nombre completo.
  assert.equal(fs.existsSync(path.join(out, 'archivo.bin (2)')), false);
});

test('--overwrite si pisa el archivo existente', async (t) => {
  const out = scratch(t, 'drop-colision-');
  fs.writeFileSync(path.join(out, 'archivo.bin'), 'VIEJO');

  const code = someCode();
  const body = Buffer.from('NUEVO');
  const port = await withSender(t, code, [{ name: 'archivo.bin', size: body.length }], [body]);

  const received = await receiveFiles(
    '127.0.0.1', port, code, out, () => {}, 0, { overwrite: true }
  );

  assert.equal(fs.readFileSync(path.join(out, 'archivo.bin'), 'utf-8'), 'NUEVO');
  assert.equal(received[0].path, path.join(out, 'archivo.bin'));
  assert.deepEqual(fs.readdirSync(out), ['archivo.bin']);
});

test('dos archivos con el mismo nombre en un manifiesto no se pisan', async (t) => {
  const out = scratch(t, 'drop-colision-');

  const code = someCode();
  const uno = Buffer.from('PRIMERO');
  const dos = Buffer.from('SEGUNDO');
  // En el momento de reservar el segundo destino el primero todavia no existe en
  // disco (esta en su `.part`), asi que mirar el disco no basta.
  const port = await withSender(
    t, code,
    [{ name: 'a.bin', size: uno.length }, { name: 'a.bin', size: dos.length }],
    [uno, dos]
  );

  const received = await receiveFiles('127.0.0.1', port, code, out, () => {});

  assert.equal(received.length, 2);
  assert.equal(fs.readFileSync(path.join(out, 'a.bin'), 'utf-8'), 'PRIMERO');
  assert.equal(fs.readFileSync(path.join(out, 'a (2).bin'), 'utf-8'), 'SEGUNDO');
  assert.deepEqual(fs.readdirSync(out).sort(), ['a (2).bin', 'a.bin']);
});

// --------------------------------------------------------------- integridad

test('un SHA-256 que no cuadra no deja el archivo con el nombre bueno', async (t) => {
  const out = scratch(t, 'drop-integridad-');

  const code = someCode();
  const body = Buffer.from('contenido');
  const port = await withSender(
    t, code, [{ name: 'archivo.bin', size: body.length }], [body], { badHash: true }
  );

  await assert.rejects(
    receiveFiles('127.0.0.1', port, code, out, () => {}),
    (err) => err.code === 'INTEGRITY_MISMATCH'
  );

  // Ni el nombre final ni el `.part`: el destino queda como estaba.
  assert.deepEqual(fs.readdirSync(out), []);
});

// ---------------------------------------------------------- version y tramas

test('un emisor sin version de protocolo da error de version, no un archivo corrupto', async (t) => {
  const out = scratch(t, 'drop-version-');

  const code = someCode();
  const body = Buffer.from('contenido');
  const port = await withSender(
    t, code, [{ name: 'archivo.bin', size: body.length }], [body], { version: null }
  );

  await assert.rejects(
    receiveFiles('127.0.0.1', port, code, out, () => {}),
    (err) => {
      assert.equal(err.code, 'PROTOCOL_VERSION');
      assert.equal(err.senderVersion, 0);
      assert.equal(err.supportedVersion, PROTOCOL_VERSION);
      return true;
    }
  );
  assert.deepEqual(fs.readdirSync(out), []);
});

test('un emisor con una version futura tambien se rechaza', async (t) => {
  const out = scratch(t, 'drop-version-');

  const code = someCode();
  const body = Buffer.from('contenido');
  const port = await withSender(
    t, code, [{ name: 'archivo.bin', size: body.length }], [body],
    { version: PROTOCOL_VERSION + 1 }
  );

  await assert.rejects(
    receiveFiles('127.0.0.1', port, code, out, () => {}),
    (err) => err.code === 'PROTOCOL_VERSION'
  );
  assert.deepEqual(fs.readdirSync(out), []);
});

test('una trama de tipo desconocido no acaba dentro del archivo', async (t) => {
  const out = scratch(t, 'drop-trama-');

  const code = someCode();
  const body = Buffer.from('contenido');
  const port = await withSender(
    t, code, [{ name: 'archivo.bin', size: body.length }], [body], { dataType: 7 }
  );

  await assert.rejects(
    receiveFiles('127.0.0.1', port, code, out, () => {}),
    (err) => err.code === 'PROTOCOL_FRAME'
  );
  assert.deepEqual(fs.readdirSync(out), []);
});

test('un emisor que corta a media transferencia no deja el archivo con el nombre bueno', async (t) => {
  const out = scratch(t, 'drop-truncado-');

  const code = someCode();
  const body = Buffer.from('a medias');
  const port = await withSender(
    t, code, [{ name: 'archivo.bin', size: 999 }], [body], { truncateAfter: 0 }
  );

  await assert.rejects(
    receiveFiles('127.0.0.1', port, code, out, () => {}),
    (err) => err.code === 'TRUNCATED'
  );
  assert.deepEqual(fs.readdirSync(out), []);
});

// -------------------------------------------- colisiones por el camino relay

test('el receptor por relay tampoco pisa un archivo que ya existe', async (t) => {
  const { EventEmitter } = await import('node:events');
  const { receiveFromRelay } = await import('../cli/src/transfer.js');

  const out = scratch(t, 'drop-relay-colision-');
  fs.writeFileSync(path.join(out, 'archivo.bin'), 'VIEJO');

  const body = Buffer.from('NUEVO');
  class MockWs extends EventEmitter {
    send() {}
    addEventListener(evt, fn) { this.on(evt, fn); }
    removeEventListener(evt, fn) { this.off(evt, fn); }
  }

  const ws = new MockWs();
  // Por relay los nombres llegan de uno en uno con `cli-start`, no de golpe en
  // el manifiesto: la reserva tiene que hacerse ahi.
  const key = deriveKey('4271-lemon-radar-tiger-orbit');
  const recibiendo = receiveFromRelay(ws, [{ name: 'archivo.bin', size: body.length }], out, () => {}, { key });

  // Y todo llega cifrado con la clave de la sala, como lo manda el emisor.
  const signal = (data) => ws.emit('message', { data: JSON.stringify({ t: 'signal', data: sealFrame(data, key) }) });
  signal({ type: 'cli-start', index: 0, name: 'archivo.bin', size: body.length });
  ws.emit('message', { data: encryptChunk(body, key) });
  signal({ type: 'cli-end', index: 0, sha256: sha256(body) });
  signal({ type: 'cli-done' });

  const received = await recibiendo;
  assert.equal(fs.readFileSync(path.join(out, 'archivo.bin'), 'utf-8'), 'VIEJO');
  assert.equal(fs.readFileSync(path.join(out, 'archivo (2).bin'), 'utf-8'), 'NUEVO');
  assert.equal(received[0].path, path.join(out, 'archivo (2).bin'));
});

// --------------------------------------- confirmacion del emisor (onPeer)

/** Emisor de verdad, con la puerta de confirmacion puesta. */
async function senderWithGate(onPeer) {
  const dir = tmpdir('drop-gate-');
  const filePath = path.join(dir, 'carga.bin');
  const contenido = randomBytes(64 * 1024);
  fs.writeFileSync(filePath, contenido);

  const code = newCode(randomRoomId(randomBytes), randomBytes);
  const files = [{ path: filePath, size: contenido.length }];
  const server = createSenderServer(files, code, null, null, { onPeer });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  return { dir, code, contenido, server, port: server.address().port };
}

test('el emisor no manda nada hasta que la confirmacion dice que si', async () => {
  const vistos = [];
  const emisor = await senderWithGate((info) => {
    vistos.push(info);
    return true;
  });
  const outDir = tmpdir('drop-gate-out-');

  try {
    const recibidos = await receiveFiles('127.0.0.1', emisor.port, emisor.code, outDir);
    assert.equal(recibidos.length, 1);
    assert.deepEqual(fs.readFileSync(path.join(outDir, 'carga.bin')), emisor.contenido);

    // Y a quien pregunta le llega con que decidir: quien es y que huella tiene.
    assert.equal(vistos.length, 1);
    assert.ok(vistos[0].address, 'deberia decir de donde viene la conexion');
    assert.equal(vistos[0].sas.split('-').length, 3);
  } finally {
    emisor.server.close();
    fs.rmSync(emisor.dir, { recursive: true, force: true });
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('si la confirmacion dice que no, el receptor no ve ni el manifiesto', async () => {
  // Lo que se comprueba es que NO se escribe nada en el socket: quien conecta
  // sabe el codigo, asi que si el emisor dice que no, ni los nombres de archivo
  // pueden salir de aqui.
  const emisor = await senderWithGate(() => false);
  const outDir = tmpdir('drop-gate-out-');

  try {
    await assert.rejects(() => receiveFiles('127.0.0.1', emisor.port, emisor.code, outDir));
    assert.deepEqual(fs.readdirSync(outDir), []);
  } finally {
    emisor.server.close();
    fs.rmSync(emisor.dir, { recursive: true, force: true });
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('un sondeo de puerto no le pregunta nada al emisor', async () => {
  // El receptor tantea el puerto con una conexion que cierra al instante antes de
  // abrir la de verdad (probeCandidateIPs). Si eso disparase la confirmacion, a
  // quien envia le saldrian dos preguntas por el mismo receptor.
  let preguntas = 0;
  const emisor = await senderWithGate(() => { preguntas++; return true; });

  try {
    await new Promise((resolve, reject) => {
      const sonda = net.connect({ host: '127.0.0.1', port: emisor.port });
      sonda.on('connect', () => { sonda.destroy(); resolve(); });
      sonda.on('error', reject);
    });
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(preguntas, 0, 'un sondeo no deberia molestar a nadie');
  } finally {
    emisor.server.close();
    fs.rmSync(emisor.dir, { recursive: true, force: true });
  }
});

test('la huella que ve el emisor es la misma que ve el receptor', async () => {
  // Es lo unico que hace util compararla en voz alta.
  let sasEmisor = null;
  let sasReceptor = null;
  const emisor = await senderWithGate((info) => {
    sasEmisor = info.sas;
    return true;
  });
  const outDir = tmpdir('drop-gate-out-');

  try {
    await receiveFiles('127.0.0.1', emisor.port, emisor.code, outDir, null, 0, {
      onConnected: (sas) => { sasReceptor = sas; },
    });
    assert.ok(sasEmisor, 'el emisor deberia haber calculado una huella');
    assert.equal(sasReceptor, sasEmisor);
  } finally {
    emisor.server.close();
    fs.rmSync(emisor.dir, { recursive: true, force: true });
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('un cliente que corta la conexion a mitad no deja el descriptor de archivo abierto', async (t) => {
  const root = scratch(t, 'drop-leak-');
  const filePath = path.join(root, 'testfile.bin');
  fs.writeFileSync(filePath, Buffer.alloc(1024 * 1024, 0x55));

  const code = someCode();
  const server = createSenderServer([{ path: filePath, size: 1024 * 1024 }], code);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const port = server.address().port;

  let warningEmitted = false;
  const onWarning = (warning) => {
    if (warning.message?.includes('Closing file descriptor') || warning.code === 'DEP0137') {
      warningEmitted = true;
    }
  };
  process.on('warning', onWarning);
  t.after(() => process.off('warning', onWarning));

  const s = net.connect({ host: '127.0.0.1', port });
  await new Promise((resolve) => s.once('connect', resolve));
  s.destroy();

  await new Promise((resolve) => setTimeout(resolve, 150));

  if (global.gc) {
    global.gc();
  }

  assert.equal(warningEmitted, false, 'No debe emitir DEP0137 de descriptor cerrado en garbage collection');
});
