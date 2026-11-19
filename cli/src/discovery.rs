// Descubrimiento en LAN por broadcast UDP IPv4, multicast IPv6, mDNS y candidatos + Happy Eyeballs.

use std::collections::HashSet;
use std::env;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, SocketAddrV4, SocketAddrV6};
use std::time::Duration;

use if_addrs::{IfAddr, get_if_addrs};
use sha2::{Digest, Sha256};
use socket2::{Domain, Protocol, SockRef, Socket, Type};
use tokio::net::{TcpStream, UdpSocket};
use tokio::sync::oneshot;
use tokio::task::JoinHandle;
use tokio::time::{interval, timeout};

use crate::shared::codes::split_for_key;

pub const BROADCAST_PORT: u16 = 42424;
pub const MULTICAST_V6: Ipv6Addr = Ipv6Addr::new(0xff02, 0, 0, 0, 0, 0, 0, 1);

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
    mdns: Option<crate::mdns::MdnsResponder>,
}

impl Broadcaster {
    pub fn stop(&mut self) {
        if let Some(tx) = self.stop_tx.take() {
            let _ = tx.send(());
        }
        if let Some(h) = self.handle.take() {
            h.abort();
        }
        if let Some(ref mut m) = self.mdns {
            m.stop();
        }
    }
}

impl Drop for Broadcaster {
    fn drop(&mut self) {
        self.stop();
    }
}

pub fn ipv6_multicast_ifindices() -> Vec<u32> {
    let Ok(addrs) = get_if_addrs() else {
        return Vec::new();
    };
    let mut seen = HashSet::new();
    let mut nic = Vec::new();
    let mut lo = Vec::new();
    for iface in addrs {
        if let IfAddr::V6(_) = iface.addr
            && let Some(idx) = iface.index
            && idx != 0
            && seen.insert(idx)
        {
            if iface.is_loopback() {
                lo.push(idx);
            } else {
                nic.push(idx);
            }
        }
    }
    nic.extend(lo);
    nic
}

/// Convierte la dirección de origen UDP en un host conectable por TCP (conserva `%scope_id` en link-local IPv6).
pub fn format_peer_host(rinfo: SocketAddr) -> String {
    match rinfo {
        SocketAddr::V4(v4) => v4.ip().to_string(),
        SocketAddr::V6(v6) => {
            if let Some(v4) = v6.ip().to_ipv4_mapped() {
                return v4.to_string();
            }
            if v6.ip().is_unicast_link_local() && v6.scope_id() != 0 {
                return format!("{}%{}", v6.ip(), v6.scope_id());
            }
            v6.ip().to_string()
        }
    }
}

pub fn parse_lan_packet(
    data: &[u8],
    rinfo: SocketAddr,
    expected_hash: &str,
) -> Option<(String, u16)> {
    let val = serde_json::from_slice::<serde_json::Value>(data).ok()?;
    if val.get("t").and_then(|v| v.as_str()) != Some("drop-lan") {
        return None;
    }
    if val.get("h").and_then(|v| v.as_str()) != Some(expected_hash) {
        return None;
    }
    let port = val.get("p").and_then(|v| v.as_u64())?;
    if !(1..=65535).contains(&port) {
        return None;
    }
    Some((format_peer_host(rinfo), port as u16))
}

/// Conecta TCP aceptando tanto IPv4/IPv6 literales como link-local IPv6 con zona (`fe80::1%5`).
pub async fn connect_host(host: &str, port: u16) -> std::io::Result<TcpStream> {
    let stream = if host.contains(':') {
        if let Ok(addr) = format!("[{host}]:{port}").parse::<SocketAddr>() {
            TcpStream::connect(addr).await?
        } else {
            TcpStream::connect((host, port)).await?
        }
    } else {
        TcpStream::connect((host, port)).await?
    };
    let _ = stream.set_nodelay(true);
    Ok(stream)
}

pub(crate) fn create_reusable_udp4(bind_port: u16) -> std::io::Result<UdpSocket> {
    let sock = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
    sock.set_reuse_address(true)?;
    #[cfg(all(unix, not(target_os = "android")))]
    {
        let _ = sock.set_reuse_port(true);
    }
    sock.set_broadcast(true)?;
    let _ = sock.set_multicast_loop_v4(true);
    sock.set_nonblocking(true)?;
    let addr = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, bind_port));
    sock.bind(&addr.into())?;
    let std_sock: std::net::UdpSocket = sock.into();
    UdpSocket::from_std(std_sock)
}

