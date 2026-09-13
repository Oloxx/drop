#!/usr/bin/env node

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execSync, execFileSync } from 'node:child_process';
import readline from 'node:readline';
import os from 'node:os';
import crypto from 'node:crypto';
import { c, fmtBytes, fmtDuration, renderProgressBar, renderProgressBarComplete, setProgressStream } from './ui.js';
import { getLocalIPs, startBroadcasting, listenForLAN, probeCandidateIPs } from './discovery.js';
import { connectSignaling, createRoom, joinRoom, getSignalingUrl, reportBadGuest } from './signaling.js';
import { attachSender, receiveFiles, receiveFromRelay, RELAY_IDLE_TIMEOUT_MS, PROTOCOL_VERSION } from './transfer.js';
import { listenOrExplain, watchServerErrors } from './listen.js';
import { proofFromKey, sasFromKey, deriveKey, encryptChunk, sealFrame, unsealFrame } from './crypto.js';
import { runSpeedHost, runSpeedGuest } from './speed.js';
import { mapPort } from './upnp.js';
import { newCode, parseCode, randomRoomId, CodeError } from '../../public/shared/codes.js';
import { verifySignature } from './minisign.js';
import { encodeQr, qrToBlocks, ECL } from '../../public/shared/qr.js';
import pkg from '../../package.json' with { type: 'json' };

// La version sale del package.json y de ningun otro sitio. Estuvo escrita a mano
// tambien aqui, y desincronizarlas no es cosmetico: `drop update` compara la
// release de GitHub contra esta constante, asi que una constante vieja deja al
// CLI creyendose desactualizado para siempre, o al reves. Al empaquetar, esbuild
// mete el JSON dentro del bundle, asi que el binario tampoco lee nada en marcha.
const VERSION = pkg.version;

// Clave publica con la que se firma cada release (formato minisign). La privada
// vive como secret del repositorio y solo la toca el workflow de publicacion.
//
// Va empotrada aqui a proposito: si se bajase de la red junto con la firma, quien
// pudiera servir una respuesta falsa serviria las dos y no se estaria comprobando
// nada. Rotarla obliga a publicar una version nueva del CLI, porque los binarios
// ya instalados siguen llevando la vieja.
const PUBLIC_KEY = 'RWQqNnfqvCrj+eavJ9njz2vCoHaC8YnLqjsvNBMndz3hBroQLpou7+Kp';
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

/**
 * Descarga un asset de texto de la release. Devuelve `null` si la release no lo
 * incluye, y lanza si la descarga falla: no es lo mismo "esta release es vieja y
 * no lo trae" que "alguien esta cortando la peticion", y arriba se tratan
 * distinto.
 */
async function fetchTextAsset(release, name, headers) {
  const asset = release.assets?.find((a) => a.name === name);
  if (!asset) return null;

  const authorized = Boolean(headers['Authorization']);
  const res = await fetch(authorized ? asset.url : asset.browser_download_url, {
    headers: {
      'User-Agent': 'drop-cli',
      ...(authorized ? { 'Authorization': headers['Authorization'], 'Accept': 'application/octet-stream' } : {})
    },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} descargando ${name}`);
  return await res.text();
}

/** Busca en un SHA256SUMS el hash de un asset concreto. */
function expectedHashFor(sums, assetName) {
  for (const line of String(sums).split('\n')) {
    // Formato de sha256sum: "<hash>  <nombre>" (dos espacios, o " *" en binario).
    const match = line.trim().match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/);
    if (match && path.basename(match[2].trim()) === assetName) return match[1].toLowerCase();
  }
  return null;
}

/**
 * Comprueba el binario descargado ANTES de escribirlo encima del ejecutable en
 * marcha, que es la superficie mas sensible que tiene la herramienta.
 *
 * Son dos comprobaciones encadenadas y hacen falta las dos:
 *
 *   · la FIRMA del SHA256SUMS dice que ese indice de hashes lo publico quien
 *     tiene la clave privada del proyecto. Sin ella, cualquiera capaz de servir
 *     una respuesta a api.github.com (un proxy con su propia CA, un DNS
 *     envenenado, la cuenta de GitHub comprometida) publica su binario Y su
 *     SHA256SUMS, y las dos mitades cuadran entre si;
 *   · el HASH dice que el binario que ha llegado es el que nombra ese indice.
 *
 * Una release sin firma corta el proceso en vez de conformarse con el hash: si
 * bastara con borrar el .minisig para volver al nivel anterior, la firma no
 * garantizaria nada. `--allow-unsigned` esta para las releases anteriores a la
 * v0.5.2, que no la llevan porque no existia.
 */
async function verifyDownload(release, asset, binaryBuffer, headers, allowUnsigned) {
  let sums = null;
  let signature = null;
  try {
    sums = await fetchTextAsset(release, 'SHA256SUMS', headers);
    if (sums !== null) signature = await fetchTextAsset(release, 'SHA256SUMS.minisig', headers);
  } catch (err) {
    console.error(`\n\n  ${c.red}No se ha podido comprobar la release:${c.reset} ${err.message}`);
    console.error(`  ${c.dim}No se instala nada. Vuelve a intentarlo.${c.reset}\n`);
    process.exit(1);
  }

  if (sums === null) {
    console.error(`\n\n  ${c.red}Esta release no publica SHA256SUMS: no se puede verificar el binario.${c.reset}`);
    console.error(`  ${c.dim}Las releases anteriores a la v0.4.1 no lo incluyen. Si aun asi quieres`);
    console.error(`  actualizar, repite con:${c.reset} ${c.yellow}drop update --skip-verify${c.reset}\n`);
    process.exit(1);
  }

  if (signature === null) {
    if (!allowUnsigned) {
      console.error(`\n\n  ${c.red}Esta release no esta firmada.${c.reset}`);
      console.error(`  ${c.dim}Las anteriores a la v0.5.2 no llevan firma. Para instalarla igualmente,`);
      console.error(`  comprobando solo el hash:${c.reset} ${c.yellow}drop update --allow-unsigned${c.reset}\n`);
      process.exit(1);
    }
    console.log(`\n\n  ${c.yellow}Aviso: release sin firmar, solo se comprueba el hash (--allow-unsigned).${c.reset}`);
  } else {
    const check = verifySignature({ content: sums, signature, publicKey: PUBLIC_KEY });
    if (!check.ok) {
      console.error(`\n\n  ${c.red}✖ La firma de la release no es valida.${c.reset}`);
      console.error(`  ${c.dim}${check.reason}${c.reset}`);
      console.error(`\n  No se instala nada. Si se repite, descargar el binario a mano no es la`);
      console.error(`  salida: el problema no esta en la descarga, sino en quien la sirve.\n`);
      process.exit(1);
    }
    console.log(`\n\n  ${c.green}✔ Firma de la release verificada (Ed25519).${c.reset}`);
  }

  const expected = expectedHashFor(sums, asset.name);
  if (!expected) {
    console.error(`\n  ${c.red}El SHA256SUMS de la release no menciona ${asset.name}.${c.reset}\n`);
    process.exit(1);
  }

  const actual = crypto.createHash('sha256').update(binaryBuffer).digest('hex');
  if (actual !== expected) {
    console.error(`\n  ${c.red}✖ El binario descargado no coincide con el hash publicado.${c.reset}`);
    console.error(`  ${c.dim}Esperado:  ${expected}${c.reset}`);
    console.error(`  ${c.dim}Calculado: ${actual}${c.reset}`);
    console.error(`\n  No se instala nada. Vuelve a intentarlo; si persiste, descarga el binario`);
    console.error(`  a mano desde GitHub y comprueba el hash tu mismo.\n`);
    process.exit(1);
  }
  console.log(`  ${c.green}✔ Integridad verificada (SHA-256).${c.reset}`);
}

async function updateSelf(force = false, skipVerify = false, allowUnsigned = false) {
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

  // Firma y hash ANTES de escribir nada encima del ejecutable en marcha.
  if (skipVerify) {
    console.log(`\n\n  ${c.yellow}Aviso: verificación de integridad omitida (--skip-verify).${c.reset}`);
  } else {
    await verifyDownload(release, asset, binaryBuffer, headers, allowUnsigned);
  }

  console.log(`  ${c.dim}Instalando nueva versión...${c.reset}`);

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
  drop send --text "..."                Envía un texto sin crear un archivo antes
  drop send --clipboard                 Envía el contenido del portapapeles
  drop recv <código-o-enlace>           Recibe los archivos
  drop recv <código> --stdout           Escribe lo recibido en la salida estándar
  drop speed [código-o-enlace]          Mide la velocidad de transferencia entre 2 clientes CLI
  drop update                           Busca e instala la última versión disponible
  drop install                          Instala drop en el sistema y lo añade al PATH
  drop uninstall                        Desinstala drop del sistema

${c.bold}OPCIONES:${c.reset}
  -t, --time <segundos>  Duración de cada fase del test de velocidad (por defecto: 5s)
  -p, --port <puerto>    Puerto TCP local para escucha (por defecto: aleatorio)
  -s, --server <url>     Servidor de señalización (por defecto: ${DEFAULT_SERVER})
  -o, --out <directorio> Directorio de destino para descargas (por defecto: actual)
  --stdout               Vuelca lo recibido a stdout en vez de a disco (también -o -);
                         los mensajes y el progreso se van a stderr
  --text <texto>         Envía ese texto como message.txt
  --clipboard            Envía el portapapeles como clipboard.txt
  --relay                Fuerza la transferencia a través del servidor de Relay
  --direct-only          Fuerza conexión TCP directa sin relay (solo en test de velocidad)
  --overwrite            Sobrescribe los archivos que ya existan en el destino
                         (por defecto se guarda como "archivo (2).zip")
  --no-qr                No pinta el código QR del enlace (se omite solo si la
                         salida no es una terminal)
  --once                 Cierra el canal tras la primera descarga completa
  --expire <duración>    El canal caduca solo pasado ese tiempo: 90s, 10m, 2h
                         (un número suelto son minutos)
  --update               Comprueba y actualiza a la última versión
  --force                Fuerza la reinstalación en 'drop update'
  -y, --yes              No pide confirmación antes de servir a cada receptor
                         (se activa solo si no hay terminal interactiva)
  --allow-unsigned       Permite actualizar a una release sin firma (anteriores a la v0.5.2)
  --skip-verify          Omite firma y hash en 'drop update' (no recomendado)
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
  drop send backup.tar --once --expire 10m
  drop send --text "la clave del wifi es ..."
  drop recv 4271-lemon-radar-tiger-orbit --stdout | pbcopy
  drop recv 4271-lemon-radar-tiger-orbit
  drop recv https://drop.oloxx.dev/#4271-lemon-radar-tiger-orbit
  drop speed
  drop speed 4271-lemon-radar-tiger-orbit
  drop speed 4271-lemon-radar-tiger-orbit -t 10
  drop update
`);
}

