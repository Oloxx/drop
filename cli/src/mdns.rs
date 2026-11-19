// Descubrimiento mDNS / DNS-SD (RFC 6762 y RFC 6763) para LAN sin broadcast UDP.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;

use socket2::SockRef;
use tokio::net::UdpSocket;
use tokio::sync::oneshot;
use tokio::task::{JoinHandle, JoinSet};
use tokio::time::{interval, timeout};

use crate::discovery::{
    create_reusable_udp4, create_reusable_udp6, format_peer_host, get_local_ips, get_local_ipv6s,
    ipv4_multicast_addrs, ipv6_multicast_ifindices, join_v4_multicast_group,
    join_v6_multicast_group, room_hash, send_v4_multicast_to, send_v6_multicast_to,
};

pub const MDNS_PORT: u16 = 5353;
pub const MDNS_V4: Ipv4Addr = Ipv4Addr::new(224, 0, 0, 251);
pub const MDNS_V6: Ipv6Addr = Ipv6Addr::new(0xff02, 0, 0, 0, 0, 0, 0, 0xfb);
pub const SERVICE_TYPE: &str = "_drop._tcp.local";

const TYPE_A: u16 = 1;
const TYPE_PTR: u16 = 12;
const TYPE_TXT: u16 = 16;
const TYPE_AAAA: u16 = 28;
const TYPE_SRV: u16 = 33;
const TYPE_ANY: u16 = 255;
const CLASS_IN: u16 = 1;
const CLASS_FLUSH: u16 = 0x8001;
const MDNS_TTL_SEC: u32 = 120;

/// Codifica un nombre DNS en etiquetas de longitud prefijada terminadas en `0x00`.
pub fn encode_dns_name(name: &str) -> Option<Vec<u8>> {
    let trimmed = name.trim_end_matches('.');
    if trimmed.is_empty() {
        return Some(vec![0]);
    }
    let mut out = Vec::with_capacity(trimmed.len() + 2);
    for label in trimmed.split('.') {
        let b = label.as_bytes();
        if b.is_empty() || b.len() > 63 {
            return None;
        }
        out.push(b.len() as u8);
        out.extend_from_slice(b);
    }
    out.push(0);
    Some(out)
}

/// Decodifica un nombre DNS soportando punteros de compresión (RFC 1035 §4.1.4) con protección contra bucles.
pub fn decode_dns_name(pkt: &[u8], start: usize) -> Option<(String, usize)> {
    let mut pos = start;
    let mut next_after = None;
    let mut labels: Vec<String> = Vec::new();
    let mut jumps = 0u8;

    loop {
        let len = *pkt.get(pos)?;
        if len == 0 {
            if next_after.is_none() {
                next_after = Some(pos + 1);
            }
            return Some((labels.join("."), next_after?));
        }
        if (len & 0xC0) == 0xC0 {
            let b2 = *pkt.get(pos + 1)?;
            if next_after.is_none() {
                next_after = Some(pos + 2);
            }
            let target = (((len & 0x3F) as usize) << 8) | (b2 as usize);
            if target >= pkt.len() {
                return None;
            }
            jumps = jumps.checked_add(1)?;
            if jumps > 32 {
                return None;
            }
            pos = target;
            continue;
        }
        if (len & 0xC0) != 0 {
            return None;
        }
        let end = pos.checked_add(1 + len as usize)?;
        let raw = pkt.get(pos + 1..end)?;
        labels.push(String::from_utf8_lossy(raw).into_owned());
        pos = end;
    }
}

fn push_rr_header(out: &mut Vec<u8>, name_wire: &[u8], rtype: u16, rclass: u16, ttl: u32, rdata_len: u16) {
    out.extend_from_slice(name_wire);
    out.extend_from_slice(&rtype.to_be_bytes());
    out.extend_from_slice(&rclass.to_be_bytes());
    out.extend_from_slice(&ttl.to_be_bytes());
    out.extend_from_slice(&rdata_len.to_be_bytes());
}