pub(crate) fn create_reusable_udp6(bind_port: u16) -> std::io::Result<UdpSocket> {
    let sock = Socket::new(Domain::IPV6, Type::DGRAM, Some(Protocol::UDP))?;
    sock.set_only_v6(true)?;
    sock.set_reuse_address(true)?;
    #[cfg(all(unix, not(target_os = "android")))]
    {
        let _ = sock.set_reuse_port(true);
    }
    let _ = sock.set_multicast_loop_v6(true);
    let _ = sock.set_multicast_hops_v6(1);
    sock.set_nonblocking(true)?;
    let addr = SocketAddr::V6(SocketAddrV6::new(Ipv6Addr::UNSPECIFIED, bind_port, 0, 0));
    sock.bind(&addr.into())?;
    let std_sock: std::net::UdpSocket = sock.into();
    UdpSocket::from_std(std_sock)
}

pub(crate) fn ipv4_multicast_addrs() -> Vec<Ipv4Addr> {
    let mut seen = HashSet::new();
    let mut nic = Vec::new();
    let mut lo = Vec::new();
    if let Ok(addrs) = get_if_addrs() {
        for iface in addrs {
            if let IfAddr::V4(ref v4) = iface.addr
                && !v4.ip.is_unspecified()
                && seen.insert(v4.ip)
            {
                if iface.is_loopback() {
                    lo.push(v4.ip);
                } else {
                    nic.push(v4.ip);
                }
            }
        }
    }
    if seen.insert(Ipv4Addr::LOCALHOST) {
        lo.push(Ipv4Addr::LOCALHOST);
    }
    nic.extend(lo);
    nic
}

pub(crate) fn join_v4_multicast_group(sock: &UdpSocket, group: Ipv4Addr, addrs: &[Ipv4Addr]) {
    let mut joined = false;
    for &ip in addrs {
        if sock.join_multicast_v4(group, ip).is_ok() {
            joined = true;
        }
    }
    if !joined {
        let _ = sock.join_multicast_v4(group, Ipv4Addr::UNSPECIFIED);
    }
}

pub(crate) fn join_v6_multicast_group(sock: &UdpSocket, group: Ipv6Addr, ifindices: &[u32]) {
    let mut joined = false;
    for &idx in ifindices {
        if sock.join_multicast_v6(&group, idx).is_ok() {
            joined = true;
        }
    }
    if !joined {
        let _ = sock.join_multicast_v6(&group, 0);
    }
}

pub(crate) async fn send_v4_multicast_to(
    sock: &UdpSocket,
    payload: &[u8],
    group: Ipv4Addr,
    udp_port: u16,
    addrs: &[Ipv4Addr],
) {
    let sock_ref = SockRef::from(sock);
    let target = SocketAddr::V4(SocketAddrV4::new(group, udp_port));
    if addrs.is_empty() {
        let _ = sock.send_to(payload, target).await;
        return;
    }
    for &ip in addrs {
        let _ = sock_ref.set_multicast_if_v4(&ip);
        let _ = sock.send_to(payload, target).await;
    }
}

pub(crate) async fn send_v6_multicast_to(
    sock: &UdpSocket,
    payload: &[u8],
    group: Ipv6Addr,
    udp_port: u16,
    ifindices: &[u32],
) {
    let sock_ref = SockRef::from(sock);
    if ifindices.is_empty() {
        let target = SocketAddr::V6(SocketAddrV6::new(group, udp_port, 0, 0));
        let _ = sock.send_to(payload, target).await;
        return;
    }
    for &idx in ifindices {
        let _ = sock_ref.set_multicast_if_v6(idx);
        let target = SocketAddr::V6(SocketAddrV6::new(group, udp_port, 0, idx));
        let _ = sock.send_to(payload, target).await;
    }
}

pub fn start_broadcasting(code: &str, tcp_port: u16) -> Broadcaster {
    let mut b = start_broadcasting_on(code, tcp_port, BROADCAST_PORT);
    if env::var_os("DROP_NO_LAN").is_none_or(|v| v.is_empty()) {
        b.mdns = Some(crate::mdns::start_mdns(code, tcp_port));
    }
    b
}

