// Nucleo de medicion de velocidad P2P (`TcpSpeedChannel`, `RelaySpeedChannel` y `run_speed_test`).

use std::io::Write;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::net::tcp::OwnedWriteHalf;
use tokio::sync::{Mutex, mpsc};
use tokio::task::JoinHandle;
use tokio::time::{sleep, timeout};

use crate::crypto::{decrypt_chunk, derive_key, encrypt_chunk};
use crate::signaling::{SignalingSender, WsEvent};
use crate::ui::{BOLD, CYAN, DIM, GREEN, RESET, fmt_bytes, fmt_ms, fmt_speed};

pub const TCP_CHUNK_SIZE: usize = 256 * 1024;
pub const RELAY_CHUNK_SIZE: usize = 64 * 1024;
pub const DUMMY_BYTE: u8 = 0x5a;
const MAX_SPEED_FRAME_LEN: usize = 16 * 1024 * 1024;
const SPEED_FRAME_CTRL: u8 = 0x00;
const SPEED_FRAME_DATA: u8 = 0x01;

#[derive(Debug, Clone)]
pub struct SpeedResults {
    pub path_desc: String,
    pub rtt_ms: f64,
    pub out_rate: f64,
    pub out_bytes: u64,
    pub out_sec: f64,
    pub in_rate: f64,
    pub in_bytes: u64,
    pub in_sec: f64,
}

pub fn render_speed_bar(
    direction: &str,
    elapsed_sec: f64,
    duration_sec: u64,
    rate_bps: f64,
    bytes: u64,
) {
    let pct = if duration_sec > 0 {
        (elapsed_sec / duration_sec as f64).clamp(0.0, 1.0)
    } else {
        0.0
    };
    let width = 24usize;
    let filled = ((width as f64) * pct).round() as usize;
    let empty = width.saturating_sub(filled);
    let label = if direction == "outbound" {
        "Subida "
    } else {
        "Bajada "
    };
    let bar = format!(
        "{CYAN}{}{DIM}{}{RESET}",
        "█".repeat(filled),
        "░".repeat(empty)
    );
    let mut out = std::io::stdout().lock();
    let _ = write!(
        out,
        "\r  {BOLD}{label}{RESET} {bar} {:>3.0}% · {} · {}   \x1b[K",
        pct * 100.0,
        fmt_speed(rate_bps),
        fmt_bytes(bytes)
    );
    let _ = out.flush();
}

pub fn render_speed_bar_complete(direction: &str, rate_bps: f64, total_bytes: u64, total_sec: f64) {
    let label = if direction == "outbound" {
        "Subida "
    } else {
        "Bajada "
    };
    let bar = format!("{CYAN}{}{RESET}", "█".repeat(24));
    let mut out = std::io::stdout().lock();
    let _ = writeln!(
        out,
        "\r  {BOLD}{label}{RESET} {bar} 100% · {} · {} ({total_sec:.2}s)   \x1b[K",
        fmt_speed(rate_bps),
        fmt_bytes(total_bytes)
    );
    let _ = out.flush();
}

pub fn print_speed_report(res: &SpeedResults) {
    println!("\n{BOLD}================================================================{RESET}");
    println!("  {GREEN}✔ Resultado de la prueba de velocidad{RESET}");
    println!("{BOLD}================================================================{RESET}");
    println!("  {BOLD}Ruta:{RESET}    {}", res.path_desc);
    println!(
        "  {BOLD}Latencia:{RESET} {CYAN}{}{RESET}",
        fmt_ms(Some(res.rtt_ms))
    );
    println!(
        "  {BOLD}Subida:{RESET}   {}  {DIM}({} en {:.2}s){RESET}",
        fmt_speed(res.out_rate),
        fmt_bytes(res.out_bytes),
        res.out_sec
    );
    println!(
        "  {BOLD}Bajada:{RESET}   {}  {DIM}({} en {:.2}s){RESET}",
        fmt_speed(res.in_rate),
        fmt_bytes(res.in_bytes),
        res.in_sec
    );
    println!("{BOLD}================================================================{RESET}\n");
}

struct RxTracker {
    active: AtomicBool,
    bytes: AtomicU64,
    started_at: std::sync::Mutex<Option<Instant>>,
    ended_at: std::sync::Mutex<Option<Instant>>,
    first_byte_at: std::sync::Mutex<Option<Instant>>,
    last_report_at: std::sync::Mutex<Option<Instant>>,
    last_bytes: AtomicU64,
    smoothed_bps: std::sync::Mutex<f64>,
    duration_sec: AtomicU64,
}

