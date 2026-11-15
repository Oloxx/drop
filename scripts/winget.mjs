// Genera y opcionalmente envia a `microsoft/winget-pkgs` el manifiesto WinGet
// de una release publicada de `Oloxx/drop`.
//
// Invariante de seguridad: nunca confia en los hashes ni genera manifiestos sin
// verificar antes `SHA256SUMS.minisig` con la clave publica del proyecto usando
// `./minisign.mjs` (`verifySignature`).
//
// Uso:
//   node scripts/winget.mjs [tag] [--out <dir>] [--from-dist <dir>] [--date AAAA-MM-DD] [--submit]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { verifySignature } from './minisign.mjs';

export const DEFAULT_REPO = 'Oloxx/drop';
export const UPSTREAM_REPO = 'microsoft/winget-pkgs';
export const PACKAGE_ID = 'Oloxx.drop';
export const PUBLIC_KEY = 'RWQqNnfqvCrj+eavJ9njz2vCoHaC8YnLqjsvNBMndz3hBroQLpou7+Kp';
export const SCHEMA_VERSION = '1.12.0';

function normalizeTagAndVersion(rawTag) {
  const clean = String(rawTag || '').trim();
  if (!clean) {
    throw new Error('Falta la etiqueta o version de la release.');
  }
  const version = clean.replace(/^v/i, '');
  const tag = `v${version}`;
  return { tag, version };
}

/**
 * Analiza un fichero `SHA256SUMS` y devuelve un Map `nombreArchivo -> sha256`.
 */
export function parseSums(text) {
  const map = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([0-9a-f]{64})\s+\*?(\S+)$/i);
    if (!match) continue;
    const cleanName = match[2].replace(/^\.\//, '');
    map.set(path.posix.basename(cleanName), match[1].toLowerCase());
  }
  return map;
}

/**
 * Construye los tres ficheros YAML del manifiesto multiarchivo WinGet (`1.28.0`).
 */
export function buildManifests({ version, sha256, releaseDate, tag }) {
  const ver = String(version || '').replace(/^v/i, '');
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(ver)) {
    throw new Error(`Version no valida para WinGet: "${version}".`);
  }
  if (!/^[0-9a-f]{64}$/i.test(String(sha256 || ''))) {
    throw new Error(`SHA-256 no valido para WinGet: "${sha256}".`);
  }
  const releaseTag = tag || `v${ver}`;
  const date = releaseDate || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`Fecha no valida para ReleaseDate (esperado AAAA-MM-DD): "${date}".`);
  }

  const exeName = `drop-${releaseTag}-windows-x64.exe`;
  const installerUrl = `https://github.com/${DEFAULT_REPO}/releases/download/${releaseTag}/${exeName}`;
  const shaUpper = sha256.toUpperCase();
  const relDir = path.posix.join('manifests', 'o', 'Oloxx', 'drop', ver);

  const versionYaml = [
    `# yaml-language-server: $schema=https://aka.ms/winget-manifest.version.${SCHEMA_VERSION}.schema.json`,
    '',
    `PackageIdentifier: ${PACKAGE_ID}`,
    `PackageVersion: ${ver}`,
    'DefaultLocale: en-US',
    'ManifestType: version',
    `ManifestVersion: ${SCHEMA_VERSION}`,
    '',
  ].join('\n');

  const installerYaml = [
    `# yaml-language-server: $schema=https://aka.ms/winget-manifest.installer.${SCHEMA_VERSION}.schema.json`,
    '',
    `PackageIdentifier: ${PACKAGE_ID}`,
    `PackageVersion: ${ver}`,
    'InstallerLocale: en-US',
    'InstallerType: portable',
    'Commands:',
    '- drop',
    `ReleaseDate: ${date}`,
    'Installers:',
    '- Architecture: x64',
    `  InstallerUrl: ${installerUrl}`,
    `  InstallerSha256: ${shaUpper}`,
    'ManifestType: installer',
    `ManifestVersion: ${SCHEMA_VERSION}`,
    '',
  ].join('\n');

  const localeYaml = [
    `# yaml-language-server: $schema=https://aka.ms/winget-manifest.defaultLocale.${SCHEMA_VERSION}.schema.json`,
    '',
    `PackageIdentifier: ${PACKAGE_ID}`,
    `PackageVersion: ${ver}`,
    'PackageLocale: en-US',
    'Publisher: Oloxx',
    'PublisherUrl: https://github.com/Oloxx',
    'PublisherSupportUrl: https://github.com/Oloxx/drop/issues',
    'Author: Àlex Rodriguez (Oloxx)',
    'PackageName: drop',
    `PackageUrl: https://github.com/${DEFAULT_REPO}`,
    'License: Apache-2.0',
    `LicenseUrl: https://github.com/${DEFAULT_REPO}/blob/main/LICENSE`,
    'ShortDescription: End-to-end encrypted peer-to-peer file transfer with a speakable code.',
    'Description: |-',
    '  drop transfers files directly between devices without accounts or size limits. A signaling server pairs peers (or relays E2EE ciphertext when a direct path is unavailable), while the four-word secret never leaves your devices.',
    '',
    '  Supports CLI-to-CLI direct TCP, LAN UDP/mDNS discovery, UPnP/NAT-PMP port mapping, STUN, Web-to-CLI and CLI-to-Web interoperability, multi-file and folder transfers, speed testing, and a standalone embedded server (`drop serve`).',
    'Moniker: drop',
    'Tags:',
    '- cli',
    '- e2ee',
    '- encryption',
    '- file-sharing',
    '- file-transfer',
    '- lan',
    '- p2p',
    '- peer-to-peer',
    '- rust',
    'InstallationNotes: Upgrade with `winget upgrade Oloxx.drop` (or `drop update` only for standalone manual installs).',
    'Documentations:',
    '- DocumentLabel: Web App',
    '  DocumentUrl: https://drop.oloxx.dev',
    '- DocumentLabel: Threat Model',
    `  DocumentUrl: https://github.com/${DEFAULT_REPO}/blob/main/docs/THREAT-MODEL.md`,
    `ReleaseNotesUrl: https://github.com/${DEFAULT_REPO}/releases/tag/${releaseTag}`,
    'ManifestType: defaultLocale',
    `ManifestVersion: ${SCHEMA_VERSION}`,
    '',
  ].join('\n');

  return {
    version: ver,
    tag: releaseTag,
    sha256: shaUpper,
    installerUrl,
    relDir,
    files: {
      [`${PACKAGE_ID}.yaml`]: versionYaml,
      [`${PACKAGE_ID}.installer.yaml`]: installerYaml,
      [`${PACKAGE_ID}.locale.en-US.yaml`]: localeYaml,
    },
  };
}

