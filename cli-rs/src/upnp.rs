// Modulo UPnP (IGD) y respaldo NAT-PMP (RFC 6886) / PCP (RFC 6887) para mapeo automatico de puertos TCP en routers residenciales.

use std::collections::HashSet;
use std::env;
use std::io::{ErrorKind, Write};
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use rand::Rng;
use regex::Regex;
use reqwest::Client;
use socket2::{Domain, Protocol, Socket, Type};
use tokio::net::UdpSocket;
use tokio::sync::Mutex;
use tokio::task::{JoinHandle, JoinSet};
use tokio::time::{interval, timeout};
use url::Url;

use crate::discovery::get_local_ips;
use crate::natpmp::{
    NatPmpRouter, PcpMapped, build_map_tcp_request, build_pcp_map_tcp_request,
    discover_gateway_ips, has_explicit_gateway_override, map_natpmp_port, map_pcp_port,
    probe_and_map_pcp, probe_and_map_pcp_on, probe_natpmp, probe_natpmp_on, unmap_natpmp_sync,
    unmap_pcp_sync,
};

#[derive(Debug, Clone)]
pub struct UpnpRouter {
    pub control_url: String,
    pub service_type: String,
    pub router_ip: String,
    pub client_lan_ip: String,
}

#[derive(Debug, Clone)]
pub struct UpnpResult {
    pub success: bool,
    pub external_port: Option<u16>,
    pub public_ip: Option<String>,
    pub router_ip: Option<String>,
    pub client_lan_ip: Option<String>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone)]
enum MappingBackend {
    Upnp {
        control_url: String,
        service_type: String,
        internal_port: u16,
        lease_sec: u32,
    },
    NatPmp {
        gateway: SocketAddr,
        internal_port: u16,
        lease_sec: u32,
    },
    Pcp {
        gateway: SocketAddr,
        client_ip: Ipv4Addr,
        nonce: [u8; 12],
        internal_port: u16,
        lease_sec: u32,
    },
}

pub struct UpnpMapping {
    pub external_port: u16,
    pub public_ip: Option<String>,
    pub router_ip: String,
    pub client_lan_ip: String,
    backend: MappingBackend,
    unmapped: Arc<AtomicBool>,
    renew_task: Mutex<Option<JoinHandle<()>>>,
}

