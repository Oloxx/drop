#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import readline from 'node:readline';
import os from 'node:os';
import { c, fmtBytes, fmtDuration, renderProgressBar, renderProgressBarComplete } from './ui.js';
import { getLocalIPs, startBroadcasting, listenForLAN } from './discovery.js';
import { connectSignaling, createRoom, joinRoom, getSignalingUrl } from './signaling.js';
import { createSenderServer, receiveFiles, receiveFromRelay } from './transfer.js';

const VERSION = '0.2.4';
const DEFAULT_SERVER = process.env.DROP_SERVER || 'https://drop.oloxx.dev';

function getInstallDir() {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || 'C:\\', 'AppData', 'Local');
    return path.join(localAppData, 'Programs', 'drop');
  }
  const home = process.env.HOME || process.env.USERPROFILE || '/tmp';
  return path.join(home, '.local', 'bin');
}

function isInstalled() {
  try {
    const installDir = getInstallDir();
    const currentDir = path.dirname(process.execPath);
    return path.resolve(installDir).toLowerCase() === path.resolve(currentDir).toLowerCase();
  } catch {
    return false;
  }
}

async function installSelf() {
  console.log(`\n${c.bold}======================================================${c.reset}`);
  console.log(`  ${c.cyan}Drop CLI — Instalador de Sistema${c.reset} (${c.bold}v${VERSION}${c.reset})`);
  console.log(`${c.bold}======================================================${c.reset}\n`);

  const installDir = getInstallDir();
  const exeName = process.platform === 'win32' ? 'drop.exe' : 'drop';
  const targetPath = path.join(installDir, exeName);

  console.log(`  ${c.dim}Instalando en:${c.reset} ${targetPath}`);

  try {
    fs.mkdirSync(installDir, { recursive: true });

    if (path.resolve(process.execPath).toLowerCase() === path.resolve(targetPath).toLowerCase()) {
      console.log(`  ${c.green}✔ Drop ya está ubicado en este directorio.${c.reset}`);
    } else {
      fs.copyFileSync(process.execPath, targetPath);
      console.log(`  ${c.green}✔ Archivo copiado a la carpeta de programas.${c.reset}`);
    }

    if (process.platform === 'win32') {
      const psCommand = `
        $dir = '${installDir.replace(/'/g, "''")}';
        $userPath = [Environment]::GetEnvironmentVariable('PATH', 'User');
        if ($userPath -notlike ('*' + $dir + '*')) {
            $newPath = ($userPath.TrimEnd(';') + ';' + $dir).Trim(';');
            [Environment]::SetEnvironmentVariable('PATH', $newPath, 'User');
            Write-Output 'ADDED';
        } else {
            Write-Output 'EXISTS';
        }
      `.replace(/\r?\n\s*/g, ' ');

      const out = execSync(`powershell -NoProfile -Command "${psCommand}"`, { encoding: 'utf-8' }).trim();
      if (out.includes('ADDED')) {
        console.log(`  ${c.green}✔ Carpeta añadida permanentemente a tu variable de entorno PATH.${c.reset}`);
      } else {
        console.log(`  ${c.green}✔ La ruta ya está configurada en tu variable PATH.${c.reset}`);
      }
    } else {
      try { fs.chmodSync(targetPath, 0o755); } catch {}
      console.log(`  ${c.green}✔ Permisos de ejecución configurados.${c.reset}`);
    }

    console.log(`\n  ${c.bold}${c.green}✔ ¡Drop se ha instalado con éxito en tu sistema!${c.reset}`);
    console.log(`\n  Ya puedes abrir cualquier terminal (${c.cyan}PowerShell, CMD o Terminal${c.reset}) y usar:`);
    console.log(`    ${c.yellow}drop send <archivo>${c.reset}`);
    console.log(`    ${c.yellow}drop recv <código>${c.reset}\n`);

  } catch (err) {
    console.error(`\n  ${c.red}Error durante la instalación:${c.reset} ${err.message}\n`);
  }

  if (process.stdin.isTTY && !process.argv.slice(2).includes('install')) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    await new Promise((resolve) => rl.question(`  ${c.dim}Presiona ENTER para salir...${c.reset}`, () => { rl.close(); resolve(); }));
  }
}

