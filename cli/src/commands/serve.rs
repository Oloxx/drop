// Servidor HTTP de web estática + señalización/relay WebSocket (`drop serve`).

use std::collections::{HashMap, HashSet, VecDeque};
use std::env;
use std::io::{self, Write};
use std::net::{IpAddr, SocketAddr};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use futures_util::{SinkExt, StreamExt};
use hmac::{Hmac, Mac};
use rand::RngCore;
use rand::rngs::OsRng;
use serde_json::{Value, json};
use sha1::Sha1;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{Notify, watch};
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::{WebSocketStream, accept_hdr_async_with_config};
use url::Url;

use crate::cli::VERSION;
use crate::discovery::{get_local_ips, get_local_ipv6s, plain_address};
use crate::listen::{ListenError, listen_on_addr};
use crate::shared::codes::ROOM_ID_DIGITS;
use crate::throttle::parse_rate;
use crate::ui::{CYAN, DIM, GREEN, RED, RESET, YELLOW};

include!(concat!(env!("OUT_DIR"), "/embedded_public.rs"));

const MAX_HTTP_HEAD_BYTES: usize = 16 * 1024;
const MAX_WS_PAYLOAD: usize = 256 * 1024;
const LINK_TOKEN_BYTES: usize = 12;
const JOIN_FAIL_MAX: u32 = 20;
const JOIN_FAIL_WINDOW: Duration = Duration::from_secs(60);
const BAD_GUEST_MAX: u32 = 5;
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);
const OUTBOUND_QUEUE_CAP: usize = 512;

const CSP_HEADER: &str = "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'";

pub struct RunningServer {
    pub addr: SocketAddr,
    shutdown_tx: watch::Sender<bool>,
    task: JoinHandle<()>,
}

impl RunningServer {
    pub async fn shutdown(self) {
        let _ = self.shutdown_tx.send(true);
        let _ = self.task.await;
    }
}

struct ServerConfig {
    room_rate_max: u32,
    room_rate_window: Duration,
    max_guests: usize,
    max_rooms: usize,
    room_ttl: Duration,
    room_sweep: Duration,
    msg_burst: f64,
    msg_rate: f64,
    relay_limit: u64,
    relay_limit_total: u64,
    turn_url: Option<String>,
    turn_secret: Option<String>,
    turn_ttl_secs: u64,
    allowed_origins: HashSet<String>,
    origin_any: bool,
    custom_origins_only: bool,
    trusted_proxies: Vec<CidrRule>,
    commit: Option<String>,
}

impl ServerConfig {
    fn from_env(port: u16) -> Self {
        let env_u64 = |name: &str, fallback: u64| -> u64 {
            env::var(name)
                .ok()
                .and_then(|s| s.trim().parse::<f64>().ok())
                .filter(|n| n.is_finite() && *n > 0.0)
                .map(|n| n.round() as u64)
                .unwrap_or(fallback)
        };
        let env_rate = |name: &str| -> u64 {
            env::var(name)
                .ok()
                .and_then(|s| parse_rate(&s).ok())
                .unwrap_or(0)
        };

        let custom_origins_env = env::var("DROP_ALLOWED_ORIGINS")
            .ok()
            .filter(|s| !s.trim().is_empty());
        let custom_origins_only = custom_origins_env.is_some();
        let mut allowed_origins = HashSet::new();
        if let Some(raw) = custom_origins_env {
            for part in raw.split(',') {
                let norm = norm_origin(part);
                if !norm.is_empty() {
                    allowed_origins.insert(norm);
                }
            }
        } else {
            allowed_origins.insert("https://drop.oloxx.dev".to_string());
            if let Ok(domain) = env::var("DROP_DOMAIN") {
                let d = domain.trim();
                if !d.is_empty() {
                    allowed_origins.insert(norm_origin(&format!("https://{d}")));
                }
            }
            allowed_origins.insert(format!("http://localhost:{port}"));
            allowed_origins.insert(format!("http://127.0.0.1:{port}"));
            allowed_origins.insert(format!("http://[::1]:{port}"));
        }
        let origin_any = allowed_origins.contains("*");

        let trust_proxy_raw = env::var("DROP_TRUST_PROXY")
            .unwrap_or_default()
            .trim()
            .to_string();
        let trusted_proxies = compile_cidr_rules(&trust_proxy_raw);

        let turn_url = env::var("TURN_URL").ok().filter(|s| !s.trim().is_empty());
        let turn_secret = env::var("TURN_SECRET").ok().filter(|s| !s.trim().is_empty());

        let commit = env::var("DROP_COMMIT")
            .ok()
            .filter(|s| is_valid_commit_sha(s));

        Self {
            room_rate_max: env_u64("DROP_ROOM_RATE_MAX", 30) as u32,
            room_rate_window: Duration::from_millis(env_u64("DROP_ROOM_RATE_WINDOW_MS", 60_000)),
            max_guests: env_u64("DROP_MAX_GUESTS", 25) as usize,
            max_rooms: env_u64("DROP_MAX_ROOMS", 5000) as usize,
            room_ttl: Duration::from_millis(env_u64("DROP_ROOM_TTL_MS", 30 * 60_000)),
            room_sweep: Duration::from_millis(env_u64("DROP_ROOM_SWEEP_MS", 60_000)),
            msg_burst: env_u64("DROP_MSG_BURST", 300) as f64,
            msg_rate: env_u64("DROP_MSG_RATE", 100) as f64,
            relay_limit: env_rate("DROP_RELAY_LIMIT"),
            relay_limit_total: env_rate("DROP_RELAY_LIMIT_TOTAL"),
            turn_url,
            turn_secret,
            turn_ttl_secs: env_u64("TURN_TTL_SECONDS", 12 * 3600),
            allowed_origins,
            origin_any,
            custom_origins_only,
            trusted_proxies,
            commit,
        }
    }

    fn origin_allowed(&self, origin: Option<&str>, req_host: Option<&str>) -> bool {
        let Some(raw) = origin.map(str::trim).filter(|s| !s.is_empty()) else {
            return true;
        };
        if self.origin_any {
            return true;
        }
        let norm = norm_origin(raw);
        if self.allowed_origins.contains(&norm) {
            return true;
        }
        if self.custom_origins_only {
            return false;
        }
        // En red local (`http://192.168.x.x:3000`) o detras de un proxy TLS propio,
        // el navegador manda `Origin` del mismo host que `Host` de la peticion.
        same_origin_as_host(raw, req_host)
    }
}

fn norm_origin(raw: &str) -> String {
    raw.trim()
        .to_ascii_lowercase()
        .trim_end_matches('/')
        .to_string()
}