impl UpnpMapping {
    pub fn protocol_label(&self) -> &'static str {
        match self.backend {
            MappingBackend::Upnp { .. } => "UPnP",
            MappingBackend::NatPmp { .. } => "NAT-PMP",
            MappingBackend::Pcp { .. } => "PCP",
        }
    }

    pub fn as_result(&self) -> UpnpResult {
        UpnpResult {
            success: true,
            external_port: Some(self.external_port),
            public_ip: self.public_ip.clone(),
            router_ip: Some(self.router_ip.clone()),
            client_lan_ip: Some(self.client_lan_ip.clone()),
            reason: None,
        }
    }

    pub async fn renew(&self) -> bool {
        if self.unmapped.load(Ordering::SeqCst) {
            return false;
        }
        match &self.backend {
            MappingBackend::Upnp {
                control_url,
                service_type,
                internal_port,
                lease_sec,
            } => {
                let soap = build_add_port_mapping_soap(
                    service_type,
                    self.external_port,
                    *internal_port,
                    &self.client_lan_ip,
                    "drop-p2p",
                    *lease_sec,
                );
                let Ok(client) = Client::builder().timeout(Duration::from_secs(5)).build() else {
                    return false;
                };
                let Ok(res) = client
                    .post(control_url)
                    .header("Content-Type", "text/xml; charset=\"utf-8\"")
                    .header("SOAPAction", format!("\"{service_type}#AddPortMapping\""))
                    .body(soap)
                    .send()
                    .await
                else {
                    return false;
                };
                res.status().is_success()
            }
            MappingBackend::NatPmp {
                gateway,
                internal_port,
                lease_sec,
            } => map_natpmp_port(*gateway, *internal_port, self.external_port, *lease_sec, 1500)
                .await
                .is_ok(),
            MappingBackend::Pcp {
                gateway,
                client_ip,
                nonce,
                internal_port,
                lease_sec,
            } => map_pcp_port(
                *gateway,
                *client_ip,
                nonce,
                *internal_port,
                self.external_port,
                *lease_sec,
                1500,
            )
            .await
            .is_ok(),
        }
    }

    pub async fn unmap(&self) {
        if self.unmapped.swap(true, Ordering::SeqCst) {
            return;
        }
        if let Some(h) = self.renew_task.lock().await.take() {
            h.abort();
        }
        match &self.backend {
            MappingBackend::Upnp {
                control_url,
                service_type,
                ..
            } => {
                let soap = build_delete_port_mapping_soap(service_type, self.external_port);
                if let Ok(client) = Client::builder().timeout(Duration::from_secs(3)).build() {
                    let _ = client
                        .post(control_url)
                        .header("Content-Type", "text/xml; charset=\"utf-8\"")
                        .header(
                            "SOAPAction",
                            format!("\"{service_type}#DeletePortMapping\""),
                        )
                        .body(soap)
                        .send()
                        .await;
                }
            }
            MappingBackend::NatPmp {
                gateway,
                internal_port,
                ..
            } => {
                if let Ok(sock) = UdpSocket::bind("0.0.0.0:0").await
                    && sock.connect(*gateway).await.is_ok()
                {
                    let pkt = build_map_tcp_request(*internal_port, 0, 0);
                    let _ = sock.send(&pkt).await;
                }
            }
            MappingBackend::Pcp {
                gateway,
                client_ip,
                nonce,
                internal_port,
                ..
            } => {
                if let Ok(sock) = UdpSocket::bind("0.0.0.0:0").await
                    && sock.connect(*gateway).await.is_ok()
                {
                    let pkt = build_pcp_map_tcp_request(*client_ip, nonce, *internal_port, 0, 0);
                    let _ = sock.send(&pkt).await;
                }
            }
        }
    }

    /// Borrado sincrono rapido por socket para usar en señales/salidas sin runtime async.
    pub fn unmap_sync(&self) {
        if self.unmapped.swap(true, Ordering::SeqCst) {
            return;
        }
        match &self.backend {
            MappingBackend::Upnp {
                control_url,
                service_type,
                ..
            } => {
                let soap = build_delete_port_mapping_soap(service_type, self.external_port);
                send_delete_port_mapping_sync(control_url, service_type, &soap);
            }
            MappingBackend::NatPmp {
                gateway,
                internal_port,
                ..
            } => {
                unmap_natpmp_sync(*gateway, *internal_port);
            }
            MappingBackend::Pcp {
                gateway,
                client_ip,
                nonce,
                internal_port,
                ..
            } => {
                unmap_pcp_sync(*gateway, *client_ip, nonce, *internal_port);
            }
        }
    }
}

impl Drop for UpnpMapping {
    fn drop(&mut self) {
        if !self.unmapped.load(Ordering::SeqCst) {
            self.unmap_sync();
        }
    }
}

pub fn build_add_port_mapping_soap(
    service_type: &str,
    external_port: u16,
    internal_port: u16,
    client_lan_ip: &str,
    description: &str,
    lease_sec: u32,
) -> String {
    format!(
        r#"<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
<s:Body>
  <u:AddPortMapping xmlns:u="{service_type}">
    <NewRemoteHost></NewRemoteHost>
    <NewExternalPort>{external_port}</NewExternalPort>
    <NewProtocol>TCP</NewProtocol>
    <NewInternalPort>{internal_port}</NewInternalPort>
    <NewInternalClient>{client_lan_ip}</NewInternalClient>
    <NewEnabled>1</NewEnabled>
    <NewPortMappingDescription>{description}</NewPortMappingDescription>
    <NewLeaseDuration>{lease_sec}</NewLeaseDuration>
  </u:AddPortMapping>
</s:Body>
</s:Envelope>"#
    )
}

pub fn build_delete_port_mapping_soap(service_type: &str, external_port: u16) -> String {
    format!(
        r#"<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
<s:Body>
  <u:DeletePortMapping xmlns:u="{service_type}">
    <NewRemoteHost></NewRemoteHost>
    <NewExternalPort>{external_port}</NewExternalPort>
    <NewProtocol>TCP</NewProtocol>
  </u:DeletePortMapping>
</s:Body>
</s:Envelope>"#
    )
}

