#!/usr/bin/env node

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execSync } from 'node:child_process';
import readline from 'node:readline';
import os from 'node:os';
import crypto from 'node:crypto';
import { c, fmtBytes, fmtDuration, renderProgressBar, renderProgressBarComplete } from './ui.js';
import { getLocalIPs, startBroadcasting, listenForLAN, probeCandidateIPs } from './discovery.js';
import { connectSignaling, createRoom, joinRoom, getSignalingUrl, reportBadGuest } from './signaling.js';
import { createSenderServer, receiveFiles, receiveFromRelay } from './transfer.js';
import { secretProof } from './crypto.js';
import { runSpeedHost, runSpeedGuest } from './speed.js';
import { mapPort } from './upnp.js';
import { newCode, parseCode, randomRoomId, CodeError } from '../../public/shared/codes.js';

const VERSION = '0.4.0';
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
  drop speed [código-o-enlace]          Mide la velocidad de transferencia entre 2 clientes CLI
  drop update                           Busca e instala la última versión disponible
  drop install                          Instala drop en el sistema y lo añade al PATH
  drop uninstall                        Desinstala drop del sistema

${c.bold}OPCIONES:${c.reset}
  -t, --time <segundos>  Duración de cada fase del test de velocidad (por defecto: 5s)
  -p, --port <puerto>    Puerto TCP local para escucha (por defecto: aleatorio)
  -s, --server <url>     Servidor de señalización (por defecto: ${DEFAULT_SERVER})
  -o, --out <directorio> Directorio de destino para descargas (por defecto: actual)
  --relay                Fuerza el test a través del servidor de Relay
  --direct-only          Fuerza conexión TCP directa sin relay (solo en test de velocidad)
  --update               Comprueba y actualiza a la última versión
  --force                Fuerza la reinstalación en 'drop update'
  -h, --help             Muestra esta ayuda
  -v, --version          Muestra la versión

${c.bold}EL CÓDIGO:${c.reset}
  ${c.cyan}4271-lemon-radar-tiger-orbit${c.reset}
  ${c.dim}El número identifica la sala y es lo único que ve el servidor. Las cuatro
  palabras son el secreto del que sale el cifrado y no salen de tu equipo.
  Al teclearlo da igual usar mayúsculas, espacios en vez de guiones o solo las
  4 primeras letras de cada palabra: 4271-lemo-rada-tige-orbi vale igual.${c.reset}

