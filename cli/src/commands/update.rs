// Autoactualizacion (`drop update` / `drop --update`) con verificacion Minisign + SHA256SUMS.

use std::env;
use std::fs;
use std::io::{self, Cursor, IsTerminal, Read};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use flate2::read::GzDecoder;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tar::Archive;

use crate::commands::install::{cleanup_old_binary, home_dir, is_installed};
use crate::minisign::verify_signature;
use crate::pkgmgr::PackageManager;
use crate::ui::{BOLD, CYAN, DIM, GREEN, RED, RESET, YELLOW, fmt_bytes};

/// Intervalo minimo entre comprobaciones automaticas de actualizacion (24 horas).
pub const AUTO_UPDATE_INTERVAL_SECS: u64 = 24 * 60 * 60;
/// Tiempo de espera tras un error de red o rate-limit antes de volver a comprobar (1 hora).
const AUTO_UPDATE_RETRY_AFTER_ERROR_SECS: u64 = 60 * 60;

#[derive(Debug, Clone, Default)]
pub struct UpdateOptions {
    pub force: bool,
    pub allow_unsigned: bool,
    pub skip_verify: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ReleaseAsset {
    pub name: String,
    pub url: String,
    pub browser_download_url: String,
    pub size: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct LatestRelease {
    pub tag_name: String,
    pub assets: Vec<ReleaseAsset>,
}

pub fn parse_semver_triplet(ver: &str) -> [u64; 3] {
    let clean = ver.trim().trim_start_matches(['v', 'V']);
    let core = clean.split('-').next().unwrap_or(clean);
    let mut parts = core.split('.').map(|p| p.parse::<u64>().unwrap_or(0));
    [
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
    ]
}

pub fn is_newer_version(latest: &str, current: &str) -> bool {
    let a = parse_semver_triplet(latest);
    let b = parse_semver_triplet(current);
    a > b
}

pub fn target_asset_suffixes_for(os: &str, arch: &str) -> Vec<&'static str> {
    let arch_tag = match arch {
        "aarch64" | "arm64" => "arm64",
        _ => "x64",
    };
    match (os, arch_tag) {
        ("windows", "arm64") => vec!["windows-arm64.exe", "windows-x64.exe"],
        ("windows", _) => vec!["windows-x64.exe"],
        ("macos", "arm64") => vec!["macos-arm64.tar.gz", "macos-arm64"],
        ("macos", _) => vec!["macos-x64.tar.gz", "macos-x64"],
        ("linux", "arm64") => vec!["linux-arm64.tar.gz", "linux-arm64"],
        _ => vec!["linux-x64.tar.gz", "linux-x64"],
    }
}

pub fn target_asset_suffixes() -> Vec<&'static str> {
    target_asset_suffixes_for(env::consts::OS, env::consts::ARCH)
}

pub fn expected_hash_for(sums_text: &str, asset_name: &str) -> Result<String, String> {
    for line in sums_text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let mut parts = trimmed.split_whitespace();
        let Some(hash) = parts.next() else {
            continue;
        };
        let Some(file) = parts.next() else {
            continue;
        };
        let clean_name = file.trim_start_matches('*').trim_start_matches("./");
        if (clean_name == asset_name || Path::new(clean_name).file_name().and_then(|s| s.to_str()) == Some(asset_name))
            && hash.len() == 64
            && hash.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Ok(hash.to_ascii_lowercase());
        }
    }
    Err(format!("No se encontró el hash de {asset_name} en SHA256SUMS."))
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for b in digest {
        out.push(char::from_digit((b >> 4) as u32, 16).unwrap_or('0'));
        out.push(char::from_digit((b & 0x0f) as u32, 16).unwrap_or('0'));
    }
    out
}

fn env_github_token() -> Option<String> {
    for var in ["GITHUB_TOKEN", "GH_TOKEN"] {
        if let Ok(tok) = env::var(var)
            && !tok.trim().is_empty()
        {
            return Some(tok.trim().to_string());
        }
    }
    None
}