pub fn is_conflict_error(_status: u16, body_text: &str) -> bool {
    if body_text.is_empty() {
        return false;
    }
    let lower = body_text.to_ascii_lowercase();
    if lower.contains("conflictinmappingentry") {
        return true;
    }
    let code_re = Regex::new(r"(?i)<errorCode>\s*718\s*</errorCode>").unwrap();
    if code_re.is_match(body_text) {
        return true;
    }
    body_text.contains("718") && (lower.contains("upnperror") || lower.contains("fault"))
}

pub fn get_next_candidate_port(
    base_port: u16,
    attempt: usize,
    tried_ports: &HashSet<u16>,
) -> u16 {
    if attempt <= 3 {
        let candidate = base_port as u32 + attempt as u32;
        if (1024..=65535).contains(&candidate) && !tried_ports.contains(&(candidate as u16)) {
            return candidate as u16;
        }
    }

    let mut rng = rand::thread_rng();
    for _ in 0..100 {
        let candidate = rng.gen_range(10240u16..=65535u16);
        if !tried_ports.contains(&candidate) {
            return candidate;
        }
    }

    base_port.saturating_add(attempt as u16)
}

pub fn send_delete_port_mapping_sync(control_url: &str, service_type: &str, soap_del: &str) -> bool {
    let Ok(url) = Url::parse(control_url) else {
        return false;
    };
    let Some(host) = url.host_str() else {
        return false;
    };
    let port = url.port_or_known_default().unwrap_or(80);
    let path = if let Some(q) = url.query() {
        format!("{}?{q}", url.path())
    } else {
        url.path().to_string()
    };
    let Ok(mut stream) =
        std::net::TcpStream::connect_timeout(&format!("{host}:{port}").parse().unwrap_or_else(|_| SocketAddr::from(([127, 0, 0, 1], port))), Duration::from_secs(2))
    else {
        // Fallback por si `host` necesita resolucion DNS
        let Ok(stream) = std::net::TcpStream::connect((host, port)) else {
            return false;
        };
        return send_raw_http(stream, host, port, &path, service_type, soap_del);
    };
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    send_raw_http_ref(&mut stream, host, port, &path, service_type, soap_del)
}

fn send_raw_http(
    mut stream: std::net::TcpStream,
    host: &str,
    port: u16,
    path: &str,
    service_type: &str,
    soap: &str,
) -> bool {
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    send_raw_http_ref(&mut stream, host, port, path, service_type, soap)
}

fn send_raw_http_ref(
    stream: &mut std::net::TcpStream,
    host: &str,
    port: u16,
    path: &str,
    service_type: &str,
    soap: &str,
) -> bool {
    let req = format!(
        "POST {path} HTTP/1.1\r\nHost: {host}:{port}\r\nContent-Type: text/xml; charset=\"utf-8\"\r\nSOAPAction: \"{service_type}#DeletePortMapping\"\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{soap}",
        soap.len()
    );
    stream.write_all(req.as_bytes()).is_ok()
}

pub fn parse_description_xml(xml: &str, location: &str) -> Option<(String, String)> {
    let svc_re = Regex::new(r"(?is)<service>.*?</service>").unwrap();
    let type_re = Regex::new(
        r"(?i)<serviceType>\s*(urn:schemas-upnp-org:service:WAN(?:IP|PPP)Connection:[^<]+)\s*</serviceType>",
    )
    .unwrap();
    let url_re = Regex::new(r"(?i)<controlURL>\s*([^<]+)\s*</controlURL>").unwrap();
    let base = Url::parse(location).ok()?;

    for m in svc_re.find_iter(xml) {
        let block = m.as_str();
        if let (Some(tc), Some(uc)) = (type_re.captures(block), url_re.captures(block)) {
            let service_type = tc[1].trim().to_string();
            let control_path = uc[1].trim();
            if let Ok(resolved) = base.join(control_path) {
                return Some((service_type, resolved.to_string()));
            }
        }
    }
    None
}