function githubApiBase(override) {
  const base = override || process.env.DROP_GITHUB_API || 'https://api.github.com';
  return base.replace(/\/+$/, '');
}

function resolveToken(env = process.env) {
  for (const name of ['WINGET_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN']) {
    const val = (env[name] || '').trim();
    if (val) return val;
  }
  if (env.DROP_NO_GH) return null;
  try {
    const tok = execFileSync('gh', ['auth', 'token'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return tok || null;
  } catch {
    return null;
  }
}

async function fetchJson(url, token) {
  const headers = {
    'User-Agent': 'drop-winget',
    Accept: 'application/vnd.github+json',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { headers });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { ok: res.ok, status: res.status, data };
}

async function apiRequest(apiBase, endpoint, { method = 'GET', token, body } = {}) {
  const headers = {
    'User-Agent': 'drop-winget',
    Accept: 'application/vnd.github+json',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${apiBase}${endpoint}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { ok: res.ok, status: res.status, data };
}

async function downloadText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'drop-winget' } });
  if (!res.ok) {
    throw new Error(`Error descargando ${url} (HTTP ${res.status}).`);
  }
  return res.text();
}

/**
 * Obtiene SHA256SUMS + SHA256SUMS.minisig (desde disco o desde GitHub Releases),
 * verifica la firma Minisign contra `publicKey` y escribe los 3 manifiestos YAML.
 */
