// Pruebas unitarias y de integracion de red: listen, discovery, stun, upnp, signaling y pkgmgr.

use std::collections::HashSet;
use std::net::Ipv4Addr;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream, UdpSocket};

use drop::discovery::{
    LanListener, connect_host, format_peer_host, get_candidate_ips, get_local_ipv6s,
    ipv6_multicast_ifindices, is_link_local_v6, is_local_address, is_unique_local_v6,
    parse_lan_packet, plain_address, probe_candidate_ips, rank_candidates, room_hash,
    start_broadcasting_on,
};
use drop::listen::{explain_listen_error, listen_any_family};
use drop::mdns::{
    MDNS_V4, MDNS_V6, SERVICE_TYPE, build_mdns_query, build_mdns_response, decode_dns_name,
    encode_dns_name, is_drop_ptr_query, listen_mdns_on, parse_mdns_response, start_mdns_on,
};
use drop::natpmp::{
    NatPmpMapResponse, build_map_tcp_request, build_pcp_map_tcp_request,
    build_public_address_request, parse_bsd_default_route, parse_map_tcp_response,
    parse_pcp_map_tcp_response, parse_proc_net_route, parse_public_address_response,
};
use drop::pkgmgr::package_manager_of;
use drop::shared::protocol::FileEntry;
use drop::signaling::{get_signaling_url, translate_error};
use drop::stun::{
    StunResult, StunServer, build_binding_request, merge_offer_candidates, parse_binding_response,
    parse_stun_server, query_stun, resolve_offer_candidates,
};
use drop::transfer::{ReceiveOptions, SendItem, attach_sender, receive_files};
use drop::upnp::{
    MapOutcome, MapPortOptions, UpnpRouter, build_add_port_mapping_soap,
    build_delete_port_mapping_soap, get_next_candidate_port, is_conflict_error, map_port,
    parse_description_xml,
};

#[test]
fn test_pkgmgr_detection() {
    assert_eq!(
        package_manager_of(Path::new("/opt/homebrew/Cellar/drop/0.12.0/bin/drop"))
            .unwrap()
            .name,
        "Homebrew"
    );
    assert_eq!(
        package_manager_of(Path::new("C:\\Users\\alex\\scoop\\shims\\drop.exe"))
            .unwrap()
            .name,
        "Scoop"
    );
    assert_eq!(
        package_manager_of(Path::new("D:\\tools\\apps\\drop\\current\\drop.exe"))
            .unwrap()
            .name,
        "Scoop"
    );
    let winget_pkg = package_manager_of(Path::new(
        "C:\\Users\\alex\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Oloxx.drop_Microsoft.Winget.Source_8wekyb3d8bbwe\\drop.exe",
    ))
    .unwrap();
    assert_eq!(winget_pkg.name, "WinGet");
    assert_eq!(winget_pkg.upgrade, "winget upgrade Oloxx.drop");
    assert_eq!(winget_pkg.uninstall, "winget uninstall Oloxx.drop");
    assert_eq!(
        package_manager_of(Path::new(
            "C:\\Users\\alex\\AppData\\Local\\Microsoft\\WinGet\\Links\\drop.exe",
        ))
        .unwrap()
        .name,
        "WinGet"
    );
    assert_eq!(
        package_manager_of(Path::new(
            "C:\\Program Files\\WinGet\\Packages\\Oloxx.drop_Microsoft.Winget.Source_8wekyb3d8bbwe\\drop.exe",
        ))
        .unwrap()
        .name,
        "WinGet"
    );
    assert!(package_manager_of(Path::new("/usr/local/bin/drop")).is_none());
}

#[test]
fn test_signaling_url_and_errors() {
    assert_eq!(
        get_signaling_url("https://drop.oloxx.dev").unwrap(),
        "wss://drop.oloxx.dev"
    );
    assert_eq!(
        get_signaling_url("http://127.0.0.1:3456").unwrap(),
        "ws://127.0.0.1:3456"
    );
    assert_eq!(
        get_signaling_url("http://[::1]:8080").unwrap(),
        "ws://[::1]:8080"
    );
    assert!(translate_error("BAD_SECRET").contains("palabras"));
    assert_eq!(translate_error("CUSTOM"), "CUSTOM");
}

#[test]
fn test_discovery_ipv6_and_ranking() {
    assert!(is_link_local_v6("fe80::1"));
    assert!(!is_link_local_v6("2001:db8::1"));
    assert!(is_unique_local_v6("fd7a:115c:a1e0::1"));
    assert!(!is_unique_local_v6("2001:db8::1"));

    assert_eq!(plain_address("::ffff:192.168.1.5"), "192.168.1.5");
    assert!(is_local_address("::ffff:192.168.1.5"));
    assert!(is_local_address("10.0.0.4"));
    assert!(is_local_address("172.16.0.1"));
    assert!(!is_local_address("172.32.0.1"));
    assert!(is_local_address("fd00::1"));
    assert!(!is_local_address("8.8.8.8"));

    let hash_a = room_hash("4271-lemon-radar-tiger-orbit");
    let hash_b = room_hash("4271-zoo-ability-able-about");
    assert_eq!(hash_a.len(), 16);
    assert_eq!(hash_a, hash_b, "roomHash solo depende de roomId publico");

    let local = vec!["192.168.1.10".to_string(), "2001:db8:1:2::10".to_string()];
    let candidates = vec![
        "8.8.8.8".to_string(),
        "fd00::5".to_string(),
        "192.168.1.44".to_string(),
        "2001:db8:1:2::99".to_string(),
        "127.0.0.1".to_string(),
        "192.168.1.44".to_string(),
    ];
    let ranked = rank_candidates(&candidates, &local);
    assert_eq!(
        ranked,
        vec![
            "127.0.0.1",
            "192.168.1.44",
            "2001:db8:1:2::99",
            "fd00::5",
            "8.8.8.8"
        ]
    );
}