async function uninstallSelf() {
  const installDir = getInstallDir();
  const exeName = process.platform === 'win32' ? 'drop.exe' : 'drop';
  const targetPath = path.join(installDir, exeName);

  if (process.platform === 'win32') {
    const psCommand = `
      $dir = '${installDir.replace(/'/g, "''")}';
      $userPath = [Environment]::GetEnvironmentVariable('PATH', 'User');
      $parts = $userPath.Split(';') | Where-Object { $_ -ne $dir -and $_ -ne '' };
      $newPath = $parts -join ';';
      [Environment]::SetEnvironmentVariable('PATH', $newPath, 'User');
    `.replace(/\r?\n\s*/g, ' ');
    try { execSync(`powershell -NoProfile -Command "${psCommand}"`); } catch {}
  }

  try {
    if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
    console.log(`\n  ${c.green}✔ Drop ha sido desinstalado de tu sistema y retirado del PATH.${c.reset}\n`);
  } catch (err) {
    console.log(`\n  ${c.yellow}Drop ha sido retirado del PATH. Puedes eliminar el archivo manualmente en: ${targetPath}${c.reset}\n`);
  }
}

function isNewerVersion(remote, local) {
  const cleanRemote = remote.replace(/^v/, '').trim();
  const cleanLocal = local.replace(/^v/, '').trim();
  if (cleanRemote === cleanLocal) return false;

  const rParts = cleanRemote.split('.').map((n) => parseInt(n, 10) || 0);
  const lParts = cleanLocal.split('.').map((n) => parseInt(n, 10) || 0);

  for (let i = 0; i < Math.max(rParts.length, lParts.length); i++) {
    const r = rParts[i] || 0;
    const l = lParts[i] || 0;
    if (r > l) return true;
    if (r < l) return false;
  }
  return false;
}

function getTargetAssetSuffix() {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === 'win32') {
    return 'windows-x64.exe';
  } else if (platform === 'darwin') {
    return arch === 'arm64' ? 'macos-arm64.tar.gz' : 'macos-x64.tar.gz';
  } else if (platform === 'linux') {
    return arch === 'arm64' ? 'linux-arm64.tar.gz' : 'linux-x64.tar.gz';
  }
  return null;
}

async function downloadWithProgress(url, headers, onProgress) {
  const res = await fetch(url, { headers, redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`Error descargando actualización (HTTP ${res.status}): ${res.statusText}`);
  }
  const contentLength = parseInt(res.headers.get('content-length') || '0', 10);
  const reader = res.body.getReader();
  const chunks = [];
  let receivedBytes = 0;
  const startTime = performance.now();
  let lastReport = startTime;
  let lastBytes = 0;
  let speed = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    receivedBytes += value.length;

    const now = performance.now();
    const dt = (now - lastReport) / 1000;
    if (dt >= 0.15) {
      const inst = (receivedBytes - lastBytes) / dt;
      speed = speed ? speed * 0.7 + inst * 0.3 : inst;
      lastBytes = receivedBytes;
      lastReport = now;
      if (onProgress) onProgress(receivedBytes, contentLength, speed);
    }
  }

  const totalTimeSec = Math.max(0.001, (performance.now() - startTime) / 1000);
  const avgSpeed = receivedBytes / totalTimeSec;
  const result = Buffer.concat(chunks);
  result.stats = { totalBytes: receivedBytes, totalTimeSec, avgSpeed };
  return result;
}