fn same_origin_as_host(origin: &str, req_host: Option<&str>) -> bool {
    let Some(host_hdr) = req_host.map(str::trim).filter(|s| !s.is_empty()) else {
        return false;
    };
    let Ok(url) = Url::parse(origin) else {
        return false;
    };
    let scheme = url.scheme();
    if scheme != "http" && scheme != "https" {
        return false;
    }
    let Some(origin_host) = url.host_str() else {
        return false;
    };
    let origin_authority = match url.port() {
        Some(p) => format!("{origin_host}:{p}"),
        None => origin_host.to_string(),
    };
    let hdr_lower = host_hdr.to_ascii_lowercase();
    if origin_authority.eq_ignore_ascii_case(&hdr_lower) {
        return true;
    }
    if url.port().is_none() {
        let default_port = if scheme == "https" { 443 } else { 80 };
        return format!("{origin_host}:{default_port}").eq_ignore_ascii_case(&hdr_lower);
    }
    false
}

fn is_valid_commit_sha(s: &str) -> bool {
    s.len() == 40 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

#[derive(Clone, Copy)]
enum CidrRule {
    V4 { net: u32, mask: u32 },
    V6 { net: u128, mask: u128 },
}

impl CidrRule {
    fn matches(&self, ip: IpAddr) -> bool {
        match (*self, ip) {
            (CidrRule::V4 { net, mask }, IpAddr::V4(v4)) => (u32::from(v4) & mask) == net,
            (CidrRule::V6 { net, mask }, IpAddr::V6(v6)) => (u128::from(v6) & mask) == net,
            _ => false,
        }
    }
}

fn compile_cidr_rules(spec: &str) -> Vec<CidrRule> {
    let mut expanded = Vec::new();
    for token in spec.split(|c: char| c.is_whitespace() || c == ',') {
        let t = token.trim();
        if t.is_empty() {
            continue;
        }
        match t.to_ascii_lowercase().as_str() {
            "loopback" => {
                expanded.push("127.0.0.0/8");
                expanded.push("::1/128");
            }
            "private" | "uniquelocal" => {
                expanded.push("10.0.0.0/8");
                expanded.push("172.16.0.0/12");
                expanded.push("192.168.0.0/16");
                expanded.push("fc00::/7");
                expanded.push("fe80::/10");
            }
            _ => expanded.push(t),
        }
    }

    let mut rules = Vec::new();
    for entry in expanded {
        let (addr_raw, prefix_raw) = match entry.split_once('/') {
            Some((a, p)) => (a, Some(p)),
            None => (entry, None),
        };
        let Some(ip) = normalize_ip(addr_raw) else {
            continue;
        };
        match ip {
            IpAddr::V4(v4) => {
                let prefix = match prefix_raw {
                    Some(p) => match p.parse::<u32>() {
                        Ok(n) if n <= 32 => n,
                        _ => continue,
                    },
                    None => 32,
                };
                let mask = if prefix == 0 {
                    0
                } else {
                    !0u32 << (32 - prefix)
                };
                rules.push(CidrRule::V4 {
                    net: u32::from(v4) & mask,
                    mask,
                });
            }
            IpAddr::V6(v6) => {
                let prefix = match prefix_raw {
                    Some(p) => match p.parse::<u32>() {
                        Ok(n) if n <= 128 => n,
                        _ => continue,
                    },
                    None => 128,
                };
                let mask = if prefix == 0 {
                    0
                } else {
                    !0u128 << (128 - prefix)
                };
                rules.push(CidrRule::V6 {
                    net: u128::from(v6) & mask,
                    mask,
                });
            }
        }
    }
    rules
}

fn normalize_ip(raw: &str) -> Option<IpAddr> {
    let mut s = raw.trim();
    if s.is_empty() {
        return None;
    }
    if let Some(inner) = s.strip_prefix('[').and_then(|v| v.strip_suffix(']')) {
        s = inner;
    }
    if let Some(zone) = s.split('%').next() {
        s = zone;
    }
    let mapped = plain_address(s);
    match mapped.parse::<IpAddr>() {
        Ok(IpAddr::V6(v6)) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                Some(IpAddr::V4(v4))
            } else {
                Some(IpAddr::V6(v6))
            }
        }
        Ok(IpAddr::V4(v4)) => Some(IpAddr::V4(v4)),
        Err(_) => None,
    }
}

fn resolve_client_ip(peer_ip: IpAddr, xff: Option<&str>, trusted: &[CidrRule]) -> String {
    let normalized_peer = match peer_ip {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map(IpAddr::V4).unwrap_or(IpAddr::V6(v6)),
        v4 => v4,
    };
    let is_trusted = |ip: IpAddr| trusted.iter().any(|r| r.matches(ip));
    if trusted.is_empty() || !is_trusted(normalized_peer) {
        return normalized_peer.to_string();
    }
    if let Some(raw_xff) = xff {
        let hops: Vec<IpAddr> = raw_xff.split(',').filter_map(normalize_ip).collect();
        for hop in hops.iter().rev() {
            if !is_trusted(*hop) {
                return hop.to_string();
            }
        }
        if let Some(first) = hops.first() {
            return first.to_string();
        }
    }
    normalized_peer.to_string()
}

struct RelayBucket {
    rate: f64,
    tokens: f64,
    at: Instant,
}

impl RelayBucket {
    fn new(bytes_per_sec: u64) -> Self {
        let r = bytes_per_sec as f64;
        Self {
            rate: r,
            tokens: r,
            at: Instant::now(),
        }
    }

    fn drain(&mut self, bytes: usize) -> u64 {
        let now = Instant::now();
        let elapsed = now.duration_since(self.at).as_secs_f64();
        self.tokens = self.rate.min(self.tokens + elapsed * self.rate);
        self.at = now;
        self.tokens -= bytes as f64;
        if self.tokens < 0.0 {
            ((-self.tokens / self.rate) * 1000.0).ceil() as u64
        } else {
            0
        }
    }
}

#[derive(Clone)]
enum ClientEvent {
    Send(Message),
    Close,
}

struct QueueInner {
    queue: VecDeque<ClientEvent>,
    binary_len: usize,
    closed: bool,
}

/// Cola de salida FIFO por cliente WebSocket.
///
/// A diferencia de un unico `mpsc` acotado, `binary_len` limita exclusivamente
/// los frames binarios (`OUTBOUND_QUEUE_CAP`) mientras los mensajes de control y
/// cierre se encolan sin descartes al final de la misma `VecDeque`, preservando
/// siempre el orden estricto (`cli-start` -> datos -> `cli-end` -> `cli-done` -> `guest-gone`).
#[derive(Clone)]
struct ClientTx {
    inner: Arc<Mutex<QueueInner>>,
    notify_rx: Arc<Notify>,
    notify_space: Arc<Notify>,
}

