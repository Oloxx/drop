// Cliente STUN minimo RFC 5389 para descubrir la IP publica en transferencia P2P.

use std::collections::HashSet;
use std::env;
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;

use rand::RngCore;
use tokio::net::{UdpSocket, lookup_host};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio::time::timeout;

use crate::upnp::UpnpResult;

const STUN_BINDING_REQUEST: u16 = 0x0001;
const STUN_BINDING_RESPONSE: u16 = 0x0101;
const STUN_MAGIC_COOKIE: u32 = 0x2112_a442;
const ATTR_MAPPED_ADDRESS: u16 = 0x0001;
const ATTR_XOR_MAPPED_ADDRESS: u16 = 0x0020;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StunServer {
    pub host: String,
    pub port: u16,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StunEndpoint {
    pub ip: String,
    pub port: u16,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StunResult {
    pub ip: String,
    pub port: u16,
    pub server: String,
}

#[derive(Debug, Clone)]
pub struct OfferCandidates {
    pub candidate_ips: Vec<String>,
    pub upnp: Option<UpnpResult>,
    pub stun: Option<StunResult>,
}

pub fn default_stun_servers() -> Vec<StunServer> {
    vec![
        StunServer { host: "stun.l.google.com".into(), port: 19302 },
        StunServer { host: "stun1.l.google.com".into(), port: 19302 },
        StunServer { host: "stun.cloudflare.com".into(), port: 3478 },
    ]
}

pub fn build_binding_request(tx_id: &[u8; 12]) -> [u8; 20] {
    let mut buf = [0u8; 20];
    buf[0..2].copy_from_slice(&STUN_BINDING_REQUEST.to_be_bytes());
    buf[2..4].copy_from_slice(&0u16.to_be_bytes());
    buf[4..8].copy_from_slice(&STUN_MAGIC_COOKIE.to_be_bytes());
    buf[8..20].copy_from_slice(tx_id);
    buf
}

fn format_address(family: u8, raw: &[u8]) -> Option<String> {
    if family == 1 && raw.len() == 4 {
        return Some(Ipv4Addr::new(raw[0], raw[1], raw[2], raw[3]).to_string());
    }
    if family == 2 && raw.len() == 16 {
        let mut octets = [0u8; 16];
        octets.copy_from_slice(raw);
        return Some(Ipv6Addr::from(octets).to_string());
    }
    None
}

fn parse_address_attr(val: &[u8], xor: bool, tx_id: &[u8; 12]) -> Option<StunEndpoint> {
    if val.len() < 4 {
        return None;
    }
    let family = val[1];
    let addr_len = match family {
        1 => 4,
        2 => 16,
        _ => return None,
    };
    if val.len() < 4 + addr_len {
        return None;
    }

    let raw_port = u16::from_be_bytes([val[2], val[3]]);
    let port = if xor {
        raw_port ^ ((STUN_MAGIC_COOKIE >> 16) as u16)
    } else {
        raw_port
    };

    let mut raw_addr = val[4..4 + addr_len].to_vec();
    if xor {
        let mut mask = [0u8; 16];
        mask[0..4].copy_from_slice(&STUN_MAGIC_COOKIE.to_be_bytes());
        mask[4..16].copy_from_slice(tx_id);
        for (b, m) in raw_addr.iter_mut().zip(mask.iter()) {
            *b ^= *m;
        }
    }

    let ip = format_address(family, &raw_addr)?;
    Some(StunEndpoint { ip, port })
}

pub fn parse_binding_response(buf: &[u8], expected_tx: Option<&[u8; 12]>) -> Option<StunEndpoint> {
    if buf.len() < 20 {
        return None;
    }
    let msg_type = u16::from_be_bytes([buf[0], buf[1]]);
    if msg_type != STUN_BINDING_RESPONSE {
        return None;
    }
    let cookie = u32::from_be_bytes([buf[4], buf[5], buf[6], buf[7]]);
    if cookie != STUN_MAGIC_COOKIE {
        return None;
    }
    let mut tx_id = [0u8; 12];
    tx_id.copy_from_slice(&buf[8..20]);
    if let Some(exp) = expected_tx
        && &tx_id != exp
    {
        return None;
    }

    let msg_len = u16::from_be_bytes([buf[2], buf[3]]) as usize;
    let end = buf.len().min(20 + msg_len);
    let mut offset = 20usize;
    let mut fallback = None;

    while offset + 4 <= end {
        let attr_type = u16::from_be_bytes([buf[offset], buf[offset + 1]]);
        let attr_len = u16::from_be_bytes([buf[offset + 2], buf[offset + 3]]) as usize;
        let val_start = offset + 4;
        if val_start + attr_len > end {
            break;
        }
        let val = &buf[val_start..val_start + attr_len];
        if attr_type == ATTR_XOR_MAPPED_ADDRESS {
            if let Some(parsed) = parse_address_attr(val, true, &tx_id) {
                return Some(parsed);
            }
        } else if attr_type == ATTR_MAPPED_ADDRESS
            && fallback.is_none()
        {
            fallback = parse_address_attr(val, false, &tx_id);
        }
        offset = val_start + ((attr_len + 3) & !3);
    }

    fallback
}

/// Acepta `host:port`, `stun:host:port`, `[ipv6]:port` o `host`.
pub fn parse_stun_server(spec: &str) -> Option<StunServer> {
    let trimmed = spec.trim();
    let clean = if trimmed.len() >= 5 && trimmed[..5].eq_ignore_ascii_case("stun:") {
        &trimmed[5..]
    } else {
        trimmed
    };
    if clean.is_empty() {
        return None;
    }
    if let Some(rest) = clean.strip_prefix('[')
        && let Some((host, after)) = rest.split_once(']')
    {
        let port = after
            .strip_prefix(':')
            .and_then(|p| p.parse::<u16>().ok())
            .filter(|&p| p > 0)
            .unwrap_or(3478);
        return Some(StunServer {
            host: host.to_string(),
            port,
        });
    }
    if let Some((host, port_str)) = clean.rsplit_once(':')
        && !host.is_empty()
        && !host.contains(':')
        && !port_str.is_empty()
        && port_str.bytes().all(|b| b.is_ascii_digit())
    {
        let port = port_str.parse::<u16>().unwrap_or(3478);
        return Some(StunServer {
            host: host.to_string(),
            port: if port == 0 { 3478 } else { port },
        });
    }
    Some(StunServer {
        host: clean.to_string(),
        port: 3478,
    })
}

fn resolve_configured_servers(servers: Option<&[StunServer]>) -> Vec<StunServer> {
    if let Some(s) = servers
        && !s.is_empty()
    {
        return s.to_vec();
    }
    if let Ok(env_val) = env::var("DROP_STUN_SERVER")
        && !env_val.is_empty()
    {
        let custom: Vec<StunServer> = env_val
            .split(',')
            .filter_map(parse_stun_server)
            .collect();
        if !custom.is_empty() {
            return custom;
        }
    }
    default_stun_servers()
}

pub async fn query_stun(server: &StunServer, timeout_ms: u64, ipv6: bool) -> Option<StunResult> {
    let target_addr: SocketAddr = if let Ok(ip) = server.host.parse() {
        SocketAddr::new(ip, server.port)
    } else {
        let Ok(resolved) = lookup_host((server.host.as_str(), server.port)).await else {
            return None;
        };
        resolved.into_iter().find(|a| a.is_ipv6() == ipv6)?
    };

    let bind_addr = if target_addr.is_ipv6() { "[::]:0" } else { "0.0.0.0:0" };
    let sock = UdpSocket::bind(bind_addr).await.ok()?;
    let mut tx_id = [0u8; 12];
    rand::rngs::OsRng.fill_bytes(&mut tx_id);
    let req = build_binding_request(&tx_id);

    let fut = async {
        sock.send_to(&req, target_addr).await.ok()?;
        let mut retry_tick = tokio::time::interval(Duration::from_millis(600));
        retry_tick.tick().await;
        let mut retries_left = 2u8;
        let mut buf = [0u8; 1024];
        loop {
            tokio::select! {
                _ = retry_tick.tick(), if retries_left > 0 => {
                    retries_left -= 1;
                    let _ = sock.send_to(&req, target_addr).await;
                }
                recv = sock.recv_from(&mut buf) => {
                    let (n, _) = match recv {
                        Ok(v) => v,
                        Err(e) if matches!(
                            e.kind(),
                            std::io::ErrorKind::ConnectionReset
                                | std::io::ErrorKind::WouldBlock
                                | std::io::ErrorKind::Interrupted
                        ) => {
                            continue;
                        }
                        Err(_) => return None,
                    };
                    if let Some(ep) = parse_binding_response(&buf[..n], Some(&tx_id)) {
                        return Some(StunResult {
                            ip: ep.ip,
                            port: ep.port,
                            server: format!("{}:{}", server.host, server.port),
                        });
                    }
                }
            }
        }
    };

    (timeout(Duration::from_millis(timeout_ms), fut).await).unwrap_or(None)
}

pub async fn discover_public_ip(
    servers: Option<&[StunServer]>,
    timeout_ms: u64,
) -> Option<StunResult> {
    if env::var_os("DROP_NO_STUN").is_some_and(|v| !v.is_empty()) {
        return None;
    }
    let list = resolve_configured_servers(servers);
    if list.is_empty() {
        return None;
    }

    let (tx, mut rx) = mpsc::channel::<Option<StunResult>>(list.len());
    let mut handles = Vec::with_capacity(list.len());
    for srv in list {
        let tx = tx.clone();
        handles.push(tokio::spawn(async move {
            let res = query_stun(&srv, timeout_ms, false).await;
            let _ = tx.send(res).await;
        }));
    }
    drop(tx);

    let result = timeout(Duration::from_millis(timeout_ms), async {
        while let Some(item) = rx.recv().await {
            if item.is_some() {
                return item;
            }
        }
        None
    })
    .await
    .unwrap_or_default();

    for h in handles {
        h.abort();
    }
    result
}

pub fn merge_offer_candidates(
    local_ips: &[String],
    upnp: Option<UpnpResult>,
    stun: Option<StunResult>,
    ws_public_ip: Option<&str>,
    force_relay: bool,
) -> OfferCandidates {
    if force_relay {
        return OfferCandidates {
            candidate_ips: Vec::new(),
            upnp: None,
            stun: None,
        };
    }

    let mut seen: HashSet<String> = HashSet::new();
    let mut candidate_ips = Vec::with_capacity(local_ips.len() + 3);
    for ip in local_ips {
        if seen.insert(ip.clone()) {
            candidate_ips.push(ip.clone());
        }
    }
    if let Some(ref u) = upnp
        && let Some(ref ip) = u.public_ip
        && !ip.is_empty()
        && seen.insert(ip.clone())
    {
        candidate_ips.push(ip.clone());
    }
    if let Some(ref s) = stun
        && !s.ip.is_empty()
        && seen.insert(s.ip.clone())
    {
        candidate_ips.push(s.ip.clone());
    }
    if let Some(ip) = ws_public_ip
        && !ip.is_empty()
        && seen.insert(ip.to_string())
    {
        candidate_ips.push(ip.to_string());
    }

    OfferCandidates {
        candidate_ips,
        upnp,
        stun,
    }
}

/// Espera con techo (`timeout_ms`) por UPnP y STUN y devuelve las candidatas combinadas.
pub async fn resolve_offer_candidates(
    local_ips: &[String],
    upnp_fut: Option<JoinHandle<Option<UpnpResult>>>,
    stun_fut: Option<JoinHandle<Option<StunResult>>>,
    ws_public_ip: Option<&str>,
    force_relay: bool,
    timeout_ms: u64,
) -> OfferCandidates {
    if force_relay {
        return OfferCandidates {
            candidate_ips: Vec::new(),
            upnp: None,
            stun: None,
        };
    }

    async fn wait_bounded<T>(h: Option<JoinHandle<Option<T>>>, ms: u64) -> Option<T> {
        let handle = h?;
        match timeout(Duration::from_millis(ms), handle).await {
            Ok(Ok(res)) => res,
            _ => None,
        }
    }

    let (upnp, stun) = tokio::join!(
        wait_bounded(upnp_fut, timeout_ms),
        wait_bounded(stun_fut, timeout_ms.min(1000))
    );
    merge_offer_candidates(local_ips, upnp, stun, ws_public_ip, false)
}