/**
 * Lee el portapapeles con la herramienta del sistema: no hay API en Node y una
 * dependencia nativa no cabe en el binario. Se prueban por orden las que suele
 * haber; si no hay ninguna, se dice cual instalar.
 */
function readClipboard() {
  const attempts = process.platform === 'win32'
    ? [['powershell', ['-NoProfile', '-Command', '[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-Clipboard -Raw']]]
    : process.platform === 'darwin'
      ? [['pbpaste', []]]
      : [['wl-paste', ['--no-newline']], ['xclip', ['-selection', 'clipboard', '-o']], ['xsel', ['--clipboard', '--output']]];
  for (const [cmd, cmdArgs] of attempts) {
    try {
      return execFileSync(cmd, cmdArgs, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { /* siguiente herramienta */ }
  }
  const hint = process.platform === 'linux'
    ? 'Hace falta wl-clipboard (Wayland), xclip o xsel (X11).'
    : 'No se ha podido leer el portapapeles con las herramientas del sistema.';
  throw new Error(`No hay forma de leer el portapapeles. ${hint}`);
}

/**
 * `--text` y `--clipboard` envian un fragmento sin que el usuario tenga que
 * crear un archivo: se crea aqui, en un directorio temporal que se borra al
 * salir. El emisor lee de disco con descriptores y por trozos, asi que fabricar
 * un archivo de verdad es lo que menos toca del camino ya probado.
 */
function stageInlineContent(options) {
  const staged = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drop-inline-'));
  if (options.text != null) {
    const p = path.join(dir, 'message.txt');
    fs.writeFileSync(p, options.text, 'utf-8');
    staged.push(p);
  }
  if (options.clipboard) {
    let text;
    try {
      text = readClipboard();
    } catch (err) {
      console.error(`\n${c.red}${err.message}${c.reset}\n`);
      process.exit(1);
    }
    if (!text || !text.trim()) {
      console.error(`\n${c.red}El portapapeles está vacío (o no contiene texto).${c.reset}\n`);
      process.exit(1);
    }
    const p = path.join(dir, 'clipboard.txt');
    fs.writeFileSync(p, text, 'utf-8');
    staged.push(p);
  }
  const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} };
  return { staged, cleanup };
}