impl ClientTx {
    fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(QueueInner {
                queue: VecDeque::new(),
                binary_len: 0,
                closed: false,
            })),
            notify_rx: Arc::new(Notify::new()),
            notify_space: Arc::new(Notify::new()),
        }
    }

    fn send_ctrl_msg(&self, msg: Message) {
        let mut guard = self.inner.lock().expect("queue poisoned");
        if guard.closed {
            return;
        }
        guard.queue.push_back(ClientEvent::Send(msg));
        self.notify_rx.notify_one();
    }

    fn send_ctrl_json(&self, val: &Value) {
        self.send_ctrl_msg(Message::Text(val.to_string().into()));
    }

    fn close(&self) {
        let mut guard = self.inner.lock().expect("queue poisoned");
        if guard.closed {
            return;
        }
        guard.closed = true;
        guard.queue.push_back(ClientEvent::Close);
        self.notify_rx.notify_one();
        self.notify_space.notify_waiters();
    }

    fn mark_dropped(&self) {
        let mut guard = self.inner.lock().expect("queue poisoned");
        guard.closed = true;
        guard.queue.clear();
        guard.binary_len = 0;
        self.notify_rx.notify_one();
        self.notify_space.notify_waiters();
    }

    async fn send_binary(&self, payload: Vec<u8>) {
        loop {
            let notified = self.notify_space.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            {
                let mut guard = self.inner.lock().expect("queue poisoned");
                if guard.closed {
                    return;
                }
                if guard.binary_len < OUTBOUND_QUEUE_CAP {
                    guard.binary_len += 1;
                    guard
                        .queue
                        .push_back(ClientEvent::Send(Message::Binary(payload.into())));
                    self.notify_rx.notify_one();
                    return;
                }
            }
            notified.await;
        }
    }

    async fn recv(&self) -> Option<ClientEvent> {
        loop {
            let notified = self.notify_rx.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            {
                let mut guard = self.inner.lock().expect("queue poisoned");
                if let Some(ev) = guard.queue.pop_front() {
                    if matches!(&ev, ClientEvent::Send(Message::Binary(_))) {
                        guard.binary_len = guard.binary_len.saturating_sub(1);
                        self.notify_space.notify_one();
                    }
                    return Some(ev);
                }
                if guard.closed {
                    return None;
                }
            }
            notified.await;
        }
    }
}

struct PeerHandle {
    conn_id: u64,
    tx: ClientTx,
}

struct Room {
    host: PeerHandle,
    guests: HashMap<u32, PeerHandle>,
    last_activity: Instant,
    bad_guests: u32,
    relay: Option<RelayBucket>,
}

struct RateEntry {
    count: u32,
    since: Instant,
}

struct Metrics {
    started_at: Instant,
    rooms_opened: u64,
    relay_bytes: u64,
    relay_frames: u64,
    relay_throttled: u64,
    rejected: HashMap<String, u64>,
}

impl Metrics {
    fn reject(&mut self, reason: &str) {
        *self.rejected.entry(reason.to_string()).or_insert(0) += 1;
    }
}

struct InnerState {
    rooms: HashMap<String, Room>,
    next_guest_id: u32,
    join_fails: HashMap<String, RateEntry>,
    rooms_per_ip: HashMap<String, RateEntry>,
    relay_total: Option<RelayBucket>,
    metrics: Metrics,
}

struct ServerState {
    config: ServerConfig,
    next_conn_id: AtomicU64,
    inner: Mutex<InnerState>,
    live_sockets: Mutex<HashMap<u64, LiveSocket>>,
}

struct LiveSocket {
    is_alive: Arc<AtomicBool>,
    tx: ClientTx,
}

impl ServerState {
    fn new(config: ServerConfig) -> Self {
        let relay_total = (config.relay_limit_total > 0)
            .then(|| RelayBucket::new(config.relay_limit_total));
        Self {
            config,
            next_conn_id: AtomicU64::new(1),
            inner: Mutex::new(InnerState {
                rooms: HashMap::new(),
                next_guest_id: 1,
                join_fails: HashMap::new(),
                rooms_per_ip: HashMap::new(),
                relay_total,
                metrics: Metrics {
                    started_at: Instant::now(),
                    rooms_opened: 0,
                    relay_bytes: 0,
                    relay_frames: 0,
                    relay_throttled: 0,
                    rejected: HashMap::new(),
                },
            }),
            live_sockets: Mutex::new(HashMap::new()),
        }
    }

    fn health_json(&self) -> Value {
        let guard = self.inner.lock().expect("state poisoned");
        let guests: usize = guard.rooms.values().map(|r| r.guests.len()).sum();
        json!({
            "ok": true,
            "rooms": guard.rooms.len(),
            "guests": guests,
            "uptime": guard.metrics.started_at.elapsed().as_secs(),
            "roomsOpened": guard.metrics.rooms_opened,
            "relay": {
                "bytes": guard.metrics.relay_bytes,
                "frames": guard.metrics.relay_frames,
                "throttled": guard.metrics.relay_throttled,
                "limit": self.config.relay_limit,
                "limitTotal": self.config.relay_limit_total,
            },
            "rejected": guard.metrics.rejected,
        })
    }

    fn config_json(&self) -> Value {
        let mut ice_servers = vec![json!({
            "urls": [
                "stun:stun.l.google.com:19302",
                "stun:stun1.l.google.com:19302",
                "stun:stun.cloudflare.com:3478"
            ]
        })];
        if let (Some(url), Some(secret)) = (&self.config.turn_url, &self.config.turn_secret) {
            let now_secs = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            let username = format!("{}:drop", now_secs + self.config.turn_ttl_secs);
            let mut mac = Hmac::<Sha1>::new_from_slice(secret.as_bytes()).expect("hmac key");
            mac.update(username.as_bytes());
            let credential = STANDARD.encode(mac.finalize().into_bytes());
            ice_servers.push(json!({
                "urls": url,
                "username": username,
                "credential": credential,
            }));
        }
        json!({
            "iceServers": ice_servers,
            "ttl": self.config.turn_ttl_secs,
        })
    }

    fn version_json(&self) -> Value {
        json!({
            "version": VERSION,
            "commit": self.config.commit,
        })
    }
}

fn send_json(tx: &ClientTx, val: &Value) {
    tx.send_ctrl_json(val);
}

fn close_socket(tx: &ClientTx) {
    tx.close();
}

