// Pruebas unitarias y de integracion de red: listen, discovery, stun, upnp, signaling y pkgmgr.

use std::collections::HashSet;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream, UdpSocket};

use drop::discovery::{
    get_candidate_ips, get_local_ipv6s, is_link_local_v6, is_local_address, is_unique_local_v6,
    plain_address, probe_candidate_ips, rank_candidates, room_hash,
};
use drop::listen::{explain_listen_error, listen_any_family};
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