${c.bold}EJEMPLOS:${c.reset}
  drop send video.mp4
  drop recv 4271-lemon-radar-tiger-orbit
  drop recv https://drop.oloxx.dev/#4271-lemon-radar-tiger-orbit
  drop speed
  drop speed 4271-lemon-radar-tiger-orbit
  drop speed 4271-lemon-radar-tiger-orbit -t 10
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

  // 1. Reservar el puerto TCP antes de nada, para poder lanzar el mapeo UPnP en
  // paralelo con la señalización. Aquí solo hace falta el número de puerto: el
  // servidor de verdad se monta abajo, cuando ya existe el código. Antes se creaba
  // aquí un `createSenderServer` con token vacío y se tiraba; ahora derivar la
  // clave cuesta 62 ms de scrypt y no tiene ningún sentido pagarlos para nada.
  let broadcaster = null;
  let ws = null;

  const portProbe = net.createServer();
  await new Promise((resolve) => portProbe.listen(options.port || 0, '0.0.0.0', resolve));
  const tcpPort = portProbe.address().port;

  // Iniciar mapeo UPnP en el router en segundo plano
  let upnpPromise = null;
  let upnpResult = null;
  if (!process.env.DROP_NO_UPNP) {
    upnpPromise = mapPort(tcpPort, options.port || tcpPort, 'drop-send')
      .then((res) => {
        if (res?.success) {
          upnpResult = res;
          console.log(`  ${c.green}✔ Puerto mapeado por UPnP en router:${c.reset} ${c.cyan}:${res.externalPort}${c.reset} ${c.dim}(IP WAN: ${res.publicIp || 'detectada'})${c.reset}`);
        }
        return res;
      })
      .catch(() => null);
  }

  // 2. Conectar a señalización. El servidor solo reparte el identificador PUBLICO
  // de sala (4 dígitos); las palabras del código las sorteamos aquí y no salen de
  // esta máquina: son el único material del que se deriva la clave AES.
  let roomId = null;
  try {
    ws = await connectSignaling(options.server);
    roomId = await createRoom(ws);
  } catch (err) {
    // Sin servidor no hay quien reparta salas, así que el identificador lo
    // sorteamos nosotros. Con `randomBytes` de node:crypto: antes esto era
    // `Math.random()`, que es un PRNG predecible, y de ahí salía la sal del KDF.
    roomId = randomRoomId(crypto.randomBytes);
    console.log(`${c.yellow}Aviso: Sin conexión con el servidor. Operando en modo LAN local pura.${c.reset}`);
  }

  const code = newCode(roomId, crypto.randomBytes);
  const { secret } = parseCode(code);

  portProbe.close();
  const activeServer = createSenderServer(
    files,
    code,
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

  // 3. Iniciar descubrimiento LAN. Por el broadcast UDP solo viaja un hash del
  // identificador público: las palabras no se emiten a la subred (ver discovery.js).
  broadcaster = startBroadcasting(code, tcpPort);

  const shareLink = options.server ? `${options.server}/#${code}` : `https://drop.oloxx.dev/#${code}`;
  console.log(`
  ${c.green}✔ Canal abierto.${c.reset}
  ${c.bold}Código:${c.reset}  ${c.cyan}${c.bold}${code}${c.reset}
  ${c.bold}Enlace:${c.reset}  ${c.dim}${shareLink}${c.reset}

  ${c.dim}Díctaselo tal cual, o pásale el enlace. En el otro equipo:${c.reset}
    ${c.yellow}drop recv ${code}${c.reset}

  ${c.dim}Esperando a que el receptor se conecte...${c.reset}
`);

const activeStreams = new Set();
const guestAcks = new Map();
// Reto pendiente por receptor: guestId -> nonce.
const pendingProofs = new Map();

async function streamToWebGuest(guestId, files, ws, onProgress) {
  const CHUNK = 64 * 1024;
  const MAX_IN_FLIGHT = 8 * 1024 * 1024; // Ventana deslizante de 8 MB máximo sin confirmar
  const totalBytes = files.reduce((acc, f) => acc + f.size, 0);
  let totalSent = 0;
  const startTime = performance.now();
  let lastReport = startTime;
  let lastBytes = 0;
  let speed = 0;

  activeStreams.add(guestId);
  const ackInfo = { acked: 0, completed: false, notify: null };
  guestAcks.set(guestId, ackInfo);

  try {
    for (const [index, file] of files.entries()) {
      if (!activeStreams.has(guestId)) throw new Error('Receptor desconectado.');

      const fileHash = crypto.createHash('sha256');

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

          // Control de flujo (Backpressure): pausar si hay más de 8 MB en tránsito sin confirmar
          // o si el buffer local del WebSocket está saturado (> 4 MB)
          while ((totalSent - ackInfo.acked) > MAX_IN_FLIGHT || ws.bufferedAmount > 4 * 1024 * 1024) {
            if (!activeStreams.has(guestId)) throw new Error('Receptor desconectado.');
            await new Promise((resolve) => {
              ackInfo.notify = resolve;
              setTimeout(resolve, 50);
            });
          }

          const toRead = Math.min(CHUNK, file.size - offset);
          const { bytesRead } = await fd.read(buf, 0, toRead, offset);
          if (bytesRead === 0) break;

          const slice = buf.subarray(0, bytesRead);
          fileHash.update(slice);

          const header = Buffer.allocUnsafe(4);
          header.writeUInt32BE(guestId, 0);
          const packet = Buffer.concat([header, slice]);

          ws.send(packet);
          offset += bytesRead;
          totalSent += bytesRead;

          const now = performance.now();
          const dt = (now - lastReport) / 1000;
          if (dt >= 0.15) {
            // El progreso real mostrado se basa en lo que el receptor ha confirmado (ACKs)
            const progressBytes = Math.min(totalBytes, Math.max(ackInfo.acked, Math.min(totalSent, totalBytes)));
            const inst = (progressBytes - lastBytes) / dt;
            speed = speed ? speed * 0.7 + inst * 0.3 : inst;
            lastBytes = progressBytes;
            lastReport = now;
            if (onProgress) onProgress(progressBytes, totalBytes, speed);
          }
        }
      } finally {
        await fd.close().catch(() => {});
      }

      if (!activeStreams.has(guestId)) throw new Error('Receptor desconectado.');

      const sha256 = fileHash.digest('hex');

      ws.send(JSON.stringify({
        t: 'signal',
        to: guestId,
        data: { type: 'cli-end', index, sha256 }
      }));
    }

    ws.send(JSON.stringify({
      t: 'signal',
      to: guestId,
      data: { type: 'cli-done' }
    }));

    // Esperar a que el receptor confirme la recepción completa de todos los datos
    while (ackInfo.acked < totalBytes && !ackInfo.completed && activeStreams.has(guestId)) {
      await new Promise((resolve) => {
        ackInfo.notify = resolve;
        setTimeout(resolve, 50);
      });
      if (onProgress) {
        onProgress(Math.min(totalBytes, ackInfo.acked), totalBytes, speed);
      }
    }

    const totalTimeSec = Math.max(0.001, (performance.now() - startTime) / 1000);
    const avgSpeed = totalBytes / totalTimeSec;
    return { totalBytes, totalTimeSec, avgSpeed };
  } finally {
    activeStreams.delete(guestId);
    guestAcks.delete(guestId);
  }
}

  // 4. Si hay WS de señalización, escuchar si el receptor conecta por WAN o Web
  if (ws) {
    const localIPs = getLocalIPs();
    ws.addEventListener('message', async (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.t === 'guest') {
          let upnp = upnpResult;
          if (!upnp && upnpPromise) {
            upnp = await Promise.race([
              upnpPromise,
              new Promise((r) => setTimeout(r, 2000))
            ]);
          }

          const candidateIps = [...localIPs];
          if (upnp?.publicIp && !candidateIps.includes(upnp.publicIp)) {
            candidateIps.push(upnp.publicIp);
          }
          if (ws.publicIp && !candidateIps.includes(ws.publicIp)) {
            candidateIps.push(ws.publicIp);
          }

          // La oferta va SIN manifiesto. Acertar el identificador de sala son 4
          // dígitos, y los nombres de los archivos ya son información: primero
          // que demuestre que sabe las palabras. El reto es un nonce nuevo por
          // receptor, así que una respuesta no vale para la siguiente sala.
          const nonce = crypto.randomBytes(16).toString('hex');
          pendingProofs.set(msg.guestId, nonce);

          ws.send(JSON.stringify({
            t: 'signal',
            to: msg.guestId,
            data: {
              type: 'cli-offer',
              ips: candidateIps,
              port: upnp?.externalPort || tcpPort,
              upnp: Boolean(upnp?.success),
              nonce,
            }
          }));
        } else if (msg.t === 'signal') {
          if (msg.data?.type === 'cli-proof') {
            // Solo lo manda quien va a comer por el relay (la web siempre, y un
            // CLI que no ha podido abrir TCP directo). Por TCP directo no hace
            // falta: la prueba de conocimiento es que AES-GCM autentique.
            const nonce = pendingProofs.get(msg.from);
            if (!nonce) return;
            pendingProofs.delete(msg.from);
            if (msg.data.proof !== secretProof(nonce, secret)) {
              console.log(`\n  ${c.yellow}Receptor (${msg.from}) rechazado: el código no coincide.${c.reset}\n`);
              reportBadGuest(ws, msg.from);
              return;
            }
            ws.send(JSON.stringify({
              t: 'signal',
              to: msg.from,
              data: {
                type: 'cli-manifest',
                manifest: files.map((f) => ({
                  name: path.basename(f.path),
                  size: f.size,
                  type: 'application/octet-stream'
                }))
              }
            }));
            return;
          }
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
          } else if (msg.data?.type === 'cli-ack') {
            const guest = msg.from;
            const ackInfo = guestAcks.get(guest);
            if (ackInfo) {
              ackInfo.acked = Math.max(ackInfo.acked, msg.data.bytes || 0);
              if (ackInfo.notify) {
                const cb = ackInfo.notify;
                ackInfo.notify = null;
                cb();
              }
            }
          } else if (msg.data?.type === 'cli-complete') {
            const guest = msg.from;
            const ackInfo = guestAcks.get(guest);
            if (ackInfo) {
              ackInfo.completed = true;
              ackInfo.acked = totalBytes;
              if (ackInfo.notify) {
                const cb = ackInfo.notify;
                ackInfo.notify = null;
                cb();
              }
            }
          } else if (msg.data?.type === 'cli-retry') {
            const guest = msg.from;
            const retryIdx = msg.data?.index || 0;
            console.log(`\n  ${c.yellow}Reintentando envío para archivo #${retryIdx} a petición de (${guest})...${c.reset}\n`);
            try {
              const filesToRetry = files.slice(retryIdx);
              const stats = await streamToWebGuest(guest, filesToRetry, ws, (sent, total, speed) => {
                renderProgressBar(sent, total, speed);
              });
              renderProgressBarComplete(stats.totalBytes, stats.totalTimeSec, stats.avgSpeed);
              console.log(`\n  ${c.green}✔ ¡Reintento completado con éxito para (${guest})!${c.reset}\n`);
            } catch (err) {
              console.log(`\n  ${c.yellow}Reintento interrumpido: ${err.message}${c.reset}\n`);
            }
          } else if (msg.data?.type === 'cli-error') {
            activeStreams.delete(msg.from);
            const ackInfo = guestAcks.get(msg.from);
            if (ackInfo?.notify) {
              const cb = ackInfo.notify;
              ackInfo.notify = null;
              cb();
            }
          }
        } else if (msg.t === 'guest-gone') {
          activeStreams.delete(msg.guestId);
          pendingProofs.delete(msg.guestId);
          const ackInfo = guestAcks.get(msg.guestId);
          if (ackInfo?.notify) {
            const cb = ackInfo.notify;
            ackInfo.notify = null;
            cb();
          }
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
    const onExit = async () => {
      console.log(`\n\n  ${c.yellow}Cerrando canal de transferencia...${c.reset}`);
      if (broadcaster) broadcaster.stop();
      if (ws) {
        try { ws.close(); } catch {}
      }
      try { activeServer.close(); } catch {}
      if (upnpResult?.unmap) {
        try { await upnpResult.unmap(); } catch {}
      }
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
  for (const item of received) {
    const filePath = typeof item === 'string' ? item : (item.path || item);
    const verified = typeof item === 'object' && item.verified;
    const badge = verified ? ` ${c.green}✔ verificado (SHA-256)${c.reset}` : '';
    console.log(`    · ${path.basename(filePath)}${badge}`);
  }
  console.log('');
}

async function askRetry(err, retryFn) {
  if (err.code === 'INTEGRITY_MISMATCH' || err.message?.includes('SHA-256')) {
    console.error(`\n  ${c.red}✖ Alerta de discrepancia de integridad:${c.reset} ${err.message}`);
    if (process.stdin.isTTY) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise((r) => rl.question(`\n  ¿Deseas reintentar la transferencia del archivo corrupto? (s/N): `, r));
      rl.close();
      if (answer.trim().toLowerCase() === 's' || answer.trim().toLowerCase() === 'y') {
        console.log(`\n  ${c.cyan}Reintentando transferencia...${c.reset}\n`);
        return retryFn();
      }
    }
  }
  process.exit(1);
}

async function runRecv(args, options) {
  const input = args[0];
  if (!input) {
    console.error(`${c.red}Error: Debes especificar el código o enlace a recibir.${c.reset}`);
    process.exit(1);
  }

  // Validar el código ANTES de tocar la red: no tiene sentido abrir un websocket
  // para descubrir que faltaba una palabra. `parseCode` acepta el código suelto o
  // un enlace entero, tolera mayúsculas, acentos y espacios en vez de guiones, y
  // corrige prefijos (`4271-lemo-rada-tige-orbi`).
  let parsed;
  try {
    parsed = parseCode(input);
  } catch (err) {
    if (err instanceof CodeError) {
      console.error(`\n${c.red}Código inválido:${c.reset} ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
  // `code` es lo que abre la caja fuerte (de ahí sale la clave AES); `roomId` es
  // lo único que puede salir a la red: al servidor y al broadcast de la LAN.
  const code = parsed.code;
  const roomId = parsed.roomId;
  if (parsed.legacy) {
    // @deprecated Código de la v0.3.5. Se acepta para poder recibir de emisores
    // ya distribuidos; se elimina en la v0.5.0.
    console.log(`\n  ${c.yellow}Aviso: código en formato antiguo (v0.3.5). Sigue funcionando, pero pídele al emisor que actualice.${c.reset}`);
  }
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
    console.error(`Especifica una carpeta accesible con -o (ejemplo: drop recv ${code} -o %USERPROFILE%\\Downloads)\n`);
    process.exit(1);
  }

  console.log(`\n${c.bold}Buscando emisor para el código:${c.reset} ${c.cyan}${code}${c.reset}`);

  // 1. Primero intentar descubrimiento LAN instantáneo (<1.2s)
  process.stdout.write(`  ${c.dim}Explorando red local (LAN)...${c.reset}`);
  let target = await listenForLAN(code, 1200);

  if (target) {
    console.log(`\r  ${c.green}✔ Emisor encontrado en red local:${c.reset} ${target.host}:${target.port}`);
    console.log(`\n  ${c.bold}Conectando a:${c.reset} ${target.host}:${target.port} (Sockets TCP nativos - LAN)\n`);
    try {
      const received = await receiveFiles(target.host, target.port, code, outputDir, (current, total, speed) => {
        renderProgressBar(current, total, speed);
      });
      if (received.stats) {
        renderProgressBarComplete(received.stats.totalBytes, received.stats.totalTimeSec, received.stats.avgSpeed);
      }
      printSuccess(received, outputDir);
      process.exit(0);
    } catch (err) {
      if (err.code === 'INTEGRITY_MISMATCH' || err.message?.includes('SHA-256')) {
        return askRetry(err, () => runRecv(args, options));
      }
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
    await joinRoom(ws, roomId);

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

  const { ips = [], port } = offer;

  // 3. Probar si alguna IP es accesible directamente por TCP (misma red local, VPN o UPnP en Internet)
  const localIPs = getLocalIPs();
  function scoreIP(ip) {
    if (ip === '127.0.0.1' || ip === '::1') return 100;
    const rsub = ip.split('.').slice(0, 3).join('.');
    if (localIPs.some((lip) => lip.split('.').slice(0, 3).join('.') === rsub)) return 90;
    if (ip.startsWith('192.168.')) return 80;
    if (ip.startsWith('10.')) return 70;
    if (ip.startsWith('172.')) return 60;
    return 50;
  }
  const candidateIPs = port ? [...new Set(ips)].sort((a, b) => scoreIP(b) - scoreIP(a)) : [];

  if (candidateIPs.length > 0) {
    process.stdout.write(`  ${c.dim}Comprobando ruta TCP directa con el emisor...${c.reset}`);
    const probe = await probeCandidateIPs(candidateIPs, port, 2500);
    process.stdout.write('\r\x1b[K');
    if (probe) {
      try { probe.socket.destroy(); } catch {}
      const isLocal = probe.ip?.includes('127.0.0.1') || probe.ip?.includes('::1') || probe.ip?.startsWith('192.168.') || probe.ip?.startsWith('10.');
      const tag = isLocal ? 'Sockets TCP nativos - LAN' : 'Sockets TCP nativos - Internet/P2P';
      console.log(`  ${c.green}✔ Emisor alcanzable por TCP directo:${c.reset} ${probe.ip}:${port}`);
      console.log(`\n  ${c.bold}Conectando a:${c.reset} ${probe.ip}:${port} (${tag})\n`);
      try {
        const received = await receiveFiles(probe.ip, port, code, outputDir, (current, total, speed) => {
          renderProgressBar(current, total, speed);
        }, 3000);
        if (ws) ws.close();
        if (received.stats) {
          renderProgressBarComplete(received.stats.totalBytes, received.stats.totalTimeSec, received.stats.avgSpeed);
        }
        printSuccess(received, outputDir);
        process.exit(0);
      } catch (err) {
        if (err.code === 'INTEGRITY_MISMATCH' || err.message?.includes('SHA-256')) {
          if (ws) ws.close();
          return askRetry(err, () => runRecv(args, options));
        }
      }
    }
  }

  // 4. Modo Relay por Internet (Streaming seguro a través del servidor).
  //
  // El emisor no manda el manifiesto con la oferta: primero pide una prueba de
  // que conocemos las palabras. Aquí sí la damos, y solo aquí: por este camino
  // los datos pasan por el servidor de todas formas, así que no hay cifrado
  // nuestro que proteger. Por TCP directo no se manda nunca (ver crypto.js).
  console.log(`  ${c.cyan}[MODO RELAY POR INTERNET]${c.reset} ${c.dim}Descargando archivos en streaming...${c.reset}\n`);
  // @deprecated Un emisor v0.3.5 manda el manifiesto dentro de la propia oferta y
  // no entiende de retos: si viene, se usa tal cual. Se elimina en la v0.5.0.
  let manifest = offer.manifest || null;
  try {
    if (!manifest) manifest = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('El emisor no ha aceptado el código')), 10000);
      const onMsg = (ev) => {
        try {
          if (typeof ev.data !== 'string') return;
          const msg = JSON.parse(ev.data);
          if (msg.t === 'signal' && msg.data?.type === 'cli-manifest') {
            clearTimeout(timeout);
            ws.removeEventListener('message', onMsg);
            resolve(msg.data.manifest || []);
          } else if (msg.t === 'error') {
            clearTimeout(timeout);
            ws.removeEventListener('message', onMsg);
            reject(new Error('El emisor ha rechazado el código: las palabras no coinciden.'));
          }
        } catch {}
      };
      ws.addEventListener('message', onMsg);
      ws.send(JSON.stringify({
        t: 'signal',
        data: { type: 'cli-proof', proof: secretProof(offer.nonce || '', parsed.secret) },
      }));
    });
  } catch (err) {
    if (ws) ws.close();
    console.error(`\n${c.red}Error: ${err.message}${c.reset}\n`);
    process.exit(1);
  }

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
    if (err.code === 'INTEGRITY_MISMATCH' || err.message?.includes('SHA-256')) {
      return askRetry(err, () => runRecv(args, options));
    }
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
    time: 5,
    port: 0,
    directOnly: false,
    relay: false,
  };

  const cleanArgs = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '-s' || argv[i] === '--server') {
      options.server = argv[++i];
    } else if (argv[i] === '-o' || argv[i] === '--out') {
      options.out = argv[++i];
    } else if (argv[i] === '-p' || argv[i] === '--port') {
      options.port = parseInt(argv[++i], 10) || 0;
    } else if (argv[i] === '-t' || argv[i] === '--time') {
      options.time = parseInt(argv[++i], 10) || 5;
    } else if (argv[i] === '--direct-only') {
      options.directOnly = true;
    } else if (argv[i] === '--relay') {
      options.relay = true;
    } else {
      cleanArgs.push(argv[i]);
    }
  }

  const command = cleanArgs[0];
  const rest = cleanArgs.slice(1);

  if (command === 'send') {
    await runSend(rest, options);
  } else if (command === 'recv' || command === 'get') {
    // Ojo con el join: `drop recv 4271 lemon radar tiger orbit` (dictado con
    // espacios) tiene que funcionar igual que con guiones.
    await runRecv([rest.join(' ')], options);
  } else if (command === 'speed' || command === 'test') {
    if (rest.length > 0 && !rest[0].startsWith('-')) {
      await runSpeedGuest(rest.join(' '), options);
    } else {
      await runSpeedHost(options);
    }
  } else {
    // Si se pasa directamente un archivo: drop archivo.zip
    if (fs.existsSync(command)) {
      await runSend([command, ...rest], options);
    } else {
      // Si se pasa directamente un código: drop 4271-lemon-radar-tiger-orbit
      // Se unen los argumentos sueltos porque al dictarlo mucha gente lo teclea
      // con espacios en vez de guiones, y `parseCode` ya normaliza eso.
      await runRecv([[command, ...rest].join(' ')], options);
    }
  }
}

main().catch((err) => {
  console.error(`\n${c.red}Fallo fatal: ${err.message}${c.reset}`);
  process.exit(1);
});