export async function generateWingetManifests(opts = {}) {
  const repo = opts.repo || DEFAULT_REPO;
  const publicKey = opts.publicKey || PUBLIC_KEY;
  const apiBase = githubApiBase(opts.githubApi);
  const outDir = path.resolve(opts.outDir || path.join(os.tmpdir(), 'drop-winget'));
  const token = opts.token !== undefined ? opts.token : resolveToken();

  let tagInput = opts.tag;
  let releaseDate = opts.releaseDate;
  let sumsText;
  let sigText;

  if (opts.fromDist) {
    const distDir = path.resolve(opts.fromDist);
    const sumsPath = path.join(distDir, 'SHA256SUMS');
    const sigPath = path.join(distDir, 'SHA256SUMS.minisig');
    if (!fs.existsSync(sumsPath)) {
      throw new Error(`Falta ${sumsPath}.`);
    }
    if (!fs.existsSync(sigPath)) {
      throw new Error(`Falta ${sigPath} (no se generan manifiestos sin firma Minisign).`);
    }
    sumsText = fs.readFileSync(sumsPath, 'utf8');
    sigText = fs.readFileSync(sigPath, 'utf8');
    if (!tagInput) {
      const pkgPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
      if (fs.existsSync(pkgPath)) {
        tagInput = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
      }
    }
    releaseDate = releaseDate || new Date().toISOString().slice(0, 10);
  } else {
    const cleanWanted = tagInput ? normalizeTagAndVersion(tagInput).tag : null;
    const releaseUrl = cleanWanted
      ? `${apiBase}/repos/${repo}/releases/tags/${encodeURIComponent(cleanWanted)}`
      : `${apiBase}/repos/${repo}/releases/latest`;
    const res = await fetchJson(releaseUrl, token);
    if (!res.ok || !res.data) {
      throw new Error(`GitHub respondio HTTP ${res.status} al consultar ${releaseUrl}.`);
    }
    const release = res.data;
    tagInput = release.tag_name;
    releaseDate = releaseDate || (release.published_at ? String(release.published_at).slice(0, 10) : new Date().toISOString().slice(0, 10));

    const sumsAsset = (release.assets || []).find((a) => a.name === 'SHA256SUMS');
    const sigAsset = (release.assets || []).find((a) => a.name === 'SHA256SUMS.minisig');
    if (!sumsAsset) {
      throw new Error(`La release ${tagInput} no incluye SHA256SUMS.`);
    }
    if (!sigAsset) {
      throw new Error(`La release ${tagInput} no incluye SHA256SUMS.minisig (firma requerida).`);
    }
    sumsText = await downloadText(sumsAsset.browser_download_url);
    sigText = await downloadText(sigAsset.browser_download_url);
  }

  const { tag, version } = normalizeTagAndVersion(tagInput);
  const sigCheck = verifySignature({
    content: Buffer.from(sumsText, 'utf8'),
    signature: sigText,
    publicKey,
  });
  if (!sigCheck.ok) {
    throw new Error(`Firma Minisign NO VALIDA para SHA256SUMS: ${sigCheck.reason}`);
  }

  const exeName = `drop-${tag}-windows-x64.exe`;
  const sumsMap = parseSums(sumsText);
  const sha256 = sumsMap.get(exeName);
  if (!sha256) {
    throw new Error(`El SHA256SUMS firmado no contiene ${exeName}.`);
  }

  const manifest = buildManifests({ version, sha256, releaseDate, tag });
  const manifestDir = path.join(outDir, ...manifest.relDir.split('/'));
  fs.mkdirSync(manifestDir, { recursive: true });
  for (const [name, content] of Object.entries(manifest.files)) {
    fs.writeFileSync(path.join(manifestDir, name), content, 'utf8');
  }

  return {
    ...manifest,
    outDir,
    manifestDir,
  };
}

function buildPrBody({ version, isNewPackage }) {
  const kind = isNewPackage ? 'New package' : 'New version';
  return [
    '## Description',
    '',
    `${kind}: \`${PACKAGE_ID}\` version \`${version}\` (portable CLI binary generated from signed \`SHA256SUMS\` in \`${DEFAULT_REPO}\`).`,
    '',
    '## Checklist',
    '',
    '- [x] Checked that there are no duplicate open pull requests for this package version',
    '- [x] This PR only modifies one manifest directory under `manifests/`',
    '- [x] Verified `SHA256SUMS` signature with Minisign before generating manifests',
    '- [x] Manifest conforms to the 1.12.0 schema',
    '',
  ].join('\n');
}

/**
 * Crea o actualiza el fork `<usuario>/winget-pkgs`, sube exclusivamente los 3 YAML
 * en una rama dedicada y abre la Pull Request en `microsoft/winget-pkgs`.
 */