async function updateSelf(force = false) {
  console.log(`\n${c.bold}Comprobando actualizaciones en GitHub...${c.reset}`);

  const headers = {
    'User-Agent': 'drop-cli',
    'Accept': 'application/vnd.github+json'
  };

  const envToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (envToken) {
    headers['Authorization'] = `Bearer ${envToken}`;
  } else {
    try {
      const ghToken = execSync('gh auth token', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
      if (ghToken) headers['Authorization'] = `Bearer ${ghToken}`;
    } catch {}
  }

  let release;
  try {
    const res = await fetch('https://api.github.com/repos/Oloxx/drop/releases/latest', { headers });
    if (!res.ok) {
      if (res.status === 404) {
        throw new Error('No se encontraron releases públicas en GitHub.');
      }
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    release = await res.json();
  } catch (err) {
    console.error(`\n  ${c.red}Error comprobando actualizaciones:${c.reset} ${err.message}\n`);
    process.exit(1);
  }

  const remoteTag = release.tag_name || '';
  const remoteVersion = remoteTag.replace(/^v/, '');

  if (!force && !isNewerVersion(remoteVersion, VERSION)) {
    console.log(`\n  ${c.green}✔ Drop ya está actualizado a la última versión disponible (${c.bold}v${VERSION}${c.reset}${c.green}).${c.reset}\n`);
    return;
  }

  console.log(`\n  ${c.cyan}Nueva versión detectada:${c.reset} ${c.bold}${remoteTag}${c.reset} (versión actual: v${VERSION})`);

  const assetSuffix = getTargetAssetSuffix();
  if (!assetSuffix) {
    console.error(`\n  ${c.red}Plataforma no soportada para auto-actualización: ${process.platform}-${process.arch}${c.reset}\n`);
    process.exit(1);
  }

  const asset = release.assets?.find((a) => a.name.endsWith(assetSuffix));
  if (!asset) {
    console.error(`\n  ${c.red}No se encontró el paquete para tu plataforma (*${assetSuffix}) en la release ${remoteTag}.${c.reset}\n`);
    process.exit(1);
  }

  const downloadUrl = headers['Authorization'] ? asset.url : asset.browser_download_url;
  const dlHeaders = {
    'User-Agent': 'drop-cli',
    ...(headers['Authorization'] ? { 'Authorization': headers['Authorization'], 'Accept': 'application/octet-stream' } : {})
  };

  console.log(`  ${c.dim}Descargando ${asset.name} (${(asset.size / (1024 * 1024)).toFixed(1)} MB)...${c.reset}\n`);

  let binaryBuffer;
  try {
    binaryBuffer = await downloadWithProgress(downloadUrl, dlHeaders, (current, total, speed) => {
      renderProgressBar(current, total, speed);
    });
    if (binaryBuffer?.stats) {
      renderProgressBarComplete(binaryBuffer.stats.totalBytes, binaryBuffer.stats.totalTimeSec, binaryBuffer.stats.avgSpeed);
    }
  } catch (err) {
    console.error(`\n\n  ${c.red}Error descargando actualización:${c.reset} ${err.message}\n`);
    process.exit(1);
  }

  console.log(`\n\n  ${c.dim}Instalando nueva versión...${c.reset}`);

  // Determinar la ruta de instalación del ejecutable
  let targetPath = process.execPath;
  const isExe = path.basename(targetPath).toLowerCase().startsWith('drop');
  if (!isExe) {
    const installDir = getInstallDir();
    const exeName = process.platform === 'win32' ? 'drop.exe' : 'drop';
    targetPath = path.join(installDir, exeName);
  }

  try {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });

    if (asset.name.endsWith('.tar.gz')) {
      const tmpDir = path.join(os.tmpdir(), `drop_update_${Date.now()}`);
      fs.mkdirSync(tmpDir, { recursive: true });
      const tarPath = path.join(tmpDir, 'archive.tar.gz');
      fs.writeFileSync(tarPath, binaryBuffer);
      execSync(`tar -xzf "${tarPath}" -C "${tmpDir}"`);
      const extractedFiles = fs.readdirSync(tmpDir).filter((f) => f.startsWith('drop') && !f.endsWith('.tar.gz'));
      if (extractedFiles.length === 0) throw new Error('No se encontró el binario en el archivo comprimido.');
      const extractedBin = path.join(tmpDir, extractedFiles[0]);
      fs.copyFileSync(extractedBin, targetPath);
      fs.chmodSync(targetPath, 0o755);
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    } else {
      if (process.platform === 'win32') {
        const oldPath = targetPath + '.old';
        if (fs.existsSync(oldPath)) {
          try { fs.unlinkSync(oldPath); } catch {}
        }
        if (fs.existsSync(targetPath)) {
          fs.renameSync(targetPath, oldPath);
        }
        fs.writeFileSync(targetPath, binaryBuffer);
        // Limpiar el .old en segundo plano una vez cerrado el proceso
        try {
          execSync(`powershell -NoProfile -Command "Start-Process powershell -ArgumentList '-NoProfile -Command Start-Sleep -Milliseconds 800; Remove-Item -Force ''${oldPath}'' -ErrorAction SilentlyContinue' -WindowStyle Hidden"`, { stdio: 'ignore' });
        } catch {}
      } else {
        fs.writeFileSync(targetPath, binaryBuffer);
        fs.chmodSync(targetPath, 0o755);
      }
    }

    console.log(`  ${c.green}✔ ¡Drop actualizado con éxito a la versión ${c.bold}${remoteTag}${c.reset}${c.green}!${c.reset}\n`);
  } catch (err) {
    console.error(`\n  ${c.red}Error instalando actualización:${c.reset} ${err.message}\n`);
    process.exit(1);
  }
}

