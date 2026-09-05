import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const NODE_VERSION = 'v22.15.0';
const DIST_DIR = path.resolve('dist');
const CACHE_DIR = path.resolve('node_modules', '.cache', 'sea-binaries');

if (!fs.existsSync(DIST_DIR)) fs.mkdirSync(DIST_DIR, { recursive: true });
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf-8'));
const VERSION_TAG = `v${pkg.version}`;

const TARGETS = {
  'win-x64': {
    output: `drop-${VERSION_TAG}-windows-x64.exe`,
    legacyOutput: 'drop-windows-x64.exe',
    getNode: async () => {
      // Nada de reutilizar `process.execPath` aunque estemos en Windows x64: el
      // Node del sistema puede ser de cualquier version, y el binario base tiene
      // que ser exactamente NODE_VERSION (ver generateBlob).
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
    output: `drop-${VERSION_TAG}-linux-x64`,
    archive: `node-${NODE_VERSION}-linux-x64.tar.gz`,
    subPath: `node-${NODE_VERSION}-linux-x64/bin/node`,
  },
  'linux-arm64': {
    output: `drop-${VERSION_TAG}-linux-arm64`,
    archive: `node-${NODE_VERSION}-linux-arm64.tar.gz`,
    subPath: `node-${NODE_VERSION}-linux-arm64/bin/node`,
  },
  'darwin-arm64': {
    output: `drop-${VERSION_TAG}-macos-arm64`,
    archive: `node-${NODE_VERSION}-darwin-arm64.tar.gz`,
    subPath: `node-${NODE_VERSION}-darwin-arm64/bin/node`,
  },
  'darwin-x64': {
    output: `drop-${VERSION_TAG}-macos-x64`,
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
  const isDarwin = key.startsWith('darwin-');
  const onDarwinHost = process.platform === 'darwin';

  // Los binarios de macOS vienen firmados de nodejs.org. La inyeccion invalida
  // esa firma, y en arm64 la firma no es opcional: el sistema mata el proceso al
  // arrancar. Hay que quitarla antes de tocar el binario y volver a ponerla
  // despues (firma ad-hoc, `-`). Solo se puede hacer desde un macOS: al compilar
  // desde Linux o Windows el binario sale sin firmar y hay que firmarlo luego.
  if (isDarwin && onDarwinHost) {
    try {
      execSync(`codesign --remove-signature "${outPath}"`, { stdio: 'ignore' });
    } catch {
      // Un binario ya sin firma hace fallar el comando: no es un problema.
    }
  }

  // Mach-O no tiene "recursos" como PE ni "notas" como ELF: el blob va en una
  // seccion dentro de un segmento propio, y postject necesita que se lo digan.
  // Sin esto el binario de macOS se genera igual pero no encuentra su bytecode.
  const machoFlag = isDarwin ? ' --macho-segment-name NODE_SEA' : '';
  execSync(`npx --yes postject "${outPath}" NODE_SEA_BLOB "${blobPath}" --sentinel-fuse ${fuse}${machoFlag}`, { stdio: 'inherit' });

  if (isDarwin) {
    if (onDarwinHost) {
      execSync(`codesign --sign - --force "${outPath}"`, { stdio: 'inherit' });
      console.log(`  ${'\u2714'} Binario firmado (ad-hoc) para macOS.`);
    } else {
      console.warn(`  Aviso: ${key} compilado desde ${process.platform}, sale SIN FIRMAR.`);
      console.warn(`  En un Mac no arrancara (arm64) o avisara Gatekeeper. Firmalo con:`);
      console.warn(`    codesign --sign - --force dist/${info.output}`);
    }
  }

  const sizeMB = (fs.statSync(outPath).size / (1024 * 1024)).toFixed(1);
  console.log(`✔ ¡Binario generado con éxito!: dist/${info.output} (${sizeMB} MB)`);

  if (info.legacyOutput) {
    fs.copyFileSync(outPath, path.join(DIST_DIR, info.legacyOutput));
  }

  if (key !== 'win-x64') {
    const tarName = `${info.output}.tar.gz`;
    console.log(`  Empaquetando dist/${tarName}...`);
    execSync(`tar -czf "${path.join(DIST_DIR, tarName)}" -C "${DIST_DIR}" "${info.output}"`);
    console.log(`✔ ¡Comprimido generado!: dist/${tarName}`);
  }
}

// Que binario base corresponde a la maquina donde se compila. Se usa para
// generar el blob, no para inyectarlo.
const HOST_KEY = {
  'darwin-arm64': 'darwin-arm64',
  'darwin-x64': 'darwin-x64',
  'linux-x64': 'linux-x64',
  'linux-arm64': 'linux-arm64',
  'win32-x64': 'win-x64',
}[`${process.platform}-${process.arch}`];

/**
 * Genera el blob SEA con el Node de NODE_VERSION, no con el del sistema.
 *
 * El blob va atado a la version EXACTA de Node que lo produce, no solo a la
 * mayor. Un blob generado con v22.23.2 e inyectado en un binario base v22.15.0
 * compila sin quejarse y produce ejecutables que mueren al arrancar, en todas
 * las plataformas a la vez:
 *
 *   FATAL ERROR: v8::ToLocalChecked Empty MaybeLocal
 *     node::sea::LoadSingleExecutableApplication(...)
 *
 * Paso en la release v0.4.0: el runner traia v22.23.2 y las bases eran v22.15.0.
 * Comprobar la version mayor no basta, y pedirle a quien compila que tenga
 * instalada una version concreta es fragil. Asi que se descarga el binario base
 * del host -- el mismo mecanismo que ya se usa para los targets, con la misma
 * cache -- y se genera el blob con el. La version del Node del sistema deja de
 * importar: solo hace falta para arrancar este script.
 */
async function generateBlob() {
  if (!HOST_KEY) {
    console.warn(`\n  Aviso: plataforma ${process.platform}-${process.arch} sin binario base conocido.`);
    console.warn(`  Se genera el blob con el Node del sistema (v${process.versions.node}).`);
    console.warn(`  Si no es exactamente ${NODE_VERSION}, los ejecutables no arrancaran.\n`);
    execSync('node --experimental-sea-config sea-config.json', { stdio: 'inherit' });
    return;
  }

  const hostNode = await getBinary(HOST_KEY, TARGETS[HOST_KEY]);
  if (process.platform !== 'win32') {
    try { fs.chmodSync(hostNode, 0o755); } catch {}
  }
  execSync(`"${hostNode}" --experimental-sea-config sea-config.json`, { stdio: 'inherit' });
}

async function main() {
  const args = process.argv.slice(2);
  const requested = args[0] || 'win-x64';

  console.log('1. Generando bundle de código...');
  execSync('npx --yes esbuild cli/src/cli.js --bundle --platform=node --format=cjs --outfile=dist/bundle.cjs', { stdio: 'inherit' });

  console.log(`2. Generando blob SEA con Node ${NODE_VERSION}...`);
  await generateBlob();

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
