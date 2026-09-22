// `drop verify-web`: comprobar que un servidor sirve el codigo del repositorio.
//
// La web confia en el `app.js` que descarga, como toda web: un servidor
// malicioso podria servir otro que mande las palabras a donde quiera. Esto no lo
// impide, pero deja comprobarlo sin fiarse del servidor:
//
//   1. `/version` dice que commit sirve (lo pone el despliegue).
//   2. La API de GitHub da el arbol de `public/` en ese commit, con el hash git
//      (SHA-1 de "blob <tamano>\0<contenido>") de cada archivo. Eso sale del
//      repositorio publico, que cualquiera puede leer y auditar.
//   3. Se descarga del servidor cada uno de esos archivos y se compara.
//
// Si `index.html` cuadra, lo que carga (app.js, style.css, shared/...) tambien
// esta en la lista y tambien se compara: un archivo de mas en el servidor no
// sirve de nada si nada lo carga.
//
// Lo que NO dice: que el servidor sirva lo mismo a todo el mundo. Un servidor
// malicioso puede darle el codigo bueno a quien pregunta desde un CLI y el malo
// a un navegador concreto. Es una comprobacion de lo que te ha servido a ti.
import crypto from 'node:crypto';

export const REPO = 'Oloxx/drop';

/** Hash git de un blob: lo que el arbol de GitHub da para cada archivo. */
export function gitBlobSha(buf) {
  return crypto.createHash('sha1')
    .update(Buffer.from(`blob ${buf.length}\0`))
    .update(buf)
    .digest('hex');
}

/**
 * Compara lo que sirve `base` con `public/` del commit que dice servir.
 * Devuelve `{ version, commit, files: [{ path, ok, reason? }] }`; lanza si no
 * hay forma de saber que comparar (sin commit, GitHub no contesta...).
 */
export async function verifyWeb(base, {
  fetchImpl = fetch,
  githubApi = process.env.DROP_GITHUB_API || 'https://api.github.com',
  headers = {},
} = {}) {
  const origin = new URL(base).origin;
  const res = await fetchImpl(origin + '/version', { cache: 'no-store' });
  if (!res.ok) throw new Error(`${origin}/version responde ${res.status}: el servidor es anterior a esta comprobación.`);
  const { version, commit } = await res.json();
  if (!/^[0-9a-f]{40}$/.test(commit || '')) {
    throw new Error(`${origin} no dice qué commit sirve (commit: ${JSON.stringify(commit ?? null)}): no hay con qué comparar.`);
  }

  const treeUrl = `${githubApi}/repos/${REPO}/git/trees/${commit}?recursive=1`;
  const treeRes = await fetchImpl(treeUrl, { headers: { 'User-Agent': 'drop-cli', Accept: 'application/vnd.github+json', ...headers } });
  if (treeRes.status === 404 || treeRes.status === 422) {
    throw new Error(`El commit ${commit.slice(0, 12)} no está en github.com/${REPO}: el servidor sirve código que no es del repositorio público.`);
  }
  if (!treeRes.ok) throw new Error(`GitHub responde ${treeRes.status} al pedir el árbol de ${commit.slice(0, 12)}.`);
  const tree = await treeRes.json();
  if (tree.truncated) throw new Error('GitHub ha devuelto el árbol recortado: no se puede comprobar entero.');

  const blobs = (tree.tree || []).filter((e) => e.type === 'blob' && e.path.startsWith('public/'));
  if (!blobs.some((e) => e.path === 'public/index.html')) throw new Error(`El commit ${commit.slice(0, 12)} no tiene public/index.html.`);

  const files = [];
  for (const entry of blobs) {
    const rel = entry.path.slice('public/'.length);
    const url = origin + '/' + rel.split('/').map(encodeURIComponent).join('/');
    let got;
    try {
      const r = await fetchImpl(url, { cache: 'no-store' });
      if (!r.ok) {
        files.push({ path: rel, ok: false, reason: `HTTP ${r.status}` });
        continue;
      }
      got = Buffer.from(await r.arrayBuffer());
    } catch (err) {
      files.push({ path: rel, ok: false, reason: err.message });
      continue;
    }
    const ok = gitBlobSha(got) === entry.sha;
    files.push(ok ? { path: rel, ok } : { path: rel, ok, reason: 'distinto del repositorio' });
  }
  return { version, commit, files };
}