pub async fn discover_router(timeout_ms: u64) -> Option<UpnpRouter> {
    let local_ips = get_local_ips();
    if local_ips.is_empty() {
        return None;
    }

    let queries = [
        "M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 1\r\nST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\n\r\n",
        "M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 1\r\nST: urn:schemas-upnp-org:device:InternetGatewayDevice:2\r\n\r\n",
        "M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 1\r\nST: urn:schemas-upnp-org:service:WANIPConnection:1\r\n\r\n",
        "M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 1\r\nST: urn:schemas-upnp-org:service:WANPPPConnection:1\r\n\r\n",
    ];
    let loc_re = Regex::new(r"(?im)^LOCATION:\s*([^\r\n]+)").unwrap();
    let client = Client::builder().timeout(Duration::from_secs(3)).build().ok()?;
    let os_gateways = discover_gateway_ips();

    let mut set = JoinSet::new();
    for iface_ip in local_ips {
        let Ok(v4_iface) = iface_ip.parse::<Ipv4Addr>() else {
            continue;
        };
        let loc_re = loc_re.clone();
        let client = client.clone();
        let os_gws = os_gateways.clone();

        set.spawn(async move {
            let sock = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP)).ok()?;
            let _ = sock.set_reuse_address(true);
            let _ = sock.set_broadcast(true);
            let _ = sock.set_multicast_if_v4(&v4_iface);
            sock.set_nonblocking(true).ok()?;
            sock.bind(&SocketAddr::V4(SocketAddrV4::new(v4_iface, 0)).into()).ok()?;
            let std_sock: std::net::UdpSocket = sock.into();
            let udp = UdpSocket::from_std(std_sock).ok()?;

            let mcast: SocketAddr = "239.255.255.250:1900".parse().unwrap();
            let octs = v4_iface.octets();
            let mut unicast_targets: Vec<SocketAddr> = Vec::new();
            let mut seen_gw = HashSet::new();
            for gw_ip in os_gws {
                // Solo enviamos unicast SSDP a gateways en el mismo /24 o si coincide el prefijo local.
                let g = gw_ip.octets();
                if g[0] == octs[0] && g[1] == octs[1] && g[2] == octs[2] && seen_gw.insert(gw_ip) {
                    unicast_targets.push(SocketAddr::V4(SocketAddrV4::new(gw_ip, 1900)));
                }
            }
            let guessed_gw = Ipv4Addr::new(octs[0], octs[1], octs[2], 1);
            if guessed_gw != v4_iface && seen_gw.insert(guessed_gw) {
                unicast_targets.push(SocketAddr::V4(SocketAddrV4::new(guessed_gw, 1900)));
            }

            async fn send_ssdp_burst(
                udp_ref: &UdpSocket,
                queries: &[&str],
                mcast: SocketAddr,
                targets: &[SocketAddr],
            ) {
                for q in queries {
                    let _ = udp_ref.send_to(q.as_bytes(), mcast).await;
                    for &gw in targets {
                        let _ = udp_ref.send_to(q.as_bytes(), gw).await;
                    }
                }
            }

            send_ssdp_burst(&udp, &queries, mcast, &unicast_targets).await;

            // Reintentamos M-SEARCH hasta 2 veces más (750 ms / 1500 ms) para sobrevivir pérdidas UDP en Wi-Fi.
            let mut retry_tick = interval(Duration::from_millis(750));
            retry_tick.tick().await; // consume tick inmediato t=0
            let mut retries_left = 2u8;
            let mut seen_locations = HashSet::new();
            let mut buf = [0u8; 4096];

            loop {
                tokio::select! {
                    _ = retry_tick.tick(), if retries_left > 0 => {
                        retries_left -= 1;
                        send_ssdp_burst(&udp, &queries, mcast, &unicast_targets).await;
                    }
                    recv = udp.recv_from(&mut buf) => {
                        let (n, rinfo) = match recv {
                            Ok(v) => v,
                            // En Windows, un ICMP Port Unreachable del unicast gw:1900 devuelve
                            // WSAECONNRESET (ConnectionReset) en el siguiente recv_from; debemos
                            // ignorarlo para no abortar la escucha de la respuesta multicast.
                            Err(e) if matches!(e.kind(), ErrorKind::ConnectionReset | ErrorKind::WouldBlock | ErrorKind::Interrupted) => {
                                continue;
                            }
                            Err(_) => return None,
                        };
                        let text = String::from_utf8_lossy(&buf[..n]);
                        if let Some(cap) = loc_re.captures(&text) {
                            let location = cap[1].trim().to_string();
                            if !seen_locations.insert(location.clone()) {
                                continue;
                            }
                            if let Ok(resp) = client.get(&location).send().await
                                && resp.status().is_success()
                                && let Ok(xml) = resp.text().await
                                && let Some((service_type, control_url)) =
                                    parse_description_xml(&xml, &location)
                            {
                                return Some(UpnpRouter {
                                    control_url,
                                    service_type,
                                    router_ip: rinfo.ip().to_string(),
                                    client_lan_ip: iface_ip,
                                });
                            }
                        }
                    }
                }
            }
        });
    }

    let wait_first = async {
        while let Some(res) = set.join_next().await {
            if let Ok(Some(router)) = res {
                return Some(router);
            }
        }
        None
    };

    let found = (timeout(Duration::from_millis(timeout_ms), wait_first).await).unwrap_or(None);
    set.abort_all();
    found
}

