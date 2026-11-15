// Cliente NAT-PMP (RFC 6886) para mapeo automático de puertos TCP cuando UPnP IGD no responde.

use std::collections::HashSet;
use std::env;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::time::Duration;

#[cfg(windows)]
use if_addrs::{IfAddr, get_if_addrs};
use tokio::net::UdpSocket;
use tokio::task::JoinSet;
use tokio::time::timeout;

use crate::discovery::get_local_ips;

pub const NATPMP_PORT: u16 = 5351;
const NATPMP_VERSION: u8 = 0;
const OP_PUBLIC_ADDRESS: u8 = 0;
const OP_MAP_TCP: u8 = 2;
const RESP_PUBLIC_ADDRESS: u8 = 128 + OP_PUBLIC_ADDRESS;
const RESP_MAP_TCP: u8 = 128 + OP_MAP_TCP;
const RESULT_OK: u16 = 0;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NatPmpMapResponse {
    pub internal_port: u16,
    pub external_port: u16,
    pub lifetime_sec: u32,
}

#[derive(Debug, Clone)]
pub struct NatPmpRouter {
    pub gateway: SocketAddr,
    pub public_ip: Ipv4Addr,
    pub client_lan_ip: String,
}

pub fn build_public_address_request() -> [u8; 2] {
    [NATPMP_VERSION, OP_PUBLIC_ADDRESS]
}

pub fn parse_public_address_response(buf: &[u8]) -> Result<Ipv4Addr, String> {
    if buf.len() < 12 {
        return Err("Respuesta NAT-PMP de IP pública truncada".to_string());
    }
    if buf[0] != NATPMP_VERSION || buf[1] != RESP_PUBLIC_ADDRESS {
        return Err("Cabecera NAT-PMP inválida en IP pública".to_string());
    }
    let code = u16::from_be_bytes([buf[2], buf[3]]);
    if code != RESULT_OK {
        return Err(format!("NAT-PMP devolvió código de error {code}"));
    }
    Ok(Ipv4Addr::new(buf[8], buf[9], buf[10], buf[11]))
}

pub fn build_map_tcp_request(
    internal_port: u16,
    external_port: u16,
    lifetime_sec: u32,
) -> [u8; 12] {
    let mut pkt = [0u8; 12];
    pkt[0] = NATPMP_VERSION;
    pkt[1] = OP_MAP_TCP;
    pkt[4..6].copy_from_slice(&internal_port.to_be_bytes());
    pkt[6..8].copy_from_slice(&external_port.to_be_bytes());
    pkt[8..12].copy_from_slice(&lifetime_sec.to_be_bytes());
    pkt
}

pub fn parse_map_tcp_response(
    buf: &[u8],
    expected_internal_port: u16,
) -> Result<NatPmpMapResponse, String> {
    if buf.len() < 16 {
        return Err("Respuesta NAT-PMP de mapeo truncada".to_string());
    }
    if buf[0] != NATPMP_VERSION || buf[1] != RESP_MAP_TCP {
        return Err("Cabecera NAT-PMP inválida en mapeo TCP".to_string());
    }
    let code = u16::from_be_bytes([buf[2], buf[3]]);
    if code != RESULT_OK {
        return Err(format!("NAT-PMP devolvió código de error {code}"));
    }
    let internal_port = u16::from_be_bytes([buf[8], buf[9]]);
    if internal_port != expected_internal_port {
        return Err(format!(
            "NAT-PMP devolvió puerto interno {internal_port} distinto de {expected_internal_port}"
        ));
    }
    let external_port = u16::from_be_bytes([buf[10], buf[11]]);
    let lifetime_sec = u32::from_be_bytes([buf[12], buf[13], buf[14], buf[15]]);
    Ok(NatPmpMapResponse {
        internal_port,
        external_port,
        lifetime_sec,
    })
}