async function runSend(args, options) {
  const filePaths = [...args];
  let inlineCleanup = null;
  if (options.text != null || options.clipboard) {
    const { staged, cleanup } = stageInlineContent(options);
    filePaths.push(...staged);
    inlineCleanup = cleanup;
    process.on('exit', cleanup);
  }
  if (!filePaths.length) {
    console.error(`${c.red}Error: Debes especificar al menos un archivo para enviar (o --text / --clipboard).${c.reset}`);
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
  // paralelo con la señalización. Aquí solo hace falta el número de puerto, no la
  // clave: derivarla cuesta 62 ms de scrypt y el código todavía no existe. Es UN
  // solo servidor: antes se abría uno para sondear el puerto, se cerraba sin
  // esperar y se abría otro sobre el mismo puerto, en carrera con el `close()`.
  let broadcaster = null;
  let ws = null;
  let upnpResult = null;
  let activeServer = null;

  // Los manejadores de proceso van ANTES del primer `listen`. Estaban registrados
  // al final, dentro del `await` que deja el canal abierto, o sea cuando el bind ya
  // habia funcionado: un EADDRINUSE o un EACCES salia como excepcion no capturada.
  const onExit = installExitHandlers(() => ({ broadcaster, ws, activeServer, upnpResult }));

  // --once y --expire acotan la ventana en la que el codigo sirve para algo. Un
  // canal abierto sigue atendiendo a cualquiera que tenga el codigo hasta que
  // alguien lo cierra a mano, y con codigos que se dictan (y se oyen de paso)
  // eso es mas ventana de la que hace falta para "te paso este archivo".
  //
  // Ninguno de los dos corta una descarga a medias: al caducar se deja de aceptar
  // gente nueva y se sale cuando termina lo que este en curso. El servidor libera
  // la sala solo, porque la sala muere con el websocket del emisor.
  let inFlight = 0;      // receptores a los que se esta sirviendo ahora mismo
  let delivered = 0;     // descargas completas (por relay, ademas verificadas)
  let expired = false;
  const finishIfDue = () => {
    if (inFlight > 0) return;
    if (options.once && delivered > 0) {
      console.log(`\n  ${c.green}✔ Entrega única completada: se cierra el canal (--once).${c.reset}`);
      onExit(0);
    } else if (expired) {
      console.log(`\n  ${c.yellow}Canal caducado (--expire ${options.expire}): se cierra.${c.reset}`);
      onExit(0);
    }
  };
  const acceptingPeers = () => !expired && !(options.once && delivered > 0);

  activeServer = net.createServer();
  // Entre el bind y el momento en que se conoce el codigo no hay nada que servir:
  // un socket aceptado aqui se quedaria colgado sin que nadie lo lea.
  const rejectEarly = (socket) => socket.destroy();
  activeServer.on('connection', rejectEarly);

  try {
    await listenOrExplain(activeServer, options.port || 0, '0.0.0.0');
  } catch (err) {
    console.error(`\n  ${c.red}${err.message}${c.reset}\n`);
    process.exit(1);
  }
  watchServerErrors(activeServer, (err) => {
    console.error(`\n  ${c.red}Error en el canal de escucha: ${err.message}${c.reset}\n`);
  });
  const tcpPort = activeServer.address().port;

  // `--relay` (o DROP_FORCE_RELAY) fuerza el camino por el servidor: ni UPnP, ni
  // anuncio por LAN, ni IPs en la oferta. Sirve para probarlo a mano y es lo que
  // usa el test de regresión del relay, que si no acabaría yéndose por TCP directo.
  const forceRelay = options.relay || Boolean(process.env.DROP_FORCE_RELAY);

  // Iniciar mapeo UPnP en el router en segundo plano
  let upnpPromise = null;
  if (!forceRelay && !process.env.DROP_NO_UPNP) {
    upnpPromise = mapPort(tcpPort, options.port || tcpPort, 'drop-send', 7200, {
      onRenewError: (err) => {
        console.warn(`\n  ${c.yellow}Aviso: Falló la renovación periódica UPnP en router (${err.message}). Se reintentará...${c.reset}`);
      }
    })
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
    // `connectSignaling` solo vigila el error mientras conecta. Sin este listener
    // permanente, un corte con el canal ya abierto se queda mudo.
    ws.addEventListener('error', () => {
      console.warn(`\n  ${c.yellow}Aviso: se ha perdido la conexión con el servidor de señalización. El canal TCP directo sigue abierto.${c.reset}\n`);
    });
    roomId = await createRoom(ws);
  } catch (err) {
    // Sin servidor no hay quien reparta salas, así que el identificador lo
    // sorteamos nosotros. Con `randomBytes` de node:crypto: antes esto era
    // `Math.random()`, que es un PRNG predecible, y de ahí salía la sal del KDF.
    roomId = randomRoomId(crypto.randomBytes);
    console.log(`${c.yellow}Aviso: Sin conexión con el servidor. Operando en modo LAN local pura.${c.reset}`);
  }

  const code = newCode(roomId, crypto.randomBytes);

  // La clave de la sala se deriva una vez (scrypt, 62 ms) y sirve para todo: el
  // TCP directo la usa dentro de attachSender, y el relay cifra con ella cada
  // trozo y cada marco de control que salga hacia el servidor.
  const key = deriveKey(code);

  // Huella de la sesión: sale de la clave AES ya derivada, no de las palabras del
  // código. Es la misma que ve el receptor por TCP directo, y sirve para comprobar
  // de viva voz que los dos están en la misma transferencia (public/shared/sas.js).
  const sas = sasFromKey(key, roomId);

  // Sin terminal interactiva no hay a quién preguntar: se aprueba solo, igual que
  // con --yes, y se dice en el aviso de cada receptor.
  const askPeer = makePeerGate({
    auto: options.yes || !process.stdin.isTTY,
    motivo: options.yes ? '--yes' : 'sin terminal interactiva',
  });

  // Ya hay código: el servidor que lleva escuchando desde el principio pasa a
  // servir de verdad, sin cerrar nada ni volver a bindear.
  activeServer.off('connection', rejectEarly);
  attachSender(
    activeServer,
    files,
    code,
    (current, total, speed, list) => {
      renderProgressBar(current, total, speed, 30, list);
    },
    ({ totalBytes, totalTimeSec, avgSpeed, socket }) => {
      renderProgressBarComplete(totalBytes, totalTimeSec, avgSpeed);
      delivered++;
      console.log(`\n  ${c.green}✔ ¡Transferencia completada con éxito para el receptor (${socket.remoteAddress})!${c.reset}`);
      if (acceptingPeers()) console.log(`  ${c.dim}Canal abierto para más descargas. Presiona Ctrl + C para cerrarlo.${c.reset}\n`);
    },
    {
      // Nada se escribe en el socket hasta que esto devuelve true: quien conecta
      // sabe el código, pero saber el código no da derecho a los archivos.
      // Con el canal caducado o ya entregado (--once) no se sirve a nadie mas.
      onPeer: ({ address, sas: peerSas }) => (acceptingPeers()
        ? askPeer({ who: address || '(dirección desconocida)', sas: peerSas, path: 'TCP directo' })
        : false),
    }
  );

  // 3. Iniciar descubrimiento LAN. Por el broadcast UDP solo viaja un hash del
  // identificador público: las palabras no se emiten a la subred (ver discovery.js).
  if (!forceRelay) broadcaster = startBroadcasting(code, tcpPort);

  const shareLink = options.server ? `${options.server}/#${code}` : `https://drop.oloxx.dev/#${code}`;
  console.log(`
  ${c.green}✔ Canal abierto.${c.reset}
  ${c.bold}Código:${c.reset}  ${c.cyan}${c.bold}${code}${c.reset}
  ${c.bold}Enlace:${c.reset}  ${c.dim}${shareLink}${c.reset}
  ${c.bold}Huella:${c.reset}  ${c.cyan}${sas}${c.reset} ${c.dim}(el receptor tiene que ver esta misma por TCP directo)${c.reset}

  ${c.dim}Díctaselo tal cual, o pásale el enlace. En el otro equipo:${c.reset}
    ${c.yellow}drop recv ${code}${c.reset}
`);

  // El QR del enlace, para el movil: enfocar la pantalla y listo, sin teclear
  // 16 caracteres ni pasarse el enlace por otra aplicacion. Solo en una terminal
  // de verdad -- en un log o una tuberia son treinta lineas de bloques que no
  // lee nadie -- y con los colores forzados (fondo blanco, tinta negra) para que
  // la camara vea la polaridad normal tanto en un tema oscuro como en uno claro.
  if (!options.noQr && process.stdout.isTTY && !process.env.DROP_NO_QR) {
    try {
      const qr = encodeQr(shareLink, { ecl: ECL.M });
      console.log(qrToBlocks(qr).split('\n').map((l) => '  ' + l).join('\n'));
      console.log(`  ${c.dim}Escanéalo con el móvil para abrir el enlace. (--no-qr lo quita)${c.reset}\n`);
    } catch { /* un enlace que no cabe en un QR no es motivo para no enviar */ }
  }

  console.log(`  ${c.dim}Esperando a que el receptor se conecte...${c.reset}\n`);

const activeStreams = new Set();
const guestAcks = new Map();
// Reto pendiente por receptor: guestId -> nonce.
const pendingProofs = new Map();
// IP con la que cada receptor entró en la sala, para poder decir a quién se sirve.
const guestIps = new Map();

// Lado EMISOR del protocolo de relay del CLI: manda cli-start, los trozos
// binarios, cli-end y cli-done, y avanza la ventana con los cli-ack que le
// llegan. El protocolo entero -- cada mensaje, quien lo emite y que espera de
// vuelta -- esta descrito en cli/src/transfer.js, encima de receiveFromRelay.
// Cambiar algo aqui sin mirar alli es como se llego a que el receptor no
// acusara recibo y el envio se parase a los 8 MB.
//
// Todo lo que sale de aqui va cifrado con la clave de la sala: los marcos de
// control sellados (`sealFrame`) y cada trozo con `encryptChunk`. El servidor
// reenvia lo mismo que antes, solo que ya no puede leerlo. La contabilidad
// (totalSent, acuses, progreso) es de bytes EN CLARO, que es lo que el receptor
// cuenta al otro lado tras descifrar.
function sendSealed(ws, guestId, obj) {
  ws.send(JSON.stringify({ t: 'signal', to: guestId, data: sealFrame(obj, key) }));
}

async function streamToWebGuest(guestId, files, ws, onProgress) {
  const CHUNK = 64 * 1024;
  const MAX_IN_FLIGHT = 8 * 1024 * 1024; // Ventana deslizante de 8 MB máximo sin confirmar
  const totalBytes = files.reduce((acc, f) => acc + f.size, 0);
  const manifest = files.map((f) => ({ name: path.basename(f.path), size: f.size }));
  let totalSent = 0;
  const startTime = performance.now();
  let lastReport = startTime;
  let lastBytes = 0;
  let speed = 0;

  activeStreams.add(guestId);
  const ackInfo = { acked: 0, total: totalBytes, completed: false, notify: null, lastProgress: Date.now() };
  guestAcks.set(guestId, ackInfo);

  // El emisor solo avanza con los acuses del receptor. Si dejan de llegar (receptor
  // caído, o un binario antiguo que no los manda) esto corta con un mensaje en vez
  // de dejar el proceso girando en el bucle de espera para siempre.
  const failIfStalled = () => {
    if (Date.now() - ackInfo.lastProgress <= RELAY_IDLE_TIMEOUT_MS) return;
    throw new Error(
      `El receptor lleva ${Math.round(RELAY_IDLE_TIMEOUT_MS / 1000)}s sin confirmar nada: se corta el envío por relay.`
    );
  };

  try {
    for (const [index, file] of files.entries()) {
      if (!activeStreams.has(guestId)) throw new Error('Receptor desconectado.');

      const fileHash = crypto.createHash('sha256');

      sendSealed(ws, guestId, {
        type: 'cli-start',
        index,
        name: path.basename(file.path),
        size: file.size,
        mime: 'application/octet-stream',
      });

      const fd = await fs.promises.open(file.path, 'r');
      const buf = Buffer.allocUnsafe(CHUNK);
      let offset = 0;

      try {
        while (offset < file.size) {
          if (!activeStreams.has(guestId)) throw new Error('Receptor desconectado.');

          // Control de flujo (Backpressure): pausar si hay más de 8 MB en tránsito sin confirmar
          // o si el buffer local del WebSocket está saturado (> 4 MB)
          let buffered = ws.bufferedAmount;
          while ((totalSent - ackInfo.acked) > MAX_IN_FLIGHT || ws.bufferedAmount > 4 * 1024 * 1024) {
            if (!activeStreams.has(guestId)) throw new Error('Receptor desconectado.');
            // El buffer vaciándose también es señal de vida: en un enlace lento los
            // acuses tardan, pero mientras salgan bytes no hay nada roto.
            if (ws.bufferedAmount < buffered) {
              buffered = ws.bufferedAmount;
              ackInfo.lastProgress = Date.now();
            }
            failIfStalled();
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

          // Cabecera de destino en claro (el servidor la quita) y el trozo
          // cifrado detras: 28 bytes mas por trozo de 64 KiB.
          const header = Buffer.allocUnsafe(4);
          header.writeUInt32BE(guestId, 0);
          const packet = Buffer.concat([header, encryptChunk(slice, key)]);

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
            if (onProgress) onProgress(progressBytes, totalBytes, speed, manifest);
          }
        }
      } finally {
        await fd.close().catch(() => {});
      }

      if (!activeStreams.has(guestId)) throw new Error('Receptor desconectado.');

      const sha256 = fileHash.digest('hex');

      sendSealed(ws, guestId, { type: 'cli-end', index, sha256 });
    }

    sendSealed(ws, guestId, { type: 'cli-done' });

    // Esperar a que el receptor confirme la recepción completa de todos los datos.
    // El reloj se pone a cero aquí: enviar el último archivo puede haber llevado más
    // que el propio timeout sin necesitar un solo acuse por el camino.
    ackInfo.lastProgress = Date.now();
    while (ackInfo.acked < totalBytes && !ackInfo.completed && activeStreams.has(guestId)) {
      failIfStalled();
      await new Promise((resolve) => {
        ackInfo.notify = resolve;
        setTimeout(resolve, 50);
      });
      if (onProgress) {
        onProgress(Math.min(totalBytes, ackInfo.acked), totalBytes, speed, manifest);
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
          // Sin oferta no hay nada que hacer para quien llega tarde: el canal
          // ya no sirve a nadie mas.
          if (!acceptingPeers()) return;
          if (msg.ip) guestIps.set(msg.guestId, msg.ip);
          let upnp = upnpResult;
          if (!upnp && upnpPromise) {
            upnp = await Promise.race([
              upnpPromise,
              new Promise((r) => setTimeout(r, 2000))
            ]);
          }

          const candidateIps = forceRelay ? [] : [...localIPs];
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
              v: PROTOCOL_VERSION,
              ips: candidateIps,
              port: forceRelay ? 0 : (upnp?.externalPort || tcpPort),
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
            // Un receptor de otra version manda otra prueba (o ninguna `v`): no
            // es alguien probando codigos, asi que no cuenta para quemar la
            // sala. Se le dice que no y por que, aunque un binario viejo solo
            // vaya a entender el "no".
            if (msg.data.v !== PROTOCOL_VERSION) {
              console.log(`\n  ${c.yellow}Receptor (${msg.from}) rechazado: usa la versión ${msg.data.v ?? '0 (drop anterior a la 0.5.0)'} del protocolo y este emisor la ${PROTOCOL_VERSION}. Pídele que ejecute drop update.${c.reset}\n`);
              ws.send(JSON.stringify({ t: 'signal', to: msg.from, data: { type: 'cli-denied', reason: 'VERSION', v: PROTOCOL_VERSION } }));
              return;
            }
            if (msg.data.proof !== proofFromKey(key, nonce)) {
              console.log(`\n  ${c.yellow}Receptor (${msg.from}) rechazado: el código no coincide.${c.reset}\n`);
              reportBadGuest(ws, msg.from);
              return;
            }
            // Sabe las palabras, pero eso no le da derecho a los archivos: la
            // última palabra la tiene quien envía. La huella es la misma que por
            // TCP directo: sale de la clave, y por relay se cifra con esa clave.
            const permitido = await askPeer({
              who: guestIps.get(msg.from) || `receptor ${msg.from}`,
              sas,
              path: 'relay por servidor, cifrado extremo a extremo',
            });
            if (!permitido) {
              ws.send(JSON.stringify({ t: 'signal', to: msg.from, data: { type: 'cli-denied' } }));
              return;
            }

            // Los nombres de los archivos ya son informacion: el manifiesto va
            // sellado, como todo lo que sigue.
            sendSealed(ws, msg.from, {
              type: 'cli-manifest',
              v: PROTOCOL_VERSION,
              manifest: files.map((f) => ({
                name: path.basename(f.path),
                size: f.size,
                type: 'application/octet-stream'
              }))
            });
            return;
          }
          if (msg.data?.type === 'cli-accept') {
            const guest = msg.from;
            if (!acceptingPeers()) return;
            console.log(`\n  ${c.bold}Receptor conectado (${guest}):${c.reset} ${c.cyan}[MODO STREAMING RELAY]${c.reset}\n`);
            inFlight++;
            try {
              const stats = await streamToWebGuest(guest, files, ws, (sent, total, speed, list) => {
                renderProgressBar(sent, total, speed, 30, list);
              });
              renderProgressBarComplete(stats.totalBytes, stats.totalTimeSec, stats.avgSpeed);
              // `cli-complete` solo llega con todo escrito y verificado en el
              // receptor: por relay "entregado" quiere decir eso.
              delivered++;
              console.log(`\n  ${c.green}✔ ¡Transferencia completada con éxito para el receptor (${guest})!${c.reset}`);
              if (acceptingPeers()) console.log(`  ${c.dim}Canal abierto para más descargas. Presiona Ctrl + C para cerrarlo.${c.reset}\n`);
            } catch (err) {
              console.log(`\n\n  ${c.yellow}Receptor (${guest}) interrumpido: ${err.message}${c.reset}`);
              if (acceptingPeers()) console.log(`  ${c.dim}Canal abierto. Esperando nuevas conexiones... (Presiona Ctrl + C para salir)${c.reset}\n`);
            } finally {
              inFlight--;
              finishIfDue();
            }
          } else if (msg.data?.type === 'cli-ack') {
            const guest = msg.from;
            const ackInfo = guestAcks.get(guest);
            if (ackInfo) {
              ackInfo.acked = Math.max(ackInfo.acked, msg.data.bytes || 0);
              ackInfo.lastProgress = Date.now();
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
              // El total del envío en curso, no el de la sesión: un `cli-retry`
              // reenvía solo una parte de los archivos.
              ackInfo.acked = ackInfo.total ?? totalBytes;
              ackInfo.lastProgress = Date.now();
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
            inFlight++;
            try {
              const filesToRetry = files.slice(retryIdx);
              const stats = await streamToWebGuest(guest, filesToRetry, ws, (sent, total, speed, list) => {
                renderProgressBar(sent, total, speed, 30, list);
              });
              renderProgressBarComplete(stats.totalBytes, stats.totalTimeSec, stats.avgSpeed);
              delivered++;
              console.log(`\n  ${c.green}✔ ¡Reintento completado con éxito para (${guest})!${c.reset}\n`);
            } catch (err) {
              console.log(`\n  ${c.yellow}Reintento interrumpido: ${err.message}${c.reset}\n`);
            } finally {
              inFlight--;
              finishIfDue();
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
          guestIps.delete(msg.guestId);
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
    // Por TCP la entrega se cuenta en onComplete; aqui solo se sabe cuando el
    // socket se ha ido, que es el momento en que --once/--expire pueden cerrar.
    inFlight++;
    socket.once('close', () => {
      inFlight--;
      finishIfDue();
    });
  });

  if (options.expire) {
    const ms = parseDuration(options.expire);
    const timer = setTimeout(() => {
      expired = true;
      // Se deja de anunciar y de aceptar. Lo que este en curso termina: cortar
      // una descarga al 90% por un reloj no le hace ningun favor a nadie.
      if (broadcaster) broadcaster.stop();
      try { activeServer.close(); } catch {}
      if (inFlight > 0) {
        console.log(`\n  ${c.yellow}Canal caducado (--expire ${options.expire}): no se aceptan más receptores; se termina la transferencia en curso.${c.reset}`);
      }
      finishIfDue();
    }, ms);
    timer.unref?.();
  }

  const vigencia = [
    options.once ? 'se cierra tras la primera descarga (--once)' : '',
    options.expire ? `caduca en ${options.expire} (--expire)` : '',
  ].filter(Boolean).join(' y ');
  console.log(vigencia
    ? `  ${c.dim}Canal abierto: ${vigencia}. Presiona ${c.bold}Ctrl + C${c.reset}${c.dim} para cerrarlo antes.${c.reset}\n`
    : `  ${c.dim}Canal abierto permanentemente. Presiona ${c.bold}Ctrl + C${c.reset}${c.dim} para cerrarlo cuando hayas terminado.${c.reset}\n`);

  // El canal se queda abierto hasta que alguien lo cierre; el cierre ordenado lo
  // llevan los manejadores instalados arriba.
  await new Promise(() => {});
}

/**
 * `--expire 10m` -> milisegundos. Acepta `s`, `m` y `h`; un numero suelto son
 * minutos, que es la unidad en la que la gente piensa "esto caduca en...".
 */
function parseDuration(text) {
  const m = String(text).trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(s|m|h|min|seg|sec)?$/);
  if (!m) {
    const err = new Error(`Duración no válida: "${text}". Ejemplos: 90s, 10m, 2h.`);
    err.code = 'BAD_DURATION';
    throw err;
  }
  const n = Number(m[1]);
  const unit = (m[2] || 'm')[0];
  const factor = unit === 's' ? 1000 : unit === 'h' ? 3_600_000 : 60_000;
  const ms = Math.round(n * factor);
  if (!(ms > 0)) {
    const err = new Error(`La duración tiene que ser mayor que cero: "${text}".`);
    err.code = 'BAD_DURATION';
    throw err;
  }
  return ms;
}

/**
 * Cierre ordenado del emisor: para el anuncio LAN, cierra la señalización y el
 * servidor TCP y deshace el mapeo UPnP.
 *
 * `getState` se pasa como funcion y no como objeto porque esto se instala antes de
 * que exista nada de eso: la gracia es cubrir tambien los fallos del arranque.
 */
function installExitHandlers(getState) {
  let closing = false;

  const onExit = async (exitCode = 0) => {
    if (closing) return;
    closing = true;
    const { broadcaster, ws, activeServer, upnpResult } = getState();
    if (exitCode === 0) {
      console.log(`\n\n  ${c.yellow}Cerrando canal de transferencia...${c.reset}`);
    }
    if (broadcaster) broadcaster.stop();
    if (ws) {
      try { ws.close(); } catch {}
    }
    if (activeServer) {
      try { activeServer.close(); } catch {}
    }
    if (upnpResult?.unmap) {
      try { await upnpResult.unmap(); } catch {}
    }
    if (exitCode === 0) {
      console.log(`  ${c.green}✔ ¡Canal cerrado con éxito!${c.reset}\n`);
    }
    process.exit(exitCode);
  };

  process.on('SIGINT', () => onExit(0));
  process.on('SIGTERM', () => onExit(0));
  // El mensaje primero; la pila solo con DROP_DEBUG. Lo que necesita quien lo lee
  // es la frase, no cuarenta lineas de `at ...`.
  process.on('uncaughtException', async (err) => {
    console.error(`\n  ${c.red}Error no capturado:${c.reset} ${err?.message || err}`);
    if (process.env.DROP_DEBUG) console.error(err);
    await onExit(1);
  });
  process.on('unhandledRejection', async (reason) => {
    console.error(`\n  ${c.red}Promesa rechazada no capturada:${c.reset} ${reason?.message || reason}`);
    if (process.env.DROP_DEBUG) console.error(reason);
    await onExit(1);
  });
  process.on('exit', () => {
    const { upnpResult } = getState();
    if (upnpResult?.unmapSync) {
      try { upnpResult.unmapSync(); } catch {}
    }
  });

  return onExit;
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

/**
 * Final de `drop recv`. Con `--stdout` los archivos se han recibido en un
 * directorio temporal -- verificados igual, con su `.part` y su SHA-256 -- y
 * aqui se vuelcan a la salida estandar, en orden, y se borra el temporal. Se
 * vuelca al final y no en streaming a proposito: lo que sale por la tuberia ya
 * esta comprobado, y una tuberia no se puede rebobinar si el hash no cuadra.
 */
async function finishRecv(received, outputDir, options) {
  if (!options.stdout) {
    printSuccess(received, outputDir);
    return;
  }
  for (const item of received) {
    const filePath = typeof item === 'string' ? item : item.path;
    await new Promise((resolve, reject) => {
      const src = fs.createReadStream(filePath);
      src.on('error', reject);
      src.on('end', resolve);
      src.pipe(process.stdout, { end: false });
    });
  }
  await new Promise((resolve) => (process.stdout.write('', resolve)));
  try { fs.rmSync(outputDir, { recursive: true, force: true }); } catch {}
  console.error(`  ${c.green}✔ ${received.length} archivo(s) verificado(s) y volcado(s) a stdout.${c.reset}`);
}

/**
 * Pide permiso al humano antes de servirle los archivos a alguien.
 *
 * Las peticiones se encolan: con dos receptores a la vez, dos prompts de readline
 * compitiendo por el mismo stdin se comen las teclas del otro.
 *
 * Sin TTY (un script, un cron, la suite de tests) NO se pregunta: se aprueba y se
 * dice por que. Bloquear ahi seria colgar el proceso esperando una tecla que no va
 * a llegar nunca.
 */
function makePeerGate({ auto, motivo }) {
  let cola = Promise.resolve();

  return function askPeer({ who, sas, path: via }) {
    const turno = cola.then(async () => {
      const huella = sas
        ? `\n  ${c.bold}Huella de la sesión:${c.reset} ${c.cyan}${sas}${c.reset} ${c.dim}(tiene que coincidir con la que ve el receptor)${c.reset}`
        : `\n  ${c.dim}Sin huella: por esta ruta los datos pasan por el servidor de relay.${c.reset}`;

      const donde = via ? ` ${c.dim}(${via})${c.reset}` : '';
      console.log(`\n  ${c.bold}Alguien quiere descargar:${c.reset} ${c.yellow}${who}${c.reset}${donde}${huella}`);

      if (auto) {
        console.log(`  ${c.dim}Autorizado sin preguntar (${motivo}).${c.reset}\n`);
        return true;
      }

      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const respuesta = await new Promise((r) => rl.question(`  ¿Le dejas descargar? (s/N): `, r));
      rl.close();
      const ok = ['s', 'si', 'sí', 'y', 'yes'].includes(respuesta.trim().toLowerCase());
      console.log(ok
        ? `  ${c.green}✔ Autorizado.${c.reset}\n`
        : `  ${c.yellow}✖ Rechazado.${c.reset} ${c.dim}El canal sigue abierto para otros receptores.${c.reset}\n`);
      return ok;
    });

    // La cola no se puede romper por un fallo de un prompt: si no, el siguiente
    // receptor se quedaria esperando un turno que no llega nunca.
    cola = turno.catch(() => {});
    return turno;
  };
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

/**
 * Se llama al conectar por TCP directo, antes de que llegue el manifiesto.
 *
 * Enseña la huella para poder compararla con la del emisor por otro canal, y avisa
 * de que la espera es normal: el emisor puede estar pidiéndole permiso a un humano.
 */
function printSasAndWait(sas) {
  console.log(`  ${c.bold}Huella de la sesión:${c.reset} ${c.cyan}${sas}${c.reset} ${c.dim}(compárala con la del emisor)${c.reset}`);
  console.log(`  ${c.dim}Esperando a que el emisor autorice la descarga...${c.reset}\n`);
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
  // --stdout: el contenido va por stdout, asi que TODO lo demas -- mensajes,
  // barra de progreso, errores -- tiene que irse a stderr. Se recibe en un
  // temporal, con todas las comprobaciones de siempre, y se vuelca al final.
  const term = options.stdout ? process.stderr : process.stdout;
  if (options.stdout) {
    console.log = (...a) => console.error(...a);
    setProgressStream(process.stderr);
    options.out = fs.mkdtempSync(path.join(os.tmpdir(), 'drop-stdout-'));
    process.on('exit', () => { try { fs.rmSync(options.out, { recursive: true, force: true }); } catch {} });
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

  // `--relay` (o DROP_FORCE_RELAY) salta los caminos directos y va derecho al
  // servidor: es la forma de probar ese modo sin montar una NAT de verdad.
  const forceRelay = options.relay || Boolean(process.env.DROP_FORCE_RELAY);

  // 1. Primero intentar descubrimiento LAN instantáneo (<1.2s)
  let target = null;
  if (!forceRelay) {
    term.write(`  ${c.dim}Explorando red local (LAN)...${c.reset}`);
    target = await listenForLAN(code, 1200);
  }

  if (target) {
    console.log(`\r  ${c.green}✔ Emisor encontrado en red local:${c.reset} ${target.host}:${target.port}`);
    console.log(`\n  ${c.bold}Conectando a:${c.reset} ${target.host}:${target.port} (Sockets TCP nativos - LAN)\n`);
    try {
      const received = await receiveFiles(target.host, target.port, code, outputDir, (current, total, speed, list) => {
        renderProgressBar(current, total, speed, 30, list);
      }, 0, { overwrite: options.overwrite, onConnected: printSasAndWait });
      if (received.stats) {
        renderProgressBarComplete(received.stats.totalBytes, received.stats.totalTimeSec, received.stats.avgSpeed);
      }
      await finishRecv(received, outputDir, options);
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
  console.log(`\r  ${c.dim}${forceRelay ? 'Relay forzado: conectando por servidor de señalización...' : 'No detectado en LAN directa, conectando por servidor de señalización...'}${c.reset}`);
  let ws = null;
  let offer = null;
  try {
    ws = await connectSignaling(options.server);
    ws.binaryType = 'arraybuffer';
    // Nos presentamos como `cli`: un emisor web nos servira por el relay en vez
    // de mandarnos una oferta WebRTC que no sabriamos contestar.
    await joinRoom(ws, roomId, { name: 'cli' });

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
          } else if (msg.t === 'signal' && msg.data?.sdp) {
            // Una oferta WebRTC: el emisor es una pagina anterior a que la web
            // supiera servir a un CLI. Decirlo vale mas que agotar el tiempo.
            clearTimeout(timeout);
            ws.removeEventListener('message', onMsg);
            reject(new Error('El emisor es una versión antigua de la web que no sabe servir a un receptor CLI: pídele que recargue la página.'));
          } else if (msg.t === 'host-gone') {
            clearTimeout(timeout);
            ws.removeEventListener('message', onMsg);
            reject(new Error('El emisor ha cerrado el canal.'));
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

  // La oferta es lo unico que va en claro, y trae la version: si no es la
  // nuestra, nada de lo que venga detras (cifrado con otra prueba, otro
  // formato) se va a entender. Cortar aqui evita sondear TCP para nada.
  if (offer.v !== PROTOCOL_VERSION) {
    ws.close();
    console.error(`
${c.red}El emisor usa la versión ${offer.v ?? '0 (drop anterior a la 0.5.0)'} del protocolo y este receptor la ${PROTOCOL_VERSION}: actualiza drop en los dos equipos.${c.reset}
`);
    process.exit(1);
  }

  const { ips = [], port } = offer;
  // La misma clave que usa el TCP directo: por relay cifra cada trozo y cada
  // marco de control, y de ella sale la prueba de conocimiento y la huella.
  const key = deriveKey(code);

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
  const candidateIPs = port && !forceRelay ? [...new Set(ips)].sort((a, b) => scoreIP(b) - scoreIP(a)) : [];

  if (candidateIPs.length > 0) {
    term.write(`  ${c.dim}Comprobando ruta TCP directa con el emisor...${c.reset}`);
    const probe = await probeCandidateIPs(candidateIPs, port, 2500);
    term.write('\r\x1b[K');
    if (probe) {
      try { probe.socket.destroy(); } catch {}
      const isLocal = probe.ip?.includes('127.0.0.1') || probe.ip?.includes('::1') || probe.ip?.startsWith('192.168.') || probe.ip?.startsWith('10.');
      const tag = isLocal ? 'Sockets TCP nativos - LAN' : 'Sockets TCP nativos - Internet/P2P';
      console.log(`  ${c.green}✔ Emisor alcanzable por TCP directo:${c.reset} ${probe.ip}:${port}`);
      console.log(`\n  ${c.bold}Conectando a:${c.reset} ${probe.ip}:${port} (${tag})\n`);
      try {
        const received = await receiveFiles(probe.ip, port, code, outputDir, (current, total, speed, list) => {
          renderProgressBar(current, total, speed, 30, list);
        }, 3000, { overwrite: options.overwrite, onConnected: printSasAndWait });
        if (ws) ws.close();
        if (received.stats) {
          renderProgressBarComplete(received.stats.totalBytes, received.stats.totalTimeSec, received.stats.avgSpeed);
        }
        await finishRecv(received, outputDir, options);
        process.exit(0);
      } catch (err) {
        if (err.code === 'INTEGRITY_MISMATCH' || err.message?.includes('SHA-256')) {
          if (ws) ws.close();
          return askRetry(err, () => runRecv(args, options));
        }
        // Cambiar de camino no arregla ninguno de estos: cortar aqui y decirlo.
        // Antes se tragaban y se reintentaba por relay, donde volvian a fallar
        // igual pero sesenta segundos mas tarde.
        if (['PROTOCOL_VERSION', 'PROTOCOL_FRAME', 'PROTOCOL_ERROR', 'BAD_CODE', 'UNSAFE_NAME'].includes(err.code)) {
          if (ws) ws.close();
          console.error(`
${c.red}${err.message}${c.reset}
`);
          process.exit(1);
        }
      }
    }
  }

  // 4. Modo Relay por Internet (Streaming cifrado a través del servidor).
  //
  // El emisor no manda el manifiesto con la oferta: primero pide una prueba de
  // que tenemos la misma clave. Es un HMAC con la clave scrypt y no un hash de
  // las palabras porque pasa por el servidor (ver crypto.js y shared/e2ee.js).
  // Por TCP directo no se manda nunca: allí la prueba es que AES-GCM autentique.
  console.log(`  ${c.cyan}[MODO RELAY POR INTERNET]${c.reset} ${c.dim}${offer.web ? 'El emisor es un navegador: ' : ''}descargando archivos en streaming, cifrados de extremo a extremo...${c.reset}`);
  // La huella sale de la clave, y ahora por relay se cifra con esa misma clave:
  // significa lo mismo que por TCP directo (ver public/shared/sas.js).
  console.log(`  ${c.bold}Huella de la sesión:${c.reset} ${c.cyan}${sasFromKey(key, roomId)}${c.reset} ${c.dim}(compárala con la del emisor)${c.reset}`);
  console.log(`  ${c.dim}Esperando a que el emisor autorice la descarga...${c.reset}\n`);
  let manifest = null;
  try {
    manifest = await new Promise((resolve, reject) => {
      // Generoso a proposito: al otro lado puede haber alguien decidiendo si
      // autoriza la descarga, y eso no cabe en diez segundos.
      const timeout = setTimeout(
        () => reject(new Error('El emisor no ha respondido: puede que no haya autorizado la descarga.')),
        90_000
      );
      const onMsg = (ev) => {
        try {
          if (typeof ev.data !== 'string') return;
          const msg = JSON.parse(ev.data);
          if (msg.t === 'signal' && msg.data?.type === 'cli-sealed') {
            // El manifiesto llega sellado. Si no autentica, la clave no es la
            // misma, y eso ya no puede pasar aqui: la prueba la acabamos de dar.
            let inner;
            try {
              inner = unsealFrame(msg.data, key);
            } catch {
              clearTimeout(timeout);
              ws.removeEventListener('message', onMsg);
              reject(Object.assign(new Error('El manifiesto del emisor no autentica con esta clave.'), { code: 'PROTOCOL_ERROR' }));
              return;
            }
            if (inner.type !== 'cli-manifest') return;
            clearTimeout(timeout);
            ws.removeEventListener('message', onMsg);
            if (inner.v !== PROTOCOL_VERSION) {
              const err = new Error(
                `El emisor usa la versión ${inner.v ?? '0 (drop anterior a la 0.5.0)'} del protocolo y este receptor la ${PROTOCOL_VERSION}: actualiza drop en los dos equipos.`
              );
              err.code = 'PROTOCOL_VERSION';
              reject(err);
              return;
            }
            resolve(inner.manifest || []);
          } else if (msg.t === 'signal' && msg.data?.type === 'cli-denied') {
            // El código era correcto: quien envía ha dicho que no.
            clearTimeout(timeout);
            ws.removeEventListener('message', onMsg);
            if (msg.data.reason === 'VERSION') {
              reject(Object.assign(
                new Error(`El emisor usa la versión ${msg.data.v ?? '?'} del protocolo y este receptor la ${PROTOCOL_VERSION}: actualiza drop en los dos equipos.`),
                { code: 'PROTOCOL_VERSION' },
              ));
              return;
            }
            reject(new Error('El emisor no ha autorizado esta descarga.'));
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
        data: { type: 'cli-proof', v: PROTOCOL_VERSION, proof: proofFromKey(key, offer.nonce || '') },
      }));
    });
  } catch (err) {
    if (ws) ws.close();
    console.error(`\n${c.red}Error: ${err.message}${c.reset}\n`);
    process.exit(1);
  }

  try {
    const received = await receiveFromRelay(ws, manifest, outputDir, (current, total, speed, list) => {
      renderProgressBar(current, total, speed, 30, list);
    }, { overwrite: options.overwrite, key });
    if (ws) ws.close();
    if (received.stats) {
      renderProgressBarComplete(received.stats.totalBytes, received.stats.totalTimeSec, received.stats.avgSpeed);
    }
    await finishRecv(received, outputDir, options);
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
    const skipVerify = argv.includes('--skip-verify');
    const allowUnsigned = argv.includes('--allow-unsigned');
    await updateSelf(force, skipVerify, allowUnsigned);
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
    overwrite: false,
    yes: false,
    once: false,
    expire: null,
    noQr: false,
    stdout: false,
    text: null,
    clipboard: false,
  };

  const cleanArgs = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '-s' || argv[i] === '--server') {
      options.server = argv[++i];
    } else if (argv[i] === '-o' || argv[i] === '--out') {
      options.out = argv[++i];
      // `-o -` es la forma de toda la vida de decir "a stdout".
      if (options.out === '-') { options.out = null; options.stdout = true; }
    } else if (argv[i] === '--stdout') {
      options.stdout = true;
    } else if (argv[i] === '--text') {
      options.text = argv[++i];
      if (options.text == null) {
        console.error(`\n${c.red}--text necesita el texto a enviar.${c.reset}\n`);
        process.exit(1);
      }
    } else if (argv[i] === '--clipboard') {
      options.clipboard = true;
    } else if (argv[i] === '-p' || argv[i] === '--port') {
      options.port = parseInt(argv[++i], 10) || 0;
    } else if (argv[i] === '-t' || argv[i] === '--time') {
      options.time = parseInt(argv[++i], 10) || 5;
    } else if (argv[i] === '--direct-only') {
      options.directOnly = true;
    } else if (argv[i] === '--relay') {
      options.relay = true;
    } else if (argv[i] === '--overwrite') {
      options.overwrite = true;
    } else if (argv[i] === '--once') {
      options.once = true;
    } else if (argv[i] === '--no-qr') {
      options.noQr = true;
    } else if (argv[i] === '--expire') {
      options.expire = argv[++i];
      // Se valida aqui, antes de abrir nada: un canal que se abre y muere al
      // instante por una duracion mal escrita es peor que no abrirse.
      try {
        parseDuration(options.expire);
      } catch (err) {
        console.error(`\n${c.red}${err.message}${c.reset}\n`);
        process.exit(1);
      }
    } else if (argv[i] === '-y' || argv[i] === '--yes') {
      options.yes = true;
    } else {
      cleanArgs.push(argv[i]);
    }
  }

  const command = cleanArgs[0];
  const rest = cleanArgs.slice(1);

  // `drop --text "..."` o `drop --clipboard` a secas: es un envio.
  if (!command && (options.text != null || options.clipboard)) {
    await runSend([], options);
    return;
  }

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