fn close_room_in_state(
    inner: &mut InnerState,
    token: &str,
    reason: &str,
    hang_up: bool,
) {
    let Some(room) = inner.rooms.remove(token) else {
        return;
    };
    let host_gone = json!({ "t": "host-gone" });
    for guest in room.guests.values() {
        send_json(&guest.tx, &host_gone);
        if hang_up {
            close_socket(&guest.tx);
        }
    }
    send_json(&room.host.tx, &json!({ "t": "error", "reason": reason }));
    if hang_up {
        close_socket(&room.host.tx);
    }
}

fn random_room_id(rooms: &HashMap<String, Room>, link: bool) -> Option<String> {
    let mut buf = [0u8; LINK_TOKEN_BYTES];
    for _ in 0..200 {
        let id = if link {
            OsRng.fill_bytes(&mut buf);
            URL_SAFE_NO_PAD.encode(buf)
        } else {
            let max_unbiased = u32::MAX - (u32::MAX % 10_000);
            let n = loop {
                let candidate = OsRng.next_u32();
                if candidate < max_unbiased {
                    break candidate % 10_000;
                }
            };
            format!("{n:0width$}", width = ROOM_ID_DIGITS)
        };
        if !rooms.contains_key(&id) {
            return Some(id);
        }
    }
    None
}

fn rate_exceeded(map: &HashMap<String, RateEntry>, ip: &str, max: u32, window: Duration) -> bool {
    if ip.is_empty() {
        return false;
    }
    let Some(entry) = map.get(ip) else {
        return false;
    };
    if entry.since.elapsed() > window {
        return false;
    }
    entry.count >= max
}

fn note_rate(map: &mut HashMap<String, RateEntry>, ip: &str, window: Duration) {
    if ip.is_empty() {
        return;
    }
    let now = Instant::now();
    match map.get_mut(ip) {
        Some(entry) if now.duration_since(entry.since) <= window => {
            entry.count = entry.count.saturating_add(1);
        }
        _ => {
            map.insert(ip.to_string(), RateEntry { count: 1, since: now });
        }
    }
}

#[derive(Clone)]
enum WsRole {
    None,
    Host { token: String },
    Guest { token: String, guest_id: u32 },
}

struct ControlBucket {
    tokens: f64,
    at: Instant,
    burst: f64,
    rate: f64,
}

impl ControlBucket {
    fn new(burst: f64, rate: f64) -> Self {
        Self {
            tokens: burst,
            at: Instant::now(),
            burst,
            rate,
        }
    }

    fn take(&mut self) -> bool {
        let now = Instant::now();
        let elapsed = now.duration_since(self.at).as_secs_f64();
        self.tokens = self.burst.min(self.tokens + elapsed * self.rate);
        self.at = now;
        if self.tokens < 1.0 {
            return false;
        }
        self.tokens -= 1.0;
        true
    }
}

struct PrefixedStream<S> {
    prefix: Vec<u8>,
    pos: usize,
    inner: S,
}

impl<S: AsyncRead + Unpin> AsyncRead for PrefixedStream<S> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if self.pos < self.prefix.len() {
            let avail = &self.prefix[self.pos..];
            let n = avail.len().min(buf.remaining());
            buf.put_slice(&avail[..n]);
            self.pos += n;
            return Poll::Ready(Ok(()));
        }
        Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for PrefixedStream<S> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        data: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.inner).poll_write(cx, data)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

fn find_header_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4)
        .position(|w| w == b"\r\n\r\n")
        .map(|idx| idx + 4)
}

struct ParsedHttpHead {
    method: String,
    target: String,
    close: bool,
    is_websocket_upgrade: bool,
}

fn parse_http_head(head: &[u8]) -> Option<ParsedHttpHead> {
    let text = std::str::from_utf8(head).ok()?;
    let mut lines = text.split("\r\n");
    let req_line = lines.next()?;
    let mut parts = req_line.split_whitespace();
    let method = parts.next()?.to_ascii_uppercase();
    let target = parts.next()?.to_string();
    let version = parts.next().unwrap_or("HTTP/1.1");

    let mut upgrade_ws = false;
    let mut conn_upgrade = false;
    let mut conn_close = version.eq_ignore_ascii_case("HTTP/1.0");
    let mut conn_keep_alive = false;

    for line in lines {
        if line.is_empty() {
            continue;
        }
        if let Some((name, val)) = line.split_once(':') {
            let name = name.trim();
            let val = val.trim();
            if name.eq_ignore_ascii_case("upgrade") && val.eq_ignore_ascii_case("websocket") {
                upgrade_ws = true;
            } else if name.eq_ignore_ascii_case("connection") {
                for tok in val.split(',').map(str::trim) {
                    if tok.eq_ignore_ascii_case("upgrade") {
                        conn_upgrade = true;
                    } else if tok.eq_ignore_ascii_case("close") {
                        conn_close = true;
                    } else if tok.eq_ignore_ascii_case("keep-alive") {
                        conn_keep_alive = true;
                    }
                }
            }
        }
    }

    let close = if version.eq_ignore_ascii_case("HTTP/1.0") {
        !conn_keep_alive
    } else {
        conn_close
    };

    let is_websocket_upgrade = method == "GET" && upgrade_ws && conn_upgrade;

    Some(ParsedHttpHead {
        method,
        target,
        close,
        is_websocket_upgrade,
    })
}

fn decode_url_path(target: &str) -> Option<String> {
    let without_frag = target.split('#').next().unwrap_or(target);
    let raw_path = without_frag.split('?').next().unwrap_or(without_frag);
    if !raw_path.starts_with('/') {
        return None;
    }

    let bytes = raw_path.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return None;
            }
            let hex_str = std::str::from_utf8(&bytes[i + 1..i + 3]).ok()?;
            let val = u8::from_str_radix(hex_str, 16).ok()?;
            if val == 0 {
                return None;
            }
            decoded.push(val);
            i += 3;
        } else {
            if bytes[i] == 0 {
                return None;
            }
            decoded.push(bytes[i]);
            i += 1;
        }
    }

    let path_str = String::from_utf8(decoded).ok()?;
    let mut segments = Vec::new();
    for seg in path_str.split('/') {
        if seg.is_empty() || seg == "." {
            continue;
        }
        if seg == ".." || seg.contains('\\') {
            return None;
        }
        segments.push(seg);
    }

    if segments.is_empty() {
        Some("/".to_string())
    } else {
        Some(format!("/{}", segments.join("/")))
    }
}

fn find_public_asset(url_path: &str) -> Option<(&'static str, &'static [u8])> {
    let lookup = |candidate: &str| -> Option<(&'static str, &'static [u8])> {
        PUBLIC_ASSETS
            .binary_search_by_key(&candidate, |(p, _)| *p)
            .ok()
            .map(|idx| PUBLIC_ASSETS[idx])
    };
    if url_path == "/" {
        return lookup("/index.html");
    }
    if let Some(hit) = lookup(url_path) {
        return Some(hit);
    }
    if !url_path.ends_with('/') {
        let html_fallback = format!("{url_path}.html");
        return lookup(&html_fallback);
    }
    None
}

