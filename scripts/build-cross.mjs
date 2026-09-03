import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const NODE_VERSION = 'v22.15.0';
const DIST_DIR = path.resolve('dist');
const CACHE_DIR = path.resolve('node_modules', '.cache', 'sea-binaries');

if (!fs.existsSync(DIST_DIR)) fs.mkdirSync(DIST_DIR, { recursive: true });
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const TARGETS = {
  'win-x64': {
    output: 'drop.exe',
    getNode: async () => {
      if (process.platform === 'win32' && process.arch === 'x64') {
        return process.execPath;
      }
      const dest = path.join(CACHE_DIR, `node-${NODE_VERSION}-win-x64.exe`);
      if (!fs.existsSync(dest)) {
        console.log(`  Descargando node.exe (${NODE_VERSION})...`);
        const res = await fetch(`https://nodejs.org/dist/${NODE_VERSION}/win-x64/node.exe`);
        const buf = Buffer.from(await res.arrayBuffer());
        fs.writeFileSync(dest, buf);
      }
      return dest;
    }
  },
  'linux-x64': {
    output: 'drop-linux-x64',
    archive: `node-${NODE_VERSION}-linux-x64.tar.gz`,
    subPath: `node-${NODE_VERSION}-linux-x64/bin/node`,
  },
  'linux-arm64': {
    output: 'drop-linux-arm64',
    archive: `node-${NODE_VERSION}-linux-arm64.tar.gz`,
    subPath: `node-${NODE_VERSION}-linux-arm64/bin/node`,
  },
  'darwin-arm64': {
    output: 'drop-macos-arm64',
    archive: `node-${NODE_VERSION}-darwin-arm64.tar.gz`,
    subPath: `node-${NODE_VERSION}-darwin-arm64/bin/node`,
  },
  'darwin-x64': {
    output: 'drop-macos-x64',
    archive: `node-${NODE_VERSION}-darwin-x64.tar.gz`,
    subPath: `node-${NODE_VERSION}-darwin-x64/bin/node`,
  },
};

async function getBinary(key, info) {
  if (info.getNode) return await info.getNode();

  const binaryDest = path.join(CACHE_DIR, `base-${key}-node`);
  if (fs.existsSync(binaryDest)) return binaryDest;

  const archiveDest = path.join(CACHE_DIR, info.archive);
  if (!fs.existsSync(archiveDest)) {
    console.log(`  Descargando ${info.archive}...`);
    const url = `https://nodejs.org/dist/${NODE_VERSION}/${info.archive}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} al descargar ${url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(archiveDest, buf);
  }

  console.log(`  Extrayendo binario de ${info.archive}...`);
  // Usar tar nativo para extraer solo el archivo binario
  execSync(`tar -xzf "${archiveDest}" -C "${CACHE_DIR}" "${info.subPath}"`, { stdio: 'inherit' });
  const extracted = path.join(CACHE_DIR, info.subPath);
  fs.copyFileSync(extracted, binaryDest);
  return binaryDest;
}

async function buildTarget(key) {
  const info = TARGETS[key];
  if (!info) {
    console.error(`Destino desconocido: ${key}. Opciones: ${Object.keys(TARGETS).join(', ')}`);
    process.exit(1);
  }

  console.log(`\n=== Compilando Drop para [${key}] ===`);
  const baseBinary = await getBinary(key, info);
  const outPath = path.join(DIST_DIR, info.output);

  console.log(`  Copiando binario base a ${info.output}...`);
  fs.copyFileSync(baseBinary, outPath);

  console.log(`  Inyectando bytecode SEA con postject...`);
  const fuse = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
  const blobPath = path.join(DIST_DIR, 'sea-prep.blob');
  execSync(`npx --yes postject "${outPath}" NODE_SEA_BLOB "${blobPath}" --sentinel-fuse ${fuse}`, { stdio: 'inherit' });

  const sizeMB = (fs.statSync(outPath).size / (1024 * 1024)).toFixed(1);
  console.log(`✔ ¡Binario generado con éxito!: dist/${info.output} (${sizeMB} MB)`);
}

async function main() {
  const args = process.argv.slice(2);
  const requested = args[0] || 'win-x64';

  console.log('1. Generando bundle de código...');
  execSync('npx --yes esbuild cli/src/cli.js --bundle --platform=node --format=cjs --outfile=dist/bundle.cjs', { stdio: 'inherit' });

  console.log('2. Generando blob SEA agnóstico de plataforma...');
  execSync('node --experimental-sea-config sea-config.json', { stdio: 'inherit' });

  if (requested === 'all') {
    for (const key of Object.keys(TARGETS)) {
      await buildTarget(key);
    }
  } else {
    await buildTarget(requested);
  }

  // Limpiar temporales
  const bundlePath = path.join(DIST_DIR, 'bundle.cjs');
  const blobPath = path.join(DIST_DIR, 'sea-prep.blob');
  if (fs.existsSync(bundlePath)) fs.unlinkSync(bundlePath);
  if (fs.existsSync(blobPath)) fs.unlinkSync(blobPath);

  console.log('\n✔ Proceso de compilación finalizado.');
}

main().catch((err) => {
  console.error('\nError durante la compilación:', err.message);
  process.exit(1);
});