fn github_token() -> Option<String> {
    if let Some(tok) = env_github_token() {
        return Some(tok);
    }
    if env::var_os("DROP_NO_GH").is_some_and(|v| !v.is_empty()) {
        return None;
    }
    if let Ok(out) = std::process::Command::new("gh")
        .args(["auth", "token"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        && out.status.success()
    {
        let tok = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !tok.is_empty() {
            return Some(tok);
        }
    }
    None
}

async fn fetch_asset_bytes(
    client: &Client,
    asset: &ReleaseAsset,
    token: Option<&str>,
    show_progress: bool,
) -> Result<Vec<u8>, String> {
    let url = if token.is_some() {
        &asset.url
    } else {
        &asset.browser_download_url
    };
    let mut req = client.get(url);
    if let Some(tok) = token {
        req = req
            .header("Authorization", format!("Bearer {tok}"))
            .header("Accept", "application/octet-stream");
    }

    let mut res = req
        .send()
        .await
        .map_err(|e| format!("Error descargando {}: {e}", asset.name))?;
    if !res.status().is_success() {
        return Err(format!(
            "No se pudo descargar {} (HTTP {}).",
            asset.name,
            res.status().as_u16()
        ));
    }

    let total = res.content_length().or(asset.size).unwrap_or(0);
    let mut out = if total > 0 && total < 256 * 1024 * 1024 {
        Vec::with_capacity(total as usize)
    } else {
        Vec::new()
    };

    let mut downloaded = 0u64;
    let is_tty = show_progress && io::stdout().is_terminal();
    while let Some(chunk) = res
        .chunk()
        .await
        .map_err(|e| format!("Error leyendo {}: {e}", asset.name))?
    {
        out.extend_from_slice(&chunk);
        downloaded += chunk.len() as u64;
        if is_tty && total > 0 {
            use std::io::Write;
            let pct = ((downloaded as f64 / total as f64) * 100.0).min(100.0) as u64;
            print!(
                "\r  Descargando {}: {pct}% ({}/{})   ",
                asset.name,
                fmt_bytes(downloaded),
                fmt_bytes(total)
            );
            let _ = io::stdout().flush();
        }
    }
    if is_tty && total > 0 {
        println!();
    }
    Ok(out)
}

async fn fetch_text_asset(
    client: &Client,
    asset: &ReleaseAsset,
    token: Option<&str>,
) -> Result<String, String> {
    let bytes = fetch_asset_bytes(client, asset, token, false).await?;
    String::from_utf8(bytes).map_err(|_| format!("{} no contiene UTF-8 válido.", asset.name))
}

/// Verifica SHA256SUMS + SHA256SUMS.minisig contra los bytes descargados.
/// Nunca acepta una firma `.minisig` manipulada, ni siquiera con `--allow-unsigned`.
pub async fn verify_download(
    client: &Client,
    assets: &[ReleaseAsset],
    target_asset: &ReleaseAsset,
    downloaded_bytes: &[u8],
    public_key: &str,
    token: Option<&str>,
    opts: &UpdateOptions,
) -> Result<(), String> {
    verify_download_inner(
        client,
        assets,
        target_asset,
        downloaded_bytes,
        public_key,
        token,
        opts,
        false,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn verify_download_inner(
    client: &Client,
    assets: &[ReleaseAsset],
    target_asset: &ReleaseAsset,
    downloaded_bytes: &[u8],
    public_key: &str,
    token: Option<&str>,
    opts: &UpdateOptions,
    quiet: bool,
) -> Result<(), String> {
    if opts.skip_verify {
        if !quiet {
            println!("  {YELLOW}Aviso: verificación omitida (--skip-verify).{RESET}");
        }
        return Ok(());
    }

    let Some(sums_asset) = assets.iter().find(|a| a.name == "SHA256SUMS") else {
        return Err(
            "La release no incluye SHA256SUMS. Usa --skip-verify si aun así quieres instalarla."
                .to_string(),
        );
    };
    let sums_text = fetch_text_asset(client, sums_asset, token).await?;

    if let Some(sig_asset) = assets.iter().find(|a| a.name == "SHA256SUMS.minisig") {
        let sig_text = fetch_text_asset(client, sig_asset, token).await?;
        let res = verify_signature(sums_text.as_bytes(), &sig_text, public_key);
        if !res.ok {
            let reason = res.reason.unwrap_or_else(|| "desconocida".to_string());
            return Err(format!("Firma Minisign NO VÁLIDA: {reason}"));
        }
        if !quiet {
            println!("  {GREEN}✔ Firma verificada (Minisign).{RESET}");
        }
    } else if opts.allow_unsigned {
        if !quiet {
            println!(
                "  {YELLOW}Aviso: release sin firma (--allow-unsigned). Comprobando solo SHA-256.{RESET}"
            );
        }
    } else {
        return Err(
            "La release no está firmada (falta SHA256SUMS.minisig). Usa --allow-unsigned solo para versiones anteriores a la v0.5.2."
                .to_string(),
        );
    }

    let expected = expected_hash_for(&sums_text, &target_asset.name)?;
    let actual = sha256_hex(downloaded_bytes);
    if actual != expected {
        return Err(format!(
            "SHA-256 no coincide para {} (esperado {}, recibido {}).",
            target_asset.name,
            &expected[..12],
            &actual[..12]
        ));
    }
    if !quiet {
        println!("  {GREEN}✔ SHA-256 verificado ({}).{RESET}", &actual[..12]);
    }
    Ok(())
}

pub fn extract_binary_from_tar_gz(archive_bytes: &[u8]) -> Result<Vec<u8>, String> {
    let gz = GzDecoder::new(Cursor::new(archive_bytes));
    let mut archive = Archive::new(gz);
    let entries = archive
        .entries()
        .map_err(|e| format!("Error abriendo el archivo .tar.gz: {e}"))?;

    for entry_res in entries {
        let mut entry =
            entry_res.map_err(|e| format!("Entrada inválida en el .tar.gz: {e}"))?;
        if !entry.header().entry_type().is_file() {
            continue;
        }
        let path = entry
            .path()
            .map_err(|e| format!("Ruta inválida en el .tar.gz: {e}"))?;
        let name = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or_default();
        if name == "drop" || name == "drop.exe" || name.starts_with("drop-") {
            let mut buf = Vec::new();
            entry
                .read_to_end(&mut buf)
                .map_err(|e| format!("Error leyendo el binario del .tar.gz: {e}"))?;
            if !buf.is_empty() {
                return Ok(buf);
            }
        }
    }
    Err("El archivo .tar.gz no contenía el binario de drop.".to_string())
}

pub fn install_binary_bytes(exe_path: &Path, binary_bytes: &[u8]) -> Result<(), String> {
    let parent = exe_path
        .parent()
        .ok_or_else(|| "Ruta de binario inválida.".to_string())?;
    cleanup_old_binary(exe_path);

    let tmp = parent.join(format!(".drop-update-{}.tmp", std::process::id()));
    fs::write(&tmp, binary_bytes)
        .map_err(|e| format!("No se pudo escribir el binario temporal: {e}"))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o755));
    }

    #[cfg(windows)]
    {
        let old = PathBuf::from(format!("{}.old", exe_path.display()));
        let moved_old = if exe_path.exists() {
            fs::rename(exe_path, &old)
                .map_err(|e| {
                    let _ = fs::remove_file(&tmp);
                    format!("No se pudo apartar el ejecutable en uso: {e}")
                })?;
            true
        } else {
            false
        };

        if let Err(e) = fs::rename(&tmp, exe_path) {
            if moved_old {
                let _ = fs::rename(&old, exe_path);
            }
            let _ = fs::remove_file(&tmp);
            return Err(format!("No se pudo reemplazar el ejecutable: {e}"));
        }
        // Intentamos borrar el `.old`; si Windows aun lo bloquea, caera en el proximo arranque.
        let _ = fs::remove_file(&old);
    }

    #[cfg(not(windows))]
    {
        if let Err(e) = fs::rename(&tmp, exe_path) {
            let _ = fs::remove_file(&tmp);
            return Err(format!("No se pudo reemplazar el ejecutable: {e}"));
        }
    }

    Ok(())
}

pub async fn run_update(
    opts: UpdateOptions,
    repo: &str,
    current_version: &str,
    public_key: &str,
) -> i32 {
    let Ok(exe_path) = env::current_exe() else {
        eprintln!("\n  {RED}✖ No se pudo determinar la ruta del ejecutable.{RESET}\n");
        return 1;
    };
    cleanup_old_binary(&exe_path);

    let github_api = env::var("DROP_GITHUB_API")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "https://api.github.com".to_string());
    let github_api = github_api.trim_end_matches('/');

    let token = github_token();
    let ua = format!("drop-cli/{current_version}");
    let Ok(client) = Client::builder()
        .user_agent(ua)
        .timeout(Duration::from_secs(60))
        .build()
    else {
        eprintln!("\n  {RED}✖ No se pudo inicializar el cliente HTTP.{RESET}\n");
        return 1;
    };

    println!("\n  {DIM}Buscando actualizaciones... (actual: v{current_version}){RESET}");

    let latest_url = format!("{github_api}/repos/{repo}/releases/latest");
    let mut req = client
        .get(&latest_url)
        .header("Accept", "application/vnd.github+json");
    if let Some(tok) = token.as_deref() {
        req = req.header("Authorization", format!("Bearer {tok}"));
    }

    let res = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            eprintln!("\n  {RED}✖ No se pudo consultar GitHub: {e}{RESET}\n");
            return 1;
        }
    };

    if !res.status().is_success() {
        eprintln!(
            "\n  {RED}✖ GitHub devolvió HTTP {} al consultar la última release.{RESET}\n",
            res.status().as_u16()
        );
        return 1;
    }

    let release: LatestRelease = match res.json().await {
        Ok(r) => r,
        Err(e) => {
            eprintln!("\n  {RED}✖ Respuesta de GitHub inválida: {e}{RESET}\n");
            return 1;
        }
    };

    let latest_clean = release.tag_name.trim_start_matches(['v', 'V']);
    if !opts.force && !is_newer_version(latest_clean, current_version) {
        save_update_state(
            &state_file_path(),
            &UpdateState {
                last_check_unix: now_unix_secs(),
                latest_version: Some(latest_clean.to_string()),
            },
        );
        println!(
            "  {GREEN}✔ Ya tienes la última versión (v{current_version}).{RESET}\n"
        );
        return 0;
    }

    let suffixes = target_asset_suffixes();
    let selected = suffixes
        .iter()
        .find_map(|sfx| release.assets.iter().find(|a| a.name.ends_with(sfx)));

    let Some(asset) = selected else {
        eprintln!(
            "\n  {RED}✖ No hay binario disponible para {}-{} en la release {}. {RESET}\n",
            env::consts::OS,
            env::consts::ARCH,
            release.tag_name
        );
        return 1;
    };

    println!(
        "  {CYAN}Actualizando a {BOLD}v{latest_clean}{RESET}{CYAN} ({})...{RESET}",
        asset.name
    );

    let downloaded = match fetch_asset_bytes(&client, asset, token.as_deref(), true).await {
        Ok(b) => b,
        Err(e) => {
            eprintln!("\n  {RED}✖ {e}{RESET}\n");
            return 1;
        }
    };

    if let Err(e) = verify_download(
        &client,
        &release.assets,
        asset,
        &downloaded,
        public_key,
        token.as_deref(),
        &opts,
    )
    .await
    {
        eprintln!("\n  {RED}✖ {e}{RESET}\n");
        return 1;
    }

    let bin_bytes = if asset.name.ends_with(".tar.gz") {
        match extract_binary_from_tar_gz(&downloaded) {
            Ok(b) => b,
            Err(e) => {
                eprintln!("\n  {RED}✖ {e}{RESET}\n");
                return 1;
            }
        }
    } else {
        downloaded
    };

    if let Err(e) = install_binary_bytes(&exe_path, &bin_bytes) {
        eprintln!("\n  {RED}✖ {e}{RESET}\n");
        return 1;
    }

    save_update_state(
        &state_file_path(),
        &UpdateState {
            last_check_unix: now_unix_secs(),
            latest_version: Some(latest_clean.to_string()),
        },
    );

    println!(
        "  {GREEN}✔ Actualizado a v{latest_clean} correctamente.{RESET}\n"
    );
    0
}