impl RxTracker {
    fn new() -> Self {
        Self {
            active: AtomicBool::new(false),
            bytes: AtomicU64::new(0),
            started_at: std::sync::Mutex::new(None),
            ended_at: std::sync::Mutex::new(None),
            first_byte_at: std::sync::Mutex::new(None),
            last_report_at: std::sync::Mutex::new(None),
            last_bytes: AtomicU64::new(0),
            smoothed_bps: std::sync::Mutex::new(0.0),
            duration_sec: AtomicU64::new(5),
        }
    }

    fn begin_receive(&self, duration_sec: u64) {
        self.bytes.store(0, Ordering::SeqCst);
        self.last_bytes.store(0, Ordering::SeqCst);
        self.duration_sec.store(duration_sec, Ordering::SeqCst);
        *self.started_at.lock().expect("lock") = None;
        *self.ended_at.lock().expect("lock") = None;
        *self.first_byte_at.lock().expect("lock") = None;
        *self.last_report_at.lock().expect("lock") = None;
        *self.smoothed_bps.lock().expect("lock") = 0.0;
        self.active.store(true, Ordering::SeqCst);
    }

    fn stop_receive(&self) -> (u64, f64) {
        self.active.store(false, Ordering::SeqCst);
        let bytes = self.bytes.load(Ordering::SeqCst);
        let start = self.first_byte_at.lock().expect("lock").or(*self.started_at.lock().expect("lock"));
        let secs = start
            .map(|s| Instant::now().duration_since(s).as_secs_f64())
            .unwrap_or(0.001)
            .max(0.001);
        (bytes, secs)
    }

    fn record_chunk(&self, len: usize) -> Option<(f64, u64, f64, u64)> {
        if !self.active.load(Ordering::SeqCst) {
            return None;
        }
        let now = Instant::now();
        let total = self.bytes.fetch_add(len as u64, Ordering::SeqCst) + len as u64;
        {
            let mut fb = self.first_byte_at.lock().expect("lock");
            if fb.is_none() {
                *fb = Some(now);
                *self.started_at.lock().expect("lock") = Some(now);
                *self.last_report_at.lock().expect("lock") = Some(now);
                return None;
            }
        }
        let mut last_rep = self.last_report_at.lock().expect("lock");
        let prev = (*last_rep)?;
        let dt = now.duration_since(prev).as_secs_f64();
        if dt < 0.12 {
            return None;
        }
        *last_rep = Some(now);
        drop(last_rep);

        let prev_b = self.last_bytes.swap(total, Ordering::SeqCst);
        let inst_bps = (total.saturating_sub(prev_b) as f64) / dt;
        let smoothed = {
            let mut sm = self.smoothed_bps.lock().expect("lock");
            if *sm == 0.0 {
                *sm = inst_bps;
            } else {
                *sm = 0.35 * inst_bps + 0.65 * *sm;
            }
            *sm
        };
        let elapsed = self
            .first_byte_at
            .lock()
            .expect("lock")
            .map(|s| now.duration_since(s).as_secs_f64())
            .unwrap_or(0.0);
        let dur = self.duration_sec.load(Ordering::SeqCst);
        Some((smoothed, total, elapsed, dur))
    }
}

enum TransportWriter {
    Tcp {
        write_half: Arc<Mutex<OwnedWriteHalf>>,
        key: [u8; 32],
        dummy_frame: Arc<Vec<u8>>,
    },
    Relay {
        ws_sender: SignalingSender,
        guest_id: Option<u64>,
        dummy_pkt: Arc<Vec<u8>>,
    },
}

pub struct SpeedChannel {
    pub path_desc: String,
    pub is_host: bool,
    closed: Arc<AtomicBool>,
    writer: TransportWriter,
    ctrl_rx: mpsc::UnboundedReceiver<Value>,
    queued_ctrl: Vec<Value>,
    rx_tracker: Arc<RxTracker>,
    reader_task: Option<JoinHandle<()>>,
}