pub async fn get_router_external_ip(control_url: &str, service_type: &str) -> Option<String> {
    let soap = format!(
        r#"<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
<s:Body>
  <u:GetExternalIPAddress xmlns:u="{service_type}">
  </u:GetExternalIPAddress>
</s:Body>
</s:Envelope>"#
    );
    let client = Client::builder().timeout(Duration::from_secs(5)).build().ok()?;
    let res = client
        .post(control_url)
        .header("Content-Type", "text/xml; charset=\"utf-8\"")
        .header("SOAPAction", format!("\"{service_type}#GetExternalIPAddress\""))
        .body(soap)
        .send()
        .await
        .ok()?;
    if !res.status().is_success() {
        return None;
    }
    let text = res.text().await.ok()?;
    let re = Regex::new(r"(?i)<NewExternalIPAddress>\s*([^<]+)\s*</NewExternalIPAddress>").unwrap();
    re.captures(&text).map(|c| c[1].trim().to_string())
}

#[derive(Debug, Clone)]
pub struct MapPortOptions {
    pub description: String,
    pub lease_sec: u32,
    pub auto_renew: bool,
    pub max_retries: usize,
    pub discover_timeout_ms: u64,
    pub router: Option<UpnpRouter>,
    pub natpmp_gateway: Option<SocketAddr>,
}

impl Default for MapPortOptions {
    fn default() -> Self {
        Self {
            description: "drop-p2p".to_string(),
            lease_sec: 7200,
            auto_renew: true,
            max_retries: 10,
            discover_timeout_ms: 4500,
            router: None,
            natpmp_gateway: None,
        }
    }
}

pub enum MapOutcome {
    Mapped(Arc<UpnpMapping>),
    Failed(UpnpResult),
}

fn failed_map(reason: impl Into<String>) -> MapOutcome {
    MapOutcome::Failed(UpnpResult {
        success: false,
        external_port: None,
        public_ip: None,
        router_ip: None,
        client_lan_ip: None,
        reason: Some(reason.into()),
    })
}

async fn spawn_renew_task(mapping: &Arc<UpnpMapping>, auto_renew: bool, lease_sec: u32) {
    if !auto_renew || lease_sec == 0 {
        return;
    }
    let weak = Arc::downgrade(mapping);
    let renew_interval = Duration::from_millis(((lease_sec as u64) * 1000 / 2).max(1000));
    let retry_delay = Duration::from_millis((((lease_sec as u64) * 1000) / 4).clamp(1000, 60_000));
    let handle = tokio::spawn(async move {
        let mut next_delay = renew_interval;
        loop {
            tokio::time::sleep(next_delay).await;
            let Some(m) = weak.upgrade() else {
                break;
            };
            if m.unmapped.load(Ordering::SeqCst) {
                break;
            }
            next_delay = if m.renew().await {
                renew_interval
            } else {
                retry_delay
            };
        }
    });
    *mapping.renew_task.lock().await = Some(handle);
}

