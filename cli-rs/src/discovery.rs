// Descubrimiento en LAN por broadcast UDP y candidatos IPv4/IPv6 + Happy Eyeballs.

use std::collections::HashSet;
use std::env;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, SocketAddrV4};
use std::time::Duration;

use if_addrs::{IfAddr, get_if_addrs};
use sha2::{Digest, Sha256};
use socket2::{Domain, Protocol, Socket, Type};
use tokio::net::{TcpStream, UdpSocket};
use tokio::sync::oneshot;
use tokio::task::JoinHandle;
use tokio::time::{interval, timeout};

use crate::shared::codes::split_for_key;

pub const BROADCAST_PORT: u16 = 42424;

/// Etiqueta de sala que viaja en broadcast UDP: primeros 16 hex de SHA-256(roomId).
pub fn room_hash(code: &str) -> String {
    let split = split_for_key(code);
    let mut hasher = Sha256::new();
    hasher.update(split.room_id.as_bytes());
    let hex_str = hex::encode(hasher.finalize());
    hex_str[..16].to_string()
}

pub fn get_local_ips() -> Vec<String> {
    let Ok(addrs) = get_if_addrs() else {
        return Vec::new();
    };
    let mut ips = Vec::new();
    for iface in addrs {
        if iface.is_loopback() {
            continue;
        }
        if let IfAddr::V4(v4) = iface.addr {
            ips.push(v4.ip.to_string());
        }
    }
    ips
}

/// `fe80::/10`: link-local (necesita indice de zona local, no viaja).
pub fn is_link_local_v6(ip: &str) -> bool {
    let lower = ip.to_ascii_lowercase();
    let Some(first) = lower.split(':').next() else {
        return false;
    };
    if let Ok(seg) = u16::from_str_radix(first, 16) {
        (seg & 0xffc0) == 0xfe80
    } else {
        false
    }
}

/// `fc00::/7`: ULA privada de IPv6 (Tailscale, VPNs, LAN ULA).
pub fn is_unique_local_v6(ip: &str) -> bool {
    let lower = ip.to_ascii_lowercase();
    let Some(first) = lower.split(':').next() else {
        return false;
    };
    if let Ok(seg) = u16::from_str_radix(first, 16) {
        (seg & 0xfe00) == 0xfc00
    } else {
        false
    }
}

pub fn get_local_ipv6s() -> Vec<String> {
    let Ok(addrs) = get_if_addrs() else {
        return Vec::new();
    };
    let mut ips = Vec::new();
    for iface in addrs {
        if iface.is_loopback() {
            continue;
        }
        if let IfAddr::V6(v6) = iface.addr {
            let s = v6.ip.to_string();
            let clean = s.split('%').next().unwrap_or(&s).to_string();
            if !is_link_local_v6(&clean) {
                ips.push(clean);
            }
        }
    }
    ips
}

pub fn get_candidate_ips() -> Vec<String> {
    let mut out = get_local_ips();
    out.extend(get_local_ipv6s());
    out
}

/// `::ffff:192.168.1.5` -> `192.168.1.5`.
pub fn plain_address(addr: &str) -> &str {
    if let Some(rest) = addr.strip_prefix("::ffff:") {
        return rest;
    }
    if let Some(rest) = addr.strip_prefix("::FFFF:") {
        return rest;
    }
    addr
}

/// Indica si una IP es loopback o direccion privada de LAN / ULA.
pub fn is_local_address(addr: &str) -> bool {
    let ip = plain_address(addr);
    if ip == "127.0.0.1" || ip == "::1" {
        return true;
    }
    if let Ok(v4) = ip.parse::<Ipv4Addr>() {
        let o = v4.octets();
        return o[0] == 127
            || (o[0] == 192 && o[1] == 168)
            || o[0] == 10
            || (o[0] == 172 && (16..=31).contains(&o[1]));
    }
    is_unique_local_v6(ip)
}

fn v4_prefix(ip: &str) -> String {
    ip.split('.').take(3).collect::<Vec<_>>().join(".")
}

fn v6_prefix(ip: &str) -> String {
    ip.to_ascii_lowercase()
        .split(':')
        .take(4)
        .collect::<Vec<_>>()
        .join(":")
}

/// Ordena IPs candidatas de mas a menos probable para minimizar la espera en WAN/LAN/IPv6.
pub fn rank_candidates(ips: &[String], local: &[String]) -> Vec<String> {
    let local_v4: HashSet<String> = local
        .iter()
        .filter(|ip| ip.contains('.'))
        .map(|ip| v4_prefix(ip))
        .collect();
    let local_v6: HashSet<String> = local
        .iter()
        .filter(|ip| ip.contains(':'))
        .map(|ip| v6_prefix(ip))
        .collect();

    let score = |ip: &str| -> i32 {
        if ip == "127.0.0.1" || ip == "::1" {
            return 100;
        }
        if ip.contains(':') {
            if local_v6.contains(&v6_prefix(ip)) {
                return 85;
            }
            if is_unique_local_v6(ip) {
                return 65;
            }
            return 55;
        }
        if local_v4.contains(&v4_prefix(ip)) {
            return 90;
        }
        if ip.starts_with("192.168.") {
            return 80;
        }
        if ip.starts_with("10.") {
            return 70;
        }
        if ip.starts_with("172.") {
            return 60;
        }
        50
    };

    let mut seen = HashSet::new();
    let mut unique: Vec<String> = ips
        .iter()
        .filter(|ip| seen.insert((*ip).clone()))
        .cloned()
        .collect();
    unique.sort_by_key(|ip| std::cmp::Reverse(score(ip)));
    unique
}

