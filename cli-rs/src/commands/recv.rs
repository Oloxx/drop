// Implementacion de `drop recv`: descubierta LAN, TCP directo P2P,
// fallback a WebSocket Relay E2EE, reanudacion `.part`, `--only` y `--stdout`.

use std::env;
use std::io::IsTerminal;
use std::path::{Path, PathBuf};
use std::time::Duration;

use rand::RngCore;
use serde_json::{Value, json};
use tokio::fs::File;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::time::timeout;

use crate::cli::Options;
use crate::commands::{ask_tty_confirm, log_out, print_sas_and_wait_prompt};
use crate::crypto::{derive_key, proof_from_key, sas_from_key, unseal_frame};
use crate::discovery::{get_candidate_ips, listen_for_lan, probe_candidate_ips, rank_candidates};
use crate::shared::codes::{Lang, parse_code};
use crate::shared::protocol::PROTOCOL_VERSION;
use crate::signaling::{WsEvent, connect_signaling, join_room, translate_error};
use crate::transfer::{
    ProgressFn, ReceiveOptions, ResumeNoticeFn, SasGateFn, TransferError, TransferStats,
    parse_manifest_entries, receive_files, receive_from_relay,
};
use crate::ui::{
    BOLD, CYAN, DIM, GREEN, RED, RESET, YELLOW, fmt_bytes, fmt_speed, render_progress_bar,
    render_progress_bar_complete, reset_file_line_state, set_progress_stderr,
};

fn resolve_default_output_dir() -> PathBuf {
    let cwd = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    #[cfg(windows)]
    {
        if let Some(windir) = env::var_os("WINDIR") {
            let cwd_low = cwd.to_string_lossy().to_lowercase();
            let win_low = PathBuf::from(windir).to_string_lossy().to_lowercase();
            if !win_low.is_empty()
                && cwd_low.starts_with(&win_low)
                && let Some(profile) = env::var_os("USERPROFILE")
            {
                let dl = PathBuf::from(&profile).join("Downloads");
                if dl.is_dir() {
                    return dl;
                }
                return PathBuf::from(profile);
            }
        }
    }
    cwd
}

fn ensure_writable_dir(dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| {
        format!(
            "No se puede crear o acceder al directorio de destino {}: {e}",
            dir.display()
        )
    })?;
    let probe = dir.join(format!(
        ".drop-write-probe-{}-{:08x}",
        std::process::id(),
        rand::thread_rng().next_u32()
    ));
    std::fs::write(&probe, b"").map_err(|e| {
        format!(
            "No tienes permiso de escritura en {}: {e}",
            dir.display()
        )
    })?;
    let _ = std::fs::remove_file(&probe);
    Ok(())
}

fn print_nothing_selected(available: &[String], patterns: &[String], use_stderr: bool) {
    log_out(
        use_stderr,
        &format!(
            "\n  {YELLOW}Ningún archivo coincide con --only ({}){RESET}",
            patterns.join(", ")
        ),
    );
    if !available.is_empty() {
        log_out(use_stderr, &format!("  {DIM}Archivos disponibles:{RESET}"));
        for item in available.iter().take(25) {
            log_out(use_stderr, &format!("    - {item}"));
        }
        if available.len() > 25 {
            log_out(
                use_stderr,
                &format!("    {DIM}... y {} más{RESET}", available.len() - 25),
            );
        }
    }
    log_out(use_stderr, "");
}

struct RelayOffer {
    v: Option<u64>,
    ips: Vec<String>,
    port: u16,
    nonce: String,
}