async fn discover_upnp_and_natpmp(
    discover_timeout_ms: u64,
) -> (Option<UpnpRouter>, Option<NatPmpRouter>) {
    let upnp_fut = discover_router(discover_timeout_ms);
    let pmp_fut = probe_natpmp(discover_timeout_ms.min(1200));
    tokio::pin!(upnp_fut);
    tokio::pin!(pmp_fut);

    tokio::select! {
        upnp = &mut upnp_fut => {
            if upnp.is_some() {
                (upnp, None)
            } else {
                (None, pmp_fut.await)
            }
        }
        pmp = &mut pmp_fut => {
            if pmp.is_some() {
                // Si NAT-PMP ya respondio, damos una ventana corta a UPnP para priorizarlo si existe.
                let grace = Duration::from_millis(discover_timeout_ms.min(800));
                let upnp = timeout(grace, &mut upnp_fut).await.unwrap_or(None);
                (upnp, pmp)
            } else {
                (upnp_fut.await, None)
            }
        }
    }
}

async fn map_natpmp_via_router(
    router: NatPmpRouter,
    internal_port: u16,
    preferred_external_port: Option<u16>,
    options: &MapPortOptions,
) -> MapOutcome {
    // En RFC 6886 lifetime = 0 significa eliminar el mapeo; usamos 7200s si se pidio 0.
    let requested_lease = if options.lease_sec == 0 {
        7200
    } else {
        options.lease_sec
    };
    let requested_ext = preferred_external_port.unwrap_or(internal_port);
    let mut res = map_natpmp_port(
        router.gateway,
        internal_port,
        requested_ext,
        requested_lease,
        1500,
    )
    .await;
    if requested_ext != 0 && !matches!(res, Ok(ref m) if m.external_port != 0) {
        res = map_natpmp_port(router.gateway, internal_port, 0, requested_lease, 1500).await;
    }

    let mapped = match res {
        Ok(m) if m.external_port != 0 => m,
        Ok(_) => return failed_map("NAT-PMP returned external port 0"),
        Err(e) => return failed_map(e),
    };

    let effective_lease = if options.lease_sec == 0 {
        0
    } else if mapped.lifetime_sec > 0 {
        mapped.lifetime_sec
    } else {
        requested_lease
    };
    let stored_lease = if effective_lease == 0 {
        requested_lease
    } else {
        effective_lease
    };

    let mapping = Arc::new(UpnpMapping {
        external_port: mapped.external_port,
        public_ip: Some(router.public_ip.to_string()),
        router_ip: router.gateway.ip().to_string(),
        client_lan_ip: router.client_lan_ip,
        backend: MappingBackend::NatPmp {
            gateway: router.gateway,
            internal_port,
            lease_sec: stored_lease,
        },
        unmapped: Arc::new(AtomicBool::new(false)),
        renew_task: Mutex::new(None),
    });
    spawn_renew_task(&mapping, options.auto_renew, effective_lease).await;
    MapOutcome::Mapped(mapping)
}

async fn wrap_pcp_mapping(
    mapped: PcpMapped,
    internal_port: u16,
    options: &MapPortOptions,
) -> MapOutcome {
    let requested_lease = if options.lease_sec == 0 {
        7200
    } else {
        options.lease_sec
    };
    let effective_lease = if options.lease_sec == 0 {
        0
    } else if mapped.response.lifetime_sec > 0 {
        mapped.response.lifetime_sec
    } else {
        requested_lease
    };
    let stored_lease = if effective_lease == 0 {
        requested_lease
    } else {
        effective_lease
    };
    let public_ip = if mapped.response.external_ip.is_unspecified() {
        None
    } else {
        Some(mapped.response.external_ip.to_string())
    };
    let mapping = Arc::new(UpnpMapping {
        external_port: mapped.response.external_port,
        public_ip,
        router_ip: mapped.gateway.ip().to_string(),
        client_lan_ip: mapped.client_lan_ip.to_string(),
        backend: MappingBackend::Pcp {
            gateway: mapped.gateway,
            client_ip: mapped.client_lan_ip,
            nonce: mapped.response.nonce,
            internal_port,
            lease_sec: stored_lease,
        },
        unmapped: Arc::new(AtomicBool::new(false)),
        renew_task: Mutex::new(None),
    });
    spawn_renew_task(&mapping, options.auto_renew, effective_lease).await;
    MapOutcome::Mapped(mapping)
}