/// Extrae puertas de enlace por defecto de `/proc/net/route` (Linux escribe IPv4 en endianness nativo).
pub fn parse_proc_net_route(contents: &str) -> Vec<Ipv4Addr> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for line in contents.lines().skip(1) {
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 3 || cols[1] != "00000000" {
            continue;
        }
        if let Ok(raw) = u32::from_str_radix(cols[2], 16) {
            let gw = Ipv4Addr::from(raw.to_ne_bytes());
            if !gw.is_unspecified() && seen.insert(gw) {
                out.push(gw);
            }
        }
    }
    out
}

/// Extrae `gateway: <ipv4>` de la salida de `route -n get default` (macOS / BSD).
pub fn parse_bsd_default_route(stdout: &str) -> Option<Ipv4Addr> {
    for line in stdout.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("gateway:")
            && let Ok(gw) = rest.trim().parse::<Ipv4Addr>()
            && !gw.is_unspecified()
        {
            return Some(gw);
        }
    }
    None
}

#[cfg(target_os = "linux")]
fn os_default_gateways() -> Vec<Ipv4Addr> {
    match std::fs::read_to_string("/proc/net/route") {
        Ok(text) => parse_proc_net_route(&text),
        Err(_) => Vec::new(),
    }
}

#[cfg(windows)]
fn os_default_gateways() -> Vec<Ipv4Addr> {
    use winreg::RegKey;
    use winreg::enums::HKEY_LOCAL_MACHINE;

    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let Ok(addrs) = get_if_addrs() else {
        return out;
    };
    let mut adapters = Vec::new();
    let mut seen_adapters = HashSet::new();
    for iface in addrs {
        if !iface.is_loopback()
            && matches!(iface.addr, IfAddr::V4(_))
            && seen_adapters.insert(iface.adapter_name.clone())
        {
            adapters.push(iface.adapter_name);
        }
    }
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    for adapter in adapters {
        let subkey = format!(
            "SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces\\{adapter}"
        );
        let Ok(key) = hklm.open_subkey(&subkey) else {
            continue;
        };
        for value_name in ["DefaultGateway", "DhcpDefaultGateway"] {
            if let Ok(list) = key.get_value::<Vec<String>, _>(value_name) {
                for s in list {
                    if let Ok(ip) = s.trim().parse::<Ipv4Addr>()
                        && !ip.is_unspecified()
                        && seen.insert(ip)
                    {
                        out.push(ip);
                    }
                }
            }
        }
    }
    out
}

#[cfg(all(unix, not(target_os = "linux")))]
fn os_default_gateways() -> Vec<Ipv4Addr> {
    let Ok(output) = std::process::Command::new("route")
        .args(["-n", "get", "default"])
        .output()
    else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&output.stdout);
    parse_bsd_default_route(&text).into_iter().collect()
}

pub fn has_explicit_gateway_override() -> bool {
    env::var("DROP_NATPMP_GATEWAY")
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false)
}

pub fn discover_gateway_addrs() -> Vec<SocketAddr> {
    if let Ok(raw) = env::var("DROP_NATPMP_GATEWAY")
        && !raw.trim().is_empty()
    {
        let mut out = Vec::new();
        for tok in raw.split([',', ' ']) {
            let s = tok.trim();
            if s.is_empty() {
                continue;
            }
            if let Ok(addr) = s.parse::<SocketAddr>() {
                out.push(addr);
            } else if let Ok(ip) = s.parse::<Ipv4Addr>() {
                out.push(SocketAddr::V4(SocketAddrV4::new(ip, NATPMP_PORT)));
            }
        }
        return out;
    }

    let mut seen = HashSet::new();
    let mut addrs = Vec::new();
    for gw in os_default_gateways() {
        if seen.insert(gw) {
            addrs.push(SocketAddr::V4(SocketAddrV4::new(gw, NATPMP_PORT)));
        }
    }
    if addrs.is_empty() {
        for local_ip in get_local_ips() {
            if let Ok(v4) = local_ip.parse::<Ipv4Addr>() {
                let o = v4.octets();
                let guess = Ipv4Addr::new(o[0], o[1], o[2], 1);
                if guess != v4 && seen.insert(guess) {
                    addrs.push(SocketAddr::V4(SocketAddrV4::new(guess, NATPMP_PORT)));
                }
            }
        }
    }
    addrs
}