async fn attempt_receive(
    code: &str,
    room_id: &str,
    key: &[u8; 32],
    sas: &str,
    output_dir: &Path,
    options: &Options,
    to_stdout: bool,
) -> Result<TransferStats, TransferError> {
    let rx_opts = ReceiveOptions {
        overwrite: options.overwrite || to_stdout,
        resume: !options.no_resume && !to_stdout,
        only: options.only.clone(),
        limit: options.limit,
    };

    let force_relay = options.relay
        || env::var_os("DROP_FORCE_RELAY").is_some_and(|v| !v.is_empty());

    let make_progress = |stderr_flag: bool| -> ProgressFn {
        Box::new(move |recv, total, speed, list| {
            let _ = stderr_flag;
            render_progress_bar(recv, total, speed, 30, Some(list));
        })
    };

    let make_resume_cb = |stderr_flag: bool| -> ResumeNoticeFn {
        Box::new(move |label, offset| {
            log_out(
                stderr_flag,
                &format!(
                    "\n  {DIM}Reanudando {label} desde {}{RESET}",
                    fmt_bytes(offset)
                ),
            );
        })
    };

    // 1. Descubierta local LAN (UDP broadcast)
    if !force_relay && let Some((host, port)) = listen_for_lan(code, 1200).await {
        log_out(
            to_stdout,
            &format!("  {GREEN}✔ Emisor encontrado en LAN:{RESET} {host}:{port}"),
        );
        if let Ok(Ok(stream)) = timeout(
            Duration::from_millis(2500),
            TcpStream::connect((host.as_str(), port)),
        )
        .await
        {
            let yes = options.yes;
            let only_pat = options.only.clone();
            let sas_gate: SasGateFn = Box::new(move |manifest, sas_str| {
                let count = crate::select::select_files(manifest, &only_pat)
                    .map(|p| p.len())
                    .unwrap_or(manifest.len());
                let sas_owned = sas_str.to_string();
                Box::pin(async move {
                    if to_stdout && count > 1 {
                        log_out(true, &format!("\n  {RED}Error: --stdout solo admite un archivo por envío (usa --only).{RESET}\n"));
                        return false;
                    }
                    print_sas_and_wait_prompt(&sas_owned, yes, to_stdout).await
                })
            });
            reset_file_line_state();
            return receive_files(
                stream,
                code,
                room_id,
                output_dir,
                rx_opts,
                Some(sas_gate),
                Some(make_progress(to_stdout)),
                Some(make_resume_cb(to_stdout)),
            )
            .await;
        }
    }

    // 2. Servidor de señalizacion
    let mut client = connect_signaling(&options.server)
        .await
        .map_err(|e| TransferError::new("NET", e))?;
    join_room(&mut client, room_id, Some("cli"))
        .await
        .map_err(|e| TransferError::new("NET", e))?;

    let offer = wait_for_offer(&mut client.events).await?;
    if offer.v != Some(PROTOCOL_VERSION as u64) {
        client.sender.close_and_wait().await;
        return Err(TransferError::new(
            "PROTOCOL_VERSION",
            format!(
                "Versión de protocolo incompatible (emisor: {}, local: {PROTOCOL_VERSION}). Ejecuta drop update.",
                offer
                    .v
                    .map(|v| v.to_string())
                    .unwrap_or_else(|| "0".to_string())
            ),
        ));
    }

    // 3. Intentar TCP directo contra las IPs candidatas si no se fuerza Relay
    if !force_relay && offer.port > 0 && !offer.ips.is_empty() {
        let local_ips = get_candidate_ips();
        let ranked = rank_candidates(&offer.ips, &local_ips);
        if let Some((stream, ip)) = probe_candidate_ips(&ranked, offer.port, 2500).await {
            client.sender.close_and_wait().await;
            log_out(
                to_stdout,
                &format!(
                    "  {GREEN}✔ Conectado por TCP directo:{RESET} {ip}:{}",
                    offer.port
                ),
            );
            let yes = options.yes;
            let sas_gate: SasGateFn = Box::new(move |_manifest, sas_str| {
                let sas_owned = sas_str.to_string();
                Box::pin(async move { print_sas_and_wait_prompt(&sas_owned, yes, to_stdout).await })
            });
            reset_file_line_state();
            return receive_files(
                stream,
                code,
                room_id,
                output_dir,
                rx_opts,
                Some(sas_gate),
                Some(make_progress(to_stdout)),
                Some(make_resume_cb(to_stdout)),
            )
            .await;
        }
    }

    if options.direct_only {
        client.sender.close_and_wait().await;
        return Err(TransferError::new(
            "DIRECT_ONLY",
            "No fue posible establecer conexión directa TCP y se especificó --direct-only.",
        ));
    }

    // 4. Fallback a Relay cifrado extremo a extremo
    let is_web_host = offer.port == 0 && offer.ips.is_empty();
    let relay_note = if is_web_host {
        "El emisor es un navegador — usando retransmisión cifrada por servidor..."
    } else {
        "Usando retransmisión cifrada por servidor..."
    };
    log_out(
        to_stdout,
        &format!("  {CYAN}[MODO RELAY POR INTERNET]{RESET} {DIM}{relay_note}{RESET}"),
    );
    let proof = proof_from_key(key, &offer.nonce);
    client
        .sender
        .send_signal(
            None,
            &json!({
                "type": "cli-proof",
                "v": PROTOCOL_VERSION,
                "proof": proof,
            }),
        )
        .map_err(|e| TransferError::new("NET", e))?;

    let manifest_val = wait_for_relay_manifest(&mut client.events, key).await?;
    let manifest = parse_manifest_entries(&manifest_val)?;

    if !print_sas_and_wait_prompt(sas, options.yes, to_stdout).await {
        let _ = client.sender.send_signal(
            None,
            &json!({ "type": "cli-error", "message": "Cancelado por el receptor" }),
        );
        client.sender.close_and_wait().await;
        return Err(TransferError::new("CANCELLED", "Cancelado por el usuario"));
    }

    reset_file_line_state();
    let res = receive_from_relay(
        &client.sender,
        &mut client.events,
        &manifest,
        key,
        output_dir,
        rx_opts,
        Some(make_progress(to_stdout)),
        Some(make_resume_cb(to_stdout)),
    )
    .await;
    client.sender.close_and_wait().await;
    res
}