// ---------------------------------------------------------------------------
// Auto-actualizacion silenciosa en segundo plano
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct UpdateState {
    pub last_check_unix: u64,
    #[serde(default)]
    pub latest_version: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AutoUpdateOutcome {
    UpToDate,
    Updated {
        from: String,
        to: String,
    },
    ManagedAvailable {
        version: String,
        manager: PackageManager,
    },
    Skipped,
}

#[derive(Debug, Clone)]
pub struct AutoUpdateConfig {
    pub exe_path: PathBuf,
    pub state_path: PathBuf,
    pub github_api: String,
    pub repo: String,
    pub current_version: String,
    pub public_key: String,
    pub manager: Option<PackageManager>,
    pub interval_secs: u64,
}

pub fn now_unix_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub fn state_dir() -> PathBuf {
    if let Ok(custom) = env::var("DROP_STATE_DIR")
        && !custom.trim().is_empty()
    {
        return PathBuf::from(custom.trim());
    }
    #[cfg(windows)]
    {
        let local_app_data = env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home_dir().join("AppData").join("Local"));
        local_app_data.join("drop")
    }
    #[cfg(not(windows))]
    {
        let cache_base = env::var_os("XDG_CACHE_HOME")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home_dir().join(".cache"));
        cache_base.join("drop")
    }
}