async fn natpmp_exchange(
    gateway: SocketAddr,
    req: &[u8],
    timeout_ms: u64,
) -> Option<(Vec<u8>, String)> {
    let sock = UdpSocket::bind("0.0.0.0:0").await.ok()?;
    sock.connect(gateway).await.ok()?;
    let client_lan_ip = sock
        .local_addr()
        .map(|a| a.ip().to_string())
        .unwrap_or_default();
    let per_try = (timeout_ms / 2).clamp(150, 1000);
    let mut buf = [0u8; 64];

    for _ in 0..2 {
        if sock.send(req).await.is_err() {
            return None;
        }
        match timeout(Duration::from_millis(per_try), sock.recv(&mut buf)).await {
            Ok(Ok(n)) => return Some((buf[..n].to_vec(), client_lan_ip)),
            Ok(Err(_)) => return None,
            Err(_) => continue,
        }
    }
    None
}

async fn probe_gateways(gateways: Vec<SocketAddr>, timeout_ms: u64) -> Option<NatPmpRouter> {
    if gateways.is_empty() {
        return None;
    }

    let mut set = JoinSet::new();
    let req = build_public_address_request();
    for gw in gateways {
        set.spawn(async move {
            let (resp, client_lan_ip) = natpmp_exchange(gw, &req, timeout_ms).await?;
            let public_ip = parse_public_address_response(&resp).ok()?;
            Some(NatPmpRouter {
                gateway: gw,
                public_ip,
                client_lan_ip,
            })
        });
    }

    let found = timeout(Duration::from_millis(timeout_ms), async {
        while let Some(res) = set.join_next().await {
            if let Ok(Some(router)) = res {
                return Some(router);
            }
        }
        None
    })
    .await
    .unwrap_or(None);

    set.abort_all();
    found
}

pub async fn probe_natpmp_on(gateway: SocketAddr, timeout_ms: u64) -> Option<NatPmpRouter> {
    probe_gateways(vec![gateway], timeout_ms).await
}

pub async fn probe_natpmp(timeout_ms: u64) -> Option<NatPmpRouter> {
    if env::var_os("DROP_NO_UPNP").is_some_and(|v| !v.is_empty())
        || env::var_os("DROP_NO_NATPMP").is_some_and(|v| !v.is_empty())
    {
        return None;
    }

    probe_gateways(discover_gateway_addrs(), timeout_ms).await
}

pub async fn map_natpmp_port(
    gateway: SocketAddr,
    internal_port: u16,
    preferred_external_port: u16,
    lifetime_sec: u32,
    timeout_ms: u64,
) -> Result<NatPmpMapResponse, String> {
    let req = build_map_tcp_request(internal_port, preferred_external_port, lifetime_sec);
    let Some((resp, _)) = natpmp_exchange(gateway, &req, timeout_ms).await else {
        return Err(format!("Sin respuesta NAT-PMP de {gateway}"));
    };
    parse_map_tcp_response(&resp, internal_port)
}

/// Borrado síncrono rápido de un mapeo NAT-PMP (`lifetime = 0`) para señales / Drop.
pub fn unmap_natpmp_sync(gateway: SocketAddr, internal_port: u16) -> bool {
    let Ok(sock) = std::net::UdpSocket::bind("0.0.0.0:0") else {
        return false;
    };
    if sock.connect(gateway).is_err() {
        return false;
    }
    let pkt = build_map_tcp_request(internal_port, 0, 0);
    sock.send(&pkt).is_ok()
}