#[tokio::test]
async fn test_listen_any_family_and_errors() {
    let listener = listen_any_family(0).unwrap();
    let port = listener.local_addr().unwrap().port();
    assert!(port > 0);

    // Segundo bind en el mismo puerto debe fallar con EADDRINUSE y mensaje legible
    let err = listen_any_family(port).unwrap_err();
    assert!(err.message.contains(&port.to_string()));
    assert!(err.message.contains("en uso"));

    let eacces = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "perm");
    assert!(explain_listen_error(&eacces, 80).contains("1024"));

    // Aceptar conexion local IPv4 e IPv6 (si hay loopback v6)
    let accept_task = tokio::spawn(async move {
        let (mut s, _) = listener.accept().await.unwrap();
        s.write_all(b"ok").await.unwrap();
    });
    let mut client = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let mut buf = [0u8; 2];
    client.read_exact(&mut buf).await.unwrap();
    assert_eq!(&buf, b"ok");
    accept_task.await.unwrap();
}

#[tokio::test]
async fn test_probe_candidate_ips_happy_eyeballs() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let accept_task = tokio::spawn(async move {
        let (_s, _) = listener.accept().await.unwrap();
    });

    // Primero un IP reservada no enrutable/cerrada o puerto distinto? Usamos 127.0.0.1 como valida
    let ips = vec!["127.0.0.1".to_string()];
    let hit = probe_candidate_ips(&ips, port, 1500).await;
    assert!(hit.is_some());
    assert_eq!(hit.unwrap().1, "127.0.0.1");
    accept_task.await.unwrap();
}