pub fn get_broadcast_addresses() -> Vec<String> {
    let mut targets = HashSet::new();
    targets.insert("255.255.255.255".to_string());
    if let Ok(addrs) = get_if_addrs() {
        for iface in addrs {
            if iface.is_loopback() {
                continue;
            }
            if let IfAddr::V4(v4) = iface.addr {
                let ip_u32 = u32::from(v4.ip);
                let mask_u32 = u32::from(v4.netmask);
                let bcast = Ipv4Addr::from(ip_u32 | !mask_u32);
                targets.insert(bcast.to_string());
            }
        }
    }
    targets.into_iter().collect()
}

pub struct Broadcaster {
    stop_tx: Option<oneshot::Sender<()>>,
    handle: Option<JoinHandle<()>>,
}

impl Broadcaster {
    pub fn stop(&mut self) {
        if let Some(tx) = self.stop_tx.take() {
            let _ = tx.send(());
        }
        if let Some(h) = self.handle.take() {
            h.abort();
        }
    }
}

impl Drop for Broadcaster {
    fn drop(&mut self) {
        self.stop();
    }
}

fn create_reusable_udp4(bind_port: u16) -> std::io::Result<UdpSocket> {
    let sock = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
    sock.set_reuse_address(true)?;
    #[cfg(all(unix, not(target_os = "android")))]
    {
        let _ = sock.set_reuse_port(true);
    }
    sock.set_broadcast(true)?;
    sock.set_nonblocking(true)?;
    let addr = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, bind_port));
    sock.bind(&addr.into())?;
    let std_sock: std::net::UdpSocket = sock.into();
    UdpSocket::from_std(std_sock)
}

pub fn start_broadcasting(code: &str, tcp_port: u16) -> Broadcaster {
    let hash = room_hash(code);
    let (stop_tx, mut stop_rx) = oneshot::channel::<()>();

    let handle = tokio::spawn(async move {
        let Ok(sock) = create_reusable_udp4(0) else {
            return;
        };
        let payload = serde_json::json!({
            "t": "drop-lan",
            "h": hash,
            "p": tcp_port,
        })
        .to_string();
        let targets: Vec<SocketAddr> = get_broadcast_addresses()
            .into_iter()
            .filter_map(|ip| ip.parse::<Ipv4Addr>().ok())
            .map(|ip| SocketAddr::V4(SocketAddrV4::new(ip, BROADCAST_PORT)))
            .collect();

        let mut tick = interval(Duration::from_millis(600));
        loop {
            tokio::select! {
                _ = &mut stop_rx => break,
                _ = tick.tick() => {
                    for &target in &targets {
                        let _ = sock.send_to(payload.as_bytes(), target).await;
                    }
                }
            }
        }
    });

    Broadcaster {
        stop_tx: Some(stop_tx),
        handle: Some(handle),
    }
}

pub async fn listen_for_lan(code: &str, timeout_ms: u64) -> Option<(String, u16)> {
    if env::var_os("DROP_NO_LAN").is_some_and(|v| !v.is_empty()) {
        return None;
    }
    let sock = create_reusable_udp4(BROADCAST_PORT).ok()?;
    let hash = room_hash(code);
    let mut buf = [0u8; 2048];

    let recv_loop = async {
        loop {
            let Ok((n, rinfo)) = sock.recv_from(&mut buf).await else {
                return None;
            };
            if let Ok(val) = serde_json::from_slice::<serde_json::Value>(&buf[..n])
                && val.get("t").and_then(|v| v.as_str()) == Some("drop-lan")
                && val.get("h").and_then(|v| v.as_str()) == Some(hash.as_str())
                && let Some(port) = val.get("p").and_then(|v| v.as_u64())
                && (1..=65535).contains(&port)
            {
                return Some((rinfo.ip().to_string(), port as u16));
            }
        }
    };

    (timeout(Duration::from_millis(timeout_ms), recv_loop).await).unwrap_or(None)
}

/// Happy Eyeballs: sondea IPs escalonadas (`min(i * 100, 300) ms`) y devuelve el primer TCP valido.
pub async fn probe_candidate_ips(
    candidate_ips: &[String],
    port: u16,
    timeout_ms: u64,
) -> Option<(TcpStream, String)> {
    if candidate_ips.is_empty() || port == 0 {
        return None;
    }

    let (tx, mut rx) = tokio::sync::mpsc::channel::<Option<(TcpStream, String)>>(candidate_ips.len());
    let mut handles = Vec::with_capacity(candidate_ips.len());

    for (i, ip) in candidate_ips.iter().enumerate() {
        let Ok(parsed_ip) = ip.parse::<IpAddr>() else {
            let _ = tx.try_send(None);
            continue;
        };
        let ip_str = ip.clone();
        let addr = SocketAddr::new(parsed_ip, port);
        let delay = Duration::from_millis((i as u64 * 100).min(300));
        let tx = tx.clone();

        handles.push(tokio::spawn(async move {
            if !delay.is_zero() {
                tokio::time::sleep(delay).await;
            }
            match TcpStream::connect(addr).await {
                Ok(stream) => {
                    let _ = stream.set_nodelay(true);
                    let _ = tx.send(Some((stream, ip_str))).await;
                }
                Err(_) => {
                    let _ = tx.send(None).await;
                }
            }
        }));
    }
    drop(tx);

    let deadline = tokio::time::sleep(Duration::from_millis(timeout_ms));
    tokio::pin!(deadline);

    let mut result = None;
    loop {
        tokio::select! {
            _ = &mut deadline => break,
            msg = rx.recv() => {
                match msg {
                    Some(Some(hit)) => {
                        result = Some(hit);
                        break;
                    }
                    Some(None) => continue,
                    None => break,
                }
            }
        }
    }

    for h in handles {
        h.abort();
    }
    result
}