export async function submitWingetPr(manifest, opts = {}) {
  const apiBase = githubApiBase(opts.githubApi);
  const upstream = opts.upstream || UPSTREAM_REPO;
  const token = (opts.token || process.env.WINGET_TOKEN || resolveToken() || '').trim();
  if (!token) {
    throw new Error('Falta un token de GitHub (WINGET_TOKEN) para enviar el PR a microsoft/winget-pkgs.');
  }

  const me = await apiRequest(apiBase, '/user', { token });
  if (!me.ok || !me.data?.login) {
    throw new Error(`No se pudo identificar el usuario del token (HTTP ${me.status}).`);
  }
  const owner = me.data.login;

  const pkgDirRes = await apiRequest(apiBase, `/repos/${upstream}/contents/manifests/o/Oloxx/drop`, { token });
  let isNewPackage = true;
  if (pkgDirRes.ok && Array.isArray(pkgDirRes.data)) {
    isNewPackage = false;
    if (pkgDirRes.data.some((entry) => entry.name === manifest.version)) {
      return {
        skipped: true,
        reason: `Oloxx.drop ${manifest.version} ya esta publicado en ${upstream}.`,
      };
    }
  } else if (pkgDirRes.status !== 404) {
    throw new Error(`Error consultando ${upstream} (HTTP ${pkgDirRes.status}).`);
  }

  const branchName = `${PACKAGE_ID}-${manifest.version}`;
  const prTitle = `${isNewPackage ? 'New package' : 'New version'}: ${PACKAGE_ID} version ${manifest.version}`;

  const existingHead = await apiRequest(
    apiBase,
    `/repos/${upstream}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branchName}`)}`,
    { token },
  );
  if (existingHead.ok && Array.isArray(existingHead.data) && existingHead.data.length > 0) {
    return {
      existing: true,
      url: existingHead.data[0].html_url,
      number: existingHead.data[0].number,
    };
  }

  const existingSearch = await apiRequest(
    apiBase,
    `/search/issues?q=${encodeURIComponent(`repo:${upstream} is:pr is:open "${PACKAGE_ID}" "${manifest.version}"`)}`,
    { token },
  );
  if (existingSearch.ok && Array.isArray(existingSearch.data?.items) && existingSearch.data.items.length > 0) {
    return {
      existing: true,
      url: existingSearch.data.items[0].html_url,
      number: existingSearch.data.items[0].number,
    };
  }

  const upstreamMeta = await apiRequest(apiBase, `/repos/${upstream}`, { token });
  const defaultBranch = upstreamMeta.ok && upstreamMeta.data?.default_branch
    ? upstreamMeta.data.default_branch
    : 'master';

  let forkReady = (await apiRequest(apiBase, `/repos/${owner}/winget-pkgs`, { token })).ok;
  if (!forkReady) {
    const forkRes = await apiRequest(apiBase, `/repos/${upstream}/forks`, {
      method: 'POST',
      token,
      body: { default_branch_only: true },
    });
    if (!forkRes.ok) {
      throw new Error(`No se pudo crear el fork ${owner}/winget-pkgs (HTTP ${forkRes.status}).`);
    }
  }

  // Espera a que la rama principal del fork este disponible y sincronizada con upstream.
  let baseCommitSha = null;
  for (let attempt = 0; attempt < 15; attempt++) {
    const refRes = await apiRequest(
      apiBase,
      `/repos/${owner}/winget-pkgs/git/ref/heads/${encodeURIComponent(defaultBranch)}`,
      { token },
    );
    if (refRes.ok && refRes.data?.object?.sha) {
      forkReady = true;
      await apiRequest(apiBase, `/repos/${owner}/winget-pkgs/merge-upstream`, {
        method: 'POST',
        token,
        body: { branch: defaultBranch },
      });
      const syncedRef = await apiRequest(
        apiBase,
        `/repos/${owner}/winget-pkgs/git/ref/heads/${encodeURIComponent(defaultBranch)}`,
        { token },
      );
      baseCommitSha = syncedRef.ok ? syncedRef.data?.object?.sha : refRes.data.object.sha;
      break;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (!forkReady || !baseCommitSha) {
    throw new Error(`El fork ${owner}/winget-pkgs no termino de inicializarse a tiempo.`);
  }

  const baseCommit = await apiRequest(
    apiBase,
    `/repos/${owner}/winget-pkgs/git/commits/${baseCommitSha}`,
    { token },
  );
  if (!baseCommit.ok || !baseCommit.data?.tree?.sha) {
    throw new Error(`No se pudo leer el arbol base del fork (HTTP ${baseCommit.status}).`);
  }

  const treeEntries = [];
  for (const [filename, content] of Object.entries(manifest.files)) {
    const blobRes = await apiRequest(apiBase, `/repos/${owner}/winget-pkgs/git/blobs`, {
      method: 'POST',
      token,
      body: { content, encoding: 'utf-8' },
    });
    if (!blobRes.ok || !blobRes.data?.sha) {
      throw new Error(`Error creando blob para ${filename} (HTTP ${blobRes.status}).`);
    }
    treeEntries.push({
      path: `${manifest.relDir}/${filename}`,
      mode: '100644',
      type: 'blob',
      sha: blobRes.data.sha,
    });
  }

  const newTree = await apiRequest(apiBase, `/repos/${owner}/winget-pkgs/git/trees`, {
    method: 'POST',
    token,
    body: { base_tree: baseCommit.data.tree.sha, tree: treeEntries },
  });
  if (!newTree.ok || !newTree.data?.sha) {
    throw new Error(`Error creando arbol Git (HTTP ${newTree.status}).`);
  }

  const newCommit = await apiRequest(apiBase, `/repos/${owner}/winget-pkgs/git/commits`, {
    method: 'POST',
    token,
    body: {
      message: prTitle,
      tree: newTree.data.sha,
      parents: [baseCommitSha],
    },
  });
  if (!newCommit.ok || !newCommit.data?.sha) {
    throw new Error(`Error creando commit (HTTP ${newCommit.status}).`);
  }

  const createRef = await apiRequest(apiBase, `/repos/${owner}/winget-pkgs/git/refs`, {
    method: 'POST',
    token,
    body: {
      ref: `refs/heads/${branchName}`,
      sha: newCommit.data.sha,
    },
  });
  if (!createRef.ok) {
    if (createRef.status === 422) {
      const updateRef = await apiRequest(
        apiBase,
        `/repos/${owner}/winget-pkgs/git/refs/heads/${encodeURIComponent(branchName)}`,
        {
          method: 'PATCH',
          token,
          body: { sha: newCommit.data.sha, force: true },
        },
      );
      if (!updateRef.ok) {
        throw new Error(`No se pudo actualizar la rama ${branchName} (HTTP ${updateRef.status}).`);
      }
    } else {
      throw new Error(`No se pudo crear la rama ${branchName} (HTTP ${createRef.status}).`);
    }
  }

  const prRes = await apiRequest(apiBase, `/repos/${upstream}/pulls`, {
    method: 'POST',
    token,
    body: {
      title: prTitle,
      head: `${owner}:${branchName}`,
      base: defaultBranch,
      body: buildPrBody({ version: manifest.version, isNewPackage }),
    },
  });
  if (!prRes.ok || !prRes.data?.html_url) {
    throw new Error(
      `No se pudo abrir la PR en ${upstream} (HTTP ${prRes.status}): ${JSON.stringify(prRes.data)}`,
    );
  }

  return {
    created: true,
    url: prRes.data.html_url,
    number: prRes.data.number,
    title: prTitle,
  };
}

export function parseCliArgs(argv) {
  const opts = { submit: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--submit') {
      opts.submit = true;
    } else if (arg === '--out') {
      opts.outDir = argv[++i];
      if (!opts.outDir) throw new Error('--out necesita un directorio.');
    } else if (arg === '--from-dist') {
      opts.fromDist = argv[++i];
      if (!opts.fromDist) throw new Error('--from-dist necesita un directorio.');
    } else if (arg === '--tag') {
      opts.tag = argv[++i];
      if (!opts.tag) throw new Error('--tag necesita una version.');
    } else if (arg === '--date') {
      opts.releaseDate = argv[++i];
      if (!opts.releaseDate) throw new Error('--date necesita una fecha AAAA-MM-DD.');
    } else if (arg === '--repo') {
      opts.repo = argv[++i];
      if (!opts.repo) throw new Error('--repo necesita owner/nombre.');
    } else if (arg === '--upstream') {
      opts.upstream = argv[++i];
      if (!opts.upstream) throw new Error('--upstream necesita owner/nombre.');
    } else if (arg.startsWith('-')) {
      throw new Error(`Opcion desconocida: ${arg}`);
    } else if (!opts.tag) {
      opts.tag = arg;
    } else {
      throw new Error(`Argumento inesperado: ${arg}`);
    }
  }
  return opts;
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
})();

if (isMain) {
  try {
    const opts = parseCliArgs(process.argv.slice(2));
    if (opts.help) {
      console.log('Uso: node scripts/winget.mjs [tag] [--out <dir>] [--from-dist <dir>] [--date AAAA-MM-DD] [--submit]');
      process.exit(0);
    }
    const manifest = await generateWingetManifests(opts);
    console.log(`Manifiestos WinGet ${manifest.version} generados (Minisign OK) en ${manifest.manifestDir}`);
    if (opts.submit) {
      const result = await submitWingetPr(manifest, opts);
      if (result.skipped) {
        console.log(result.reason);
      } else if (result.existing) {
        console.log(`PR ya abierta: ${result.url}`);
      } else {
        console.log(`PR creada en ${opts.upstream || UPSTREAM_REPO}: ${result.url}`);
      }
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}
