// Verificacion de que una instancia web de Drop sirve exactamente `public/` del commit que declara.

use std::env;
use std::sync::Arc;

use reqwest::Client;
use serde::Deserialize;
use sha1::{Digest, Sha1};
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

pub const DEFAULT_REPO: &str = "Oloxx/drop";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileCheckResult {
    pub path: String,
    pub ok: bool,
    pub status: u16,
    pub expected: String,
    pub actual: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifyWebReport {
    pub server: String,
    pub version: Option<String>,
    pub commit: String,
    pub files: Vec<FileCheckResult>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifyWebError {
    pub message: String,
    pub detail: Option<String>,
}

impl std::fmt::Display for VerifyWebError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl VerifyWebError {
    fn new(message: impl Into<String>, detail: Option<String>) -> Self {
        Self {
            message: message.into(),
            detail,
        }
    }
}

/// Calcula el SHA-1 de objeto blob de Git: `"blob <len>\0" || contenido`.
pub fn git_blob_sha(bytes: &[u8]) -> String {
    let mut hasher = Sha1::new();
    let header = format!("blob {}\0", bytes.len());
    hasher.update(header.as_bytes());
    hasher.update(bytes);
    hex_lower(&hasher.finalize())
}

fn hex_lower(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(char::from_digit((b >> 4) as u32, 16).unwrap_or('0'));
        out.push(char::from_digit((b & 0x0f) as u32, 16).unwrap_or('0'));
    }
    out
}

fn is_valid_commit_sha(commit: &str) -> bool {
    commit.len() == 40
        && commit
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

#[derive(Deserialize)]
struct VersionPayload {
    version: Option<String>,
    commit: Option<String>,
}

#[derive(Deserialize)]
struct GitTreeResponse {
    truncated: Option<bool>,
    tree: Option<Vec<GitTreeEntry>>,
}

#[derive(Deserialize)]
struct GitTreeEntry {
    path: String,
    #[serde(rename = "type")]
    kind: String,
    sha: String,
}

#[derive(Clone)]
pub struct VerifyOptions<'a> {
    pub repo: &'a str,
    pub github_api: Option<&'a str>,
    pub user_agent: &'a str,
}

impl Default for VerifyOptions<'_> {
    fn default() -> Self {
        Self {
            repo: DEFAULT_REPO,
            github_api: None,
            user_agent: concat!("drop-cli/", env!("CARGO_PKG_VERSION")),
        }
    }
}

