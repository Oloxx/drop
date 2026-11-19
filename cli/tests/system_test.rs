// Pruebas de Fase 4: `verify-web`, `update` (Minisign + SHA256SUMS + .tar.gz), `install`/`uninstall`.

use std::io::Write;
use std::process::Command;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use ed25519_dalek::{Signer, SigningKey};
use flate2::Compression;
use flate2::write::GzEncoder;
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use drop::commands::install::{ensure_path_in_posix_rc, remove_drop_path_lines};
use drop::commands::update::{
    ReleaseAsset, UpdateOptions, expected_hash_for, extract_binary_from_tar_gz,
    install_binary_bytes, is_newer_version, verify_download,
};
use drop::verifyweb::{VerifyOptions, git_blob_sha, verify_web};

fn sha256_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(64);
    for b in Sha256::digest(bytes) {
        out.push(char::from_digit((b >> 4) as u32, 16).unwrap_or('0'));
        out.push(char::from_digit((b & 0x0f) as u32, 16).unwrap_or('0'));
    }
    out
}

/// Construye un par clave publica Minisign y firma exactamente en el formato Ed25519 heredado (`Ed`).
fn minisign_fixture(content: &[u8]) -> (String, String) {
    let seed = [0x42u8; 32];
    let sk = SigningKey::from_bytes(&seed);
    let pk_bytes = sk.verifying_key().to_bytes();
    let key_id = [1u8, 2, 3, 4, 5, 6, 7, 8];

    let mut raw_pk = Vec::with_capacity(2 + 8 + 32);
    raw_pk.extend_from_slice(b"Ed");
    raw_pk.extend_from_slice(&key_id);
    raw_pk.extend_from_slice(&pk_bytes);
    let pub_b64 = B64.encode(raw_pk);

    let sig = sk.sign(content);
    let trusted_comment = "trusted comment: test release";
    let mut raw_sig = Vec::with_capacity(2 + 8 + 64);
    raw_sig.extend_from_slice(b"Ed");
    raw_sig.extend_from_slice(&key_id);
    raw_sig.extend_from_slice(&sig.to_bytes());
    let sig_b64 = B64.encode(raw_sig);

    let mut global_msg = Vec::with_capacity(64 + trusted_comment["trusted comment: ".len()..].len());
    global_msg.extend_from_slice(&sig.to_bytes());
    global_msg.extend_from_slice(b"test release");
    let global_sig = sk.sign(&global_msg);
    let global_b64 = B64.encode(global_sig.to_bytes());

    let minisig = format!(
        "untrusted comment: test\n{sig_b64}\n{trusted_comment}\n{global_b64}\n"
    );
    (pub_b64, minisig)
}

async fn start_mock_http<F>(handler: F) -> String
where
    F: Fn(&str) -> (u16, &'static str, Vec<u8>) + Send + Sync + 'static,
{
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("addr");
    let handler = std::sync::Arc::new(handler);
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            let handler = std::sync::Arc::clone(&handler);
            tokio::spawn(async move {
                let mut buf = [0u8; 4096];
                let n = stream.read(&mut buf).await.unwrap_or(0);
                if n == 0 {
                    return;
                }
                let req = String::from_utf8_lossy(&buf[..n]);
                let path = req
                    .lines()
                    .next()
                    .and_then(|l| l.split_whitespace().nth(1))
                    .unwrap_or("/");
                let (status, ctype, body) = handler(path);
                let header = format!(
                    "HTTP/1.1 {status} OK\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(header.as_bytes()).await;
                let _ = stream.write_all(&body).await;
            });
        }
    });
    format!("http://127.0.0.1:{}", addr.port())
}