fn mime_type(asset_path: &str) -> &'static str {
    let ext = asset_path.rsplit('.').next().unwrap_or("");
    match ext {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "woff2" => "font/woff2",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        "ps1" | "cmd" | "sh" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

struct HttpReply<'a> {
    status: u16,
    reason: &'static str,
    content_type: &'static str,
    no_store: bool,
    close: bool,
    body: &'a [u8],
    send_body: bool,
}

async fn write_http_response(stream: &mut TcpStream, reply: HttpReply<'_>) -> io::Result<()> {
    let cache = if reply.no_store {
        "Cache-Control: no-store\r\n"
    } else {
        ""
    };
    let conn = if reply.close { "close" } else { "keep-alive" };
    let head = format!(
        "HTTP/1.1 {} {}\r\n\
         Content-Type: {}\r\n\
         Content-Length: {}\r\n\
         Connection: {conn}\r\n\
         {cache}\
         Content-Security-Policy: {CSP_HEADER}\r\n\
         X-Content-Type-Options: nosniff\r\n\
         Referrer-Policy: no-referrer\r\n\
         Permissions-Policy: camera=(), microphone=(), geolocation=()\r\n\
         \r\n",
        reply.status,
        reply.reason,
        reply.content_type,
        reply.body.len()
    );
    stream.write_all(head.as_bytes()).await?;
    if reply.send_body && !reply.body.is_empty() {
        stream.write_all(reply.body).await?;
    }
    stream.flush().await
}

async fn handle_connection(
    mut stream: TcpStream,
    peer_addr: SocketAddr,
    state: Arc<ServerState>,
    shutdown: watch::Receiver<bool>,
) {
    let mut buf = Vec::with_capacity(2048);
    let mut temp = [0u8; 4096];

    loop {
        if *shutdown.borrow() {
            return;
        }
        let header_end = loop {
            if let Some(end) = find_header_end(&buf) {
                break end;
            }
            if buf.len() >= MAX_HTTP_HEAD_BYTES {
                let _ = write_http_response(
                    &mut stream,
                    HttpReply {
                        status: 431,
                        reason: "Request Header Fields Too Large",
                        content_type: "text/plain; charset=utf-8",
                        no_store: true,
                        close: true,
                        body: b"Headers too large",
                        send_body: true,
                    },
                )
                .await;
                return;
            }
            let read_timeout = if buf.is_empty() {
                Duration::from_secs(10)
            } else {
                Duration::from_secs(15)
            };
            let Ok(res) = tokio::time::timeout(read_timeout, stream.read(&mut temp)).await else {
                return;
            };
            let Ok(n) = res else {
                return;
            };
            if n == 0 {
                return;
            }
            buf.extend_from_slice(&temp[..n]);
        };

        let Some(parsed) = parse_http_head(&buf[..header_end - 4]) else {
            let _ = write_http_response(
                &mut stream,
                HttpReply {
                    status: 400,
                    reason: "Bad Request",
                    content_type: "text/plain; charset=utf-8",
                    no_store: true,
                    close: true,
                    body: b"Bad Request",
                    send_body: true,
                },
            )
            .await;
            return;
        };

        if parsed.is_websocket_upgrade {
            let prefixed = PrefixedStream {
                prefix: buf,
                pos: 0,
                inner: stream,
            };
            handle_ws_upgrade(prefixed, peer_addr, state, shutdown).await;
            return;
        }

        // Conservar bytes sobrantes si hubiera pipelining en keep-alive HTTP.
        buf = buf.split_off(header_end);

        if parsed.method != "GET" && parsed.method != "HEAD" {
            let _ = write_http_response(
                &mut stream,
                HttpReply {
                    status: 405,
                    reason: "Method Not Allowed",
                    content_type: "text/plain; charset=utf-8",
                    no_store: true,
                    close: true,
                    body: b"Method Not Allowed",
                    send_body: parsed.method != "HEAD",
                },
            )
            .await;
            return;
        }

        let send_body = parsed.method == "GET";
        let close = parsed.close;
        let reply_res = match decode_url_path(&parsed.target).as_deref() {
            Some("/config") => {
                let body = serde_json::to_vec(&state.config_json()).unwrap_or_default();
                write_http_response(
                    &mut stream,
                    HttpReply {
                        status: 200,
                        reason: "OK",
                        content_type: "application/json; charset=utf-8",
                        no_store: true,
                        close,
                        body: &body,
                        send_body,
                    },
                )
                .await
            }
            Some("/healthz") => {
                let body = serde_json::to_vec(&state.health_json()).unwrap_or_default();
                write_http_response(
                    &mut stream,
                    HttpReply {
                        status: 200,
                        reason: "OK",
                        content_type: "application/json; charset=utf-8",
                        no_store: true,
                        close,
                        body: &body,
                        send_body,
                    },
                )
                .await
            }
            Some("/version") => {
                let body = serde_json::to_vec(&state.version_json()).unwrap_or_default();
                write_http_response(
                    &mut stream,
                    HttpReply {
                        status: 200,
                        reason: "OK",
                        content_type: "application/json; charset=utf-8",
                        no_store: true,
                        close,
                        body: &body,
                        send_body,
                    },
                )
                .await
            }
            Some(path) => {
                if let Some((asset_path, bytes)) = find_public_asset(path) {
                    write_http_response(
                        &mut stream,
                        HttpReply {
                            status: 200,
                            reason: "OK",
                            content_type: mime_type(asset_path),
                            no_store: false,
                            close,
                            body: bytes,
                            send_body,
                        },
                    )
                    .await
                } else {
                    write_http_response(
                        &mut stream,
                        HttpReply {
                            status: 404,
                            reason: "Not Found",
                            content_type: "text/plain; charset=utf-8",
                            no_store: true,
                            close,
                            body: b"Not Found",
                            send_body,
                        },
                    )
                    .await
                }
            }
            None => {
                write_http_response(
                    &mut stream,
                    HttpReply {
                        status: 404,
                        reason: "Not Found",
                        content_type: "text/plain; charset=utf-8",
                        no_store: true,
                        close,
                        body: b"Not Found",
                        send_body,
                    },
                )
                .await
            }
        };

        if reply_res.is_err() || parsed.close {
            return;
        }
    }
}