#[test]
fn test_stun_packets_and_server_parser() {
    let tx_id = [1u8, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    let req = build_binding_request(&tx_id);
    assert_eq!(req.len(), 20);
    assert_eq!(&req[0..2], &[0x00, 0x01]);
    assert_eq!(&req[4..8], &[0x21, 0x12, 0xa4, 0x42]);
    assert_eq!(&req[8..20], &tx_id);

    // Respuesta STUN con XOR-MAPPED-ADDRESS IPv4 (203.0.113.42:54321)
    let mut resp = Vec::new();
    resp.extend_from_slice(&0x0101u16.to_be_bytes());
    resp.extend_from_slice(&12u16.to_be_bytes());
    resp.extend_from_slice(&0x2112_a442u32.to_be_bytes());
    resp.extend_from_slice(&tx_id);
    // Attr XOR-MAPPED-ADDRESS (0x0020, len 8)
    resp.extend_from_slice(&0x0020u16.to_be_bytes());
    resp.extend_from_slice(&8u16.to_be_bytes());
    resp.push(0);
    resp.push(1); // IPv4
    resp.extend_from_slice(&(54321u16 ^ 0x2112u16).to_be_bytes());
    let ip_bytes = [203u8, 0, 113, 42];
    let magic = 0x2112_a442u32.to_be_bytes();
    for i in 0..4 {
        resp.push(ip_bytes[i] ^ magic[i]);
    }
    let ep = parse_binding_response(&resp, Some(&tx_id)).unwrap();
    assert_eq!(ep.ip, "203.0.113.42");
    assert_eq!(ep.port, 54321);

    // Respuesta IPv6 XOR-MAPPED-ADDRESS (2001:db8::1:5000)
    let mut resp6 = Vec::new();
    resp6.extend_from_slice(&0x0101u16.to_be_bytes());
    resp6.extend_from_slice(&24u16.to_be_bytes());
    resp6.extend_from_slice(&magic);
    resp6.extend_from_slice(&tx_id);
    resp6.extend_from_slice(&0x0020u16.to_be_bytes());
    resp6.extend_from_slice(&20u16.to_be_bytes());
    resp6.push(0);
    resp6.push(2); // IPv6
    resp6.extend_from_slice(&(5000u16 ^ 0x2112u16).to_be_bytes());
    let v6_octets = "2001:db8::1".parse::<std::net::Ipv6Addr>().unwrap().octets();
    let mut mask = [0u8; 16];
    mask[..4].copy_from_slice(&magic);
    mask[4..16].copy_from_slice(&tx_id);
    for i in 0..16 {
        resp6.push(v6_octets[i] ^ mask[i]);
    }
    let ep6 = parse_binding_response(&resp6, Some(&tx_id)).unwrap();
    assert_eq!(ep6.ip, "2001:db8::1");
    assert_eq!(ep6.port, 5000);

    assert_eq!(
        parse_stun_server("stun:stun.example.com:19302"),
        Some(StunServer { host: "stun.example.com".into(), port: 19302 })
    );
    assert_eq!(
        parse_stun_server("[2001:db8::1]:3478"),
        Some(StunServer { host: "2001:db8::1".into(), port: 3478 })
    );
    assert_eq!(
        parse_stun_server("stun.cloudflare.com"),
        Some(StunServer { host: "stun.cloudflare.com".into(), port: 3478 })
    );
}

#[tokio::test]
async fn test_query_stun_and_merge_candidates() {
    let sock = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let stun_port = sock.local_addr().unwrap().port();
    let task = tokio::spawn(async move {
        let mut buf = [0u8; 128];
        let (n, peer) = sock.recv_from(&mut buf).await.unwrap();
        assert!(n >= 20);
        let tx_id = &buf[8..20];
        let mut resp = Vec::new();
        resp.extend_from_slice(&0x0101u16.to_be_bytes());
        resp.extend_from_slice(&12u16.to_be_bytes());
        resp.extend_from_slice(&0x2112_a442u32.to_be_bytes());
        resp.extend_from_slice(tx_id);
        resp.extend_from_slice(&0x0020u16.to_be_bytes());
        resp.extend_from_slice(&8u16.to_be_bytes());
        resp.push(0);
        resp.push(1);
        resp.extend_from_slice(&(41234u16 ^ 0x2112u16).to_be_bytes());
        let magic = 0x2112_a442u32.to_be_bytes();
        for (i, b) in [198u8, 51, 100, 9].iter().enumerate() {
            resp.push(b ^ magic[i]);
        }
        sock.send_to(&resp, peer).await.unwrap();
    });

    let srv = StunServer { host: "127.0.0.1".into(), port: stun_port };
    let res = query_stun(&srv, 1000, false).await.unwrap();
    assert_eq!(res.ip, "198.51.100.9");
    assert_eq!(res.port, 41234);
    task.await.unwrap();

    let merged = merge_offer_candidates(
        &["192.168.1.5".to_string()],
        None,
        Some(StunResult { ip: "198.51.100.9".into(), port: 41234, server: "mock".into() }),
        Some("198.51.100.9"),
        false,
    );
    assert_eq!(merged.candidate_ips, vec!["192.168.1.5", "198.51.100.9"]);

    let forced = resolve_offer_candidates(
        &["192.168.1.5".to_string()],
        None,
        None,
        Some("198.51.100.9"),
        true,
        100,
    )
    .await;
    assert!(forced.candidate_ips.is_empty());
}

#[test]
fn test_upnp_xml_soap_and_conflict_helpers() {
    let xml = r#"<root><device><serviceList><service>
      <serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType>
      <controlURL>/ctl/IPConn</controlURL>
    </service></serviceList></device></root>"#;
    let (svc, ctrl) = parse_description_xml(xml, "http://192.168.1.1:5000/rootDesc.xml").unwrap();
    assert_eq!(svc, "urn:schemas-upnp-org:service:WANIPConnection:1");
    assert_eq!(ctrl, "http://192.168.1.1:5000/ctl/IPConn");

    assert!(is_conflict_error(500, "<errorCode>718</errorCode><errorDescription>ConflictInMappingEntry</errorDescription>"));
    assert!(!is_conflict_error(500, "other error"));

    let add_soap = build_add_port_mapping_soap(&svc, 4000, 4000, "192.168.1.10", "drop-p2p", 7200);
    assert!(add_soap.contains("<NewExternalPort>4000</NewExternalPort>"));
    let del_soap = build_delete_port_mapping_soap(&svc, 4000);
    assert!(del_soap.contains("DeletePortMapping"));

    let tried = HashSet::from([4000u16]);
    assert_eq!(get_next_candidate_port(4000, 1, &tried), 4001);
}

#[tokio::test]
async fn test_upnp_map_port_conflict_718_and_permanent_725_and_unmap() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let add_calls = Arc::new(AtomicUsize::new(0));
    let del_calls = Arc::new(AtomicUsize::new(0));
    let add_c = add_calls.clone();
    let del_c = del_calls.clone();

    let srv_task = tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else { break };
            let add_c = add_c.clone();
            let del_c = del_c.clone();
            tokio::spawn(async move {
                let mut buf = vec![0u8; 8192];
                let n = stream.read(&mut buf).await.unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]);
                let (status, body) = if req.contains("AddPortMapping") {
                    let c = add_c.fetch_add(1, Ordering::SeqCst);
                    if c == 0 {
                        ("500 Internal Server Error", "<errorCode>718</errorCode><errorDescription>ConflictInMappingEntry</errorDescription>")
                    } else if c == 1 {
                        ("500 Internal Server Error", "<errorCode>725</errorCode><errorDescription>OnlyPermanentLeasesSupported</errorDescription>")
                    } else {
                        ("200 OK", "<u:AddPortMappingResponse/>")
                    }
                } else if req.contains("GetExternalIPAddress") {
                    ("200 OK", "<NewExternalIPAddress>203.0.113.77</NewExternalIPAddress>")
                } else if req.contains("DeletePortMapping") {
                    del_c.fetch_add(1, Ordering::SeqCst);
                    ("200 OK", "<u:DeletePortMappingResponse/>")
                } else {
                    ("404 Not Found", "")
                };
                let resp = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: text/xml\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(resp.as_bytes()).await;
            });
        }
    });

    let router = UpnpRouter {
        control_url: format!("http://127.0.0.1:{port}/ctl"),
        service_type: "urn:schemas-upnp-org:service:WANIPConnection:1".into(),
        router_ip: "127.0.0.1".into(),
        client_lan_ip: "127.0.0.1".into(),
    };

    let outcome = map_port(
        5000,
        None,
        MapPortOptions {
            router: Some(router),
            auto_renew: false,
            ..Default::default()
        },
    )
    .await;

    let mapping = match outcome {
        MapOutcome::Mapped(m) => m,
        MapOutcome::Failed(res) => panic!("UPnP mapping failed: {:?}", res.reason),
    };

    assert_eq!(mapping.protocol_label(), "UPnP");
    assert_eq!(mapping.external_port, 5001);
    assert_eq!(mapping.public_ip.as_deref(), Some("203.0.113.77"));
    assert_eq!(add_calls.load(Ordering::SeqCst), 3);

    mapping.unmap().await;
    assert_eq!(del_calls.load(Ordering::SeqCst), 1);
    srv_task.abort();
}

