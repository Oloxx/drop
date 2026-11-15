// Implementacion de `drop send`: empaquetado de archivos/carpetas/stdin/texto,
// escucha TCP dual-stack, NAT (UPnP + STUN), difusion LAN y Relay E2EE con Web/CLI.

use std::collections::{HashMap, HashSet};
use std::env;
use std::io::IsTerminal;
use std::path::{Path, PathBuf};
#[cfg(target_os = "linux")]
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use rand::RngCore;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::fs::File;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio::sync::{Mutex, Notify};
use tokio::time::{sleep, timeout};

use crate::cli::Options;
use crate::commands::make_peer_gate;
use crate::crypto::{derive_key, sas_from_key, seal_frame, unseal_frame, verify_proof};
use crate::discovery::{Broadcaster, get_candidate_ips, start_broadcasting};
use crate::listen::listen_any_family;
use crate::shared::codes::{new_code, random_room_id};
use crate::shared::protocol::{FileEntry, PROTOCOL_VERSION, picked_files};
use crate::shared::qr::{Ecl, encode_qr, qr_to_blocks};
use crate::signaling::{SignalingSender, WsEvent, connect_signaling, create_room};
use crate::stun::{StunResult, discover_public_ip, merge_offer_candidates};
use crate::throttle::Throttle;
use crate::transfer::{
    PeerGateFn, PeerInfo, ProgressFn, RELAY_IDLE_TIMEOUT_MS, ResumeNoticeFn, SendItem,
    TransferError, TransferStats, attach_sender, relay_binary_packet, send_sealed, total_of,
    verify_prefix,
};
use crate::ui::{
    BOLD, CYAN, DIM, GREEN, RED, RESET, YELLOW, fmt_bytes, fmt_duration, fmt_speed,
    render_progress_bar, render_progress_bar_complete, reset_file_line_state,
};
use crate::upnp::{MapOutcome, MapPortOptions, UpnpMapping, UpnpResult, map_port};

const RELAY_CHUNK_SIZE: usize = 64 * 1024;
const RELAY_MAX_IN_FLIGHT: u64 = 8 * 1024 * 1024;

fn now_epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn read_clipboard() -> Result<String, String> {
    if let Ok(mut cb) = arboard::Clipboard::new()
        && let Ok(txt) = cb.get_text()
        && !txt.is_empty()
    {
        return Ok(txt);
    }

    #[cfg(target_os = "linux")]
    {
        for (cmd, args) in [
            ("wl-paste", &["--no-newline"][..]),
            ("xclip", &["-o", "-selection", "clipboard"][..]),
            ("xsel", &["--clipboard", "--output"][..]),
        ] {
            if let Ok(out) = std::process::Command::new(cmd)
                .args(args)
                .stderr(Stdio::null())
                .output()
                && out.status.success()
            {
                let txt = String::from_utf8_lossy(&out.stdout).to_string();
                if !txt.is_empty() {
                    return Ok(txt);
                }
            }
        }
    }

    Err("No se pudo leer texto del portapapeles (o está vacío).".to_string())
}

fn stage_inline_content(content: &str, name: &str) -> Result<(PathBuf, SendItem), String> {
    let pid = std::process::id();
    let rnd = rand::thread_rng().next_u64();
    let dir = env::temp_dir().join(format!("drop-inline-{pid}-{rnd:016x}"));
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("No se pudo crear archivo temporal: {e}"))?;

    let clean_name = Path::new(name)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .filter(|s| !s.is_empty() && s != "." && s != "..")
        .unwrap_or_else(|| "message.txt".to_string());

    let file_path = dir.join(&clean_name);
    std::fs::write(&file_path, content.as_bytes())
        .map_err(|e| format!("No se pudo escribir el texto temporal: {e}"))?;

    let size = content.len() as u64;
    let item = SendItem {
        entry: FileEntry {
            name: clean_name,
            size: Some(size),
            path: None,
        },
        fs_path: Some(file_path),
        is_stdin: false,
    };
    Ok((dir, item))
}