// `tungstenite::handshake::server` impone `Result<Response, ErrorResponse>` en el callback.
#[allow(clippy::result_large_err)]
async fn handle_ws_upgrade(
    stream: PrefixedStream<TcpStream>,
    peer_addr: SocketAddr,
    state: Arc<ServerState>,
    mut shutdown: watch::Receiver<bool>,
) {
    let mut resolved_ip = String::new();
    let config = &state.config;
    let peer_ip = peer_addr.ip();

    let ws_config = WebSocketConfig::default()
        .max_message_size(Some(MAX_WS_PAYLOAD))
        .max_frame_size(Some(MAX_WS_PAYLOAD));

    let ws_stream = match accept_hdr_async_with_config(
        stream,
        |req: &Request, resp: Response| -> Result<Response, ErrorResponse> {
            let hdr_str = |name: &str| -> Option<&str> {
                req.headers().get(name).and_then(|v| v.to_str().ok())
            };
            let xff = hdr_str("x-forwarded-for");
            resolved_ip = resolve_client_ip(peer_ip, xff, &config.trusted_proxies);
            let origin = hdr_str("origin");
            let req_host = hdr_str("host");
            if config.origin_allowed(origin, req_host) {
                Ok(resp)
            } else {
                let err_resp = http::Response::builder()
                    .status(http::StatusCode::FORBIDDEN)
                    .body(Some("Forbidden origin".to_string()))
                    .unwrap_or_else(|_| http::Response::new(Some("Forbidden origin".to_string())));
                Err(err_resp)
            }
        },
        Some(ws_config),
    )
    .await
    {
        Ok(ws) => ws,
        Err(_) => return,
    };

    run_ws_client(ws_stream, resolved_ip, state, &mut shutdown).await;
}

async fn run_ws_client(
    ws_stream: WebSocketStream<PrefixedStream<TcpStream>>,
    client_ip: String,
    state: Arc<ServerState>,
    shutdown: &mut watch::Receiver<bool>,
) {
    let conn_id = state.next_conn_id.fetch_add(1, Ordering::Relaxed);
    let is_alive = Arc::new(AtomicBool::new(true));
    let tx = ClientTx::new();

    {
        let mut sockets = state.live_sockets.lock().expect("sockets poisoned");
        sockets.insert(
            conn_id,
            LiveSocket {
                is_alive: Arc::clone(&is_alive),
                tx: tx.clone(),
            },
        );
    }

    let (mut ws_sink, mut ws_read) = ws_stream.split();
    let writer_tx = tx.clone();
    let writer = tokio::spawn(async move {
        while let Some(ev) = writer_tx.recv().await {
            match ev {
                ClientEvent::Send(msg) => {
                    if ws_sink.send(msg).await.is_err() {
                        break;
                    }
                }
                ClientEvent::Close => {
                    let _ = ws_sink.send(Message::Close(None)).await;
                    break;
                }
            }
        }
        writer_tx.mark_dropped();
    });

    let mut role = WsRole::None;
    let mut bucket = ControlBucket::new(state.config.msg_burst, state.config.msg_rate);

    loop {
        let next = tokio::select! {
            biased;
            _ = shutdown.changed() => {
                if *shutdown.borrow() {
                    break;
                }
                continue;
            }
            item = ws_read.next() => item,
        };
        let Some(msg_res) = next else {
            break;
        };
        let Ok(msg) = msg_res else {
            break;
        };

        is_alive.store(true, Ordering::Relaxed);
        match msg {
            Message::Pong(_) => {}
            Message::Ping(payload) => {
                tx.send_ctrl_msg(Message::Pong(payload));
            }
            Message::Close(_) => break,
            Message::Binary(raw) => {
                if let Some(wait_ms) = relay_binary(&state, &role, &raw).await
                    && wait_ms > 0
                {
                    tokio::select! {
                        _ = tokio::time::sleep(Duration::from_millis(wait_ms)) => {}
                        _ = shutdown.changed() => {
                            if *shutdown.borrow() {
                                break;
                            }
                        }
                    }
                }
            }
            Message::Text(text) => {
                if !bucket.take() {
                    {
                        let mut guard = state.inner.lock().expect("state poisoned");
                        guard.metrics.reject("FLOOD");
                    }
                    send_json(&tx, &json!({ "t": "error", "reason": "FLOOD" }));
                    close_socket(&tx);
                    break;
                }
                let Ok(val) = serde_json::from_str::<Value>(&text) else {
                    continue;
                };
                if handle_control_msg(&state, conn_id, &client_ip, &tx, &mut role, val) {
                    break;
                }
            }
            Message::Frame(_) => {}
        }
    }

    cleanup_disconnect(&state, conn_id, &role);
    {
        let mut sockets = state.live_sockets.lock().expect("sockets poisoned");
        sockets.remove(&conn_id);
    }
    close_socket(&tx);
    let _ = writer.await;
}

async fn relay_binary(state: &ServerState, role: &WsRole, raw: &[u8]) -> Option<u64> {
    let token = match role {
        WsRole::Host { token } | WsRole::Guest { token, .. } => token.as_str(),
        WsRole::None => return None,
    };

    let (target_tx, payload, wait_ms) = {
        let mut guard = state.inner.lock().expect("state poisoned");
        let len = raw.len();
        let room = guard.rooms.get_mut(token)?;
        room.last_activity = Instant::now();

        let (target_tx, payload) = match role {
            WsRole::Host { .. } => {
                if len < 4 {
                    return None;
                }
                let to_guest_id = u32::from_be_bytes([raw[0], raw[1], raw[2], raw[3]]);
                let tx = room.guests.get(&to_guest_id).map(|g| g.tx.clone());
                (tx, raw[4..].to_vec())
            }
            WsRole::Guest { .. } => (Some(room.host.tx.clone()), raw.to_vec()),
            WsRole::None => unreachable!(),
        };

        let room_wait = room.relay.as_mut().map(|b| b.drain(len)).unwrap_or(0);
        let total_wait = guard.relay_total.as_mut().map(|b| b.drain(len)).unwrap_or(0);
        let wait_ms = room_wait.max(total_wait);

        guard.metrics.relay_bytes = guard.metrics.relay_bytes.saturating_add(len as u64);
        guard.metrics.relay_frames = guard.metrics.relay_frames.saturating_add(1);
        if wait_ms > 0 {
            guard.metrics.relay_throttled = guard.metrics.relay_throttled.saturating_add(1);
        }
        (target_tx, payload, wait_ms)
    };

    if let Some(peer) = target_tx {
        peer.send_binary(payload).await;
    }
    Some(wait_ms)
}