impl SpeedChannel {
    pub fn from_tcp(stream: TcpStream, code: &str, is_host: bool, path_desc: impl Into<String>) -> Self {
        let _ = stream.set_nodelay(true);
        let (mut rd, wr) = stream.into_split();
        let key = derive_key(code);
        let write_half = Arc::new(Mutex::new(wr));
        let closed = Arc::new(AtomicBool::new(false));
        let rx_tracker = Arc::new(RxTracker::new());
        let (ctrl_tx, ctrl_rx) = mpsc::unbounded_channel();

        let mut dummy_frame = Vec::with_capacity(5 + TCP_CHUNK_SIZE);
        let frame_len = (1 + TCP_CHUNK_SIZE) as u32;
        dummy_frame.extend_from_slice(&frame_len.to_be_bytes());
        dummy_frame.push(SPEED_FRAME_DATA);
        dummy_frame.resize(5 + TCP_CHUNK_SIZE, DUMMY_BYTE);

        let closed_rd = Arc::clone(&closed);
        let rx_rd = Arc::clone(&rx_tracker);
        let wr_ticks = Arc::clone(&write_half);
        let key_rd = key;

        let reader_task = tokio::spawn(async move {
            let mut len_buf = [0u8; 4];
            let mut body_buf = Vec::with_capacity(TCP_CHUNK_SIZE + 64);
            loop {
                if rd.read_exact(&mut len_buf).await.is_err() {
                    break;
                }
                let frame_len = u32::from_be_bytes(len_buf) as usize;
                if frame_len == 0 || frame_len > MAX_SPEED_FRAME_LEN {
                    break;
                }
                body_buf.resize(frame_len, 0);
                if rd.read_exact(&mut body_buf).await.is_err() {
                    break;
                }
                match body_buf[0] {
                    SPEED_FRAME_CTRL => {
                        if let Ok(plain) = decrypt_chunk(&body_buf[1..], &key_rd)
                            && let Ok(val) = serde_json::from_slice::<Value>(&plain)
                            && ctrl_tx.send(val).is_err()
                        {
                            break;
                        }
                    }
                    SPEED_FRAME_DATA => {
                        let data_len = frame_len - 1;
                        if let Some((rate, total, elapsed, dur)) = rx_rd.record_chunk(data_len) {
                            render_speed_bar("inbound", elapsed, dur, rate, total);
                            let tick = json!({
                                "k": "tick",
                                "rate": rate,
                                "elapsed": elapsed,
                                "bytes": total,
                            });
                            let wr = Arc::clone(&wr_ticks);
                            tokio::spawn(async move {
                                let _ = write_tcp_ctrl(&wr, &key_rd, &tick).await;
                            });
                        }
                    }
                    _ => {}
                }
            }
            closed_rd.store(true, Ordering::SeqCst);
        });

        Self {
            path_desc: path_desc.into(),
            is_host,
            closed,
            writer: TransportWriter::Tcp {
                write_half,
                key,
                dummy_frame: Arc::new(dummy_frame),
            },
            ctrl_rx,
            queued_ctrl: Vec::new(),
            rx_tracker,
            reader_task: Some(reader_task),
        }
    }