pub async fn map_port(
    internal_port: u16,
    preferred_external_port: Option<u16>,
    options: MapPortOptions,
) -> MapOutcome {
    if env::var_os("DROP_NO_UPNP").is_some_and(|v| !v.is_empty()) {
        return failed_map("UPnP disabled by environment");
    }

    let pcp_lease = if options.lease_sec == 0 {
        7200
    } else {
        options.lease_sec
    };
    let pcp_ext = preferred_external_port.unwrap_or(internal_port);

    if let Some(router) = options.router.clone() {
        let outcome =
            map_upnp_via_router(router, internal_port, preferred_external_port, &options).await;
        if let MapOutcome::Mapped(_) = outcome {
            return outcome;
        }
        if let Some(gw) = options.natpmp_gateway {
            if let Some(pmp) = probe_natpmp_on(gw, options.discover_timeout_ms).await
                && let ok @ MapOutcome::Mapped(_) =
                    map_natpmp_via_router(pmp, internal_port, preferred_external_port, &options)
                        .await
            {
                return ok;
            }
            if let Some(pcp) = probe_and_map_pcp_on(
                gw,
                internal_port,
                pcp_ext,
                pcp_lease,
                options.discover_timeout_ms,
            )
            .await
            {
                return wrap_pcp_mapping(pcp, internal_port, &options).await;
            }
        }
        return outcome;
    }

    if let Some(gw) = options.natpmp_gateway {
        if let Some(pmp) = probe_natpmp_on(gw, options.discover_timeout_ms).await
            && let ok @ MapOutcome::Mapped(_) =
                map_natpmp_via_router(pmp, internal_port, preferred_external_port, &options).await
        {
            return ok;
        }
        if let Some(pcp) = probe_and_map_pcp_on(
            gw,
            internal_port,
            pcp_ext,
            pcp_lease,
            options.discover_timeout_ms,
        )
        .await
        {
            return wrap_pcp_mapping(pcp, internal_port, &options).await;
        }
        return failed_map("No NAT-PMP/PCP router found on configured gateway");
    }

    if has_explicit_gateway_override() {
        if let Some(pmp) = probe_natpmp(options.discover_timeout_ms).await
            && let ok @ MapOutcome::Mapped(_) =
                map_natpmp_via_router(pmp, internal_port, preferred_external_port, &options).await
        {
            return ok;
        }
        if let Some(pcp) = probe_and_map_pcp(
            internal_port,
            pcp_ext,
            pcp_lease,
            options.discover_timeout_ms,
        )
        .await
        {
            return wrap_pcp_mapping(pcp, internal_port, &options).await;
        }
        return failed_map("No NAT-PMP/PCP router found on DROP_NATPMP_GATEWAY");
    }

    let (upnp_router, mut pmp_router) =
        discover_upnp_and_natpmp(options.discover_timeout_ms).await;

    if let Some(router) = upnp_router {
        match map_upnp_via_router(router, internal_port, preferred_external_port, &options).await {
            ok @ MapOutcome::Mapped(_) => return ok,
            failed => {
                if pmp_router.is_none() {
                    pmp_router = probe_natpmp(800).await;
                }
                if let Some(pmp) = pmp_router
                    && let ok @ MapOutcome::Mapped(_) =
                        map_natpmp_via_router(pmp, internal_port, preferred_external_port, &options)
                            .await
                {
                    return ok;
                }
                if let Some(pcp) = probe_and_map_pcp(internal_port, pcp_ext, pcp_lease, 1200).await
                {
                    return wrap_pcp_mapping(pcp, internal_port, &options).await;
                }
                return failed;
            }
        }
    }

    if let Some(pmp) = pmp_router
        && let ok @ MapOutcome::Mapped(_) =
            map_natpmp_via_router(pmp, internal_port, preferred_external_port, &options).await
    {
        return ok;
    }

    if let Some(pcp) = probe_and_map_pcp(
        internal_port,
        pcp_ext,
        pcp_lease,
        options.discover_timeout_ms.min(1500),
    )
    .await
    {
        return wrap_pcp_mapping(pcp, internal_port, &options).await;
    }

    failed_map("No UPnP, NAT-PMP or PCP router found")
}