#[tokio::test]
async fn test_upnp_conflict_exhaustion_and_non_conflict_error() {
    async fn start_fixed_error_router(body: &'static str) -> (u16, Arc<AtomicUsize>, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let calls = Arc::new(AtomicUsize::new(0));
        let calls_c = calls.clone();
        let task = tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else { break };
                let calls_c = calls_c.clone();
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 4096];
                    let n = stream.read(&mut buf).await.unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    let req = String::from_utf8_lossy(&buf[..n]);
                    let (status, resp_body) = if req.contains("AddPortMapping") {
                        calls_c.fetch_add(1, Ordering::SeqCst);
                        ("500 Internal Server Error", body)
                    } else {
                        ("404 Not Found", "")
                    };
                    let resp = format!(
                        "HTTP/1.1 {status}\r\nContent-Type: text/xml\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{resp_body}",
                        resp_body.len()
                    );
                    let _ = stream.write_all(resp.as_bytes()).await;
                });
            }
        });
        (port, calls, task)
    }

    // 1. Conflicto 718 repetido agota `max_retries` (1 + 2 reintentos = 3 llamadas)
    let (p1, c1, t1) = start_fixed_error_router(
        "<errorCode>718</errorCode><errorDescription>ConflictInMappingEntry</errorDescription>",
    )
    .await;
    let out1 = map_port(
        5200,
        None,
        MapPortOptions {
            router: Some(UpnpRouter {
                control_url: format!("http://127.0.0.1:{p1}/ctl"),
                service_type: "urn:schemas-upnp-org:service:WANIPConnection:1".into(),
                router_ip: "127.0.0.1".into(),
                client_lan_ip: "127.0.0.1".into(),
            }),
            max_retries: 2,
            auto_renew: false,
            ..Default::default()
        },
    )
    .await;
    match out1 {
        MapOutcome::Failed(res) => {
            assert!(res.reason.unwrap_or_default().contains("718"));
        }
        MapOutcome::Mapped(_) => panic!("debería fallar al agotar reintentos de conflicto 718"),
    }
    assert_eq!(c1.load(Ordering::SeqCst), 3);
    t1.abort();

    // 2. Error SOAP distinto a 718/725 aborta al primer intento
    let (p2, c2, t2) = start_fixed_error_router(
        "<UPnPError><errorCode>501</errorCode><errorDescription>ActionFailed</errorDescription></UPnPError>",
    )
    .await;
    let out2 = map_port(
        5201,
        None,
        MapPortOptions {
            router: Some(UpnpRouter {
                control_url: format!("http://127.0.0.1:{p2}/ctl"),
                service_type: "urn:schemas-upnp-org:service:WANIPConnection:1".into(),
                router_ip: "127.0.0.1".into(),
                client_lan_ip: "127.0.0.1".into(),
            }),
            max_retries: 3,
            auto_renew: false,
            ..Default::default()
        },
    )
    .await;
    assert!(matches!(out2, MapOutcome::Failed(_)));
    assert_eq!(c2.load(Ordering::SeqCst), 1);
    t2.abort();
}