pub fn state_file_path() -> PathBuf {
    state_dir().join("update-state.json")
}

pub fn load_update_state(path: &Path) -> Option<UpdateState> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

pub fn save_update_state(path: &Path, state: &UpdateState) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string_pretty(state) {
        let _ = fs::write(path, json);
    }
}

pub fn cleanup_state_files() {
    let file = state_file_path();
    let _ = fs::remove_file(&file);
    if let Some(dir) = file.parent() {
        let _ = fs::remove_dir(dir);
    }
}

pub fn should_check_now(state: Option<&UpdateState>, now_unix: u64, interval_secs: u64) -> bool {
    if interval_secs == 0 {
        return true;
    }
    let Some(st) = state else {
        return true;
    };
    now_unix.saturating_sub(st.last_check_unix) >= interval_secs
}

pub fn auto_update_disabled_by_env() -> bool {
    if let Ok(val) = env::var("DROP_NO_AUTO_UPDATE") {
        let v = val.trim().to_ascii_lowercase();
        if !v.is_empty() && v != "0" && v != "false" && v != "no" {
            return true;
        }
    }
    for ci_var in ["CI", "GITHUB_ACTIONS"] {
        if let Ok(val) = env::var(ci_var)
            && !val.trim().is_empty()
            && val.trim() != "0"
            && !val.trim().eq_ignore_ascii_case("false")
        {
            return true;
        }
    }
    false
}