/// Procesa un mensaje JSON de control; devuelve `true` si hay que cerrar el socket.
fn handle_control_msg(
    state: &ServerState,
    conn_id: u64,
    client_ip: &str,
    tx: &ClientTx,
    role: &mut WsRole,
    msg: Value,
) -> bool {
    let Some(msg_type) = msg.get("t").and_then(|v| v.as_str()) else {
        return false;
    };

    match msg_type {
        "host" => {
            if !matches!(role, WsRole::None) {
                return false;
            }
            let mut guard = state.inner.lock().expect("state poisoned");
            if rate_exceeded(
                &guard.rooms_per_ip,
                client_ip,
                state.config.room_rate_max,
                state.config.room_rate_window,
            ) {
                guard.metrics.reject("TOO_MANY_ROOMS");
                send_json(tx, &json!({ "t": "error", "reason": "TOO_MANY_ROOMS" }));
                close_socket(tx);
                return true;
            }
            if msg.get("v").and_then(|v| v.as_u64()) != Some(2) {
                guard.metrics.reject("VERSION");
                send_json(tx, &json!({ "t": "error", "reason": "VERSION" }));
                close_socket(tx);
                return true;
            }
            if guard.rooms.len() >= state.config.max_rooms {
                guard.metrics.reject("NO_ROOMS");
                send_json(tx, &json!({ "t": "error", "reason": "NO_ROOMS" }));
                return false;
            }
            let link = msg.get("link").and_then(|v| v.as_bool()).unwrap_or(false);
            let Some(token) = random_room_id(&guard.rooms, link) else {
                guard.metrics.reject("NO_ROOMS");
                send_json(tx, &json!({ "t": "error", "reason": "NO_ROOMS" }));
                return false;
            };
            let now = Instant::now();
            let room_relay = (state.config.relay_limit > 0)
                .then(|| RelayBucket::new(state.config.relay_limit));
            guard.rooms.insert(
                token.clone(),
                Room {
                    host: PeerHandle {
                        conn_id,
                        tx: tx.clone(),
                    },
                    guests: HashMap::new(),
                    last_activity: now,
                    bad_guests: 0,
                    relay: room_relay,
                },
            );
            guard.metrics.rooms_opened = guard.metrics.rooms_opened.saturating_add(1);
            note_rate(
                &mut guard.rooms_per_ip,
                client_ip,
                state.config.room_rate_window,
            );
            *role = WsRole::Host {
                token: token.clone(),
            };
            send_json(
                tx,
                &json!({
                    "t": "hosted",
                    "token": token,
                    "room": token,
                    "v": 2,
                    "publicIp": client_ip,
                }),
            );
            false
        }
        "join" => {
            if !matches!(role, WsRole::None) {
                return false;
            }
            let raw_token = msg.get("token").and_then(|v| v.as_str()).unwrap_or("");
            let token: String = raw_token
                .chars()
                .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
                .take(64)
                .collect();

            let mut guard = state.inner.lock().expect("state poisoned");
            if !guard.rooms.contains_key(&token) {
                if rate_exceeded(&guard.join_fails, client_ip, JOIN_FAIL_MAX, JOIN_FAIL_WINDOW) {
                    guard.metrics.reject("RATE_LIMITED");
                    send_json(tx, &json!({ "t": "error", "reason": "RATE_LIMITED" }));
                    close_socket(tx);
                    return true;
                }
                note_rate(&mut guard.join_fails, client_ip, JOIN_FAIL_WINDOW);
                guard.metrics.reject("NOT_FOUND");
                send_json(tx, &json!({ "t": "error", "reason": "NOT_FOUND" }));
                return false;
            }

            let guest_count = guard.rooms.get(&token).map(|r| r.guests.len()).unwrap_or(0);
            if guest_count >= state.config.max_guests {
                guard.metrics.reject("ROOM_FULL");
                send_json(tx, &json!({ "t": "error", "reason": "ROOM_FULL" }));
                return false;
            }

            guard.join_fails.remove(client_ip);
            let mut guest_id = guard.next_guest_id;
            if guest_id == 0 {
                guest_id = 1;
            }
            guard.next_guest_id = guest_id.wrapping_add(1).max(1);

            let Some(room) = guard.rooms.get_mut(&token) else {
                return false;
            };
            room.last_activity = Instant::now();
            room.guests.insert(
                guest_id,
                PeerHandle {
                    conn_id,
                    tx: tx.clone(),
                },
            );
            let host_tx = room.host.tx.clone();
            let name: String = msg
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .chars()
                .take(40)
                .collect();
            *role = WsRole::Guest {
                token,
                guest_id,
            };
            send_json(
                tx,
                &json!({
                    "t": "joined",
                    "guestId": guest_id,
                    "publicIp": client_ip,
                }),
            );
            send_json(
                &host_tx,
                &json!({
                    "t": "guest",
                    "guestId": guest_id,
                    "name": name,
                    "ip": client_ip,
                }),
            );
            false
        }
        "bad-guest" => {
            let WsRole::Host { token } = role else {
                return false;
            };
            let Some(guest_id) = msg.get("guestId").and_then(|v| v.as_u64()).map(|n| n as u32) else {
                return false;
            };
            let mut guard = state.inner.lock().expect("state poisoned");
            let (guest_tx, burn) = {
                let Some(room) = guard.rooms.get_mut(token) else {
                    return false;
                };
                let guest_tx = room.guests.get(&guest_id).map(|g| g.tx.clone());
                room.bad_guests = room.bad_guests.saturating_add(1);
                (guest_tx, room.bad_guests >= BAD_GUEST_MAX)
            };
            if let Some(guest_tx) = guest_tx {
                guard.metrics.reject("BAD_SECRET");
                send_json(&guest_tx, &json!({ "t": "error", "reason": "BAD_SECRET" }));
                close_socket(&guest_tx);
            }
            if burn {
                guard.metrics.reject("BURNED");
                close_room_in_state(&mut guard, token, "BURNED", false);
            }
            false
        }
        "signal" => {
            let (token, sender_id, is_host) = match role {
                WsRole::Host { token } => (token.as_str(), 0u32, true),
                WsRole::Guest { token, guest_id } => (token.as_str(), *guest_id, false),
                WsRole::None => return false,
            };
            let to = msg.get("to").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            let data = msg.get("data").cloned().unwrap_or(Value::Null);
            let mut guard = state.inner.lock().expect("state poisoned");
            let Some(room) = guard.rooms.get_mut(token) else {
                return false;
            };
            room.last_activity = Instant::now();
            let target_tx = if is_host || to > 0 {
                room.guests.get(&to).map(|g| g.tx.clone())
            } else {
                Some(room.host.tx.clone())
            };
            if let Some(peer) = target_tx {
                send_json(
                    &peer,
                    &json!({
                        "t": "signal",
                        "from": sender_id,
                        "data": data,
                    }),
                );
            }
            false
        }
        _ => false,
    }
}