pub fn start_broadcasting_on(code: &str, tcp_port: u16, udp_port: u16) -> Broadcaster {
    let hash = room_hash(code);
    let (stop_tx, mut stop_rx) = oneshot::channel::<()>();

    let handle = tokio::spawn(async move {
        let v4_sock = create_reusable_udp4(0).ok();
        let v6_sock = create_reusable_udp6(0).ok();
        if v4_sock.is_none() && v6_sock.is_none() {
            return;
        }
        let payload = serde_json::json!({
            "t": "drop-lan",
            "h": hash,
            "p": tcp_port,
        })
        .to_string();
        let v4_targets: Vec<SocketAddr> = get_broadcast_addresses()
            .into_iter()
            .filter_map(|ip| ip.parse::<Ipv4Addr>().ok())
            .map(|ip| SocketAddr::V4(SocketAddrV4::new(ip, udp_port)))
            .collect();
        let v6_ifindices = ipv6_multicast_ifindices();

        let mut tick = interval(Duration::from_millis(600));
        loop {
            tokio::select! {
                _ = &mut stop_rx => break,
                _ = tick.tick() => {
                    if let Some(ref sock) = v4_sock {
                        for &target in &v4_targets {
                            let _ = sock.send_to(payload.as_bytes(), target).await;
                        }
                    }
                    if let Some(ref sock) = v6_sock {
                        send_v6_multicast_to(sock, payload.as_bytes(), MULTICAST_V6, udp_port, &v6_ifindices).await;
                    }
                }
            }
        }
    });

    Broadcaster {
        stop_tx: Some(stop_tx),
        handle: Some(handle),
        mdns: None,
    }
}

async fn recv_matching_lan(sock: &UdpSocket, expected_hash: &str) -> Option<(String, u16)> {
    let mut buf = [0u8; 2048];
    loop {
        let Ok((n, rinfo)) = sock.recv_from(&mut buf).await else {
            return None;
        };
        if let Some(hit) = parse_lan_packet(&buf[..n], rinfo, expected_hash) {
            return Some(hit);
        }
    }
}

pub struct LanListener {
    v4: Option<UdpSocket>,
    v6: Option<UdpSocket>,
}

impl LanListener {
    pub fn bind(udp_port: u16) -> Option<Self> {
        let v4 = create_reusable_udp4(udp_port).ok();
        let v6 = Self::bind_v6_socket(udp_port).ok();
        if v4.is_none() && v6.is_none() {
            return None;
        }
        Some(Self { v4, v6 })
    }

    pub fn bind_v6(udp_port: u16) -> Option<Self> {
        let v6 = Self::bind_v6_socket(udp_port).ok()?;
        Some(Self {
            v4: None,
            v6: Some(v6),
        })
    }

    fn bind_v6_socket(udp_port: u16) -> std::io::Result<UdpSocket> {
        let sock = create_reusable_udp6(udp_port)?;
        let ifindices = ipv6_multicast_ifindices();
        join_v6_multicast_group(&sock, MULTICAST_V6, &ifindices);
        Ok(sock)
    }

    pub fn port(&self) -> Option<u16> {
        self.v6
            .as_ref()
            .or(self.v4.as_ref())
            .and_then(|s| s.local_addr().ok())
            .map(|a| a.port())
    }

    pub async fn accept(&self, code: &str, timeout_ms: u64) -> Option<(String, u16)> {
        let hash = room_hash(code);
        let recv_loop = async {
            match (&self.v4, &self.v6) {
                (Some(s4), Some(s6)) => {
                    let mut f4 = std::pin::pin!(recv_matching_lan(s4, &hash));
                    let mut f6 = std::pin::pin!(recv_matching_lan(s6, &hash));
                    tokio::select! {
                        res = &mut f4 => match res {
                            Some(hit) => Some(hit),
                            None => f6.await,
                        },
                        res = &mut f6 => match res {
                            Some(hit) => Some(hit),
                            None => f4.await,
                        },
                    }
                }
                (Some(s4), None) => recv_matching_lan(s4, &hash).await,
                (None, Some(s6)) => recv_matching_lan(s6, &hash).await,
                (None, None) => None,
            }
        };

        (timeout(Duration::from_millis(timeout_ms), recv_loop).await)
            .ok()
            .flatten()
    }
}

pub async fn listen_for_lan(code: &str, timeout_ms: u64) -> Option<(String, u16)> {
    if env::var_os("DROP_NO_LAN").is_some_and(|v| !v.is_empty()) {
        return None;
    }
    let lan_fut = async {
        let listener = LanListener::bind(BROADCAST_PORT)?;
        listener.accept(code, timeout_ms).await
    };
    let mdns_fut = crate::mdns::listen_mdns(code, timeout_ms);
    let mut f_lan = std::pin::pin!(lan_fut);
    let mut f_mdns = std::pin::pin!(mdns_fut);
    tokio::select! {
        res = &mut f_lan => match res {
            Some(hit) => Some(hit),
            None => f_mdns.await,
        },
        res = &mut f_mdns => match res {
            Some(hit) => Some(hit),
            None => f_lan.await,
        },
    }
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