    pub fn from_relay(
        ws_sender: SignalingSender,
        mut ws_events: mpsc::UnboundedReceiver<WsEvent>,
        guest_id: Option<u64>,
        is_host: bool,
        path_desc: impl Into<String>,
    ) -> Self {
        let closed = Arc::new(AtomicBool::new(false));
        let rx_tracker = Arc::new(RxTracker::new());
        let (ctrl_tx, ctrl_rx) = mpsc::unbounded_channel();

        let dummy_pkt = if is_host {
            let gid = guest_id.unwrap_or(0) as u32;
            let mut v = Vec::with_capacity(4 + RELAY_CHUNK_SIZE);
            v.extend_from_slice(&gid.to_be_bytes());
            v.resize(4 + RELAY_CHUNK_SIZE, DUMMY_BYTE);
            v
        } else {
            vec![DUMMY_BYTE; RELAY_CHUNK_SIZE]
        };

        let closed_rd = Arc::clone(&closed);
        let rx_rd = Arc::clone(&rx_tracker);
        let ws_ticks = ws_sender.clone();
        let reader_task = tokio::spawn(async move {
            while let Some(ev) = ws_events.recv().await {
                match ev {
                    WsEvent::Closed => break,
                    WsEvent::Json(msg) => {
                        if msg.get("t").and_then(|v| v.as_str()) == Some("signal")
                            && let Some(data) = msg.get("data")
                            && ctrl_tx.send(data.clone()).is_err()
                        {
                            break;
                        }
                    }
                    WsEvent::Binary(bin) => {
                        if let Some((rate, total, elapsed, dur)) = rx_rd.record_chunk(bin.len()) {
                            render_speed_bar("inbound", elapsed, dur, rate, total);
                            let _ = ws_ticks.send_signal(
                                guest_id,
                                &json!({
                                    "k": "tick",
                                    "rate": rate,
                                    "elapsed": elapsed,
                                    "bytes": total,
                                }),
                            );
                        }
                    }
                }
            }
            closed_rd.store(true, Ordering::SeqCst);
        });

        Self {
            path_desc: path_desc.into(),
            is_host,
            closed,
            writer: TransportWriter::Relay {
                ws_sender,
                guest_id,
                dummy_pkt: Arc::new(dummy_pkt),
            },
            ctrl_rx,
            queued_ctrl: Vec::new(),
            rx_tracker,
            reader_task: Some(reader_task),
        }
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    pub async fn send_control(&self, msg: &Value) -> Result<(), String> {
        match &self.writer {
            TransportWriter::Tcp {
                write_half, key, ..
            } => write_tcp_ctrl(write_half, key, msg).await,
            TransportWriter::Relay {
                ws_sender,
                guest_id,
                ..
            } => ws_sender.send_signal(*guest_id, msg),
        }
    }

    pub async fn send_payload(&self) -> bool {
        if self.is_closed() {
            return false;
        }
        match &self.writer {
            TransportWriter::Tcp {
                write_half,
                dummy_frame,
                ..
            } => {
                let mut wr = write_half.lock().await;
                if wr.write_all(dummy_frame).await.is_err() {
                    self.closed.store(true, Ordering::SeqCst);
                    return false;
                }
                true
            }
            TransportWriter::Relay {
                ws_sender,
                dummy_pkt,
                ..
            } => {
                ws_sender.wait_below(512 * 1024).await;
                if ws_sender.send_binary(dummy_pkt.as_ref().clone()).is_err() {
                    self.closed.store(true, Ordering::SeqCst);
                    return false;
                }
                true
            }
        }
    }

    pub async fn drain(&self) {
        match &self.writer {
            TransportWriter::Tcp { write_half, .. } => {
                let mut wr = write_half.lock().await;
                let _ = wr.flush().await;
            }
            TransportWriter::Relay { ws_sender, .. } => {
                ws_sender.drain().await;
            }
        }
    }

    pub fn close(&mut self) {
        self.closed.store(true, Ordering::SeqCst);
        if let Some(h) = self.reader_task.take() {
            h.abort();
        }
        if let TransportWriter::Relay { ws_sender, .. } = &self.writer {
            ws_sender.close();
        }
    }

    /// Lee el siguiente mensaje de control directo que cumpla `pred`,
    /// respondiendo automaticamente `ping`/`tick`/`rtt` intermedios.
    pub async fn wait_control<F>(&mut self, mut pred: F, timeout_ms: u64) -> Result<Value, String>
    where
        F: FnMut(&Value) -> bool,
    {
        if let Some(pos) = self.queued_ctrl.iter().position(&mut pred) {
            return Ok(self.queued_ctrl.remove(pos));
        }

        let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);
        loop {
            let rem = deadline.saturating_duration_since(tokio::time::Instant::now());
            if rem.is_zero() {
                return Err("TIMEOUT_WAITING_CONTROL".to_string());
            }
            match timeout(rem, self.ctrl_rx.recv()).await {
                Ok(Some(msg)) => {
                    match msg.get("k").and_then(|v| v.as_str()) {
                        Some("ping") => {
                            let seq = msg.get("seq").cloned().unwrap_or(json!(0));
                            let _ = self.send_control(&json!({ "k": "pong", "seq": seq })).await;
                            continue;
                        }
                        Some("tick") => {
                            let elapsed = msg.get("elapsed").and_then(|v| v.as_f64()).unwrap_or(0.0);
                            let rate = msg.get("rate").and_then(|v| v.as_f64()).unwrap_or(0.0);
                            let bytes = msg.get("bytes").and_then(|v| v.as_u64()).unwrap_or(0);
                            let dur = self.rx_tracker.duration_sec.load(Ordering::SeqCst);
                            render_speed_bar("outbound", elapsed, dur, rate, bytes);
                            continue;
                        }
                        Some("rtt") => {
                            let ms = msg.get("ms").and_then(|v| v.as_f64());
                            println!(
                                "  {BOLD}Latencia (RTT):{RESET} {CYAN}{}{RESET}\n",
                                fmt_ms(ms)
                            );
                            continue;
                        }
                        _ => {}
                    }
                    if pred(&msg) {
                        return Ok(msg);
                    }
                    self.queued_ctrl.push(msg);
                }
                Ok(None) => return Err("Canal cerrado inesperadamente".to_string()),
                Err(_) => return Err("TIMEOUT_WAITING_CONTROL".to_string()),
            }
        }
    }
}

