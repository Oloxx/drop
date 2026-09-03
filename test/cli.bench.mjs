import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const TEST_DIR = path.resolve('test_tmp');
if (!fs.existsSync(TEST_DIR)) fs.mkdirSync(TEST_DIR);

const TEST_FILE = path.join(TEST_DIR, 'payload_128mb.bin');
const OUT_DIR = path.join(TEST_DIR, 'downloaded');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR);

const SIZE_MB = 128;
console.log(`Generando archivo de prueba de ${SIZE_MB} MB...`);
const buf = Buffer.alloc(1024 * 1024, 0x5a);
const stream = fs.createWriteStream(TEST_FILE);
for (let i = 0; i < SIZE_MB; i++) {
  stream.write(buf);
}
stream.end();

await new Promise((r) => stream.on('finish', r));
console.log(`Archivo generado.`);

// Iniciar servidor de señalización local
const serverProc = spawn('node', ['server/index.js'], {
  env: { ...process.env, PORT: '3456' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

await new Promise((resolve) => {
  serverProc.stdout.on('data', (d) => {
    resolve();
  });
  setTimeout(resolve, 500);
});

const stripAnsi = (str) => str.replace(/\x1b\[[0-9;]*m/g, '');

// Iniciar emisor CLI
console.log('Iniciando emisor CLI...');
const sender = spawn('node', ['cli/src/cli.js', 'send', TEST_FILE, '--server', 'http://localhost:3456'], {
  stdio: ['pipe', 'pipe', 'pipe'],
});

let token = null;

sender.stdout.on('data', (d) => {
  const clean = stripAnsi(d.toString());
  // console.log('[SENDER]', clean);
  const match = clean.match(/Código:\s+([a-zA-Z0-9_-]+)/);
  if (match && !token) {
    token = match[1];
    console.log(`Emisor listo con token: ${token}`);
    startReceiver(token);
  }
});

sender.stderr.on('data', (d) => console.error('[SENDER ERR]', d.toString()));

function startReceiver(tok) {
  console.log('Iniciando receptor CLI...');
  const t0 = performance.now();
  const receiver = spawn('node', ['cli/src/cli.js', 'recv', tok, '--server', 'http://localhost:3456', '--out', OUT_DIR], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  receiver.stdout.on('data', (d) => {
    // process.stdout.write(d.toString());
  });

  receiver.stderr.on('data', (d) => console.error('[RECV ERR]', d.toString()));

  receiver.on('close', (code) => {
    const t1 = performance.now();
    const duration = (t1 - t0) / 1000;
    const mbps = SIZE_MB / duration;

    console.log('\n=========================================');
    console.log(`Transferencia CLI completada con código: ${code}`);
    console.log(`Tiempo total: ${duration.toFixed(2)} segundos`);
    console.log(`Velocidad media: ${mbps.toFixed(1)} MB/s (${(mbps * 8).toFixed(0)} Mbit/s)`);
    console.log('=========================================\n');

    sender.kill();
    serverProc.kill();
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    process.exit(code);
  });
}