async fn map_upnp_via_router(
    router: UpnpRouter,
    internal_port: u16,
    preferred_external_port: Option<u16>,
    options: &MapPortOptions,
) -> MapOutcome {

    let client = match Client::builder().timeout(Duration::from_secs(5)).build() {
        Ok(c) => c,
        Err(e) => {
            return MapOutcome::Failed(UpnpResult {
                success: false,
                external_port: None,
                public_ip: None,
                router_ip: None,
                client_lan_ip: None,
                reason: Some(e.to_string()),
            });
        }
    };

    let base_port = preferred_external_port.unwrap_or(internal_port);
    let mut lease_sec = options.lease_sec;
    let mut tried_ports = HashSet::new();
    let mut external_port = None;
    let mut last_reason = String::new();
    let mut attempt = 0usize;

    while attempt <= options.max_retries {
        let candidate_port = if attempt == 0 {
            base_port
        } else {
            get_next_candidate_port(base_port, attempt, &tried_ports)
        };
        tried_ports.insert(candidate_port);

        let soap_add = build_add_port_mapping_soap(
            &router.service_type,
            candidate_port,
            internal_port,
            &router.client_lan_ip,
            &options.description,
            lease_sec,
        );

        let res = match client
            .post(&router.control_url)
            .header("Content-Type", "text/xml; charset=\"utf-8\"")
            .header(
                "SOAPAction",
                format!("\"{}#AddPortMapping\"", router.service_type),
            )
            .body(soap_add)
            .send()
            .await
        {
            Ok(r) => r,
            Err(err) => {
                return MapOutcome::Failed(UpnpResult {
                    success: false,
                    external_port: None,
                    public_ip: None,
                    router_ip: None,
                    client_lan_ip: None,
                    reason: Some(err.to_string()),
                });
            }
        };

        let status = res.status().as_u16();
        if res.status().is_success() {
            external_port = Some(candidate_port);
            break;
        }

        let body_text = res.text().await.unwrap_or_default();
        if is_conflict_error(status, &body_text) {
            last_reason = format!("ConflictInMappingEntry (error 718) on port {candidate_port}");
            attempt += 1;
            continue;
        }

        let body_lower = body_text.to_ascii_lowercase();
        if (body_text.contains("725") || body_lower.contains("onlypermanentleasessupported"))
            && lease_sec != 0
        {
            lease_sec = 0;
            tried_ports.remove(&candidate_port);
            continue;
        }

        let snippet: String = body_text.chars().take(200).collect();
        return MapOutcome::Failed(UpnpResult {
            success: false,
            external_port: None,
            public_ip: None,
            router_ip: None,
            client_lan_ip: None,
            reason: Some(format!("HTTP {status} from router: {snippet}")),
        });
    }

    let Some(ext_port) = external_port else {
        return MapOutcome::Failed(UpnpResult {
            success: false,
            external_port: None,
            public_ip: None,
            router_ip: None,
            client_lan_ip: None,
            reason: Some(if last_reason.is_empty() {
                "All port mapping attempts conflicted".to_string()
            } else {
                last_reason
            }),
        });
    };

    let public_ip = get_router_external_ip(&router.control_url, &router.service_type).await;
    let mapping = Arc::new(UpnpMapping {
        external_port: ext_port,
        public_ip,
        router_ip: router.router_ip,
        client_lan_ip: router.client_lan_ip,
        backend: MappingBackend::Upnp {
            control_url: router.control_url,
            service_type: router.service_type,
            internal_port,
            lease_sec: if lease_sec == 0 { 7200 } else { lease_sec },
        },
        unmapped: Arc::new(AtomicBool::new(false)),
        renew_task: Mutex::new(None),
    });

    spawn_renew_task(&mapping, options.auto_renew, lease_sec).await;
    MapOutcome::Mapped(mapping)
}
