// Receptor de archivos: saneado de los nombres que manda el emisor.
// Este fichero no necesita el servidor levantado.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';

import { safeOutputPath, receiveFiles } from '../cli/src/transfer.js';
import { deriveKey, encryptChunk } from '../cli/src/crypto.js';
import { newCode, randomRoomId } from '../public/shared/codes.js';
import { randomBytes } from 'node:crypto';

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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

// -------------------------------------------- emisor hostil contra el receptor

/**
 * Emisor minimo que manda el manifiesto que se le diga, sin el `path.basename`
 * que aplica el emisor honesto. Es justo el escenario del que protege el
 * receptor: la garantia no puede estar en el otro lado.
 */
function hostileSender(code, manifestFiles, body) {
  const key = deriveKey(code);
  const frame = (buf) => {
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(buf.length, 0);
    return Buffer.concat([header, buf]);
  };
  const control = (obj) => frame(encryptChunk(
    Buffer.concat([Buffer.from([0]), Buffer.from(JSON.stringify(obj))]), key));

  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    socket.write(control({ files: manifestFiles }));
    socket.write(frame(encryptChunk(Buffer.concat([Buffer.from([1]), body]), key)));
    socket.write(control({ k: 'end', index: 0 }));
    socket.write(control({ k: 'done' }));
    socket.end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

test('un manifiesto con ../ no escribe fuera del directorio de destino', async () => {
  const root = tmpdir('drop-traversal-');
  const out = path.join(root, 'a', 'b');
  fs.mkdirSync(out, { recursive: true });

  const code = newCode(randomRoomId(randomBytes), randomBytes);
  const escaped = path.join(root, 'escapado.txt');
  const { server, port } = await hostileSender(
    code,
    [{ name: '../../escapado.txt', size: 5 }],
    Buffer.from('PWNED')
  );

  const received = await receiveFiles('127.0.0.1', port, code, out, () => {});

  // El escape se queda en un nombre de archivo normal dentro del destino.
  assert.equal(fs.existsSync(escaped), false, 'ha escrito fuera del directorio de destino');
  assert.deepEqual(fs.readdirSync(root), ['a']);
  assert.deepEqual(fs.readdirSync(out), ['escapado.txt']);
  assert.equal(received[0].path, path.join(out, 'escapado.txt'));

  server.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('un manifiesto con un nombre imposible corta la transferencia sin escribir nada', async () => {
  const root = tmpdir('drop-traversal-');
  const out = path.join(root, 'destino');
  fs.mkdirSync(out, { recursive: true });

  const code = newCode(randomRoomId(randomBytes), randomBytes);
  // Dos archivos, y el malo es el SEGUNDO: la validacion es de todo el manifiesto
  // de golpe, asi que no llega a escribirse ni el primero.
  const { server, port } = await hostileSender(
    code,
    [{ name: 'bueno.txt', size: 4 }, { name: '..', size: 4 }],
    Buffer.from('DATA')
  );

  await assert.rejects(
    receiveFiles('127.0.0.1', port, code, out, () => {}),
    (err) => err.code === 'UNSAFE_NAME'
  );
  assert.deepEqual(fs.readdirSync(out), []);

  server.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('un manifiesto con ruta absoluta se guarda como un archivo suelto en el destino', async () => {
  const root = tmpdir('drop-traversal-');
  const out = path.join(root, 'destino');
  fs.mkdirSync(out, { recursive: true });

  const code = newCode(randomRoomId(randomBytes), randomBytes);
  const body = Buffer.from('contenido');
  const { server, port } = await hostileSender(
    code,
    [{ name: '/tmp/absoluto.txt', size: body.length }],
    body
  );

  const received = await receiveFiles('127.0.0.1', port, code, out, () => {});
  assert.equal(received.length, 1);
  assert.equal(received[0].path, path.join(out, 'absoluto.txt'));
  assert.equal(fs.readFileSync(path.join(out, 'absoluto.txt'), 'utf-8'), 'contenido');

  server.close();
  fs.rmSync(root, { recursive: true, force: true });
});