function printHelp() {
  console.log(`
${c.bold}drop${c.reset} — transferencia P2P de archivos a máxima velocidad (${c.cyan}v${VERSION}${c.reset})

${c.bold}USO:${c.reset}
  drop send <archivo1> [archivo2 ...]   Envía uno o varios archivos
  drop recv <código-o-enlace>           Recibe los archivos
  drop update                           Busca e instala la última versión disponible
  drop install                          Instala drop en el sistema y lo añade al PATH
  drop uninstall                        Desinstala drop del sistema

${c.bold}OPCIONES:${c.reset}
  -s, --server <url>     Servidor de señalización (por defecto: ${DEFAULT_SERVER})
  -o, --out <directorio> Directorio de destino para descargas (por defecto: actual)
  --update               Comprueba y actualiza a la última versión
  --force                Fuerza la reinstalación en 'drop update'
  -h, --help             Muestra esta ayuda
  -v, --version          Muestra la versión

${c.bold}EJEMPLOS:${c.reset}
  drop send video.mp4
  drop recv 7x9y-z8w2
  drop recv https://drop.oloxx.dev/#7x9y-z8w2
  drop update
`);
}

async function runSend(args, options) {
  const filePaths = args;
  if (!filePaths.length) {
    console.error(`${c.red}Error: Debes especificar al menos un archivo para enviar.${c.reset}`);
    process.exit(1);
  }

  const files = [];
  for (const fp of filePaths) {
    const full = path.resolve(fp);
    if (!fs.existsSync(full)) {
      console.error(`${c.red}Error: El archivo no existe: ${full}${c.reset}`);
      process.exit(1);
    }
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      console.error(`${c.yellow}Nota: Las carpetas completas se añadirán en la próxima versión. Envía archivos o un .zip.${c.reset}`);
      process.exit(1);
    }
    files.push({ path: full, size: stat.size });
  }

  const totalBytes = files.reduce((acc, f) => acc + f.size, 0);
  console.log(`\n${c.bold}Preparando envío:${c.reset} ${files.length} archivo(s) · ${c.cyan}${fmtBytes(totalBytes)}${c.reset}`);

  // 1. Iniciar servidor TCP en puerto efímero
  let broadcaster = null;
  let ws = null;

  const server = createSenderServer(files, '', (current, total, speed) => {
    renderProgressBar(current, total, speed);
  });

  await new Promise((resolve) => server.listen(0, '0.0.0.0', resolve));
  const tcpPort = server.address().port;

  // 2. Conectar a señalización
  let token = null;
  try {
    ws = await connectSignaling(options.server);
    token = await createRoom(ws);
  } catch (err) {
    // Si no hay internet/servidor, generamos token local para LAN pura
    token = Math.random().toString(36).slice(2, 10);
    console.log(`${c.yellow}Aviso: Sin conexión con el servidor. Operando en modo LAN local pura.${c.reset}`);
  }

  // Actualizar clave en el servidor
  server.close();
  const activeServer = createSenderServer(
    files,
    token,
    (current, total, speed) => {
      renderProgressBar(current, total, speed);
    },
    ({ totalBytes, totalTimeSec, avgSpeed, socket }) => {
      renderProgressBarComplete(totalBytes, totalTimeSec, avgSpeed);
      console.log(`\n  ${c.green}✔ ¡Transferencia completada con éxito para el receptor (${socket.remoteAddress})!${c.reset}`);
      console.log(`  ${c.dim}Canal abierto para más descargas. Presiona Ctrl + C para cerrarlo.${c.reset}\n`);
    }
  );
  await new Promise((resolve) => activeServer.listen(tcpPort, '0.0.0.0', resolve));

  // 3. Iniciar descubrimiento LAN
  broadcaster = startBroadcasting(token, tcpPort);

  const shareLink = options.server ? `${options.server}/#${token}` : `https://drop.oloxx.dev/#${token}`;
  console.log(`
  ${c.green}✔ Canal abierto.${c.reset}
  ${c.bold}Código:${c.reset}  ${c.cyan}${token}${c.reset}
  ${c.bold}Enlace:${c.reset}  ${c.dim}${shareLink}${c.reset}

  ${c.dim}Esperando a que el receptor se conecte...${c.reset}
`);