/// Construye una consulta mDNS `PTR _drop._tcp.local`.
pub fn build_mdns_query(service_type: &str, unicast_response: bool) -> Vec<u8> {
    let mut pkt = Vec::with_capacity(64);
    pkt.extend_from_slice(&[0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
    if let Some(qname) = encode_dns_name(service_type) {
        pkt.extend_from_slice(&qname);
    } else {
        pkt.push(0);
    }
    pkt.extend_from_slice(&TYPE_PTR.to_be_bytes());
    let qclass = if unicast_response { CLASS_FLUSH } else { CLASS_IN };
    pkt.extend_from_slice(&qclass.to_be_bytes());
    pkt
}

/// Construye un paquete de respuesta/anuncio DNS-SD con registros PTR, SRV, TXT (`h=`, `p=`) y A/AAAA opcionales.
pub fn build_mdns_response(
    hash: &str,
    tcp_port: u16,
    a_addrs: &[Ipv4Addr],
    aaaa_addrs: &[Ipv6Addr],
) -> Vec<u8> {
    let service_wire = encode_dns_name(SERVICE_TYPE).unwrap_or_default();
    let instance_fqdn = format!("drop-{hash}.{SERVICE_TYPE}");
    let instance_wire = encode_dns_name(&instance_fqdn).unwrap_or_default();
    let target_fqdn = format!("drop-{hash}.local");
    let target_wire = encode_dns_name(&target_fqdn).unwrap_or_default();

    let ancount = (3 + a_addrs.len() + aaaa_addrs.len()) as u16;
    let mut pkt = Vec::with_capacity(256);
    pkt.extend_from_slice(&0u16.to_be_bytes());
    pkt.extend_from_slice(&0x8400u16.to_be_bytes()); // QR=1, AA=1
    pkt.extend_from_slice(&0u16.to_be_bytes());
    pkt.extend_from_slice(&ancount.to_be_bytes());
    pkt.extend_from_slice(&0u16.to_be_bytes());
    pkt.extend_from_slice(&0u16.to_be_bytes());

    // 1. PTR _drop._tcp.local -> drop-<hash>._drop._tcp.local (compartido: sin bit cache-flush).
    push_rr_header(
        &mut pkt,
        &service_wire,
        TYPE_PTR,
        CLASS_IN,
        MDNS_TTL_SEC,
        instance_wire.len() as u16,
    );
    pkt.extend_from_slice(&instance_wire);

    // 2. SRV drop-<hash>._drop._tcp.local -> puerto TCP y host destino sintetico.
    let srv_len = (6 + target_wire.len()) as u16;
    push_rr_header(
        &mut pkt,
        &instance_wire,
        TYPE_SRV,
        CLASS_FLUSH,
        MDNS_TTL_SEC,
        srv_len,
    );
    pkt.extend_from_slice(&0u16.to_be_bytes()); // priority
    pkt.extend_from_slice(&0u16.to_be_bytes()); // weight
    pkt.extend_from_slice(&tcp_port.to_be_bytes());
    pkt.extend_from_slice(&target_wire);

    // 3. TXT drop-<hash>._drop._tcp.local -> h=<roomHash>, p=<tcpPort>.
    let txt_h = format!("h={hash}");
    let txt_p = format!("p={tcp_port}");
    let txt_len = (1 + txt_h.len() + 1 + txt_p.len()) as u16;
    push_rr_header(
        &mut pkt,
        &instance_wire,
        TYPE_TXT,
        CLASS_FLUSH,
        MDNS_TTL_SEC,
        txt_len,
    );
    pkt.push(txt_h.len() as u8);
    pkt.extend_from_slice(txt_h.as_bytes());
    pkt.push(txt_p.len() as u8);
    pkt.extend_from_slice(txt_p.as_bytes());

    // 4. Registros A / AAAA informativos del host sintetico.
    for ip in a_addrs {
        push_rr_header(&mut pkt, &target_wire, TYPE_A, CLASS_FLUSH, MDNS_TTL_SEC, 4);
        pkt.extend_from_slice(&ip.octets());
    }
    for ip in aaaa_addrs {
        push_rr_header(
            &mut pkt,
            &target_wire,
            TYPE_AAAA,
            CLASS_FLUSH,
            MDNS_TTL_SEC,
            16,
        );
        pkt.extend_from_slice(&ip.octets());
    }

    pkt
}

/// Devuelve `Some(qu)` si el paquete es una consulta mDNS válida para `_drop._tcp.local`.
pub fn is_drop_ptr_query(pkt: &[u8]) -> Option<bool> {
    if pkt.len() < 12 {
        return None;
    }
    let flags = u16::from_be_bytes([pkt[2], pkt[3]]);
    if (flags & 0x8000) != 0 {
        return None;
    }
    let qdcount = u16::from_be_bytes([pkt[4], pkt[5]]) as usize;
    let mut cur = 12usize;
    for _ in 0..qdcount.min(32) {
        let (qname, next) = decode_dns_name(pkt, cur)?;
        if next + 4 > pkt.len() {
            return None;
        }
        let qtype = u16::from_be_bytes([pkt[next], pkt[next + 1]]);
        let qclass_raw = u16::from_be_bytes([pkt[next + 2], pkt[next + 3]]);
        let qclass = qclass_raw & 0x7FFF;
        let qu = (qclass_raw & 0x8000) != 0;
        cur = next + 4;
        if qname.eq_ignore_ascii_case(SERVICE_TYPE)
            && (qtype == TYPE_PTR || qtype == TYPE_ANY)
            && (qclass == CLASS_IN || qclass == TYPE_ANY)
        {
            return Some(qu);
        }
    }
    None
}

fn parse_txt_attrs(rdata: &[u8]) -> (Option<String>, Option<u16>) {
    let mut pos = 0usize;
    let mut hash = None;
    let mut port = None;
    while pos < rdata.len() {
        let len = rdata[pos] as usize;
        pos += 1;
        let Some(end) = pos.checked_add(len) else {
            break;
        };
        let Some(entry) = rdata.get(pos..end) else {
            break;
        };
        pos = end;
        let text = std::str::from_utf8(entry).unwrap_or("");
        if let Some(val) = text.strip_prefix("h=") {
            hash = Some(val.to_string());
        } else if let Some(val) = text.strip_prefix("p=")
            && let Ok(p) = val.parse::<u16>()
            && p != 0
        {
            port = Some(p);
        }
    }
    (hash, port)
}

/// Parsea una respuesta/anuncio mDNS y devuelve `(host, tcp_port)` si coincide con `expected_hash`.
pub fn parse_mdns_response(
    pkt: &[u8],
    rinfo: SocketAddr,
    expected_hash: &str,
) -> Option<(String, u16)> {
    if pkt.len() < 12 {
        return None;
    }
    let flags = u16::from_be_bytes([pkt[2], pkt[3]]);
    if (flags & 0x8000) == 0 {
        return None;
    }
    let qdcount = u16::from_be_bytes([pkt[4], pkt[5]]) as usize;
    let ancount = u16::from_be_bytes([pkt[6], pkt[7]]) as usize;
    let nscount = u16::from_be_bytes([pkt[8], pkt[9]]) as usize;
    let arcount = u16::from_be_bytes([pkt[10], pkt[11]]) as usize;

    let mut cur = 12usize;
    for _ in 0..qdcount.min(32) {
        let (_, next) = decode_dns_name(pkt, cur)?;
        cur = next.checked_add(4)?;
        if cur > pkt.len() {
            return None;
        }
    }

    let mut ptr_instances: Vec<String> = Vec::new();
    let mut srv_map: HashMap<String, (u16, String)> = HashMap::new();
    let mut txt_map: HashMap<String, (Option<String>, Option<u16>)> = HashMap::new();
    let mut host_ips: HashMap<String, IpAddr> = HashMap::new();

    let total_rr = ancount.saturating_add(nscount).saturating_add(arcount).min(128);
    for _ in 0..total_rr {
        if cur >= pkt.len() {
            break;
        }
        let (rr_name, after_name) = decode_dns_name(pkt, cur)?;
        let rdata_start = after_name.checked_add(10)?;
        if rdata_start > pkt.len() {
            return None;
        }
        let rr_type = u16::from_be_bytes([pkt[after_name], pkt[after_name + 1]]);
        let rr_class = u16::from_be_bytes([pkt[after_name + 2], pkt[after_name + 3]]) & 0x7FFF;
        let rdlength = u16::from_be_bytes([pkt[after_name + 8], pkt[after_name + 9]]) as usize;
        let rdata_end = rdata_start.checked_add(rdlength)?;
        if rdata_end > pkt.len() {
            return None;
        }
        cur = rdata_end;

        if rr_class != CLASS_IN {
            continue;
        }
        let name_lc = rr_name.to_ascii_lowercase();
        match rr_type {
            TYPE_PTR if name_lc == SERVICE_TYPE => {
                if let Some((inst, _)) = decode_dns_name(pkt, rdata_start) {
                    ptr_instances.push(inst.to_ascii_lowercase());
                }
            }
            TYPE_SRV if rdlength >= 6 => {
                let port = u16::from_be_bytes([pkt[rdata_start + 4], pkt[rdata_start + 5]]);
                if let Some((target, _)) = decode_dns_name(pkt, rdata_start + 6) {
                    srv_map.insert(name_lc, (port, target.to_ascii_lowercase()));
                }
            }
            TYPE_TXT => {
                txt_map.insert(name_lc, parse_txt_attrs(&pkt[rdata_start..rdata_end]));
            }
            TYPE_A if rdlength == 4 => {
                let ip = Ipv4Addr::new(
                    pkt[rdata_start],
                    pkt[rdata_start + 1],
                    pkt[rdata_start + 2],
                    pkt[rdata_start + 3],
                );
                if !ip.is_unspecified() {
                    host_ips.entry(name_lc).or_insert(IpAddr::V4(ip));
                }
            }
            TYPE_AAAA if rdlength == 16 => {
                let octets: [u8; 16] = pkt[rdata_start..rdata_end].try_into().ok()?;
                let ip = Ipv6Addr::from(octets);
                if !ip.is_unspecified() {
                    host_ips.entry(name_lc).or_insert(IpAddr::V6(ip));
                }
            }
            _ => {}
        }
    }

    for (inst, (hash_opt, txt_port)) in &txt_map {
        if hash_opt.as_deref() != Some(expected_hash) {
            continue;
        }
        if !ptr_instances.is_empty() && !ptr_instances.iter().any(|p| p == inst) {
            continue;
        }
        let srv_entry = srv_map.get(inst);
        let Some(tcp_port) = srv_entry
            .map(|(p, _)| *p)
            .filter(|&p| p != 0)
            .or(*txt_port)
        else {
            continue;
        };

        let host = if !rinfo.ip().is_unspecified() {
            format_peer_host(rinfo)
        } else if let Some((_, target)) = srv_entry
            && let Some(ip) = host_ips.get(target)
        {
            ip.to_string()
        } else {
            continue;
        };

        return Some((host, tcp_port));
    }

    None
}

fn configure_mdns_v4(sock: &UdpSocket) {
    let r = SockRef::from(sock);
    let _ = r.set_multicast_ttl_v4(255);
}

fn configure_mdns_v6(sock: &UdpSocket) {
    let r = SockRef::from(sock);
    let _ = r.set_multicast_hops_v6(255);
}

fn bind_mdns_v4(port: u16, addrs: &[Ipv4Addr]) -> Option<UdpSocket> {
    let sock = create_reusable_udp4(port).ok()?;
    configure_mdns_v4(&sock);
    if port != 0 {
        join_v4_multicast_group(&sock, MDNS_V4, addrs);
    }
    Some(sock)
}

fn bind_mdns_v6(port: u16, ifindices: &[u32]) -> Option<UdpSocket> {
    let sock = create_reusable_udp6(port).ok()?;
    configure_mdns_v6(&sock);
    if port != 0 {
        join_v6_multicast_group(&sock, MDNS_V6, ifindices);
    }
    Some(sock)
}

async fn recv_matching_mdns(sock: &UdpSocket, expected_hash: &str) -> Option<(String, u16)> {
    let mut buf = [0u8; 4096];
    loop {
        let (n, rinfo) = match sock.recv_from(&mut buf).await {
            Ok(v) => v,
            Err(e) if e.kind() == std::io::ErrorKind::ConnectionReset => continue,
            Err(_) => return None,
        };
        if let Some(hit) = parse_mdns_response(&buf[..n], rinfo, expected_hash) {
            return Some(hit);
        }
    }
}

async fn recv_query_ignore_reset(sock: &UdpSocket, buf: &mut [u8]) -> Option<(usize, SocketAddr)> {
    loop {
        match sock.recv_from(buf).await {
            Ok(v) => return Some(v),
            Err(e) if e.kind() == std::io::ErrorKind::ConnectionReset => continue,
            Err(_) => return None,
        }
    }
}

pub struct MdnsResponder {
    stop_tx: Option<oneshot::Sender<()>>,
    handle: Option<JoinHandle<()>>,
    v4_port: Option<u16>,
    v6_port: Option<u16>,
}

impl MdnsResponder {
    pub fn local_v4_port(&self) -> Option<u16> {
        self.v4_port
    }

    pub fn local_v6_port(&self) -> Option<u16> {
        self.v6_port
    }

    pub fn stop(&mut self) {
        if let Some(tx) = self.stop_tx.take() {
            let _ = tx.send(());
        }
        if let Some(h) = self.handle.take() {
            h.abort();
        }
    }
}

impl Drop for MdnsResponder {
    fn drop(&mut self) {
        self.stop();
    }
}

pub fn start_mdns(code: &str, tcp_port: u16) -> MdnsResponder {
    start_mdns_on(code, tcp_port, MDNS_PORT)
}

pub fn start_mdns_on(code: &str, tcp_port: u16, mdns_port: u16) -> MdnsResponder {
    let hash = room_hash(code);
    let v4_ifaces = ipv4_multicast_addrs();
    let v6_ifindices = ipv6_multicast_ifindices();

    // Si 5353 está bloqueado sin SO_REUSEPORT, degradar a puerto efímero para poder seguir emitiendo anuncios multicast.
    let v4_sock = bind_mdns_v4(mdns_port, &v4_ifaces).or_else(|| bind_mdns_v4(0, &v4_ifaces));
    let v6_sock = bind_mdns_v6(mdns_port, &v6_ifindices).or_else(|| bind_mdns_v6(0, &v6_ifindices));

    let v4_port = v4_sock
        .as_ref()
        .and_then(|s| s.local_addr().ok())
        .map(|a| a.port());
    let v6_port = v6_sock
        .as_ref()
        .and_then(|s| s.local_addr().ok())
        .map(|a| a.port());

    if v4_sock.is_none() && v6_sock.is_none() {
        return MdnsResponder {
            stop_tx: None,
            handle: None,
            v4_port: None,
            v6_port: None,
        };
    }

    let a_addrs: Vec<Ipv4Addr> = get_local_ips()
        .into_iter()
        .filter_map(|ip| ip.parse::<Ipv4Addr>().ok())
        .collect();
    let aaaa_addrs: Vec<Ipv6Addr> = get_local_ipv6s()
        .into_iter()
        .filter_map(|ip| ip.parse::<Ipv6Addr>().ok())
        .collect();
    let resp_pkt = build_mdns_response(&hash, tcp_port, &a_addrs, &aaaa_addrs);
    let target_port = if mdns_port != 0 {
        mdns_port
    } else {
        v4_port.or(v6_port).unwrap_or(MDNS_PORT)
    };

    let (stop_tx, mut stop_rx) = oneshot::channel::<()>();
    let handle = tokio::spawn(async move {
        let mut tick = interval(Duration::from_millis(650));
        let mut buf4 = [0u8; 2048];
        let mut buf6 = [0u8; 2048];

        loop {
            tokio::select! {
                _ = &mut stop_rx => break,
                _ = tick.tick() => {
                    if let Some(ref s4) = v4_sock {
                        send_v4_multicast_to(s4, &resp_pkt, MDNS_V4, target_port, &v4_ifaces).await;
                    }
                    if let Some(ref s6) = v6_sock {
                        send_v6_multicast_to(s6, &resp_pkt, MDNS_V6, target_port, &v6_ifindices).await;
                    }
                }
                res4 = async {
                    match v4_sock.as_ref() {
                        Some(s) => recv_query_ignore_reset(s, &mut buf4).await,
                        None => std::future::pending().await,
                    }
                } => {
                    if let Some((n, peer)) = res4
                        && let Some(qu) = is_drop_ptr_query(&buf4[..n])
                        && let Some(ref s4) = v4_sock
                    {
                        if qu || peer.port() != target_port {
                            let _ = s4.send_to(&resp_pkt, peer).await;
                        } else {
                            send_v4_multicast_to(s4, &resp_pkt, MDNS_V4, target_port, &v4_ifaces).await;
                        }
                    }
                }
                res6 = async {
                    match v6_sock.as_ref() {
                        Some(s) => recv_query_ignore_reset(s, &mut buf6).await,
                        None => std::future::pending().await,
                    }
                } => {
                    if let Some((n, peer)) = res6
                        && let Some(qu) = is_drop_ptr_query(&buf6[..n])
                        && let Some(ref s6) = v6_sock
                    {
                        if qu || peer.port() != target_port {
                            let _ = s6.send_to(&resp_pkt, peer).await;
                        } else {
                            send_v6_multicast_to(s6, &resp_pkt, MDNS_V6, target_port, &v6_ifindices).await;
                        }
                    }
                }
            }
        }
    });

    MdnsResponder {
        stop_tx: Some(stop_tx),
        handle: Some(handle),
        v4_port,
        v6_port,
    }
}

enum QueryTarget {
    V4(Vec<Ipv4Addr>),
    V6(Vec<u32>),
}

async fn send_mdns_query(sock: &UdpSocket, pkt: &[u8], mdns_port: u16, target: &QueryTarget) {
    match target {
        QueryTarget::V4(ifaces) => send_v4_multicast_to(sock, pkt, MDNS_V4, mdns_port, ifaces).await,
        QueryTarget::V6(ifindices) => {
            send_v6_multicast_to(sock, pkt, MDNS_V6, mdns_port, ifindices).await
        }
    }
}

async fn query_and_listen_mdns(
    sock: UdpSocket,
    pkt: Vec<u8>,
    mdns_port: u16,
    target: QueryTarget,
    expected_hash: String,
) -> Option<(String, u16)> {
    send_mdns_query(&sock, &pkt, mdns_port, &target).await;
    let wait = tokio::time::sleep(Duration::from_millis(350));
    tokio::pin!(wait);
    tokio::select! {
        hit = recv_matching_mdns(&sock, &expected_hash) => hit,
        _ = &mut wait => {
            send_mdns_query(&sock, &pkt, mdns_port, &target).await;
            recv_matching_mdns(&sock, &expected_hash).await
        }
    }
}

pub async fn listen_mdns(code: &str, timeout_ms: u64) -> Option<(String, u16)> {
    listen_mdns_on(code, timeout_ms, MDNS_PORT).await
}

pub async fn listen_mdns_on(code: &str, timeout_ms: u64, mdns_port: u16) -> Option<(String, u16)> {
    let hash = room_hash(code);
    let v4_ifaces = ipv4_multicast_addrs();
    let v6_ifindices = ipv6_multicast_ifindices();

    let mcast_v4 = if mdns_port != 0 {
        bind_mdns_v4(mdns_port, &v4_ifaces)
    } else {
        None
    };
    let mcast_v6 = if mdns_port != 0 {
        bind_mdns_v6(mdns_port, &v6_ifindices)
    } else {
        None
    };
    let query_v4 = bind_mdns_v4(0, &v4_ifaces);
    let query_v6 = bind_mdns_v6(0, &v6_ifindices);

    if mcast_v4.is_none() && mcast_v6.is_none() && query_v4.is_none() && query_v6.is_none() {
        return None;
    }

    let q_v4_pkt = build_mdns_query(SERVICE_TYPE, mcast_v4.is_none());
    let q_v6_pkt = build_mdns_query(SERVICE_TYPE, mcast_v6.is_none());

    let mut set = JoinSet::new();
    for sock in [mcast_v4, mcast_v6].into_iter().flatten() {
        let h = hash.clone();
        set.spawn(async move { recv_matching_mdns(&sock, &h).await });
    }

    if let Some(q4) = query_v4 {
        set.spawn(query_and_listen_mdns(
            q4,
            q_v4_pkt,
            mdns_port,
            QueryTarget::V4(v4_ifaces),
            hash.clone(),
        ));
    }

    if let Some(q6) = query_v6 {
        set.spawn(query_and_listen_mdns(
            q6,
            q_v6_pkt,
            mdns_port,
            QueryTarget::V6(v6_ifindices),
            hash,
        ));
    }

    let hit = timeout(Duration::from_millis(timeout_ms), async {
        while let Some(res) = set.join_next().await {
            if let Ok(Some(found)) = res {
                return Some(found);
            }
        }
        None
    })
    .await
    .unwrap_or(None);

    set.abort_all();
    hit
}
