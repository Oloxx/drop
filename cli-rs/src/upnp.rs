// Modulo UPnP (IGD) para mapeo automatico de puertos TCP en routers residenciales.

use std::collections::HashSet;
use std::env;
use std::io::Write;
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
use tokio::time::timeout;
use url::Url;

use crate::discovery::get_local_ips;

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

pub struct UpnpMapping {
    pub external_port: u16,
    pub public_ip: Option<String>,
    pub router_ip: String,
    pub client_lan_ip: String,
    pub control_url: String,
    pub service_type: String,
    unmapped: Arc<AtomicBool>,
    renew_task: Mutex<Option<JoinHandle<()>>>,
}

impl UpnpMapping {
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
        let soap = build_add_port_mapping_soap(
            &self.service_type,
            self.external_port,
            self.external_port,
            &self.client_lan_ip,
            "drop-p2p",
            7200,
        );
        let Ok(client) = Client::builder().timeout(Duration::from_secs(5)).build() else {
            return false;
        };
        let Ok(res) = client
            .post(&self.control_url)
            .header("Content-Type", "text/xml; charset=\"utf-8\"")
            .header("SOAPAction", format!("\"{}#AddPortMapping\"", self.service_type))
            .body(soap)
            .send()
            .await
        else {
            return false;
        };
        res.status().is_success()
    }

    pub async fn unmap(&self) {
        if self.unmapped.swap(true, Ordering::SeqCst) {
            return;
        }
        if let Some(h) = self.renew_task.lock().await.take() {
            h.abort();
        }
        let soap = build_delete_port_mapping_soap(&self.service_type, self.external_port);
        if let Ok(client) = Client::builder().timeout(Duration::from_secs(3)).build() {
            let _ = client
                .post(&self.control_url)
                .header("Content-Type", "text/xml; charset=\"utf-8\"")
                .header(
                    "SOAPAction",
                    format!("\"{}#DeletePortMapping\"", self.service_type),
                )
                .body(soap)
                .send()
                .await;
        }
    }

    /// Borrado sincrono rapido por socket HTTP para usar en señales/salidas sin runtime async.
    pub fn unmap_sync(&self) {
        if self.unmapped.swap(true, Ordering::SeqCst) {
            return;
        }
        let soap = build_delete_port_mapping_soap(&self.service_type, self.external_port);
        send_delete_port_mapping_sync(&self.control_url, &self.service_type, &soap);
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
        "M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 1\r\nST: urn:schemas-upnp-org:service:WANIPConnection:1\r\n\r\n",
    ];
    let loc_re = Regex::new(r"(?im)^LOCATION:\s*([^\r\n]+)").unwrap();
    let client = Client::builder().timeout(Duration::from_secs(3)).build().ok()?;

    let mut set = JoinSet::new();
    for iface_ip in local_ips {
        let Ok(v4_iface) = iface_ip.parse::<Ipv4Addr>() else {
            continue;
        };
        let loc_re = loc_re.clone();
        let client = client.clone();
        let q0 = queries[0];
        let q1 = queries[1];

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
            let gw = SocketAddr::V4(SocketAddrV4::new(
                Ipv4Addr::new(octs[0], octs[1], octs[2], 1),
                1900,
            ));

            for q in [q0, q1] {
                let _ = udp.send_to(q.as_bytes(), mcast).await;
                let _ = udp.send_to(q.as_bytes(), gw).await;
            }

            let mut buf = [0u8; 4096];
            loop {
                let Ok((n, rinfo)) = udp.recv_from(&mut buf).await else {
                    return None;
                };
                let text = String::from_utf8_lossy(&buf[..n]);
                if let Some(cap) = loc_re.captures(&text) {
                    let location = cap[1].trim().to_string();
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
        }
    }
}

pub enum MapOutcome {
    Mapped(Arc<UpnpMapping>),
    Failed(UpnpResult),
}

pub async fn map_port(
    internal_port: u16,
    preferred_external_port: Option<u16>,
    options: MapPortOptions,
) -> MapOutcome {
    if env::var_os("DROP_NO_UPNP").is_some_and(|v| !v.is_empty()) {
        return MapOutcome::Failed(UpnpResult {
            success: false,
            external_port: None,
            public_ip: None,
            router_ip: None,
            client_lan_ip: None,
            reason: Some("UPnP disabled by environment".to_string()),
        });
    }

    let router = match options.router {
        Some(r) => r,
        None => match discover_router(options.discover_timeout_ms).await {
            Some(r) => r,
            None => {
                return MapOutcome::Failed(UpnpResult {
                    success: false,
                    external_port: None,
                    public_ip: None,
                    router_ip: None,
                    client_lan_ip: None,
                    reason: Some("No UPnP router found".to_string()),
                });
            }
        },
    };

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
    let unmapped = Arc::new(AtomicBool::new(false));
    let mapping = Arc::new(UpnpMapping {
        external_port: ext_port,
        public_ip,
        router_ip: router.router_ip,
        client_lan_ip: router.client_lan_ip,
        control_url: router.control_url,
        service_type: router.service_type,
        unmapped: unmapped.clone(),
        renew_task: Mutex::new(None),
    });

    if options.auto_renew && lease_sec > 0 {
        let weak = Arc::downgrade(&mapping);
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

    MapOutcome::Mapped(mapping)
}