pub fn auto_update_interval_secs() -> u64 {
    env::var("DROP_AUTO_UPDATE_INTERVAL_SECS")
        .ok()
        .and_then(|s| s.trim().parse::<u64>().ok())
        .unwrap_or(AUTO_UPDATE_INTERVAL_SECS)
}

fn record_error_backoff(state_path: &Path, now_unix: u64, interval_secs: u64, prev: Option<&UpdateState>) {
    // Reintentamos dentro de 1 hora (o del intervalo configurado si es menor) para no golpear
    // GitHub en bucle cuando el equipo esta offline o bajo rate-limit.
    let backoff = AUTO_UPDATE_RETRY_AFTER_ERROR_SECS.min(interval_secs);
    let synthetic_last = now_unix.saturating_sub(interval_secs.saturating_sub(backoff));
    save_update_state(
        state_path,
        &UpdateState {
            last_check_unix: synthetic_last,
            latest_version: prev.and_then(|s| s.latest_version.clone()),
        },
    );
}

/// Ejecuta un ciclo completo de comprobacion y, si procede, instalacion silenciosa.
/// Siempre exige firma Minisign valida + SHA256SUMS y nunca imprime a stdout.
pub async fn run_auto_update_once(cfg: AutoUpdateConfig) -> AutoUpdateOutcome {
    let now = now_unix_secs();
    let prev_state = load_update_state(&cfg.state_path);
    if !should_check_now(prev_state.as_ref(), now, cfg.interval_secs) {
        return AutoUpdateOutcome::Skipped;
    }

    let token = env_github_token();
    let ua = format!("drop-cli/{}", cfg.current_version);
    let Ok(client) = Client::builder()
        .user_agent(ua)
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(60))
        .build()
    else {
        return AutoUpdateOutcome::Skipped;
    };

    let github_api = cfg.github_api.trim_end_matches('/');
    let latest_url = format!("{github_api}/repos/{}/releases/latest", cfg.repo);
    let mut req = client
        .get(&latest_url)
        .timeout(Duration::from_secs(10))
        .header("Accept", "application/vnd.github+json");
    if let Some(tok) = token.as_deref() {
        req = req.header("Authorization", format!("Bearer {tok}"));
    }

    let Ok(res) = req.send().await else {
        record_error_backoff(&cfg.state_path, now, cfg.interval_secs, prev_state.as_ref());
        return AutoUpdateOutcome::Skipped;
    };
    if !res.status().is_success() {
        record_error_backoff(&cfg.state_path, now, cfg.interval_secs, prev_state.as_ref());
        return AutoUpdateOutcome::Skipped;
    }

    let Ok(release) = res.json::<LatestRelease>().await else {
        record_error_backoff(&cfg.state_path, now, cfg.interval_secs, prev_state.as_ref());
        return AutoUpdateOutcome::Skipped;
    };

    let latest_clean = release.tag_name.trim_start_matches(['v', 'V']).to_string();
    if !is_newer_version(&latest_clean, &cfg.current_version) {
        save_update_state(
            &cfg.state_path,
            &UpdateState {
                last_check_unix: now,
                latest_version: Some(latest_clean),
            },
        );
        return AutoUpdateOutcome::UpToDate;
    }

    // Si drop lo gestiona WinGet, Scoop o Homebrew, nunca pisamos el binario: solo avisamos.
    if let Some(manager) = cfg.manager {
        save_update_state(
            &cfg.state_path,
            &UpdateState {
                last_check_unix: now,
                latest_version: Some(latest_clean.clone()),
            },
        );
        return AutoUpdateOutcome::ManagedAvailable {
            version: latest_clean,
            manager,
        };
    }

    let suffixes = target_asset_suffixes();
    let Some(asset) = suffixes
        .iter()
        .find_map(|sfx| release.assets.iter().find(|a| a.name.ends_with(sfx)))
    else {
        record_error_backoff(&cfg.state_path, now, cfg.interval_secs, prev_state.as_ref());
        return AutoUpdateOutcome::Skipped;
    };

    let Ok(downloaded) = fetch_asset_bytes(&client, asset, token.as_deref(), false).await else {
        record_error_backoff(&cfg.state_path, now, cfg.interval_secs, prev_state.as_ref());
        return AutoUpdateOutcome::Skipped;
    };

    // Verificacion estricta (Minisign + SHA256SUMS), en silencio.
    let strict_opts = UpdateOptions::default();
    if verify_download_inner(
        &client,
        &release.assets,
        asset,
        &downloaded,
        &cfg.public_key,
        token.as_deref(),
        &strict_opts,
        true,
    )
    .await
    .is_err()
    {
        record_error_backoff(&cfg.state_path, now, cfg.interval_secs, prev_state.as_ref());
        return AutoUpdateOutcome::Skipped;
    }

    let bin_bytes = if asset.name.ends_with(".tar.gz") {
        let Ok(b) = extract_binary_from_tar_gz(&downloaded) else {
            record_error_backoff(&cfg.state_path, now, cfg.interval_secs, prev_state.as_ref());
            return AutoUpdateOutcome::Skipped;
        };
        b
    } else {
        downloaded
    };

    if install_binary_bytes(&cfg.exe_path, &bin_bytes).is_err() {
        record_error_backoff(&cfg.state_path, now, cfg.interval_secs, prev_state.as_ref());
        return AutoUpdateOutcome::Skipped;
    }

    save_update_state(
        &cfg.state_path,
        &UpdateState {
            last_check_unix: now,
            latest_version: Some(latest_clean.clone()),
        },
    );

    AutoUpdateOutcome::Updated {
        from: cfg.current_version,
        to: latest_clean,
    }
}