#[tokio::test]
async fn test_ipv6_candidates_and_loopback_transfer() {
    for ip in get_local_ipv6s() {
        assert!(ip.contains(':'), "{ip} no es IPv6");
        assert!(!ip.contains('%'), "{ip} lleva índice de zona");
        assert!(!is_link_local_v6(&ip), "{ip} es link-local");
        assert_ne!(ip, "::1");
    }

    let all = get_candidate_ips();
    let first_v6 = all.iter().position(|ip| ip.contains(':'));
    let last_v4 = all.iter().rposition(|ip| ip.contains('.'));
    if let (Some(fv6), Some(lv4)) = (first_v6, last_v4) {
        assert!(lv4 < fv6, "IPv4 deben preceder a IPv6: {all:?}");
    }

    // Si el host soporta ::1, verificamos transferencia completa sobre socket IPv6 loopback.
    let Ok(v6_probe) = TcpListener::bind("[::1]:0").await else {
        return;
    };
    drop(v6_probe);

    let listener = listen_any_family(0).expect("listen_any_family");
    let port = listener.local_addr().unwrap().port();
    let dir = std::env::temp_dir().join(format!("drop-v6-test-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();

    let payload = vec![0xA5u8; 96 * 1024 + 17];
    let expected_sha = hex::encode(Sha256::digest(&payload));
    let src = dir.join("v6.bin");
    std::fs::write(&src, &payload).unwrap();
    let out_dir = dir.join("out");
    std::fs::create_dir_all(&out_dir).unwrap();

    let code = "4271-lemon-radar-tiger-orbit";
    let room_id = "4271";
    let item = SendItem {
        entry: FileEntry {
            name: "v6.bin".into(),
            size: Some(payload.len() as u64),
            path: None,
        },
        fs_path: Some(src),
        is_stdin: false,
    };

    let srv = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        attach_sender(stream, &[item], code, room_id, 0, None, None, None, None)
            .await
            .unwrap();
    });

    let (stream, _ip) = probe_candidate_ips(&["::1".to_string()], port, 2000)
        .await
        .expect("probe ::1");
    let stats = receive_files(
        stream,
        code,
        room_id,
        &out_dir,
        ReceiveOptions::default(),
        None,
        None,
        None,
    )
    .await
    .expect("receive_files ::1");
    srv.await.unwrap();

    assert_eq!(stats.files.len(), 1);
    assert_eq!(stats.files[0].sha256, expected_sha);
    assert_eq!(hex::encode(Sha256::digest(std::fs::read(out_dir.join("v6.bin")).unwrap())), expected_sha);

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn test_lan_packet_parser_ipv4_and_ipv6_scopes() {
    use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr, SocketAddrV4, SocketAddrV6};

    let code = "4271-lemon-radar-tiger-orbit";
    let h = room_hash(code);
    let payload = format!(r#"{{"t":"drop-lan","h":"{h}","p":44123}}"#);

    let r_v4 = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::new(192, 168, 1, 9), 42424));
    assert_eq!(
        parse_lan_packet(payload.as_bytes(), r_v4, &h),
        Some(("192.168.1.9".into(), 44123))
    );

    let r_mapped = SocketAddr::V6(SocketAddrV6::new(
        "::ffff:192.168.1.9".parse::<Ipv6Addr>().unwrap(),
        42424,
        0,
        0,
    ));
    assert_eq!(format_peer_host(r_mapped), "192.168.1.9");

    let r_ula = SocketAddr::V6(SocketAddrV6::new(
        "fd00::1234".parse::<Ipv6Addr>().unwrap(),
        42424,
        0,
        3,
    ));
    assert_eq!(
        parse_lan_packet(payload.as_bytes(), r_ula, &h),
        Some(("fd00::1234".into(), 44123))
    );

    let r_ll = SocketAddr::V6(SocketAddrV6::new(
        "fe80::abc:def".parse::<Ipv6Addr>().unwrap(),
        42424,
        0,
        7,
    ));
    assert_eq!(
        parse_lan_packet(payload.as_bytes(), r_ll, &h),
        Some(("fe80::abc:def%7".into(), 44123))
    );

    let wrong_hash = r#"{"t":"drop-lan","h":"deadbeefdeadbeef","p":44123}"#;
    assert!(parse_lan_packet(wrong_hash.as_bytes(), r_ula, &h).is_none());
    assert!(parse_lan_packet(br#"{"t":"drop-lan","h":"x","p":0}"#, r_v4, "x").is_none());
    assert!(parse_lan_packet(br#"{"t":"other","h":"x","p":100}"#, r_v4, "x").is_none());
    assert!(parse_lan_packet(b"not json", r_v4, &h).is_none());

    let ifindices = ipv6_multicast_ifindices();
    let unique_ifindices: HashSet<u32> = ifindices.iter().copied().collect();
    assert_eq!(ifindices.len(), unique_ifindices.len(), "ifindices duplicados: {ifindices:?}");
    assert!(!ifindices.contains(&0), "ifindex 0 invalido en lista");
}

#[tokio::test]
async fn test_lan_discovery_ipv6_multicast_roundtrip() {
    let Some(listener) = LanListener::bind_v6(0) else {
        return;
    };
    let udp_port = listener.port().expect("puerto UDP IPv6");
    let tcp_listener = match listen_any_family(0) {
        Ok(l) => l,
        Err(_) => return,
    };
    let tcp_port = tcp_listener.local_addr().unwrap().port();
    let srv = tokio::spawn(async move {
        let _ = tcp_listener.accept().await;
    });

    let code = "5512-coral-amber-tulip-spark";
    let mut bc = start_broadcasting_on(code, tcp_port, udp_port);
    // Un codigo de otra sala no debe resolverse sobre el mismo canal multicast.
    assert!(listener.accept("9999-coral-amber-tulip-spark", 120).await.is_none());
    let hit = listener.accept(code, 2000).await;
    bc.stop();

    if let Some((host, discovered_port)) = hit {
        assert_eq!(discovered_port, tcp_port);
        assert!(host.contains(':'), "debia descubrir direccion IPv6: {host}");
        let conn = connect_host(&host, discovered_port).await;
        assert!(conn.is_ok(), "fallo al conectar TCP tras descubrir {host}:{discovered_port}: {conn:?}");
        srv.await.unwrap();
    } else {
        // Entorno sin ruta/soporte de multicast IPv6 en loopback ni NICs; no debe paniquear ni romper IPv4.
        srv.abort();
    }
}

#[test]
fn test_natpmp_packet_builders_and_parsers() {
    assert_eq!(build_public_address_request(), [0, 0]);

    let pub_resp = [0, 128, 0, 0, 0, 0, 0, 42, 198, 51, 100, 7];
    assert_eq!(
        parse_public_address_response(&pub_resp).unwrap(),
        Ipv4Addr::new(198, 51, 100, 7)
    );
    assert!(parse_public_address_response(&pub_resp[..11]).is_err());
    let mut pub_err = pub_resp;
    pub_err[3] = 3;
    assert!(parse_public_address_response(&pub_err).is_err());

    let req = build_map_tcp_request(5000, 5001, 7200);
    assert_eq!(&req[..2], &[0, 2]);
    assert_eq!(u16::from_be_bytes([req[4], req[5]]), 5000);
    assert_eq!(u16::from_be_bytes([req[6], req[7]]), 5001);
    assert_eq!(u32::from_be_bytes([req[8], req[9], req[10], req[11]]), 7200);

    let mut map_resp = [0u8; 16];
    map_resp[0] = 0;
    map_resp[1] = 130;
    map_resp[8..10].copy_from_slice(&5000u16.to_be_bytes());
    map_resp[10..12].copy_from_slice(&51234u16.to_be_bytes());
    map_resp[12..16].copy_from_slice(&3600u32.to_be_bytes());
    assert_eq!(
        parse_map_tcp_response(&map_resp, 5000).unwrap(),
        NatPmpMapResponse {
            internal_port: 5000,
            external_port: 51234,
            lifetime_sec: 3600,
        }
    );
    assert!(parse_map_tcp_response(&map_resp, 5999).is_err());
    assert!(parse_map_tcp_response(&map_resp[..15], 5000).is_err());
}

#[test]
fn test_natpmp_route_table_parsers() {
    let gw_primary = u32::from_ne_bytes([192, 168, 1, 1]);
    let gw_subnet = u32::from_ne_bytes([10, 0, 0, 1]);
    let proc_route = format!(
        "Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\n\
         eth0\t00000000\t{gw_primary:08X}\t0003\t0\t0\t100\t00000000\t0\t0\t0\n\
         eth0\t0001A8C0\t00000000\t0001\t0\t0\t100\t00FFFFFF\t0\t0\t0\n\
         eth1\t00000000\t{gw_primary:08X}\t0003\t0\t0\t200\t00000000\t0\t0\t0\n\
         wg0\t0000000A\t{gw_subnet:08X}\t0003\t0\t0\t50\t000000FF\t0\t0\t0\n"
    );
    assert_eq!(
        parse_proc_net_route(&proc_route),
        vec![Ipv4Addr::new(192, 168, 1, 1)]
    );

    let bsd_route = "\
   route to: default\n\
destination: default\n\
       mask: default\n\
    gateway: 192.168.50.1\n\
  interface: en0\n";
    assert_eq!(
        parse_bsd_default_route(bsd_route),
        Some(Ipv4Addr::new(192, 168, 50, 1))
    );
    assert_eq!(parse_bsd_default_route("gateway: 0.0.0.0\n"), None);
}

#[tokio::test]
async fn test_natpmp_map_renew_unmap_and_upnp_fallback() {
    let udp = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let gw_addr = udp.local_addr().unwrap();
    let map_calls = Arc::new(AtomicUsize::new(0));
    let unmap_calls = Arc::new(AtomicUsize::new(0));
    let map_calls_srv = map_calls.clone();
    let unmap_calls_srv = unmap_calls.clone();

    let natpmp_srv = tokio::spawn(async move {
        let mut buf = [0u8; 64];
        loop {
            let (n, peer) = match udp.recv_from(&mut buf).await {
                Ok(v) => v,
                Err(e) if e.kind() == std::io::ErrorKind::ConnectionReset => continue,
                Err(_) => break,
            };
            if n < 2 || buf[0] != 0 {
                continue;
            }
            match buf[1] {
                0 => {
                    let mut resp = [0u8; 12];
                    resp[0] = 0;
                    resp[1] = 128;
                    resp[8..12].copy_from_slice(&[203, 0, 113, 88]);
                    let _ = udp.send_to(&resp, peer).await;
                }
                2 if n >= 12 => {
                    let int_port = u16::from_be_bytes([buf[4], buf[5]]);
                    let req_ext = u16::from_be_bytes([buf[6], buf[7]]);
                    let lifetime = u32::from_be_bytes([buf[8], buf[9], buf[10], buf[11]]);
                    let mut resp = [0u8; 16];
                    resp[0] = 0;
                    resp[1] = 130;
                    resp[8..10].copy_from_slice(&int_port.to_be_bytes());
                    if lifetime == 0 {
                        unmap_calls_srv.fetch_add(1, Ordering::SeqCst);
                    } else if req_ext == 5000 {
                        // Simula puerto externo ocupado en el primer intento para verificar reintento con 0.
                        resp[2..4].copy_from_slice(&4u16.to_be_bytes());
                        let _ = udp.send_to(&resp, peer).await;
                        continue;
                    } else {
                        map_calls_srv.fetch_add(1, Ordering::SeqCst);
                        let granted_ext = if req_ext == 0 { 51234 } else { req_ext };
                        resp[10..12].copy_from_slice(&granted_ext.to_be_bytes());
                        resp[12..16].copy_from_slice(&lifetime.to_be_bytes());
                    }
                    let _ = udp.send_to(&resp, peer).await;
                }
                _ => {}
            }
        }
    });

    // 1) Mapeo directo por NAT-PMP con reintento automático tras código de error cuando ext=5000 falla.
    let mapping = match map_port(
        5000,
        Some(5000),
        MapPortOptions {
            auto_renew: false,
            discover_timeout_ms: 1000,
            natpmp_gateway: Some(gw_addr),
            ..Default::default()
        },
    )
    .await
    {
        MapOutcome::Mapped(m) => m,
        MapOutcome::Failed(res) => panic!("NAT-PMP mapping failed: {:?}", res.reason),
    };
    assert_eq!(mapping.protocol_label(), "NAT-PMP");
    assert_eq!(mapping.external_port, 51234);
    assert_eq!(mapping.public_ip.as_deref(), Some("203.0.113.88"));
    assert_eq!(map_calls.load(Ordering::SeqCst), 1);

    assert!(mapping.renew().await);
    assert_eq!(map_calls.load(Ordering::SeqCst), 2);

    mapping.unmap().await;
    for _ in 0..20 {
        if unmap_calls.load(Ordering::SeqCst) >= 1 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert_eq!(unmap_calls.load(Ordering::SeqCst), 1);

    // 2) Respaldo automático a NAT-PMP cuando el router UPnP falla al mapear.
    let failing_upnp = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upnp_port = failing_upnp.local_addr().unwrap().port();
    let upnp_srv = tokio::spawn(async move {
        if let Ok((mut stream, _)) = failing_upnp.accept().await {
            let mut tmp = [0u8; 2048];
            let _ = stream.read(&mut tmp).await;
            let body = "error 501";
            let resp = format!(
                "HTTP/1.1 500 Internal Server Error\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(resp.as_bytes()).await;
        }
    });

    let fallback = match map_port(
        6000,
        Some(51235),
        MapPortOptions {
            auto_renew: false,
            max_retries: 0,
            discover_timeout_ms: 1000,
            router: Some(UpnpRouter {
                control_url: format!("http://127.0.0.1:{upnp_port}/ctl"),
                service_type: "urn:schemas-upnp-org:service:WANIPConnection:1".into(),
                router_ip: "127.0.0.1".into(),
                client_lan_ip: "127.0.0.1".into(),
            }),
            natpmp_gateway: Some(gw_addr),
            ..Default::default()
        },
    )
    .await
    {
        MapOutcome::Mapped(m) => m,
        MapOutcome::Failed(res) => panic!("Fallback to NAT-PMP failed: {:?}", res.reason),
    };
    assert_eq!(fallback.protocol_label(), "NAT-PMP");
    assert_eq!(fallback.external_port, 51235);
    fallback.unmap().await;

    upnp_srv.abort();
    natpmp_srv.abort();
}

#[test]
fn test_mdns_wire_encoding_compression_and_privacy() {
    let code = "7319-cobalt-orchid-velvet-lynx";
    let hash = room_hash(code);
    let q_mcast = build_mdns_query(SERVICE_TYPE, false);
    assert_eq!(is_drop_ptr_query(&q_mcast), Some(false));
    let q_qu = build_mdns_query(SERVICE_TYPE, true);
    assert_eq!(is_drop_ptr_query(&q_qu), Some(true));
    assert_eq!(is_drop_ptr_query(&build_mdns_query("_http._tcp.local", false)), None);

    let pkt = build_mdns_response(
        &hash,
        45123,
        &[Ipv4Addr::new(192, 168, 10, 4)],
        &[],
    );
    // El paquete mDNS jamás puede filtrar las cuatro palabras secretas ni parte del secreto.
    let lower_bytes = String::from_utf8_lossy(&pkt).to_ascii_lowercase();
    for secret_word in ["cobalt", "orchid", "velvet", "lynx"] {
        assert!(!lower_bytes.contains(secret_word), "secreto filtrado en mDNS: {secret_word}");
    }
    assert!(lower_bytes.contains(&hash));

    let src: std::net::SocketAddr = "192.168.10.4:5353".parse().unwrap();
    assert_eq!(
        parse_mdns_response(&pkt, src, &hash),
        Some(("192.168.10.4".to_string(), 45123))
    );
    assert_eq!(parse_mdns_response(&pkt, src, "0000000000000000"), None);

    // Respaldo a registro A del paquete si la IP origen viniera sin especificar.
    let unspec: std::net::SocketAddr = "0.0.0.0:5353".parse().unwrap();
    assert_eq!(
        parse_mdns_response(&pkt, unspec, &hash),
        Some(("192.168.10.4".to_string(), 45123))
    );

    // Paquete DNS comprimido manualmente con punteros 0xC0 para validar decode_dns_name.
    let test_hash = "0123456789abcdef";
    let service_wire = encode_dns_name(SERVICE_TYPE).unwrap();
    let inst_prefix = format!("drop-{test_hash}");
    let target_wire = encode_dns_name(&format!("drop-{test_hash}.local")).unwrap();

    let mut compressed = vec![
        0, 0, 0x84, 0x00, // flags QR=1 AA=1
        0, 0, 0, 3,       // ANCOUNT=3
        0, 0, 0, 0,
    ];
    compressed.extend_from_slice(&service_wire); // empieza en offset 12 (0x0C)
    compressed.extend_from_slice(&12u16.to_be_bytes()); // PTR
    compressed.extend_from_slice(&1u16.to_be_bytes());
    compressed.extend_from_slice(&120u32.to_be_bytes());
    let ptr_rdata_len = (1 + inst_prefix.len() + 2) as u16;
    compressed.extend_from_slice(&ptr_rdata_len.to_be_bytes());
    let inst_offset = compressed.len();
    compressed.push(inst_prefix.len() as u8);
    compressed.extend_from_slice(inst_prefix.as_bytes());
    compressed.extend_from_slice(&[0xC0, 0x0C]); // puntero a _drop._tcp.local

    let ptr_hi = 0xC0 | ((inst_offset >> 8) as u8);
    let ptr_lo = (inst_offset & 0xFF) as u8;

    // SRV con nombre comprimido apuntando a inst_offset.
    compressed.extend_from_slice(&[ptr_hi, ptr_lo]);
    compressed.extend_from_slice(&33u16.to_be_bytes());
    compressed.extend_from_slice(&0x8001u16.to_be_bytes());
    compressed.extend_from_slice(&120u32.to_be_bytes());
    compressed.extend_from_slice(&((6 + target_wire.len()) as u16).to_be_bytes());
    compressed.extend_from_slice(&[0, 0, 0, 0]);
    compressed.extend_from_slice(&49152u16.to_be_bytes());
    compressed.extend_from_slice(&target_wire);

    // TXT con nombre comprimido apuntando a inst_offset.
    let txt_h = format!("h={test_hash}");
    let txt_p = "p=49152";
    compressed.extend_from_slice(&[ptr_hi, ptr_lo]);
    compressed.extend_from_slice(&16u16.to_be_bytes());
    compressed.extend_from_slice(&0x8001u16.to_be_bytes());
    compressed.extend_from_slice(&120u32.to_be_bytes());
    compressed.extend_from_slice(&((2 + txt_h.len() + txt_p.len()) as u16).to_be_bytes());
    compressed.push(txt_h.len() as u8);
    compressed.extend_from_slice(txt_h.as_bytes());
    compressed.push(txt_p.len() as u8);
    compressed.extend_from_slice(txt_p.as_bytes());

    assert_eq!(
        parse_mdns_response(&compressed, src, test_hash),
        Some(("192.168.10.4".to_string(), 49152))
    );
    // Protección frente a bucle infinito en punteros DNS maliciosos.
    assert!(decode_dns_name(&[0xC0, 0x00], 0).is_none());
}

#[tokio::test]
async fn test_mdns_responder_query_reply_and_tcp_connect() {
    let tcp_listener = listen_any_family(0).unwrap();
    let tcp_port = tcp_listener.local_addr().unwrap().port();
    let srv = tokio::spawn(async move {
        let _ = tcp_listener.accept().await;
    });

    let code = "4123-maple-cedar-frost-river";
    let hash = room_hash(code);
    let mut responder = start_mdns_on(code, tcp_port, 0);
    let mdns_v4_port = responder.local_v4_port().expect("socket mDNS v4 activo");

    let client = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let target: std::net::SocketAddr = format!("127.0.0.1:{mdns_v4_port}").parse().unwrap();
    let query = build_mdns_query(SERVICE_TYPE, true);
    client.send_to(&query, target).await.unwrap();

    let mut buf = [0u8; 4096];
    let recv_res = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            let (n, peer) = client.recv_from(&mut buf).await.ok()?;
            if let Some(hit) = parse_mdns_response(&buf[..n], peer, &hash) {
                return Some(hit);
            }
        }
    })
    .await
    .ok()
    .flatten();

    responder.stop();

    let (host, discovered_port) = recv_res.expect("respuesta mDNS válida tras consulta PTR");
    assert_eq!(discovered_port, tcp_port);
    let conn = connect_host(&host, discovered_port).await;
    assert!(conn.is_ok(), "fallo conectando TCP tras mDNS: {conn:?}");
    srv.await.unwrap();
}

#[tokio::test]
async fn test_mdns_multicast_roundtrip_and_graceful_degradation() {
    assert_eq!(MDNS_V4, Ipv4Addr::new(224, 0, 0, 251));
    assert_eq!(MDNS_V6, std::net::Ipv6Addr::new(0xff02, 0, 0, 0, 0, 0, 0, 0xfb));

    // Puerto ocupado o sin respuestas debe degradar devolviendo None sin paniquear.
    let occupied = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
    let occupied_port = occupied.local_addr().unwrap().port();
    assert_eq!(
        listen_mdns_on("8811-maple-cedar-frost-river", 100, occupied_port).await,
        None
    );
    drop(occupied);

    // Prueba de multicast mDNS real en puerto efímero si el entorno tiene ruta multicast loopback.
    let tcp_listener = listen_any_family(0).unwrap();
    let tcp_port = tcp_listener.local_addr().unwrap().port();
    let srv = tokio::spawn(async move {
        let _ = tcp_listener.accept().await;
    });

    let code = "6204-maple-cedar-frost-river";
    let mut responder = start_mdns_on(code, tcp_port, 0);
    if let Some(mdns_port) = responder.local_v4_port() {
        let hit = listen_mdns_on(code, 1000, mdns_port).await;
        responder.stop();
        if let Some((host, port)) = hit {
            assert_eq!(port, tcp_port);
            let conn = connect_host(&host, port).await;
            assert!(conn.is_ok(), "fallo conectando TCP tras multicast mDNS: {conn:?}");
            srv.await.unwrap();
            return;
        }
    } else {
        responder.stop();
    }
    srv.abort();
}

#[test]
fn test_pcp_packet_builders_and_parsers() {
    let nonce = [1u8, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    let req = build_pcp_map_tcp_request(Ipv4Addr::new(192, 168, 1, 50), &nonce, 4444, 4444, 7200);
    assert_eq!(req.len(), 60);
    assert_eq!(req[0], 2); // PCP version 2
    assert_eq!(req[1], 1); // Opcode MAP
    assert_eq!(u32::from_be_bytes([req[4], req[5], req[6], req[7]]), 7200);
    assert_eq!(&req[18..24], &[0xff, 0xff, 192, 168, 1, 50]);
    assert_eq!(&req[24..36], &nonce);
    assert_eq!(req[36], 6); // TCP
    assert_eq!(u16::from_be_bytes([req[40], req[41]]), 4444);
    assert_eq!(u16::from_be_bytes([req[42], req[43]]), 4444);

    let mut resp = [0u8; 60];
    resp[0] = 2;
    resp[1] = 0x81; // Response MAP
    resp[3] = 0; // SUCCESS
    resp[4..8].copy_from_slice(&3600u32.to_be_bytes());
    resp[24..36].copy_from_slice(&nonce);
    resp[36] = 6;
    resp[40..42].copy_from_slice(&4444u16.to_be_bytes());
    resp[42..44].copy_from_slice(&54444u16.to_be_bytes());
    resp[54..60].copy_from_slice(&[0xff, 0xff, 198, 51, 100, 99]);

    let parsed = parse_pcp_map_tcp_response(&resp, &nonce, 4444).unwrap();
    assert_eq!(parsed.internal_port, 4444);
    assert_eq!(parsed.external_port, 54444);
    assert_eq!(parsed.lifetime_sec, 3600);
    assert_eq!(
        parsed.external_ip,
        std::net::IpAddr::V4(Ipv4Addr::new(198, 51, 100, 99))
    );

    // Nonce distinto o código de error deben rechazarse
    let wrong_nonce = [9u8; 12];
    assert!(parse_pcp_map_tcp_response(&resp, &wrong_nonce, 4444).is_err());
    resp[3] = 7; // NO_RESOURCES
    assert!(parse_pcp_map_tcp_response(&resp, &nonce, 4444).is_err());
}

#[tokio::test]
async fn test_pcp_fallback_map_renew_and_unmap() {
    let udp = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let gw_addr = udp.local_addr().unwrap();
    let map_calls = Arc::new(AtomicUsize::new(0));
    let unmap_calls = Arc::new(AtomicUsize::new(0));
    let map_calls_srv = map_calls.clone();
    let unmap_calls_srv = unmap_calls.clone();

    let pcp_srv = tokio::spawn(async move {
        let mut buf = [0u8; 128];
        loop {
            let (n, peer) = match udp.recv_from(&mut buf).await {
                Ok(v) => v,
                Err(e) if e.kind() == std::io::ErrorKind::ConnectionReset => continue,
                Err(_) => break,
            };
            // Rechaza NAT-PMP v0 con UNSUPP_VERSION (código 1) como un router solo-PCP.
            if n >= 2 && buf[0] == 0 {
                let err_resp = [0u8, buf[1] | 0x80, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0];
                let _ = udp.send_to(&err_resp, peer).await;
                continue;
            }
            if n >= 60 && buf[0] == 2 && buf[1] == 1 {
                let lifetime = u32::from_be_bytes([buf[4], buf[5], buf[6], buf[7]]);
                let internal = u16::from_be_bytes([buf[40], buf[41]]);
                let suggested = u16::from_be_bytes([buf[42], buf[43]]);
                let mut resp = [0u8; 60];
                resp[0] = 2;
                resp[1] = 0x81;
                resp[3] = 0;
                resp[24..36].copy_from_slice(&buf[24..36]);
                resp[36] = 6;
                resp[40..42].copy_from_slice(&internal.to_be_bytes());
                resp[54..60].copy_from_slice(&[0xff, 0xff, 203, 0, 113, 88]);
                if lifetime == 0 {
                    unmap_calls_srv.fetch_add(1, Ordering::SeqCst);
                    resp[4..8].copy_from_slice(&0u32.to_be_bytes());
                    resp[42..44].copy_from_slice(&0u16.to_be_bytes());
                } else {
                    map_calls_srv.fetch_add(1, Ordering::SeqCst);
                    let assigned = if suggested != 0 { suggested } else { 52000 };
                    resp[4..8].copy_from_slice(&3600u32.to_be_bytes());
                    resp[42..44].copy_from_slice(&assigned.to_be_bytes());
                }
                let _ = udp.send_to(&resp, peer).await;
            }
        }
    });

    let out = map_port(
        6100,
        Some(6100),
        MapPortOptions {
            natpmp_gateway: Some(gw_addr),
            auto_renew: false,
            discover_timeout_ms: 1500,
            ..Default::default()
        },
    )
    .await;
    let mapping = match out {
        MapOutcome::Mapped(m) => m,
        MapOutcome::Failed(res) => panic!("PCP fallback failed: {:?}", res.reason),
    };
    assert_eq!(mapping.protocol_label(), "PCP");
    assert_eq!(mapping.external_port, 6100);
    assert_eq!(mapping.public_ip.as_deref(), Some("203.0.113.88"));
    assert_eq!(map_calls.load(Ordering::SeqCst), 1);

    assert!(mapping.renew().await);
    assert_eq!(map_calls.load(Ordering::SeqCst), 2);

    mapping.unmap().await;
    tokio::time::sleep(std::time::Duration::from_millis(40)).await;
    assert_eq!(unmap_calls.load(Ordering::SeqCst), 1);
    pcp_srv.abort();
}