pub async fn verify_web(
    server_url: &str,
    opts: VerifyOptions<'_>,
) -> Result<VerifyWebReport, VerifyWebError> {
    let base = server_url.trim().trim_end_matches('/').to_string();
    let github_api_owned = opts
        .github_api
        .map(str::to_string)
        .or_else(|| env::var("DROP_GITHUB_API").ok().filter(|s| !s.is_empty()))
        .unwrap_or_else(|| "https://api.github.com".to_string());
    let github_api = github_api_owned.trim_end_matches('/');

    let client = Client::builder()
        .user_agent(opts.user_agent)
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| VerifyWebError::new(format!("No se pudo crear el cliente HTTP: {e}"), None))?;

    let ver_res = client
        .get(format!("{base}/version"))
        .send()
        .await
        .map_err(|e| {
            VerifyWebError::new(format!("No se pudo consultar {base}/version ({e})"), None)
        })?;
    if !ver_res.status().is_success() {
        return Err(VerifyWebError::new(
            format!("No se pudo consultar {base}/version ({})", ver_res.status().as_u16()),
            None,
        ));
    }
    let ver: VersionPayload = ver_res.json().await.map_err(|_| {
        VerifyWebError::new(
            "El servidor no dice qué commit sirve (/version sin commit).".to_string(),
            Some("Un despliegue con DROP_COMMIT (o git rev-parse HEAD) sí se puede verificar.".to_string()),
        )
    })?;

    let Some(commit) = ver.commit.filter(|c| is_valid_commit_sha(c)) else {
        return Err(VerifyWebError::new(
            "El servidor no dice qué commit sirve (/version sin commit).",
            Some(
                "Un despliegue con DROP_COMMIT (o git rev-parse HEAD) sí se puede verificar."
                    .to_string(),
            ),
        ));
    };

    let tree_url = format!("{github_api}/repos/{}/git/trees/{commit}?recursive=1", opts.repo);
    let tree_res = client
        .get(&tree_url)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| {
            VerifyWebError::new(format!("No se pudo consultar github.com ({e})"), None)
        })?;

    if tree_res.status().as_u16() == 404 {
        return Err(VerifyWebError::new(
            format!("El commit {} no está en github.com/{}.", &commit[..12], opts.repo),
            Some(
                "Puede ser un fork o código sin subir; imposible verificarlo contra el repositorio oficial."
                    .to_string(),
            ),
        ));
    }
    if !tree_res.status().is_success() {
        return Err(VerifyWebError::new(
            format!("GitHub devolvió HTTP {}.", tree_res.status().as_u16()),
            None,
        ));
    }

    let tree_json: GitTreeResponse = tree_res.json().await.map_err(|e| {
        VerifyWebError::new(format!("Respuesta de GitHub inválida ({e})"), None)
    })?;
    if tree_json.truncated.unwrap_or(false) {
        return Err(VerifyWebError::new(
            "El árbol del repositorio vino incompleto.",
            None,
        ));
    }

    let entries: Vec<(String, String)> = tree_json
        .tree
        .unwrap_or_default()
        .into_iter()
        .filter(|e| e.kind == "blob" && e.path.starts_with("public/"))
        .map(|e| (e.path["public/".len()..].to_string(), e.sha))
        .collect();

    if entries.is_empty() || !entries.iter().any(|(rel, _)| rel == "index.html") {
        return Err(VerifyWebError::new(
            format!("El commit {} no tiene public/index.html.", &commit[..12]),
            None,
        ));
    }

    let total = entries.len();
    let mut results: Vec<Option<FileCheckResult>> = vec![None; total];
    let sem = Arc::new(Semaphore::new(8));
    let mut set = JoinSet::new();

    for (idx, (rel, expected)) in entries.into_iter().enumerate() {
        let client = client.clone();
        let base = base.clone();
        let sem = Arc::clone(&sem);
        set.spawn(async move {
            let _permit = sem.acquire_owned().await.ok();
            let url = format!("{base}/{rel}");
            match client.get(&url).send().await {
                Ok(res) => {
                    let status = res.status().as_u16();
                    if !res.status().is_success() {
                        return (
                            idx,
                            FileCheckResult {
                                path: rel,
                                ok: false,
                                status,
                                expected,
                                actual: None,
                            },
                        );
                    }
                    match res.bytes().await {
                        Ok(bytes) => {
                            let actual = git_blob_sha(&bytes);
                            let ok = actual == expected;
                            (
                                idx,
                                FileCheckResult {
                                    path: rel,
                                    ok,
                                    status,
                                    expected,
                                    actual: Some(actual),
                                },
                            )
                        }
                        Err(_) => (
                            idx,
                            FileCheckResult {
                                path: rel,
                                ok: false,
                                status: 0,
                                expected,
                                actual: None,
                            },
                        ),
                    }
                }
                Err(_) => (
                    idx,
                    FileCheckResult {
                        path: rel,
                        ok: false,
                        status: 0,
                        expected,
                        actual: None,
                    },
                ),
            }
        });
    }

    while let Some(joined) = set.join_next().await {
        if let Ok((idx, item)) = joined {
            results[idx] = Some(item);
        }
    }

    let files = results.into_iter().flatten().collect();
    Ok(VerifyWebReport {
        server: base,
        version: ver.version,
        commit,
        files,
    })
}