pub struct AutoUpdateHandle {
    handle: tokio::task::JoinHandle<AutoUpdateOutcome>,
    current_version: String,
}

impl AutoUpdateHandle {
    /// Recoge el resultado si ya termino (o en un margen minimo de 150ms) y avisa por stderr
    /// solo si es una terminal interactiva. Nunca bloquea la salida ni escribe en stdout.
    pub async fn finish_and_notify(self) {
        let outcome = if self.handle.is_finished() {
            self.handle.await.ok()
        } else {
            match tokio::time::timeout(Duration::from_millis(150), self.handle).await {
                Ok(res) => res.ok(),
                Err(_) => None,
            }
        };

        let Some(outcome) = outcome else {
            return;
        };
        if !io::stderr().is_terminal() {
            return;
        }
        match outcome {
            AutoUpdateOutcome::Updated { to, .. } => {
                eprintln!(
                    "\n  {GREEN}✔ drop actualizado en segundo plano a v{to}{RESET} {DIM}(se usará en el próximo comando){RESET}"
                );
            }
            AutoUpdateOutcome::ManagedAvailable { version, manager } => {
                eprintln!(
                    "\n  {CYAN}ℹ Nueva versión disponible: v{version}{RESET} {DIM}(actual: v{}). Actualiza con:{RESET} {CYAN}{}{RESET}",
                    self.current_version, manager.upgrade
                );
            }
            AutoUpdateOutcome::UpToDate | AutoUpdateOutcome::Skipped => {}
        }
    }
}