const activeStreams = new Set();

async function streamToWebGuest(guestId, files, ws, onProgress) {
  const CHUNK = 64 * 1024;
  const totalBytes = files.reduce((acc, f) => acc + f.size, 0);
  let totalSent = 0;
  const startTime = performance.now();
  let lastReport = startTime;
  let lastBytes = 0;
  let speed = 0;

  activeStreams.add(guestId);

  try {
    for (const [index, file] of files.entries()) {
      if (!activeStreams.has(guestId)) throw new Error('Receptor desconectado.');

      ws.send(JSON.stringify({
        t: 'signal',
        to: guestId,
        data: {
          type: 'cli-start',
          index,
          name: path.basename(file.path),
          size: file.size,
          mime: 'application/octet-stream',
        }
      }));

      const fd = await fs.promises.open(file.path, 'r');
      const buf = Buffer.allocUnsafe(CHUNK);
      let offset = 0;

      try {
        while (offset < file.size) {
          if (!activeStreams.has(guestId)) throw new Error('Receptor desconectado.');

          const toRead = Math.min(CHUNK, file.size - offset);
          const { bytesRead } = await fd.read(buf, 0, toRead, offset);
          if (bytesRead === 0) break;

          const header = Buffer.allocUnsafe(4);
          header.writeUInt32BE(guestId, 0);
          const packet = Buffer.concat([header, buf.subarray(0, bytesRead)]);

          while (ws.bufferedAmount > 4 * 1024 * 1024) {
            if (!activeStreams.has(guestId)) throw new Error('Receptor desconectado.');
            await new Promise((r) => setTimeout(r, 15));
          }

          ws.send(packet);
          offset += bytesRead;
          totalSent += bytesRead;

          const now = performance.now();
          const dt = (now - lastReport) / 1000;
          if (dt >= 0.15) {
            const inst = (totalSent - lastBytes) / dt;
            speed = speed ? speed * 0.7 + inst * 0.3 : inst;
            lastBytes = totalSent;
            lastReport = now;
            if (onProgress) onProgress(totalSent, totalBytes, speed);
          }
        }
      } finally {
        await fd.close().catch(() => {});
      }

      if (!activeStreams.has(guestId)) throw new Error('Receptor desconectado.');

      ws.send(JSON.stringify({
        t: 'signal',
        to: guestId,
        data: { type: 'cli-end', index }
      }));
    }

    ws.send(JSON.stringify({
      t: 'signal',
      to: guestId,
      data: { type: 'cli-done' }
    }));
    const totalTimeSec = Math.max(0.001, (performance.now() - startTime) / 1000);
    const avgSpeed = totalBytes / totalTimeSec;
    return { totalBytes, totalTimeSec, avgSpeed };
  } finally {
    activeStreams.delete(guestId);
  }
}

  // 4. Si hay WS de señalización, escuchar si el receptor conecta por WAN o Web
  if (ws) {
    const localIPs = getLocalIPs();
    ws.addEventListener('message', async (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.t === 'guest') {
          ws.send(JSON.stringify({
            t: 'signal',
            to: msg.guestId,
            data: {
              type: 'cli-offer',
              ips: localIPs,
              port: tcpPort,
              manifest: files.map((f) => ({
                name: path.basename(f.path),
                size: f.size,
                type: 'application/octet-stream'
              }))
            }
          }));
        } else if (msg.t === 'signal') {
          if (msg.data?.type === 'cli-accept') {
            const guest = msg.from;
            console.log(`\n  ${c.bold}Receptor conectado (${guest}):${c.reset} ${c.cyan}[MODO STREAMING RELAY]${c.reset}\n`);
            try {
              const stats = await streamToWebGuest(guest, files, ws, (sent, total, speed) => {
                renderProgressBar(sent, total, speed);
              });
              renderProgressBarComplete(stats.totalBytes, stats.totalTimeSec, stats.avgSpeed);
              console.log(`\n  ${c.green}✔ ¡Transferencia completada con éxito para el receptor (${guest})!${c.reset}`);
              console.log(`  ${c.dim}Canal abierto para más descargas. Presiona Ctrl + C para cerrarlo.${c.reset}\n`);
            } catch (err) {
              console.log(`\n\n  ${c.yellow}Receptor (${guest}) interrumpido: ${err.message}${c.reset}`);
              console.log(`  ${c.dim}Canal abierto. Esperando nuevas conexiones... (Presiona Ctrl + C para salir)${c.reset}\n`);
            }
          } else if (msg.data?.type === 'cli-error') {
            activeStreams.delete(msg.from);
          }
        } else if (msg.t === 'guest-gone') {
          activeStreams.delete(msg.guestId);
        }
      } catch {}
    });
  }

  activeServer.on('connection', (socket) => {
    const isLocal = socket.remoteAddress?.includes('127.0.0.1') || socket.remoteAddress?.includes('::1') || socket.remoteAddress?.startsWith('192.168.') || socket.remoteAddress?.startsWith('10.');
    const tag = isLocal ? `${c.green}[CONEXIÓN LAN DIRECTA]${c.reset}` : `${c.cyan}[CONEXIÓN DIRECTA]${c.reset}`;
    console.log(`\n  ${c.bold}Receptor CLI conectado:${c.reset} ${socket.remoteAddress} ${tag}\n`);
  });

  console.log(`  ${c.dim}Canal abierto permanentemente. Presiona ${c.bold}Ctrl + C${c.reset}${c.dim} para cerrarlo cuando hayas terminado.${c.reset}\n`);

  await new Promise(() => {
    const onExit = () => {
      console.log(`\n\n  ${c.yellow}Cerrando canal de transferencia...${c.reset}`);
      if (broadcaster) broadcaster.stop();
      if (ws) {
        try { ws.close(); } catch {}
      }
      try { activeServer.close(); } catch {}
      console.log(`  ${c.green}✔ ¡Canal cerrado con éxito!${c.reset}\n`);
      process.exit(0);
    };

    process.on('SIGINT', onExit);
    process.on('SIGTERM', onExit);
  });
}