async fn wait_for_offer(
    events: &mut tokio::sync::mpsc::UnboundedReceiver<WsEvent>,
) -> Result<RelayOffer, TransferError> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let now = tokio::time::Instant::now();
        if now >= deadline {
            return Err(TransferError::new(
                "TIMEOUT",
                "Tiempo de espera agotado esperando oferta del emisor.",
            ));
        }
        let ev = match timeout(deadline - now, events.recv()).await {
            Ok(Some(ev)) => ev,
            Ok(None) => {
                return Err(TransferError::new(
                    "NET",
                    "El servidor cerró la conexión esperando al emisor.",
                ));
            }
            Err(_) => {
                return Err(TransferError::new(
                    "TIMEOUT",
                    "Tiempo de espera agotado esperando oferta del emisor.",
                ));
            }
        };
        if let WsEvent::Closed = ev {
            return Err(TransferError::new(
                "NET",
                "El servidor cerró la conexión esperando al emisor.",
            ));
        }
        let WsEvent::Json(msg) = ev else {
            continue;
        };
        match msg.get("t").and_then(|v| v.as_str()) {
            Some("error") => {
                let reason = msg.get("reason").and_then(|v| v.as_str()).unwrap_or("ERROR");
                return Err(TransferError::new("SIGNALING", translate_error(reason)));
            }
            Some("signal") => {
                let Some(data) = msg.get("data") else {
                    continue;
                };
                match data.get("type").and_then(|v| v.as_str()) {
                    Some("cli-denied") => {
                        let reason = data.get("reason").and_then(|v| v.as_str());
                        if reason == Some("VERSION") {
                            return Err(TransferError::new(
                                "PROTOCOL_VERSION",
                                "Protocolo incompatible con el emisor. Ejecuta drop update.",
                            ));
                        }
                        return Err(TransferError::new(
                            "DENIED",
                            "El emisor rechazó la conexión.",
                        ));
                    }
                    Some("cli-offer") => {
                        let v = data.get("v").and_then(|x| x.as_u64());
                        let ips: Vec<String> = data
                            .get("ips")
                            .and_then(|x| x.as_array())
                            .map(|a| {
                                a.iter()
                                    .filter_map(|s| s.as_str().map(str::to_string))
                                    .collect()
                            })
                            .unwrap_or_default();
                        let port = data.get("port").and_then(|x| x.as_u64()).unwrap_or(0) as u16;
                        let nonce = data
                            .get("nonce")
                            .and_then(|x| x.as_str())
                            .unwrap_or("")
                            .to_string();
                        return Ok(RelayOffer {
                            v,
                            ips,
                            port,
                            nonce,
                        });
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }
}

async fn wait_for_relay_manifest(
    events: &mut tokio::sync::mpsc::UnboundedReceiver<WsEvent>,
    key: &[u8; 32],
) -> Result<Value, TransferError> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(120);
    loop {
        let now = tokio::time::Instant::now();
        if now >= deadline {
            return Err(TransferError::new(
                "TIMEOUT",
                "El emisor no respondió a la solicitud.",
            ));
        }
        let ev = match timeout(deadline - now, events.recv()).await {
            Ok(Some(ev)) => ev,
            _ => {
                return Err(TransferError::new(
                    "NET",
                    "Conexión cerrada esperando autorización del emisor.",
                ));
            }
        };
        let WsEvent::Json(msg) = ev else {
            if matches!(ev, WsEvent::Closed) {
                return Err(TransferError::new(
                    "NET",
                    "Conexión cerrada esperando autorización del emisor.",
                ));
            }
            continue;
        };
        match msg.get("t").and_then(|v| v.as_str()) {
            Some("error") => {
                let reason = msg.get("reason").and_then(|v| v.as_str()).unwrap_or("ERROR");
                return Err(TransferError::new("SIGNALING", translate_error(reason)));
            }
            Some("signal") => {
                let Some(data) = msg.get("data") else {
                    continue;
                };
                match data.get("type").and_then(|v| v.as_str()) {
                    Some("cli-denied") => {
                        let reason = data.get("reason").and_then(|v| v.as_str());
                        if reason == Some("VERSION") {
                            return Err(TransferError::new(
                                "PROTOCOL_VERSION",
                                "Versión de protocolo incompatible. Ejecuta drop update.",
                            ));
                        }
                        return Err(TransferError::new(
                            "DENIED",
                            "El emisor rechazó la transferencia.",
                        ));
                    }
                    Some("cli-sealed") => {
                        let Some(boxed) = data.get("box").and_then(|v| v.as_str()) else {
                            continue;
                        };
                        let inner = unseal_frame(boxed, key).map_err(|_| {
                            TransferError::new(
                                "BAD_CODE",
                                "El código no coincide o el manifiesto fue adulterado.",
                            )
                        })?;
                        if inner.get("type").and_then(|v| v.as_str()) == Some("cli-manifest") {
                            let remote_v = inner.get("v").and_then(|v| v.as_u64());
                            if remote_v != Some(PROTOCOL_VERSION as u64) {
                                return Err(TransferError::new(
                                    "PROTOCOL_VERSION",
                                    "Versión de protocolo del emisor incompatible.",
                                ));
                            }
                            return Ok(inner.get("manifest").cloned().unwrap_or(Value::Null));
                        }
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }
}

pub async fn run_recv(code_input: &str, options: Options) -> i32 {
    let to_stdout = options.stdout;
    set_progress_stderr(to_stdout);

    let parsed = match parse_code(code_input, Lang::Es) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("\n  {RED}Código inválido:{RESET} {}\n", e.message);
            return 1;
        }
    };

    let mut temp_stdout_dir: Option<PathBuf> = None;
    let output_dir = if to_stdout {
        let dir = env::temp_dir().join(format!(
            "drop-stdout-{}-{:016x}",
            std::process::id(),
            rand::thread_rng().next_u64()
        ));
        if let Err(e) = std::fs::create_dir_all(&dir) {
            eprintln!("\n  {RED}No se pudo crear directorio temporal: {e}{RESET}\n");
            return 1;
        }
        temp_stdout_dir = Some(dir.clone());
        dir
    } else {
        let dir = options
            .out
            .as_deref()
            .map(PathBuf::from)
            .unwrap_or_else(resolve_default_output_dir);
        if let Err(e) = ensure_writable_dir(&dir) {
            eprintln!("\n  {RED}{e}{RESET}\n");
            return 1;
        }
        dir
    };

    log_out(
        to_stdout,
        &format!("\n{BOLD}================================================================{RESET}"),
    );
    log_out(
        to_stdout,
        &format!("  {CYAN}drop recv{RESET} — {BOLD}Recepción P2P Cifrada Extremo a Extremo{RESET}"),
    );
    log_out(
        to_stdout,
        &format!("{BOLD}================================================================{RESET}\n"),
    );
    log_out(
        to_stdout,
        &format!(
            "  {DIM}Buscando emisor para el código:{RESET} {CYAN}{}{RESET}",
            parsed.code
        ),
    );
    if options.limit > 0 {
        log_out(
            to_stdout,
            &format!(
                "  {DIM}Límite de bajada:{RESET} {}",
                fmt_speed(options.limit as f64)
            ),
        );
    }

    let key = derive_key(&parsed.code);
    let sas = sas_from_key(&key, &parsed.room_id);

    let exit_code = loop {
        match attempt_receive(
            &parsed.code,
            &parsed.room_id,
            &key,
            &sas,
            &output_dir,
            &options,
            to_stdout,
        )
        .await
        {
            Ok(stats) => {
                render_progress_bar_complete(
                    stats.total_bytes,
                    stats.total_time_sec,
                    stats.avg_speed,
                    30,
                );
                if to_stdout {
                    let mut stdout = tokio::io::stdout();
                    let mut buf = vec![0u8; 64 * 1024];
                    for rf in &stats.files {
                        let Ok(mut f) = File::open(&rf.path).await else {
                            eprintln!("\n  {RED}Error abriendo archivo temporal recibido{RESET}\n");
                            break;
                        };
                        loop {
                            match f.read(&mut buf).await {
                                Ok(0) => break,
                                Ok(n) => {
                                    if stdout.write_all(&buf[..n]).await.is_err() {
                                        eprintln!("\n  {RED}Error escribiendo en stdout{RESET}\n");
                                        if let Some(d) = temp_stdout_dir.take() {
                                            let _ = std::fs::remove_dir_all(d);
                                        }
                                        return 1;
                                    }
                                }
                                Err(e) => {
                                    eprintln!("\n  {RED}Error leyendo archivo temporal: {e}{RESET}\n");
                                    if let Some(d) = temp_stdout_dir.take() {
                                        let _ = std::fs::remove_dir_all(d);
                                    }
                                    return 1;
                                }
                            }
                        }
                        let label = rf.rel.as_deref().unwrap_or(&rf.name);
                        log_out(
                            true,
                            &format!(
                                "  {GREEN}✔{RESET} {label} {GREEN}✔ verificado{RESET} {DIM}({}){RESET}",
                                fmt_bytes(rf.size)
                            ),
                        );
                    }
                    let _ = stdout.flush().await;
                } else {
                    log_out(false, "");
                    for rf in &stats.files {
                        let label = rf.rel.as_deref().unwrap_or(&rf.name);
                        log_out(
                            false,
                            &format!(
                                "  {GREEN}✔{RESET} {label} {GREEN}✔ verificado{RESET} {DIM}({}){RESET}",
                                fmt_bytes(rf.size)
                            ),
                        );
                    }
                    if stats.resumed_bytes > 0 {
                        log_out(
                            false,
                            &format!(
                                "  {DIM}Reanudación aprovechada: {} ahorrados.{RESET}",
                                fmt_bytes(stats.resumed_bytes)
                            ),
                        );
                    }
                    log_out(
                        false,
                        &format!("\n  {DIM}Guardado en:{RESET} {}\n", output_dir.display()),
                    );
                }
                break 0;
            }
            Err(err) => {
                if err.code == "NOTHING_SELECTED" {
                    print_nothing_selected(&err.available, &options.only, to_stdout);
                    break 1;
                }
                log_out(to_stdout, &format!("\n  {RED}Error: {}{RESET}", err.message));
                if err.code == "INTEGRITY_MISMATCH"
                    && !to_stdout
                    && std::io::stdin().is_terminal()
                    && ask_tty_confirm("  ¿Quieres reintentar la descarga? [s/N]: ", false, false)
                        .await
                {
                    continue;
                }
                if err.resumable {
                    log_out(
                        to_stdout,
                        &format!(
                            "  {YELLOW}Guardados {} en .part: vuelve a ejecutar el mismo comando para reanudar desde ahí.{RESET}",
                            fmt_bytes(err.part_bytes)
                        ),
                    );
                }
                log_out(to_stdout, "");
                break 1;
            }
        }
    };

    if let Some(d) = temp_stdout_dir {
        let _ = std::fs::remove_dir_all(d);
    }
    set_progress_stderr(false);
    exit_code
}