fn cleanup_disconnect(state: &ServerState, conn_id: u64, role: &WsRole) {
    let mut guard = state.inner.lock().expect("state poisoned");
    match role {
        WsRole::Host { token } => {
            let same_host = guard
                .rooms
                .get(token)
                .map(|r| r.host.conn_id == conn_id)
                .unwrap_or(false);
            if same_host
                && let Some(room) = guard.rooms.remove(token)
            {
                let msg = json!({ "t": "host-gone" });
                for guest in room.guests.values() {
                    send_json(&guest.tx, &msg);
                }
            }
        }
        WsRole::Guest { token, guest_id } => {
            if let Some(room) = guard.rooms.get_mut(token) {
                let same_guest = room
                    .guests
                    .get(guest_id)
                    .map(|g| g.conn_id == conn_id)
                    .unwrap_or(false);
                if same_guest {
                    room.guests.remove(guest_id);
                    send_json(
                        &room.host.tx,
                        &json!({ "t": "guest-gone", "guestId": guest_id }),
                    );
                }
            }
        }
        WsRole::None => {}
    }
}

fn sweep_state(state: &ServerState) {
    let mut guard = state.inner.lock().expect("state poisoned");
    guard
        .join_fails
        .retain(|_, e| e.since.elapsed() <= JOIN_FAIL_WINDOW);
    let room_rate_win = state.config.room_rate_window;
    guard
        .rooms_per_ip
        .retain(|_, e| e.since.elapsed() <= room_rate_win);

    let ttl = state.config.room_ttl;
    let expired: Vec<String> = guard
        .rooms
        .iter()
        .filter(|(_, r)| r.last_activity.elapsed() >= ttl)
        .map(|(t, _)| t.clone())
        .collect();
    for token in expired {
        close_room_in_state(&mut guard, &token, "EXPIRED", true);
    }
}

fn ping_sockets(state: &ServerState) {
    let sockets = state.live_sockets.lock().expect("sockets poisoned");
    for sock in sockets.values() {
        if !sock.is_alive.swap(false, Ordering::Relaxed) {
            close_socket(&sock.tx);
        } else {
            sock.tx.send_ctrl_msg(Message::Ping(Default::default()));
        }
    }
}

/// Arranca el servidor HTTP+WebSocket sin bloquear el hilo actual.
pub async fn start_server(host: Option<&str>, port: u16) -> Result<RunningServer, ListenError> {
    let listener: TcpListener = listen_on_addr(host, port)?;
    let addr = listener.local_addr().map_err(|e| ListenError {
        message: e.to_string(),
        raw: e,
    })?;
    let actual_port = addr.port();
    let config = ServerConfig::from_env(actual_port);
    let state = Arc::new(ServerState::new(config));
    let (shutdown_tx, mut shutdown_rx) = watch::channel(false);

    let sweep_state_ref = Arc::clone(&state);
    let mut sweep_shutdown = shutdown_rx.clone();
    let sweep_interval = state.config.room_sweep.min(JOIN_FAIL_WINDOW);
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(sweep_interval);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        tick.tick().await;
        loop {
            tokio::select! {
                _ = tick.tick() => sweep_state(&sweep_state_ref),
                _ = sweep_shutdown.changed() => break,
            }
        }
    });

    let hb_state_ref = Arc::clone(&state);
    let mut hb_shutdown = shutdown_rx.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(HEARTBEAT_INTERVAL);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        tick.tick().await;
        loop {
            tokio::select! {
                _ = tick.tick() => ping_sockets(&hb_state_ref),
                _ = hb_shutdown.changed() => break,
            }
        }
    });

    let task = tokio::spawn(async move {
        loop {
            tokio::select! {
                accepted = listener.accept() => {
                    match accepted {
                        Ok((stream, peer)) => {
                            let st = Arc::clone(&state);
                            let rx = shutdown_rx.clone();
                            tokio::spawn(handle_connection(stream, peer, st, rx));
                        }
                        Err(_) => {
                            tokio::time::sleep(Duration::from_millis(20)).await;
                        }
                    }
                }
                _ = shutdown_rx.changed() => {
                    if *shutdown_rx.borrow() {
                        break;
                    }
                }
            }
        }
    });

    Ok(RunningServer {
        addr,
        shutdown_tx,
        task,
    })
}

fn format_host_url(ip: IpAddr, port: u16) -> String {
    match ip {
        IpAddr::V4(v4) => format!("http://{v4}:{port}"),
        IpAddr::V6(v6) => format!("http://[{v6}]:{port}"),
    }
}

fn print_banner(host: Option<&str>, addr: SocketAddr) {
    let port = addr.port();
    let any_iface = host.map(str::trim).filter(|s| !s.is_empty()).is_none()
        || addr.ip().is_unspecified();

    println!();
    if any_iface {
        println!(
            "  {GREEN}Drop escuchando en http://localhost:{port}{RESET}  {DIM}(v{VERSION}){RESET}"
        );
        for ip in get_local_ips() {
            println!("  {CYAN}LAN:{RESET} http://{ip}:{port}");
        }
        for ip in get_local_ipv6s() {
            println!("  {CYAN}LAN:{RESET} http://[{ip}]:{port}");
        }
    } else {
        println!(
            "  {GREEN}Drop escuchando en {}{RESET}  {DIM}(v{VERSION}){RESET}",
            format_host_url(addr.ip(), port)
        );
    }

    let cfg = ServerConfig::from_env(port);
    if cfg.relay_limit > 0 || cfg.relay_limit_total > 0 {
        println!(
            "  {DIM}Relay: {} B/s por sala | {} B/s en total{RESET}",
            cfg.relay_limit, cfg.relay_limit_total
        );
    }
    if cfg.turn_url.is_some() && cfg.turn_secret.is_none() {
        println!("  {YELLOW}Aviso: hay TURN_URL pero falta TURN_SECRET; no se anuncia TURN.{RESET}");
    }
    println!("  {DIM}Pulsa Ctrl+C para detener el servidor.{RESET}\n");
    let _ = io::stdout().flush();
}

async fn wait_shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let mut sigterm = signal(SignalKind::terminate()).ok();
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = async {
                if let Some(ref mut s) = sigterm {
                    s.recv().await;
                } else {
                    std::future::pending::<()>().await;
                }
            } => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

/// Subcomando `drop serve [-p <puerto>] [-H <host>]`.
pub async fn run_serve(host: Option<&str>, port: u16) -> i32 {
    let server = match start_server(host, port).await {
        Ok(s) => s,
        Err(err) => {
            eprintln!("\n  {RED}✖ {err}{RESET}\n");
            return 1;
        }
    };
    print_banner(host, server.addr);
    wait_shutdown_signal().await;
    println!("\n  {DIM}Cerrando servidor...{RESET}");
    server.shutdown().await;
    0
}