function printSuccess(received, outputDir) {
  console.log(`\n  ${c.green}✔ ¡Descarga completada con éxito!${c.reset}`);
  console.log(`  ${c.bold}Archivos guardados en:${c.reset} ${outputDir}`);
  for (const f of received) {
    console.log(`    · ${path.basename(f)}`);
  }
  console.log('');
}

async function runRecv(args, options) {
  const input = args[0];
  if (!input) {
    console.error(`${c.red}Error: Debes especificar el código o enlace a recibir.${c.reset}`);
    process.exit(1);
  }

  // Extraer token de URLs si se pega enlace
  const token = input.includes('#') ? input.split('#')[1].trim() : input.trim();
  let outputDir = options.out ? path.resolve(options.out) : process.cwd();

  // Si se ejecuta en una carpeta del sistema protegida (ej. C:\Windows\System32 por abrir PowerShell como Admin),
  // redirigir automáticamente a la carpeta de Descargas del usuario para evitar errores de permisos (EPERM)
  const winDir = process.env.WINDIR || 'C:\\Windows';
  if (!options.out && process.platform === 'win32' && outputDir.toLowerCase().startsWith(winDir.toLowerCase())) {
    const userDownloads = path.join(process.env.USERPROFILE || 'C:\\', 'Downloads');
    outputDir = fs.existsSync(userDownloads) ? userDownloads : (process.env.USERPROFILE || outputDir);
    console.log(`\n  ${c.yellow}Aviso: Terminal abierta en carpeta del sistema. Guardando en: ${outputDir}${c.reset}`);
  }

  // Verificar permisos de escritura antes de iniciar
  try {
    fs.mkdirSync(outputDir, { recursive: true });
    const testWritePath = path.join(outputDir, `.drop_test_${Date.now()}`);
    fs.writeFileSync(testWritePath, '');
    fs.unlinkSync(testWritePath);
  } catch (err) {
    console.error(`\n${c.red}Error: No se tienen permisos de escritura en "${outputDir}".${c.reset}`);
    console.error(`Especifica una carpeta accesible con -o (ejemplo: drop recv ${token} -o %USERPROFILE%\\Downloads)\n`);
    process.exit(1);
  }

  console.log(`\n${c.bold}Buscando emisor para el código:${c.reset} ${c.cyan}${token}${c.reset}`);

  // 1. Primero intentar descubrimiento LAN instantáneo (<1.2s)
  process.stdout.write(`  ${c.dim}Explorando red local (LAN)...${c.reset}`);
  let target = await listenForLAN(token, 1200);

  if (target) {
    console.log(`\r  ${c.green}✔ Emisor encontrado en red local:${c.reset} ${target.host}:${target.port}`);
    console.log(`\n  ${c.bold}Conectando a:${c.reset} ${target.host}:${target.port} (Sockets TCP nativos - LAN)\n`);
    try {
      const received = await receiveFiles(target.host, target.port, token, outputDir, (current, total, speed) => {
        renderProgressBar(current, total, speed);
      });
      if (received.stats) {
        renderProgressBarComplete(received.stats.totalBytes, received.stats.totalTimeSec, received.stats.avgSpeed);
      }
      printSuccess(received, outputDir);
      process.exit(0);
    } catch (err) {
      console.error(`\n${c.red}Error durante la transferencia LAN: ${err.message}${c.reset}`);
      process.exit(1);
    }
  }

  // 2. Si no está en LAN broadcast, conectar por servidor de señalización
  console.log(`\r  ${c.dim}No detectado en LAN directa, conectando por servidor de señalización...${c.reset}`);
  let ws = null;
  let offer = null;
  try {
    ws = await connectSignaling(options.server);
    ws.binaryType = 'arraybuffer';
    await joinRoom(ws, token);

    offer = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Tiempo de espera agotado esperando datos del emisor')), 10000);
      const onMsg = (ev) => {
        try {
          if (typeof ev.data !== 'string') return;
          const msg = JSON.parse(ev.data);
          if (msg.t === 'signal' && (msg.data?.type === 'cli-offer' || msg.data?.type === 'tcp-offer')) {
            clearTimeout(timeout);
            ws.removeEventListener('message', onMsg);
            resolve(msg.data);
          }
        } catch {}
      };
      ws.addEventListener('message', onMsg);
    });
  } catch (err) {
    if (ws) ws.close();
    console.error(`\n${c.red}Error de conexión: ${err.message}${c.reset}`);
    process.exit(1);
  }

  const { ips = [], port, manifest = [] } = offer;

  // 3. Probar si alguna IP es accesible directamente por TCP (misma red local o VPN)
  const localIPs = getLocalIPs();
  const candidateIP = ips.find((rip) => {
    if (rip === '127.0.0.1' || rip === '::1') return true;
    const rsub = rip.split('.').slice(0, 3).join('.');
    return localIPs.some((lip) => lip.split('.').slice(0, 3).join('.') === rsub);
  }) || ips[0];

  if (candidateIP && port) {
    process.stdout.write(`  ${c.dim}Comprobando ruta TCP directa con ${candidateIP}:${port}...${c.reset}`);
    try {
      const received = await receiveFiles(candidateIP, port, token, outputDir, (current, total, speed) => {
        renderProgressBar(current, total, speed);
      }, 1500);
      if (ws) ws.close();
      if (received.stats) {
        renderProgressBarComplete(received.stats.totalBytes, received.stats.totalTimeSec, received.stats.avgSpeed);
      }
      printSuccess(received, outputDir);
      process.exit(0);
    } catch (err) {
      process.stdout.write(`\r${' '.repeat(70)}\r`);
      // Si falla por timeout o error de conexión (NAT/Internet), pasamos a Relay
    }
  }

  // 4. Modo Relay por Internet (Streaming seguro a través del servidor)
  console.log(`  ${c.cyan}[MODO RELAY POR INTERNET]${c.reset} ${c.dim}Descargando archivos en streaming...${c.reset}\n`);
  try {
    const received = await receiveFromRelay(ws, manifest, outputDir, (current, total, speed) => {
      renderProgressBar(current, total, speed);
    });
    if (ws) ws.close();
    if (received.stats) {
      renderProgressBarComplete(received.stats.totalBytes, received.stats.totalTimeSec, received.stats.avgSpeed);
    }
    printSuccess(received, outputDir);
    process.exit(0);
  } catch (err) {
    if (ws) ws.close();
    console.error(`\n${c.red}Error durante la transferencia Relay: ${err.message}${c.reset}`);
    process.exit(1);
  }
}