#[test]
fn git_blob_sha_matches_git_hash_object() {
    let body = b"hola\nmundo\n";
    let ours = git_blob_sha(body);
    let mut child = Command::new("git")
        .args(["hash-object", "--stdin", "--no-filters"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .expect("spawn git");
    child.stdin.as_mut().unwrap().write_all(body).unwrap();
    let out = child.wait_with_output().expect("git out");
    assert!(out.status.success());
    let expected = String::from_utf8_lossy(&out.stdout).trim().to_string();
    assert_eq!(ours, expected);
}

#[tokio::test]
async fn verify_web_passes_and_detects_mismatches() {
    let commit = format!("c0ffee{}", "0".repeat(34));
    let index_bytes = b"<!doctype html><title>drop</title>".to_vec();
    let app_bytes = b"console.log('ok');".to_vec();
    let index_sha = git_blob_sha(&index_bytes);
    let app_sha = git_blob_sha(&app_bytes);

    let srv_commit = commit.clone();
    let srv_url = start_mock_http(move |path| match path {
        "/version" => (
            200,
            "application/json",
            json!({ "version": "0.12.0", "commit": srv_commit })
                .to_string()
                .into_bytes(),
        ),
        "/index.html" => (200, "text/html", index_bytes.clone()),
        "/app.js" => (200, "application/javascript", app_bytes.clone()),
        _ => (404, "text/plain", b"not found".to_vec()),
    })
    .await;

    let gh_path = format!("/repos/Oloxx/drop/git/trees/{commit}?recursive=1");
    let gh_ok = start_mock_http({
        let gh_path = gh_path.clone();
        let commit = commit.clone();
        let index_sha = index_sha.clone();
        let app_sha = app_sha.clone();
        move |path| {
            if path == gh_path {
                (
                    200,
                    "application/json",
                    json!({
                        "sha": commit,
                        "truncated": false,
                        "tree": [
                            { "path": "public/index.html", "type": "blob", "sha": index_sha },
                            { "path": "public/app.js", "type": "blob", "sha": app_sha },
                        ]
                    })
                    .to_string()
                    .into_bytes(),
                )
            } else {
                (404, "text/plain", b"{}".to_vec())
            }
        }
    })
    .await;

    let report = verify_web(
        &srv_url,
        VerifyOptions {
            repo: "Oloxx/drop",
            github_api: Some(&gh_ok),
            user_agent: "drop-test",
        },
    )
    .await
    .expect("verify ok");
    assert_eq!(report.commit, commit);
    assert!(report.files.iter().all(|f| f.ok));

    let bad_sha = "0".repeat(40);
    let gh_bad = start_mock_http(move |path| {
        if path == gh_path {
            (
                200,
                "application/json",
                json!({
                    "sha": commit,
                    "truncated": false,
                    "tree": [
                        { "path": "public/index.html", "type": "blob", "sha": index_sha },
                        { "path": "public/app.js", "type": "blob", "sha": bad_sha },
                    ]
                })
                .to_string()
                .into_bytes(),
            )
        } else {
            (404, "text/plain", b"{}".to_vec())
        }
    })
    .await;

    let bad_report = verify_web(
        &srv_url,
        VerifyOptions {
            repo: "Oloxx/drop",
            github_api: Some(&gh_bad),
            user_agent: "drop-test",
        },
    )
    .await
    .expect("bad report");
    let failed: Vec<_> = bad_report
        .files
        .iter()
        .filter(|f| !f.ok)
        .map(|f| f.path.as_str())
        .collect();
    assert_eq!(failed, vec!["app.js"]);
}

#[tokio::test]
async fn verify_download_enforces_minisign_and_sha256_invariants() {
    let bin = b"drop-binary-payload-v0.13.0".to_vec();
    let bin_hash = sha256_hex(&bin);
    let sums = format!("{bin_hash}  drop-v0.13.0-windows-x64.exe\n");
    let (pub_key, valid_sig) = minisign_fixture(sums.as_bytes());
    let mut bad_sig = valid_sig.clone();
    // Corrupt last character of signature payload line
    bad_sig = bad_sig.replacen('\n', "\nX", 1);

    let asset_url = start_mock_http({
        let sums = sums.clone();
        let valid_sig = valid_sig.clone();
        let bad_sig = bad_sig.clone();
        move |path| match path {
            "/sums" => (200, "text/plain", sums.as_bytes().to_vec()),
            "/sig-ok" => (200, "text/plain", valid_sig.as_bytes().to_vec()),
            "/sig-bad" => (200, "text/plain", bad_sig.as_bytes().to_vec()),
            _ => (404, "text/plain", Vec::new()),
        }
    })
    .await;

    let target = ReleaseAsset {
        name: "drop-v0.13.0-windows-x64.exe".into(),
        url: format!("{asset_url}/bin"),
        browser_download_url: format!("{asset_url}/bin"),
        size: Some(bin.len() as u64),
    };
    let sums_asset = ReleaseAsset {
        name: "SHA256SUMS".into(),
        url: format!("{asset_url}/sums"),
        browser_download_url: format!("{asset_url}/sums"),
        size: None,
    };
    let ok_sig_asset = ReleaseAsset {
        name: "SHA256SUMS.minisig".into(),
        url: format!("{asset_url}/sig-ok"),
        browser_download_url: format!("{asset_url}/sig-ok"),
        size: None,
    };
    let bad_sig_asset = ReleaseAsset {
        name: "SHA256SUMS.minisig".into(),
        url: format!("{asset_url}/sig-bad"),
        browser_download_url: format!("{asset_url}/sig-bad"),
        size: None,
    };

    let client = reqwest::Client::new();

    // 1. Firma valida + hash valido -> Ok
    verify_download(
        &client,
        &[target.clone(), sums_asset.clone(), ok_sig_asset.clone()],
        &target,
        &bin,
        &pub_key,
        None,
        &UpdateOptions::default(),
    )
    .await
    .expect("valid sig + sha");

    // 2. Hash manipulado -> rechazado
    assert!(
        verify_download(
            &client,
            &[target.clone(), sums_asset.clone(), ok_sig_asset.clone()],
            &target,
            b"tampered",
            &pub_key,
            None,
            &UpdateOptions::default(),
        )
        .await
        .is_err()
    );

    // 3. Firma presente pero corrupta NUNCA se acepta, ni siquiera con --allow-unsigned
    let err = verify_download(
        &client,
        &[target.clone(), sums_asset.clone(), bad_sig_asset],
        &target,
        &bin,
        &pub_key,
        None,
        &UpdateOptions {
            force: false,
            allow_unsigned: true,
            skip_verify: false,
        },
    )
    .await
    .unwrap_err();
    assert!(err.contains("Minisign NO VÁLIDA"), "unexpected: {err}");

    // 4. Sin firma: falla por defecto, pasa con --allow-unsigned
    assert!(
        verify_download(
            &client,
            &[target.clone(), sums_asset.clone()],
            &target,
            &bin,
            &pub_key,
            None,
            &UpdateOptions::default(),
        )
        .await
        .is_err()
    );
    verify_download(
        &client,
        &[target.clone(), sums_asset],
        &target,
        &bin,
        &pub_key,
        None,
        &UpdateOptions {
            force: false,
            allow_unsigned: true,
            skip_verify: false,
        },
    )
    .await
    .expect("unsigned allowed");

    // 5. Sin SHA256SUMS: falla por defecto, pasa solo con --skip-verify
    assert!(
        verify_download(
            &client,
            std::slice::from_ref(&target),
            &target,
            &bin,
            &pub_key,
            None,
            &UpdateOptions::default(),
        )
        .await
        .is_err()
    );
    verify_download(
        &client,
        std::slice::from_ref(&target),
        &target,
        &bin,
        &pub_key,
        None,
        &UpdateOptions {
            force: false,
            allow_unsigned: false,
            skip_verify: true,
        },
    )
    .await
    .expect("skip verify");
}

#[test]
fn semver_tar_gz_and_rc_helpers_work() {
    assert!(is_newer_version("0.13.0", "0.12.0"));
    assert!(!is_newer_version("v0.12.0", "0.12.0"));
    assert!(!is_newer_version("0.11.9", "0.12.0"));

    assert_eq!(
        expected_hash_for(
            &format!("{}  drop-v0.12.0-linux-x64.tar.gz\n", "a".repeat(64)),
            "drop-v0.12.0-linux-x64.tar.gz"
        )
        .unwrap(),
        "a".repeat(64)
    );

    // Extrae binario desde .tar.gz en memoria
    let mut gz = GzEncoder::new(Vec::new(), Compression::default());
    {
        let mut tar = tar::Builder::new(&mut gz);
        let payload = b"#!/bin/sh\necho drop\n";
        let mut hdr = tar::Header::new_gnu();
        hdr.set_size(payload.len() as u64);
        hdr.set_mode(0o755);
        hdr.set_cksum();
        tar.append_data(&mut hdr, "drop", &payload[..]).unwrap();
        tar.finish().unwrap();
    }
    let archive_bytes = gz.finish().unwrap();
    let extracted = extract_binary_from_tar_gz(&archive_bytes).unwrap();
    assert_eq!(extracted, b"#!/bin/sh\necho drop\n");

    let dir = std::env::temp_dir().join(format!("drop-sys-test-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();

    // install_binary_bytes reemplaza binario limpiamente
    let target_exe = dir.join("drop.bin");
    std::fs::write(&target_exe, b"old-binary").unwrap();
    install_binary_bytes(&target_exe, b"new-binary").unwrap();
    assert_eq!(std::fs::read(&target_exe).unwrap(), b"new-binary");

    // ensure_path_in_posix_rc + remove_drop_path_lines idempotentes
    let rc = dir.join(".profile");
    std::fs::write(&rc, "export FOO=bar\n").unwrap();
    assert!(ensure_path_in_posix_rc(&rc, "/home/u/.local/bin").unwrap());
    assert!(!ensure_path_in_posix_rc(&rc, "/home/u/.local/bin").unwrap());
    assert!(std::fs::read_to_string(&rc).unwrap().contains("# drop PATH"));
    assert!(remove_drop_path_lines(&rc, "/home/u/.local/bin").unwrap());
    assert_eq!(std::fs::read_to_string(&rc).unwrap(), "export FOO=bar\n");

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn test_throttle_pacing_and_progress_bar_formatting() {
    use drop::shared::protocol::FileEntry;
    use drop::throttle::Throttle;
    use drop::ui::format_progress_bar;
    use tokio::time::Instant;

    let rate = 1024 * 1024;
    let mut t = Throttle::new(rate);
    let t0 = Instant::now();
    t.take(rate as usize).await;
    assert!(t0.elapsed().as_millis() < 150, "ráfaga inicial no debería esperar");
    t.take((rate / 2) as usize).await;
    let elapsed_ms = t0.elapsed().as_millis();
    assert!(
        (400..1500).contains(&elapsed_ms),
        "esperó {elapsed_ms} ms, se esperaban ~500 ms"
    );

    let mut t_zero = Throttle::new(0);
    let tz0 = Instant::now();
    for _ in 0..50 {
        t_zero.take(10_000_000).await;
    }
    assert!(tz0.elapsed().as_millis() < 100);

    let files = vec![
        FileEntry { name: "a.bin".into(), size: Some(100), path: None },
        FileEntry { name: "b.bin".into(), size: Some(50), path: None },
        FileEntry { name: "c.bin".into(), size: Some(0), path: None },
        FileEntry { name: "d.bin".into(), size: Some(10), path: None },
    ];
    let multi = format_progress_bar(120, Some(160), 1000.0, 30, Some(&files));
    assert!(multi.contains('\n'));
    assert!(multi.ends_with("\x1b[1A"));
    let plain_multi = regex::Regex::new(r"\x1b\[[0-9;]*[A-Za-z]")
        .unwrap()
        .replace_all(&multi, "");
    assert!(plain_multi.contains("[2/4] b.bin 40% · 20 B / 50 B"));

    let single = format_progress_bar(60, Some(100), 1000.0, 30, Some(&files[..1]));
    assert!(!single.contains('\n'));
    assert!(!single.contains("[1/1]"));
}

#[test]
fn auto_update_interval_check_logic() {
    use drop::commands::update::{UpdateState, should_check_now};

    assert!(should_check_now(None, 1000, 86_400));
    let st = UpdateState {
        last_check_unix: 1000,
        latest_version: Some("0.14.0".into()),
    };
    assert!(!should_check_now(Some(&st), 1000 + 86_399, 86_400));
    assert!(should_check_now(Some(&st), 1000 + 86_400, 86_400));
    assert!(should_check_now(Some(&st), 1000, 0));
}

#[tokio::test]
async fn auto_update_downloads_verifies_replaces_and_respects_cache_and_pkgmgr() {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use drop::commands::update::{
        AutoUpdateConfig, AutoUpdateOutcome, load_update_state, run_auto_update_once,
        target_asset_suffixes,
    };
    use drop::pkgmgr::PackageManager;

    let suffix = target_asset_suffixes()[0];
    let asset_name = format!("drop-v0.99.0-{suffix}");
    let new_binary = b"drop-new-binary-v0.99.0".to_vec();
    let asset_bytes = if asset_name.ends_with(".tar.gz") {
        let mut tar_buf = Vec::new();
        {
            let gz = GzEncoder::new(&mut tar_buf, Compression::default());
            let mut builder = tar::Builder::new(gz);
            let mut header = tar::Header::new_gnu();
            header.set_size(new_binary.len() as u64);
            header.set_mode(0o755);
            header.set_cksum();
            builder
                .append_data(&mut header, "drop", new_binary.as_slice())
                .unwrap();
            builder.into_inner().unwrap().finish().unwrap();
        }
        tar_buf
    } else {
        new_binary.clone()
    };

    let sums = format!("{}  {asset_name}\n", sha256_hex(&asset_bytes));
    let (pub_key, valid_sig) = minisign_fixture(sums.as_bytes());
    let hits = Arc::new(AtomicUsize::new(0));

    let base_url_slot: Arc<std::sync::Mutex<String>> = Arc::new(std::sync::Mutex::new(String::new()));
    let base_url_for_handler = Arc::clone(&base_url_slot);
    let hits_for_handler = Arc::clone(&hits);
    let asset_name_h = asset_name.clone();
    let asset_bytes_h = asset_bytes.clone();
    let sums_h = sums.clone();
    let sig_h = valid_sig.clone();

    let gh_url = start_mock_http(move |path| {
        let base = base_url_for_handler.lock().unwrap().clone();
        match path {
            "/repos/Oloxx/drop/releases/latest" => {
                hits_for_handler.fetch_add(1, Ordering::SeqCst);
                let body = json!({
                    "tag_name": "v0.99.0",
                    "assets": [
                        {
                            "name": asset_name_h,
                            "url": format!("{base}/dl/bin"),
                            "browser_download_url": format!("{base}/dl/bin"),
                            "size": asset_bytes_h.len(),
                        },
                        {
                            "name": "SHA256SUMS",
                            "url": format!("{base}/dl/sums"),
                            "browser_download_url": format!("{base}/dl/sums"),
                            "size": sums_h.len(),
                        },
                        {
                            "name": "SHA256SUMS.minisig",
                            "url": format!("{base}/dl/sig"),
                            "browser_download_url": format!("{base}/dl/sig"),
                            "size": sig_h.len(),
                        }
                    ]
                })
                .to_string()
                .into_bytes();
                (200, "application/json", body)
            }
            "/dl/bin" => (200, "application/octet-stream", asset_bytes_h.clone()),
            "/dl/sums" => (200, "text/plain", sums_h.as_bytes().to_vec()),
            "/dl/sig" => (200, "text/plain", sig_h.as_bytes().to_vec()),
            _ => (404, "text/plain", Vec::new()),
        }
    })
    .await;
    *base_url_slot.lock().unwrap() = gh_url.clone();

    let dir = std::env::temp_dir().join(format!("drop-autoupdate-test-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();

    // 1. Instalacion directa: descarga, verifica firma, reemplaza binario y guarda estado.
    let fake_exe = dir.join("drop-bin");
    std::fs::write(&fake_exe, b"old-binary").unwrap();
    let state_path = dir.join("state.json");

    let cfg = AutoUpdateConfig {
        exe_path: fake_exe.clone(),
        state_path: state_path.clone(),
        github_api: gh_url.clone(),
        repo: "Oloxx/drop".into(),
        current_version: "0.14.0".into(),
        public_key: pub_key.clone(),
        manager: None,
        interval_secs: 86_400,
    };

    let outcome = run_auto_update_once(cfg.clone()).await;
    assert_eq!(
        outcome,
        AutoUpdateOutcome::Updated {
            from: "0.14.0".into(),
            to: "0.99.0".into(),
        }
    );
    assert_eq!(std::fs::read(&fake_exe).unwrap(), new_binary);
    let st = load_update_state(&state_path).expect("state saved");
    assert_eq!(st.latest_version.as_deref(), Some("0.99.0"));
    assert_eq!(hits.load(Ordering::SeqCst), 1);

    // 2. Segunda ejecucion dentro de 24h: debe saltarse sin consultar GitHub.
    let outcome2 = run_auto_update_once(cfg).await;
    assert_eq!(outcome2, AutoUpdateOutcome::Skipped);
    assert_eq!(hits.load(Ordering::SeqCst), 1);

    // 3. Con gestor de paquetes (WinGet): solo avisa y NO toca el binario.
    let managed_exe = dir.join("drop-managed");
    std::fs::write(&managed_exe, b"winget-binary").unwrap();
    let managed_state = dir.join("state-managed.json");
    let mgr = PackageManager {
        name: "WinGet",
        upgrade: "winget upgrade Oloxx.drop",
        uninstall: "winget uninstall Oloxx.drop",
    };
    let managed_outcome = run_auto_update_once(AutoUpdateConfig {
        exe_path: managed_exe.clone(),
        state_path: managed_state,
        github_api: gh_url.clone(),
        repo: "Oloxx/drop".into(),
        current_version: "0.14.0".into(),
        public_key: pub_key.clone(),
        manager: Some(mgr.clone()),
        interval_secs: 86_400,
    })
    .await;
    assert_eq!(
        managed_outcome,
        AutoUpdateOutcome::ManagedAvailable {
            version: "0.99.0".into(),
            manager: mgr,
        }
    );
    assert_eq!(std::fs::read(&managed_exe).unwrap(), b"winget-binary");

    // 4. Clave publica equivocada / firma invalida: rechaza y NO toca el binario.
    let bad_exe = dir.join("drop-bad");
    std::fs::write(&bad_exe, b"keep-me").unwrap();
    let bad_state = dir.join("state-bad.json");
    let (other_pub_key, _) = {
        let sk = SigningKey::from_bytes(&[0x99u8; 32]);
        let mut raw_pk = Vec::with_capacity(42);
        raw_pk.extend_from_slice(b"Ed");
        raw_pk.extend_from_slice(&[9u8; 8]);
        raw_pk.extend_from_slice(&sk.verifying_key().to_bytes());
        (B64.encode(raw_pk), String::new())
    };
    let bad_outcome = run_auto_update_once(AutoUpdateConfig {
        exe_path: bad_exe.clone(),
        state_path: bad_state,
        github_api: gh_url,
        repo: "Oloxx/drop".into(),
        current_version: "0.14.0".into(),
        public_key: other_pub_key,
        manager: None,
        interval_secs: 86_400,
    })
    .await;
    assert_eq!(bad_outcome, AutoUpdateOutcome::Skipped);
    assert_eq!(std::fs::read(&bad_exe).unwrap(), b"keep-me");

    let _ = std::fs::remove_dir_all(&dir);
}