impl Drop for SpeedChannel {
    fn drop(&mut self) {
        if let Some(h) = self.reader_task.take() {
            h.abort();
        }
    }
}

async fn write_tcp_ctrl(
    write_half: &Arc<Mutex<OwnedWriteHalf>>,
    key: &[u8; 32],
    msg: &Value,
) -> Result<(), String> {
    let raw = serde_json::to_vec(msg).map_err(|e| e.to_string())?;
    let encrypted = encrypt_chunk(&raw, key);
    let len = u32::try_from(1 + encrypted.len()).map_err(|_| "frame too big".to_string())?;
    let mut frame = Vec::with_capacity(5 + encrypted.len());
    frame.extend_from_slice(&len.to_be_bytes());
    frame.push(SPEED_FRAME_CTRL);
    frame.extend_from_slice(&encrypted);

    let mut wr = write_half.lock().await;
    wr.write_all(&frame).await.map_err(|e| e.to_string())
}

async fn stream_phase(
    channel: &mut SpeedChannel,
    dir: &str,
    duration_sec: u64,
) -> Result<(), String> {
    channel
        .send_control(&json!({ "k": "incoming", "dir": dir, "duration": duration_sec }))
        .await?;
    render_speed_bar("outbound", 0.0, duration_sec, 0.0, 0);

    let until = Instant::now() + Duration::from_secs(duration_sec);
    while Instant::now() < until && !channel.is_closed() {
        while let Ok(msg) = channel.ctrl_rx.try_recv() {
            match msg.get("k").and_then(|v| v.as_str()) {
                Some("ping") => {
                    let seq = msg.get("seq").cloned().unwrap_or(json!(0));
                    let _ = channel.send_control(&json!({ "k": "pong", "seq": seq })).await;
                }
                Some("tick") => {
                    let elapsed = msg.get("elapsed").and_then(|v| v.as_f64()).unwrap_or(0.0);
                    let rate = msg.get("rate").and_then(|v| v.as_f64()).unwrap_or(0.0);
                    let bytes = msg.get("bytes").and_then(|v| v.as_u64()).unwrap_or(0);
                    render_speed_bar("outbound", elapsed, duration_sec, rate, bytes);
                }
                _ => channel.queued_ctrl.push(msg),
            }
        }
        if !channel.send_payload().await {
            break;
        }
    }

    channel.drain().await;
    channel
        .send_control(&json!({ "k": "sent-done", "dir": dir }))
        .await
}