/// Lanza el auto-update en segundo plano si aplica (instalado o gestor de paquetes, no en CI,
/// no desactivado por `DROP_NO_AUTO_UPDATE`, y ha pasado el intervalo de 24h).
pub fn spawn_auto_update(
    exe_path: &Path,
    manager: Option<PackageManager>,
    repo: &str,
    current_version: &str,
    public_key: &str,
) -> Option<AutoUpdateHandle> {
    if auto_update_disabled_by_env() {
        return None;
    }
    if manager.is_none() && !is_installed(exe_path) {
        return None;
    }

    let state_path = state_file_path();
    let interval_secs = auto_update_interval_secs();
    let prev = load_update_state(&state_path);
    if !should_check_now(prev.as_ref(), now_unix_secs(), interval_secs) {
        return None;
    }

    let github_api = env::var("DROP_GITHUB_API")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "https://api.github.com".to_string());

    let cfg = AutoUpdateConfig {
        exe_path: exe_path.to_path_buf(),
        state_path,
        github_api,
        repo: repo.to_string(),
        current_version: current_version.to_string(),
        public_key: public_key.to_string(),
        manager,
        interval_secs,
    };

    let current = current_version.to_string();
    let handle = tokio::spawn(run_auto_update_once(cfg));
    Some(AutoUpdateHandle {
        handle,
        current_version: current,
    })
}