fn walk_folder(
    dir: &Path,
    prefix: &str,
    items: &mut Vec<SendItem>,
) -> Result<(), String> {
    let mut entries: Vec<_> = std::fs::read_dir(dir)
        .map_err(|e| format!("No se pudo leer la carpeta {}: {e}", dir.display()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Error leyendo entrada de {}: {e}", dir.display()))?;

    entries.sort_by_key(|e| e.file_name());

    for entry in entries {
        let name = entry.file_name().to_string_lossy().to_string();
        let full = entry.path();
        let meta = match std::fs::symlink_metadata(&full) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.file_type().is_symlink() {
            continue;
        }
        let rel = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        if meta.is_dir() {
            walk_folder(&full, &rel, items)?;
        } else if meta.is_file() {
            items.push(SendItem {
                entry: FileEntry {
                    name,
                    size: Some(meta.len()),
                    path: Some(rel),
                },
                fs_path: Some(full),
                is_stdin: false,
            });
        }
    }
    Ok(())
}

struct SenderState {
    closed: AtomicBool,
    expired: AtomicBool,
    once: bool,
    from_stdin: bool,
    stdin_spent: AtomicBool,
    stdin_failed: AtomicBool,
    in_flight: AtomicUsize,
    delivered: AtomicUsize,
    shutdown_notify: Notify,
}

impl SenderState {
    fn accepting_peers(&self) -> bool {
        if self.closed.load(Ordering::SeqCst) || self.expired.load(Ordering::SeqCst) {
            return false;
        }
        if self.once
            && (self.delivered.load(Ordering::SeqCst) > 0
                || self.in_flight.load(Ordering::SeqCst) > 0)
        {
            return false;
        }
        if self.from_stdin && self.stdin_spent.load(Ordering::SeqCst) {
            return false;
        }
        true
    }

    fn finish_peer_ok(&self, delivered_before_in_flight: bool) {
        let _ = delivered_before_in_flight;
        self.delivered.fetch_add(1, Ordering::SeqCst);
        let rem = self.in_flight.fetch_sub(1, Ordering::SeqCst).saturating_sub(1);
        if self.from_stdin {
            println!(
                "\n  {GREEN}✔ El flujo de stdin ya está entregado. Cerrando el canal.{RESET}\n"
            );
            self.closed.store(true, Ordering::SeqCst);
            self.shutdown_notify.notify_waiters();
            return;
        }
        if self.once {
            println!("\n  {GREEN}✔ Entrega única completada. Cerrando el canal.{RESET}\n");
            self.closed.store(true, Ordering::SeqCst);
            self.shutdown_notify.notify_waiters();
            return;
        }
        if self.expired.load(Ordering::SeqCst) && rem == 0 {
            self.closed.store(true, Ordering::SeqCst);
            self.shutdown_notify.notify_waiters();
        }
    }

    fn finish_peer_err(&self, had_started_stdin: bool) {
        let rem = self.in_flight.fetch_sub(1, Ordering::SeqCst).saturating_sub(1);
        if self.from_stdin && had_started_stdin && self.delivered.load(Ordering::SeqCst) == 0 {
            eprintln!(
                "\n  {RED}✖ El flujo de stdin fue consumido a medias por una transferencia fallida; no se puede reenviar a otro receptor.{RESET}\n"
            );
            self.stdin_failed.store(true, Ordering::SeqCst);
            self.closed.store(true, Ordering::SeqCst);
            self.shutdown_notify.notify_waiters();
            return;
        }
        if self.expired.load(Ordering::SeqCst) && rem == 0 {
            self.closed.store(true, Ordering::SeqCst);
            self.shutdown_notify.notify_waiters();
        }
    }
}

struct GuestStream {
    acked: AtomicU64,
    last_progress_ms: AtomicU64,
    completed: AtomicBool,
    cancelled: AtomicBool,
    cancel_reason: Mutex<Option<String>>,
    notify: Notify,
}

impl GuestStream {
    fn new() -> Self {
        Self {
            acked: AtomicU64::new(0),
            last_progress_ms: AtomicU64::new(now_epoch_ms()),
            completed: AtomicBool::new(false),
            cancelled: AtomicBool::new(false),
            cancel_reason: Mutex::new(None),
            notify: Notify::new(),
        }
    }
}

struct WebGuestStreamParams {
    guest_id: u64,
    items: Arc<Vec<SendItem>>,
    selected_indices: Vec<usize>,
    resume_map: HashMap<usize, Value>,
    key: [u8; 32],
    limit: u64,
    ws_sender: SignalingSender,
    stream_state: Arc<GuestStream>,
    sender_state: Arc<SenderState>,
}

async fn stream_to_web_guest(params: WebGuestStreamParams) -> Result<TransferStats, String> {
    let WebGuestStreamParams {
        guest_id,
        items,
        selected_indices,
        resume_map,
        key,
        limit,
        ws_sender,
        stream_state,
        sender_state,
    } = params;
    let guest_u32 = u32::try_from(guest_id).map_err(|_| "guestId fuera de rango".to_string())?;
    let selected_entries: Vec<FileEntry> = selected_indices
        .iter()
        .map(|&idx| items[idx].entry.clone())
        .collect();
    let total_expected = total_of(&selected_entries);

    let mut throttle = Throttle::new(limit);
    let mut sent_total = 0u64;
    let mut resumed_bytes = 0u64;
    let start_ts = Instant::now();
    let mut buf = vec![0u8; RELAY_CHUNK_SIZE];

    stream_state
        .last_progress_ms
        .store(now_epoch_ms(), Ordering::SeqCst);

    for &idx in &selected_indices {
        if stream_state.cancelled.load(Ordering::SeqCst)
            || sender_state.closed.load(Ordering::SeqCst)
        {
            return Err(stream_state
                .cancel_reason
                .lock()
                .await
                .clone()
                .unwrap_or_else(|| "Transferencia cancelada".to_string()));
        }

        let item = &items[idx];
        let mut offset = 0u64;
        let mut hasher = Sha256::new();

        if !item.is_stdin
            && let Some(fs_path) = &item.fs_path
            && let Some(req) = resume_map.get(&idx)
            && let Ok(Some(verified)) = verify_prefix(fs_path, item.entry.size, Some(req)).await
        {
            offset = verified.offset;
            hasher = verified.hasher;
            resumed_bytes += offset;
            sent_total += offset;
            let label = item.entry.path.as_deref().unwrap_or(&item.entry.name);
            println!(
                "  {DIM}El receptor ya tiene {} de {label}: se reanuda desde ahí.{RESET}",
                fmt_bytes(offset)
            );
        }

        let mut start_msg = json!({
            "type": "cli-start",
            "index": idx,
            "name": item.entry.name,
            "size": item.entry.size,
            "mime": "application/octet-stream",
            "offset": offset,
        });
        if let Some(p) = &item.entry.path {
            start_msg["path"] = json!(p);
        }
        send_sealed(&ws_sender, Some(guest_id), &start_msg, &key)?;

        if item.is_stdin {
            let mut stdin = tokio::io::stdin();
            loop {
                wait_relay_window(sent_total, &stream_state, &sender_state).await?;
                let n = stdin
                    .read(&mut buf)
                    .await
                    .map_err(|e| format!("Error leyendo stdin: {e}"))?;
                if n == 0 {
                    break;
                }
                throttle.take(n).await;
                hasher.update(&buf[..n]);
                let pkt = relay_binary_packet(guest_u32, &key, &buf[..n]);
                ws_sender.send_binary(pkt)?;
                sent_total += n as u64;
                let secs = start_ts.elapsed().as_secs_f64().max(0.001);
                render_progress_bar(
                    sent_total,
                    total_expected,
                    (sent_total - resumed_bytes) as f64 / secs,
                    30,
                    Some(&selected_entries),
                );
            }
        } else if let Some(fs_path) = &item.fs_path {
            let mut f = File::open(fs_path)
                .await
                .map_err(|e| format!("No se pudo abrir archivo: {e}"))?;
            if offset > 0 {
                f.seek(std::io::SeekFrom::Start(offset))
                    .await
                    .map_err(|e| format!("Error buscando offset: {e}"))?;
            }
            loop {
                wait_relay_window(sent_total, &stream_state, &sender_state).await?;
                let n = f
                    .read(&mut buf)
                    .await
                    .map_err(|e| format!("Error leyendo archivo: {e}"))?;
                if n == 0 {
                    break;
                }
                throttle.take(n).await;
                hasher.update(&buf[..n]);
                let pkt = relay_binary_packet(guest_u32, &key, &buf[..n]);
                ws_sender.send_binary(pkt)?;
                sent_total += n as u64;
                let secs = start_ts.elapsed().as_secs_f64().max(0.001);
                render_progress_bar(
                    sent_total,
                    total_expected,
                    (sent_total - resumed_bytes) as f64 / secs,
                    30,
                    Some(&selected_entries),
                );
            }
        }

        let sha_hex = hex::encode(hasher.finalize());
        send_sealed(
            &ws_sender,
            Some(guest_id),
            &json!({ "type": "cli-end", "index": idx, "sha256": sha_hex }),
            &key,
        )?;
    }

    send_sealed(&ws_sender, Some(guest_id), &json!({ "type": "cli-done" }), &key)?;

    // Esperar confirmacion `cli-complete` de que todo se escribio y verifico.
    while !stream_state.completed.load(Ordering::SeqCst) {
        if stream_state.cancelled.load(Ordering::SeqCst)
            || sender_state.closed.load(Ordering::SeqCst)
        {
            return Err(stream_state
                .cancel_reason
                .lock()
                .await
                .clone()
                .unwrap_or_else(|| "El receptor cerró antes de confirmar".to_string()));
        }
        let idle = now_epoch_ms().saturating_sub(stream_state.last_progress_ms.load(Ordering::SeqCst));
        if idle > RELAY_IDLE_TIMEOUT_MS {
            return Err("Tiempo de espera agotado esperando confirmación final del receptor".to_string());
        }
        tokio::select! {
            _ = stream_state.notify.notified() => {},
            _ = sleep(Duration::from_millis(250)) => {},
        }
    }

    let elapsed = start_ts.elapsed().as_secs_f64().max(0.001);
    let wire_bytes = sent_total - resumed_bytes;
    Ok(TransferStats {
        files: Vec::new(),
        total_bytes: sent_total,
        resumed_bytes,
        total_time_sec: elapsed,
        avg_speed: wire_bytes as f64 / elapsed,
        canceled: false,
        interrupted: false,
    })
}

async fn wait_relay_window(
    sent_total: u64,
    stream_state: &GuestStream,
    sender_state: &SenderState,
) -> Result<(), String> {
    loop {
        if stream_state.cancelled.load(Ordering::SeqCst)
            || sender_state.closed.load(Ordering::SeqCst)
        {
            return Err(stream_state
                .cancel_reason
                .lock()
                .await
                .clone()
                .unwrap_or_else(|| "Transferencia interrumpida por el receptor".to_string()));
        }
        let acked = stream_state.acked.load(Ordering::SeqCst);
        if sent_total.saturating_sub(acked) <= RELAY_MAX_IN_FLIGHT {
            return Ok(());
        }
        let idle =
            now_epoch_ms().saturating_sub(stream_state.last_progress_ms.load(Ordering::SeqCst));
        if idle > RELAY_IDLE_TIMEOUT_MS {
            return Err("Receptor estancado (sin acuses durante 60 s)".to_string());
        }
        tokio::select! {
            _ = stream_state.notify.notified() => {},
            _ = sleep(Duration::from_millis(250)) => {},
        }
    }
}

pub async fn run_send(args: &[String], options: Options) -> i32 {
    let has_stdin = args.iter().any(|a| a == "-");
    if has_stdin && args.len() > 1 {
        eprintln!("\n  {RED}Error: - (stdin) no se puede combinar con otros archivos.{RESET}\n");
        return 1;
    }
    if options.text.is_some() && options.clipboard {
        eprintln!("\n  {RED}Error: no se puede usar --text y --clipboard a la vez.{RESET}\n");
        return 1;
    }
    if (options.text.is_some() || options.clipboard) && !args.is_empty() {
        eprintln!("\n  {RED}Error: no se puede combinar --text/--clipboard con archivos.{RESET}\n");
        return 1;
    }

    let is_inline = has_stdin || options.text.is_some() || options.clipboard;
    if options.name.is_some() && !is_inline {
        eprintln!(
            "\n  {RED}Error: --name solo tiene sentido con -, --text o --clipboard.{RESET}\n"
        );
        return 1;
    }

    let mut items = Vec::new();
    let mut temp_dir: Option<PathBuf> = None;
    let mut folder_count = 0usize;

    if has_stdin {
        if std::io::stdin().is_terminal() {
            eprintln!(
                "\n  {YELLOW}Aviso: estás enviando stdin desde una terminal interactiva (usa Ctrl+D / Ctrl+Z para EOF).{RESET}"
            );
        }
        let name = options
            .name
            .as_deref()
            .and_then(|n| Path::new(n).file_name().map(|f| f.to_string_lossy().to_string()))
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "stdin".to_string());
        items.push(SendItem {
            entry: FileEntry {
                name,
                size: None,
                path: None,
            },
            fs_path: None,
            is_stdin: true,
        });
    } else if let Some(ref txt) = options.text {
        let name = options.name.as_deref().unwrap_or("message.txt");
        match stage_inline_content(txt, name) {
            Ok((dir, item)) => {
                temp_dir = Some(dir);
                items.push(item);
            }
            Err(e) => {
                eprintln!("\n  {RED}{e}{RESET}\n");
                return 1;
            }
        }
    } else if options.clipboard {
        let txt = match read_clipboard() {
            Ok(t) => t,
            Err(e) => {
                eprintln!("\n  {RED}{e}{RESET}\n");
                return 1;
            }
        };
        let name = options.name.as_deref().unwrap_or("clipboard.txt");
        match stage_inline_content(&txt, name) {
            Ok((dir, item)) => {
                temp_dir = Some(dir);
                items.push(item);
            }
            Err(e) => {
                eprintln!("\n  {RED}{e}{RESET}\n");
                return 1;
            }
        }
    } else {
        for raw in args {
            let p = PathBuf::from(raw);
            let meta = match std::fs::metadata(&p) {
                Ok(m) => m,
                Err(_) => {
                    eprintln!("\n  {RED}El archivo no existe: {raw}{RESET}\n");
                    return 1;
                }
            };
            if meta.is_dir() {
                let top_name = p
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| "carpeta".to_string());
                folder_count += 1;
                if let Err(e) = walk_folder(&p, &top_name, &mut items) {
                    eprintln!("\n  {RED}{e}{RESET}\n");
                    return 1;
                }
            } else if meta.is_file() {
                let name = p
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| raw.clone());
                items.push(SendItem {
                    entry: FileEntry {
                        name,
                        size: Some(meta.len()),
                        path: None,
                    },
                    fs_path: Some(p),
                    is_stdin: false,
                });
            }
        }
    }

    if items.is_empty() {
        eprintln!("\n  {RED}No hay ningún archivo para enviar.{RESET}\n");
        if let Some(d) = temp_dir {
            let _ = std::fs::remove_dir_all(d);
        }
        return 1;
    }

    let listener = match listen_any_family(options.port) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("\n  {RED}{}{RESET}\n", e.message);
            if let Some(d) = temp_dir {
                let _ = std::fs::remove_dir_all(d);
            }
            return 1;
        }
    };
    let tcp_port = listener.local_addr().map(|a| a.port()).unwrap_or(0);

    println!("\n{BOLD}================================================================{RESET}");
    println!("  {CYAN}drop send{RESET} — {BOLD}Envío P2P Cifrado Extremo a Extremo{RESET}");
    println!("{BOLD}================================================================{RESET}\n");

    let entries: Vec<FileEntry> = items.iter().map(|it| it.entry.clone()).collect();
    if has_stdin {
        println!(
            "  {GREEN}✔ Listo para enviar:{RESET} {} {DIM}· tamaño desconocido (stdin){RESET}",
            items[0].entry.name
        );
    } else if folder_count > 0 {
        let sum = total_of(&entries).unwrap_or(0);
        println!(
            "  {GREEN}✔ Listo para enviar:{RESET} {} archivo(s) en {folder_count} carpeta(s) {DIM}({}){RESET}",
            items.len(),
            fmt_bytes(sum)
        );
    } else if items.len() == 1 {
        let sum = items[0].entry.size.unwrap_or(0);
        println!(
            "  {GREEN}✔ Listo para enviar:{RESET} {} {DIM}({}){RESET}",
            items[0].entry.name,
            fmt_bytes(sum)
        );
    } else {
        let sum = total_of(&entries).unwrap_or(0);
        println!(
            "  {GREEN}✔ Listo para enviar:{RESET} {} archivos {DIM}({}){RESET}",
            items.len(),
            fmt_bytes(sum)
        );
    }
    if options.limit > 0 {
        println!(
            "  {DIM}Límite de subida:{RESET} {}",
            fmt_speed(options.limit as f64)
        );
    }
    if let Some(exp) = options.expire_ms {
        println!(
            "  {DIM}El canal caduca en {}{RESET}",
            fmt_duration(exp as f64 / 1000.0)
        );
    }
    if options.once {
        println!("  {DIM}El canal se cierra tras la primera descarga (--once).{RESET}");
    }

    // UPnP y STUN en segundo plano mientras conectamos señalizacion.
    let upnp_mapping_slot: Arc<Mutex<Option<Arc<UpnpMapping>>>> = Arc::new(Mutex::new(None));
    let upnp_res_slot: Arc<Mutex<Option<UpnpResult>>> = Arc::new(Mutex::new(None));
    let upnp_done = Arc::new(Notify::new());
    let upnp_enabled = !options.relay
        && env::var_os("DROP_NO_UPNP")
            .is_none_or(|v| v.is_empty());

    if upnp_enabled {
        let map_slot = Arc::clone(&upnp_mapping_slot);
        let res_slot = Arc::clone(&upnp_res_slot);
        let done = Arc::clone(&upnp_done);
        let pref = if options.port > 0 {
            Some(options.port)
        } else {
            Some(tcp_port)
        };
        tokio::spawn(async move {
            match map_port(tcp_port, pref, MapPortOptions::default()).await {
                MapOutcome::Mapped(m) => {
                    let res = m.as_result();
                    *res_slot.lock().await = Some(res.clone());
                    *map_slot.lock().await = Some(m);
                    println!(
                        "\n  {GREEN}✔ Puerto mapeado por UPnP:{RESET} {CYAN}:{}{RESET} {DIM}(WAN: {}){RESET}",
                        res.external_port.unwrap_or(tcp_port),
                        res.public_ip.as_deref().unwrap_or("detectada")
                    );
                }
                MapOutcome::Failed(res) => {
                    *res_slot.lock().await = Some(res);
                }
            }
            done.notify_waiters();
        });
    } else {
        upnp_done.notify_waiters();
    }

    let stun_res_slot: Arc<Mutex<Option<StunResult>>> = Arc::new(Mutex::new(None));
    let stun_done = Arc::new(Notify::new());
    let stun_enabled = !options.relay
        && env::var_os("DROP_NO_STUN")
            .is_none_or(|v| v.is_empty());

    if stun_enabled {
        let res_slot = Arc::clone(&stun_res_slot);
        let done = Arc::clone(&stun_done);
        tokio::spawn(async move {
            let res = discover_public_ip(None, 2500).await;
            *res_slot.lock().await = res;
            done.notify_waiters();
        });
    } else {
        stun_done.notify_waiters();
    }

    // Conexion al servidor de señalizacion (o modo LAN puro si no hay red).
    let mut sig_client = match connect_signaling(&options.server).await {
        Ok(mut c) => match create_room(&mut c).await {
            Ok(info) => Some((c, info)),
            Err(e) => {
                println!(
                    "\n  {YELLOW}Aviso: {e}. Operando en modo LAN local pura.{RESET}"
                );
                None
            }
        },
        Err(_) => {
            println!(
                "\n  {YELLOW}Aviso: Sin conexión con el servidor. Operando en modo LAN local pura.{RESET}"
            );
            None
        }
    };

    let (room_id, ws_public_ip) = match &sig_client {
        Some((_, info)) => (info.room_id.clone(), info.public_ip.clone()),
        None => (random_room_id(), None),
    };

    let code = new_code(&room_id);
    let key = derive_key(&code);
    let sas = sas_from_key(&key, &room_id);

    let broadcaster: Option<Broadcaster> = if !options.relay {
        Some(start_broadcasting(&code, tcp_port))
    } else {
        None
    };

    println!("\n  {BOLD}Código:{RESET}              {CYAN}{BOLD}{code}{RESET}");
    println!("  {BOLD}Huella:{RESET}              {YELLOW}{sas}{RESET}");
    println!("  {BOLD}En el receptor:{RESET}");
    println!(
        "    {YELLOW}drop recv {code}{}{RESET}",
        if options.relay { " --relay" } else { "" }
    );
    if sig_client.is_some() {
        let base_url = options.server.trim_end_matches('/');
        let share_url = format!("{base_url}/#{code}");
        println!("    {DIM}Enlace:  {share_url}{RESET}");
        if !options.no_qr
            && let Ok(qr) = encode_qr(&share_url, Ecl::M)
        {
            println!();
            for line in qr_to_blocks(&qr, 1, true).lines() {
                println!("  {line}");
            }
        }
    }
    println!("\n  {DIM}Esperando conexiones... (Presiona Ctrl + C para salir){RESET}\n");

    let items_arc = Arc::new(items);
    let sender_state = Arc::new(SenderState {
        closed: AtomicBool::new(false),
        expired: AtomicBool::new(false),
        once: options.once,
        from_stdin: has_stdin,
        stdin_spent: AtomicBool::new(false),
        stdin_failed: AtomicBool::new(false),
        in_flight: AtomicUsize::new(0),
        delivered: AtomicUsize::new(0),
        shutdown_notify: Notify::new(),
    });
    let peer_gate: PeerGateFn = make_peer_gate(options.yes);

    if let Some(exp_ms) = options.expire_ms {
        let st = Arc::clone(&sender_state);
        tokio::spawn(async move {
            sleep(Duration::from_millis(exp_ms)).await;
            if st.closed.load(Ordering::SeqCst) {
                return;
            }
            if st.in_flight.load(Ordering::SeqCst) == 0 {
                println!("\n  {YELLOW}⏱ Canal caducado. Cerrando...{RESET}\n");
                st.closed.store(true, Ordering::SeqCst);
                st.shutdown_notify.notify_waiters();
            } else {
                println!(
                    "\n  {YELLOW}⏱ Canal caducado: esperando a que acabe la transferencia activa...{RESET}\n"
                );
                st.expired.store(true, Ordering::SeqCst);
            }
        });
    }

    // Manejador SIGINT / Ctrl+C
    {
        let st = Arc::clone(&sender_state);
        tokio::spawn(async move {
            let _ = tokio::signal::ctrl_c().await;
            println!("\n  {DIM}Cerrando canal...{RESET}");
            st.closed.store(true, Ordering::SeqCst);
            st.shutdown_notify.notify_waiters();
        });
    }

    let ws_sender_opt = sig_client.as_ref().map(|(c, _)| c.sender.clone());
    let local_ips = get_candidate_ips();

    // Estado por receptor Relay
    let mut pending_proofs: HashMap<u64, String> = HashMap::new();
    let mut guest_picks: HashMap<u64, Option<Vec<usize>>> = HashMap::new();
    let guest_streams: Arc<Mutex<HashMap<u64, Arc<GuestStream>>>> =
        Arc::new(Mutex::new(HashMap::new()));

    loop {
        if sender_state.closed.load(Ordering::SeqCst) {
            break;
        }

        let ws_next = async {
            match sig_client.as_mut() {
                Some((client, _)) => client.events.recv().await,
                None => std::future::pending().await,
            }
        };

        tokio::select! {
            _ = sender_state.shutdown_notify.notified() => {
                break;
            }
            accept_res = listener.accept() => {
                match accept_res {
                    Ok((stream, _addr)) => {
                        if options.relay || !sender_state.accepting_peers() {
                            drop(stream);
                            continue;
                        }
                        let st = Arc::clone(&sender_state);
                        let items = Arc::clone(&items_arc);
                        let code_clone = code.clone();
                        let room_clone = room_id.clone();
                        let gate = Arc::clone(&peer_gate);
                        let limit = options.limit;

                        st.in_flight.fetch_add(1, Ordering::SeqCst);
                        let had_stdin = if st.from_stdin {
                            st.stdin_spent.store(true, Ordering::SeqCst);
                            true
                        } else {
                            false
                        };

                        tokio::spawn(async move {
                            reset_file_line_state();
                            let progress: ProgressFn = Box::new(|sent, total, speed, list| {
                                render_progress_bar(sent, total, speed, 30, Some(list));
                            });
                            let resume_cb: ResumeNoticeFn = Box::new(|label, offset| {
                                println!(
                                    "  {DIM}El receptor ya tiene {} de {label}: se reanuda.{RESET}",
                                    fmt_bytes(offset)
                                );
                            });
                            let res = attach_sender(
                                stream,
                                &items,
                                &code_clone,
                                &room_clone,
                                limit,
                                Some(gate),
                                Some(progress),
                                Some(resume_cb),
                                Some(Arc::new(AtomicBool::new(false))),
                            )
                            .await;
                            match res {
                                Ok(stats) => {
                                    render_progress_bar_complete(stats.total_bytes, stats.total_time_sec, stats.avg_speed, 30);
                                    println!("\n  {GREEN}✔ ¡Transferencia completada con éxito!{RESET}");
                                    if stats.resumed_bytes > 0 {
                                        println!(
                                            "  {DIM}{} ya estaban en el receptor: no se han vuelto a mandar.{RESET}",
                                            fmt_bytes(stats.resumed_bytes)
                                        );
                                    }
                                    st.finish_peer_ok(false);
                                    if st.accepting_peers() {
                                        println!("  {DIM}Canal abierto para más descargas. Presiona Ctrl + C para cerrarlo.{RESET}\n");
                                    }
                                }
                                Err(TransferError { code: "PROBE" | "DENIED", .. }) => {
                                    if had_stdin {
                                        st.stdin_spent.store(false, Ordering::SeqCst);
                                    }
                                    st.in_flight.fetch_sub(1, Ordering::SeqCst);
                                }
                                Err(e) => {
                                    println!("\n  {YELLOW}Receptor interrumpido: {e}{RESET}");
                                    st.finish_peer_err(had_stdin);
                                }
                            }
                        });
                    }
                    Err(_) => break,
                }
            }
            ev_opt = ws_next => {
                let Some(ev) = ev_opt else {
                    sig_client = None;
                    continue;
                };
                let WsEvent::Json(msg) = ev else {
                    if matches!(ev, WsEvent::Closed) {
                        sig_client = None;
                    }
                    continue;
                };
                let Some(ws_sender) = ws_sender_opt.as_ref() else {
                    continue;
                };

                match msg.get("t").and_then(|v| v.as_str()) {
                    Some("guest") => {
                        let Some(guest_id) = msg.get("guestId").and_then(|v| v.as_u64()) else {
                            continue;
                        };
                        let mut nonce_bytes = [0u8; 16];
                        rand::thread_rng().fill_bytes(&mut nonce_bytes);
                        let nonce = hex::encode(nonce_bytes);
                        pending_proofs.insert(guest_id, nonce.clone());

                        let ws = ws_sender.clone();
                        let ips_base = local_ips.clone();
                        let ws_pub = ws_public_ip.clone();
                        let force_relay = options.relay;
                        let u_slot = Arc::clone(&upnp_res_slot);
                        let s_slot = Arc::clone(&stun_res_slot);
                        let u_done = Arc::clone(&upnp_done);
                        let s_done = Arc::clone(&stun_done);

                        tokio::spawn(async move {
                            if !force_relay {
                                if u_slot.lock().await.is_none() {
                                    let _ = timeout(Duration::from_millis(1500), u_done.notified()).await;
                                }
                                if s_slot.lock().await.is_none() {
                                    let _ = timeout(Duration::from_millis(1500), s_done.notified()).await;
                                }
                            }
                            let u_res = u_slot.lock().await.clone();
                            let s_res = s_slot.lock().await.clone();
                            let upnp_ok = u_res.as_ref().is_some_and(|r| r.success);
                            let offer_port = if force_relay {
                                0
                            } else {
                                u_res.as_ref().and_then(|r| r.external_port).unwrap_or(tcp_port)
                            };
                            let merged = merge_offer_candidates(
                                &ips_base,
                                u_res,
                                s_res,
                                ws_pub.as_deref(),
                                force_relay,
                            );
                            let _ = ws.send_signal(
                                Some(guest_id),
                                &json!({
                                    "type": "cli-offer",
                                    "v": PROTOCOL_VERSION,
                                    "ips": merged.candidate_ips,
                                    "port": offer_port,
                                    "upnp": upnp_ok,
                                    "nonce": nonce,
                                }),
                            );
                        });
                    }
                    Some("guest-gone") => {
                        if let Some(guest_id) = msg.get("guestId").and_then(|v| v.as_u64()) {
                            pending_proofs.remove(&guest_id);
                            guest_picks.remove(&guest_id);
                            if let Some(gs) = guest_streams.lock().await.remove(&guest_id) {
                                *gs.cancel_reason.lock().await =
                                    Some("El receptor se desconectó".to_string());
                                gs.cancelled.store(true, Ordering::SeqCst);
                                gs.notify.notify_waiters();
                            }
                        }
                    }
                    Some("signal") => {
                        let Some(guest_id) = msg.get("from").and_then(|v| v.as_u64()) else {
                            continue;
                        };
                        let Some(raw_data) = msg.get("data") else {
                            continue;
                        };
                        let data: Value = if raw_data.get("type").and_then(|v| v.as_str())
                            == Some("cli-sealed")
                        {
                            if let Some(b) = raw_data.get("box").and_then(|v| v.as_str())
                                && let Ok(v) = unseal_frame(b, &key)
                            {
                                v
                            } else {
                                continue;
                            }
                        } else {
                            raw_data.clone()
                        };

                        match data.get("type").and_then(|v| v.as_str()) {
                            Some("cli-proof") => {
                                let Some(nonce) = pending_proofs.remove(&guest_id) else {
                                    continue;
                                };
                                let v_opt = data.get("v").and_then(|v| v.as_u64());
                                if v_opt != Some(PROTOCOL_VERSION as u64) {
                                    println!(
                                        "\n  {YELLOW}Receptor ({guest_id}) rechazado: protocolo incompatible. Pídele que ejecute drop update.{RESET}\n"
                                    );
                                    let _ = ws_sender.send_signal(
                                        Some(guest_id),
                                        &json!({
                                            "type": "cli-denied",
                                            "reason": "VERSION",
                                            "v": PROTOCOL_VERSION,
                                        }),
                                    );
                                    continue;
                                }
                                let proof = data.get("proof").and_then(|v| v.as_str()).unwrap_or("");
                                if !verify_proof(&key, &nonce, proof) {
                                    println!(
                                        "\n  {YELLOW}Receptor ({guest_id}) rechazado: el código no coincide.{RESET}\n"
                                    );
                                    ws_sender.report_bad_guest(guest_id);
                                    continue;
                                }

                                let gate = Arc::clone(&peer_gate);
                                let ws = ws_sender.clone();
                                let items = Arc::clone(&items_arc);
                                let sas_clone = sas.clone();
                                tokio::spawn(async move {
                                    let ok = gate(PeerInfo {
                                        who: format!("receptor {guest_id}"),
                                        address: format!("relay #{guest_id}"),
                                        sas: sas_clone,
                                        path: "relay por servidor, cifrado extremo a extremo"
                                            .to_string(),
                                    })
                                    .await;
                                    if !ok {
                                        let _ = ws.send_signal(
                                            Some(guest_id),
                                            &json!({ "type": "cli-denied" }),
                                        );
                                        return;
                                    }
                                    let manifest: Vec<Value> = items
                                        .iter()
                                        .map(|it| {
                                            let mut m = json!({
                                                "name": it.entry.name,
                                                "size": it.entry.size,
                                                "type": "application/octet-stream",
                                            });
                                            if let Some(p) = &it.entry.path {
                                                m["path"] = json!(p);
                                            }
                                            m
                                        })
                                        .collect();
                                    let _ = ws.send_signal(
                                        Some(guest_id),
                                        &seal_frame(
                                            &json!({
                                                "type": "cli-manifest",
                                                "v": PROTOCOL_VERSION,
                                                "manifest": manifest,
                                            }),
                                            &key,
                                        ),
                                    );
                                });
                            }
                            Some("cli-accept") => {
                                if !sender_state.accepting_peers() {
                                    continue;
                                }
                                let req_files: Option<Vec<i64>> = data
                                    .get("files")
                                    .and_then(|v| v.as_array())
                                    .map(|a| a.iter().filter_map(|x| x.as_i64()).collect());
                                let picked = picked_files(req_files.as_deref(), items_arc.len());
                                guest_picks.insert(guest_id, picked.clone());

                                let mut resume_map = HashMap::new();
                                if let Some(arr) = data.get("resume").and_then(|v| v.as_array()) {
                                    for r in arr {
                                        if let Some(idx) = r.get("index").and_then(|x| x.as_u64()) {
                                            resume_map.insert(idx as usize, r.clone());
                                        }
                                    }
                                }

                                let selected_indices: Vec<usize> = match picked {
                                    Some(p) => p,
                                    None => (0..items_arc.len()).collect(),
                                };
                                spawn_relay_guest_stream(
                                    guest_id,
                                    &selected_indices,
                                    resume_map,
                                    &items_arc,
                                    key,
                                    options.limit,
                                    ws_sender,
                                    &guest_streams,
                                    &sender_state,
                                )
                                .await;
                            }
                            Some("cli-retry") => {
                                if !sender_state.accepting_peers() {
                                    continue;
                                }
                                let retry_idx = data
                                    .get("index")
                                    .and_then(|v| v.as_u64())
                                    .unwrap_or(0) as usize;
                                let picked = guest_picks.get(&guest_id).cloned().flatten();
                                let selected_indices: Vec<usize> = match picked {
                                    Some(p) => p.into_iter().filter(|&i| i >= retry_idx).collect(),
                                    None => (retry_idx..items_arc.len()).collect(),
                                };
                                spawn_relay_guest_stream(
                                    guest_id,
                                    &selected_indices,
                                    HashMap::new(),
                                    &items_arc,
                                    key,
                                    options.limit,
                                    ws_sender,
                                    &guest_streams,
                                    &sender_state,
                                )
                                .await;
                            }
                            Some("cli-ack") => {
                                if let Some(bytes) = data.get("bytes").and_then(|v| v.as_u64())
                                    && let Some(gs) = guest_streams.lock().await.get(&guest_id).cloned()
                                {
                                    let prev = gs.acked.fetch_max(bytes, Ordering::SeqCst);
                                    if bytes > prev {
                                        gs.last_progress_ms.store(now_epoch_ms(), Ordering::SeqCst);
                                    }
                                    gs.notify.notify_waiters();
                                }
                            }
                            Some("cli-complete") => {
                                if let Some(gs) = guest_streams.lock().await.get(&guest_id).cloned() {
                                    gs.completed.store(true, Ordering::SeqCst);
                                    gs.notify.notify_waiters();
                                }
                            }
                            Some("cli-error") => {
                                let m = data
                                    .get("message")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("El receptor canceló la transferencia.")
                                    .to_string();
                                if let Some(gs) = guest_streams.lock().await.get(&guest_id).cloned() {
                                    *gs.cancel_reason.lock().await = Some(m);
                                    gs.cancelled.store(true, Ordering::SeqCst);
                                    gs.notify.notify_waiters();
                                }
                            }
                            _ => {}
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    // Limpieza ordenada de recursos
    if let Some(mut b) = broadcaster {
        b.stop();
    }
    if let Some(ws) = ws_sender_opt {
        ws.close();
    }
    if let Some(m) = upnp_mapping_slot.lock().await.take() {
        let _ = timeout(Duration::from_secs(2), m.unmap()).await;
    }
    if let Some(d) = temp_dir {
        let _ = std::fs::remove_dir_all(d);
    }

    if sender_state.stdin_failed.load(Ordering::SeqCst) {
        1
    } else {
        0
    }
}

#[allow(clippy::too_many_arguments)]
async fn spawn_relay_guest_stream(
    guest_id: u64,
    selected_indices: &[usize],
    resume_map: HashMap<usize, Value>,
    items_arc: &Arc<Vec<SendItem>>,
    key: [u8; 32],
    limit: u64,
    ws_sender: &SignalingSender,
    guest_streams: &Arc<Mutex<HashMap<u64, Arc<GuestStream>>>>,
    sender_state: &Arc<SenderState>,
) {
    println!(
        "\n  {BOLD}Receptor conectado ({guest_id}):{RESET} {CYAN}[MODO STREAMING RELAY]{RESET}\n"
    );
    if selected_indices.len() < items_arc.len() {
        println!(
            "  {DIM}Ha pedido {} de {} archivos.{RESET}",
            selected_indices.len(),
            items_arc.len()
        );
    }

    let gs = Arc::new(GuestStream::new());
    if let Some(prev) = guest_streams.lock().await.insert(guest_id, Arc::clone(&gs)) {
        *prev.cancel_reason.lock().await = Some("Reiniciado por cli-retry".to_string());
        prev.cancelled.store(true, Ordering::SeqCst);
        prev.notify.notify_waiters();
    }

    sender_state.in_flight.fetch_add(1, Ordering::SeqCst);
    let had_stdin = if sender_state.from_stdin {
        sender_state.stdin_spent.store(true, Ordering::SeqCst);
        true
    } else {
        false
    };

    let items = Arc::clone(items_arc);
    let indices = selected_indices.to_vec();
    let ws = ws_sender.clone();
    let streams = Arc::clone(guest_streams);
    let st = Arc::clone(sender_state);
    let seen_set: HashSet<usize> = indices.iter().copied().collect();
    let _ = seen_set;

    tokio::spawn(async move {
        reset_file_line_state();
        let res = stream_to_web_guest(WebGuestStreamParams {
            guest_id,
            items,
            selected_indices: indices,
            resume_map,
            key,
            limit,
            ws_sender: ws,
            stream_state: Arc::clone(&gs),
            sender_state: Arc::clone(&st),
        })
        .await;
        streams.lock().await.retain(|&id, cur| id != guest_id || !Arc::ptr_eq(cur, &gs));
        let superseded = gs.cancel_reason.lock().await.as_deref() == Some("Reiniciado por cli-retry");
        if superseded {
            st.in_flight.fetch_sub(1, Ordering::SeqCst);
            return;
        }
        match res {
            Ok(stats) => {
                render_progress_bar_complete(stats.total_bytes, stats.total_time_sec, stats.avg_speed, 30);
                println!(
                    "\n  {GREEN}✔ ¡Transferencia completada con éxito para el receptor ({guest_id})!{RESET}"
                );
                if stats.resumed_bytes > 0 {
                    println!(
                        "  {DIM}{} ya estaban en el receptor: no se han vuelto a mandar.{RESET}",
                        fmt_bytes(stats.resumed_bytes)
                    );
                }
                st.finish_peer_ok(false);
                if st.accepting_peers() {
                    println!(
                        "  {DIM}Canal abierto para más descargas. Presiona Ctrl + C para cerrarlo.{RESET}\n"
                    );
                }
            }
            Err(e) => {
                println!("\n\n  {YELLOW}Receptor ({guest_id}) interrumpido: {e}{RESET}");
                st.finish_peer_err(had_stdin);
                if st.accepting_peers() {
                    println!(
                        "  {DIM}Canal abierto. Esperando nuevas conexiones... (Presiona Ctrl + C para salir){RESET}\n"
                    );
                }
            }
        }
    });
}