async function main() {
  const argv = process.argv.slice(2);

  if (process.platform === 'win32') {
    const oldExe = process.execPath + '.old';
    if (fs.existsSync(oldExe)) {
      try { fs.unlinkSync(oldExe); } catch {}
    }
  }

  if (argv.includes('-v') || argv.includes('--version')) {
    console.log(`drop v${VERSION}`);
    return;
  }

  if (argv.includes('install')) {
    await installSelf();
    return;
  }

  if (argv.includes('uninstall')) {
    await uninstallSelf();
    return;
  }

  if (argv.includes('update') || argv.includes('--update')) {
    const force = argv.includes('--force');
    await updateSelf(force);
    return;
  }

  if (!argv.length) {
    const isExe = path.basename(process.execPath).toLowerCase().startsWith('drop');
    if (isExe && !isInstalled()) {
      await installSelf();
      return;
    }
    printHelp();
    return;
  }

  if (argv.includes('-h') || argv.includes('--help')) {
    printHelp();
    return;
  }

  const options = {
    server: DEFAULT_SERVER,
    out: null,
  };

  const cleanArgs = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '-s' || argv[i] === '--server') {
      options.server = argv[++i];
    } else if (argv[i] === '-o' || argv[i] === '--out') {
      options.out = argv[++i];
    } else {
      cleanArgs.push(argv[i]);
    }
  }

  const command = cleanArgs[0];
  const rest = cleanArgs.slice(1);

  if (command === 'send') {
    await runSend(rest, options);
  } else if (command === 'recv' || command === 'get') {
    await runRecv(rest, options);
  } else {
    // Si se pasa directamente un archivo: drop archivo.zip
    if (fs.existsSync(command)) {
      await runSend([command, ...rest], options);
    } else {
      // Si se pasa directamente un token: drop 7x9y-z8w2
      await runRecv([command], options);
    }
  }
}

main().catch((err) => {
  console.error(`\n${c.red}Fallo fatal: ${err.message}${c.reset}`);
  process.exit(1);
});