/// Ejecuta la prueba de velocidad bidireccional completa (RTT + subida + bajada)
/// sobre un `SpeedChannel` ya conectado.
pub async fn run_speed_test(
    channel: &mut SpeedChannel,
    is_host: bool,
    duration_sec: u64,
) -> Result<SpeedResults, String> {
    channel.rx_tracker.duration_sec.store(duration_sec, Ordering::SeqCst);
    let mut results = SpeedResults {
        path_desc: channel.path_desc.clone(),
        rtt_ms: 0.0,
        out_rate: 0.0,
        out_bytes: 0,
        out_sec: 0.0,
        in_rate: 0.0,
        in_bytes: 0,
        in_sec: 0.0,
    };

    if is_host {
        let mut out = std::io::stdout().lock();
        let _ = write!(out, "  {DIM}Midiendo latencia de red (RTT)...{RESET}");
        let _ = out.flush();
        drop(out);

        let mut rtts = Vec::with_capacity(10);
        for seq in 0u64..10 {
            let t0 = Instant::now();
            channel.send_control(&json!({ "k": "ping", "seq": seq })).await?;
            if channel
                .wait_control(
                    |m| m.get("k").and_then(|v| v.as_str()) == Some("pong")
                        && m.get("seq").and_then(|v| v.as_u64()) == Some(seq),
                    1000,
                )
                .await
                .is_ok()
            {
                rtts.push(t0.elapsed().as_secs_f64() * 1000.0);
            }
            sleep(Duration::from_millis(25)).await;
        }

        let min_rtt = rtts.into_iter().fold(f64::INFINITY, f64::min);
        let min_rtt = if min_rtt.is_finite() { min_rtt } else { 1.0 };
        results.rtt_ms = min_rtt;
        channel.send_control(&json!({ "k": "rtt", "ms": min_rtt })).await?;
        println!(
            "\r  {BOLD}Latencia (RTT):{RESET} {CYAN}{}{RESET}   \x1b[K\n",
            fmt_ms(Some(min_rtt))
        );

        // Fase 1: Host emite (h2g)
        stream_phase(channel, "h2g", duration_sec).await?;
        let h2g = channel
            .wait_control(
                |m| m.get("k").and_then(|v| v.as_str()) == Some("result")
                    && m.get("dir").and_then(|v| v.as_str()) == Some("h2g"),
                30_000,
            )
            .await?;
        results.out_rate = h2g.get("rate").and_then(|v| v.as_f64()).unwrap_or(0.0);
        results.out_bytes = h2g.get("bytes").and_then(|v| v.as_u64()).unwrap_or(0);
        results.out_sec = h2g.get("duration").and_then(|v| v.as_f64()).unwrap_or(1.0);
        render_speed_bar_complete("outbound", results.out_rate, results.out_bytes, results.out_sec);

        // Fase 2: Guest emite (g2h)
        channel.rx_tracker.begin_receive(duration_sec);
        render_speed_bar("inbound", 0.0, duration_sec, 0.0, 0);
        channel.send_control(&json!({ "k": "start-phase2" })).await?;

        channel
            .wait_control(
                |m| m.get("k").and_then(|v| v.as_str()) == Some("sent-done")
                    && m.get("dir").and_then(|v| v.as_str()) == Some("g2h"),
                30_000,
            )
            .await?;
        let (rx_bytes, rx_sec) = channel.rx_tracker.stop_receive();
        let avg_rate = (rx_bytes as f64) / rx_sec;
        results.in_rate = avg_rate;
        results.in_bytes = rx_bytes;
        results.in_sec = rx_sec;
        channel
            .send_control(&json!({
                "k": "result",
                "dir": "g2h",
                "rate": avg_rate,
                "bytes": rx_bytes,
                "duration": rx_sec,
            }))
            .await?;
        render_speed_bar_complete("inbound", avg_rate, rx_bytes, rx_sec);

        sleep(Duration::from_millis(50)).await;
        channel.send_control(&json!({ "k": "finished" })).await?;
    } else {
        // Guest espera pings/rtt hasta incoming h2g
        channel
            .wait_control(
                |m| m.get("k").and_then(|v| v.as_str()) == Some("incoming")
                    && m.get("dir").and_then(|v| v.as_str()) == Some("h2g"),
                30_000,
            )
            .await?;
        channel.rx_tracker.begin_receive(duration_sec);
        render_speed_bar("inbound", 0.0, duration_sec, 0.0, 0);

        channel
            .wait_control(
                |m| m.get("k").and_then(|v| v.as_str()) == Some("sent-done")
                    && m.get("dir").and_then(|v| v.as_str()) == Some("h2g"),
                30_000,
            )
            .await?;
        let (rx_bytes, rx_sec) = channel.rx_tracker.stop_receive();
        let avg_rate = (rx_bytes as f64) / rx_sec;
        results.in_rate = avg_rate;
        results.in_bytes = rx_bytes;
        results.in_sec = rx_sec;
        channel
            .send_control(&json!({
                "k": "result",
                "dir": "h2g",
                "rate": avg_rate,
                "bytes": rx_bytes,
                "duration": rx_sec,
            }))
            .await?;
        render_speed_bar_complete("inbound", avg_rate, rx_bytes, rx_sec);

        channel
            .wait_control(|m| m.get("k").and_then(|v| v.as_str()) == Some("start-phase2"), 30_000)
            .await?;
        stream_phase(channel, "g2h", duration_sec).await?;
        let g2h = channel
            .wait_control(
                |m| m.get("k").and_then(|v| v.as_str()) == Some("result")
                    && m.get("dir").and_then(|v| v.as_str()) == Some("g2h"),
                30_000,
            )
            .await?;
        results.out_rate = g2h.get("rate").and_then(|v| v.as_f64()).unwrap_or(0.0);
        results.out_bytes = g2h.get("bytes").and_then(|v| v.as_u64()).unwrap_or(0);
        results.out_sec = g2h.get("duration").and_then(|v| v.as_f64()).unwrap_or(1.0);
        render_speed_bar_complete("outbound", results.out_rate, results.out_bytes, results.out_sec);

        channel
            .wait_control(|m| m.get("k").and_then(|v| v.as_str()) == Some("finished"), 30_000)
            .await?;
    }

    print_speed_report(&results);
    Ok(results)
}
