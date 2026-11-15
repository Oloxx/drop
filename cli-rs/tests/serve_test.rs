// Pruebas unitarias y de integracion del servidor embebido (`drop serve`).

use std::path::PathBuf;

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::{connect_async, tungstenite};

use drop::cli::VERSION;
use drop::commands::serve::{PUBLIC_ASSETS, start_server};
use drop::listen::listen_on_addr;

async fn http_raw(port: u16, req: &str) -> (u16, String, Vec<u8>) {
    let mut stream = TcpStream::connect(("127.0.0.1", port))
        .await
        .expect("connect");
    stream.write_all(req.as_bytes()).await.expect("write");
    stream.shutdown().await.expect("shutdown write");

    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).await.expect("read");
    let split = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .expect("separator");
    let head = String::from_utf8_lossy(&raw[..split]).to_string();
    let status = head
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|c| c.parse::<u16>().ok())
        .expect("status code");
    let body = raw[split + 4..].to_vec();
    (status, head, body)
}

async fn next_json<S>(stream: &mut S) -> Value
where
    S: StreamExt<Item = Result<Message, tungstenite::Error>> + Unpin,
{
    while let Some(item) = stream.next().await {
        match item.expect("ws frame") {
            Message::Text(txt) => {
                return serde_json::from_str(&txt).expect("valid json");
            }
            Message::Ping(_) | Message::Pong(_) => continue,
            other => panic!("frame inesperado: {other:?}"),
        }
    }
    panic!("websocket cerrado antes de recibir JSON");
}

#[tokio::test]
async fn test_listen_on_addr_validates_host_and_port_in_use() {
    let listener = listen_on_addr(Some("127.0.0.1"), 0).expect("bind loopback");
    let port = listener.local_addr().unwrap().port();
    assert_ne!(port, 0);

    let conflict = listen_on_addr(Some("127.0.0.1"), port).expect_err("port busy");
    assert!(conflict.message.contains("ya está en uso"));

    let bad_host = listen_on_addr(Some("no-es-una-ip"), 0).expect_err("invalid host");
    assert!(bad_host.message.contains("no válida"));
}

#[test]
fn test_embedded_public_matches_disk() {
    let public_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("public");
    assert!(
        PUBLIC_ASSETS.len() >= 20,
        "faltan activos embebidos: {}",
        PUBLIC_ASSETS.len()
    );
    for (web_path, bytes) in PUBLIC_ASSETS {
        let rel = web_path.trim_start_matches('/');
        let disk = std::fs::read(public_root.join(rel)).expect("leer activo en public/");
        assert_eq!(*bytes, disk.as_slice(), "desajuste en activo {web_path}");
    }
}

#[tokio::test]
async fn test_serve_http_endpoints_headers_and_static() {
    let srv = start_server(Some("127.0.0.1"), 0)
        .await
        .expect("start_server");
    let port = srv.addr.port();

    let (status, head, body) = http_raw(
        port,
        "GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
    )
    .await;
    assert_eq!(status, 200);
    let head_lower = head.to_ascii_lowercase();
    assert!(head_lower.contains("content-type: text/html; charset=utf-8"));
    assert!(head_lower.contains("content-security-policy: default-src 'self'"));
    assert!(head_lower.contains("x-content-type-options: nosniff"));
    assert!(head_lower.contains("referrer-policy: no-referrer"));
    assert!(head_lower.contains("permissions-policy: camera=()"));
    assert!(!head_lower.contains("x-powered-by:"));
    assert!(String::from_utf8_lossy(&body).to_ascii_lowercase().contains("<!doctype html>"));

    // HEAD no debe enviar cuerpo, pero si el Content-Length real.
    let (h_status, h_head, h_body) = http_raw(
        port,
        "HEAD / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
    )
    .await;
    assert_eq!(h_status, 200);
    assert!(h_body.is_empty());
    assert!(
        h_head
            .to_ascii_lowercase()
            .contains(&format!("content-length: {}", body.len()))
    );

    // Extension .html limpia (/speed -> /speed.html)
    let (s_status, _, s_body) = http_raw(
        port,
        "GET /speed HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
    )
    .await;
    assert_eq!(s_status, 200);
    assert!(!s_body.is_empty());

    // Traversal rechazado
    let (t_status, _, _) = http_raw(
        port,
        "GET /%2e%2e/package.json HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
    )
    .await;
    assert_eq!(t_status, 404);

    // /config
    let (c_status, c_head, c_body) = http_raw(
        port,
        "GET /config HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
    )
    .await;
    assert_eq!(c_status, 200);
    assert!(c_head.to_ascii_lowercase().contains("cache-control: no-store"));
    let cfg: Value = serde_json::from_slice(&c_body).unwrap();
    assert!(cfg["iceServers"].is_array());
    assert!(cfg["ttl"].as_u64().unwrap() > 0);

    // /version
    let (v_status, v_head, v_body) = http_raw(
        port,
        "GET /version HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
    )
    .await;
    assert_eq!(v_status, 200);
    assert!(v_head.to_ascii_lowercase().contains("cache-control: no-store"));
    let ver: Value = serde_json::from_slice(&v_body).unwrap();
    assert_eq!(ver["version"], VERSION);

    // /healthz
    let (hz_status, hz_head, hz_body) = http_raw(
        port,
        "GET /healthz HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
    )
    .await;
    assert_eq!(hz_status, 200);
    assert!(hz_head.to_ascii_lowercase().contains("cache-control: no-store"));
    let hz: Value = serde_json::from_slice(&hz_body).unwrap();
    assert_eq!(hz["ok"], true);
    assert_eq!(hz["rooms"], 0);

    srv.shutdown().await;
}

#[tokio::test]
async fn test_serve_websocket_signaling_relay_and_security() {
    let srv = start_server(Some("127.0.0.1"), 0)
        .await
        .expect("start_server");
    let port = srv.addr.port();
    let ws_url = format!("ws://127.0.0.1:{port}");

    // Origen ajeno rechazado con 403 en el upgrade
    let mut bad_req = ws_url.as_str().into_client_request().unwrap();
    bad_req
        .headers_mut()
        .insert("Origin", HeaderValue::from_static("https://attacker.invalid"));
    let err = connect_async(bad_req).await.expect_err("origin forbidden");
    if let tungstenite::Error::Http(resp) = err {
        assert_eq!(resp.status().as_u16(), 403);
    } else {
        panic!("esperaba 403 HTTP, recibi: {err:?}");
    }

    // Mismo origen permitido (ej. LAN / local web UI)
    let mut ok_req = ws_url.as_str().into_client_request().unwrap();
    let local_origin = format!("http://127.0.0.1:{port}");
    ok_req
        .headers_mut()
        .insert("Origin", HeaderValue::from_str(&local_origin).unwrap());
    let (mut probe_ws, _) = connect_async(ok_req).await.expect("same origin allowed");
    // Sin v:2 devuelve VERSION
    probe_ws
        .send(Message::Text(json!({ "t": "host" }).to_string().into()))
        .await
        .unwrap();
    let v_err = next_json(&mut probe_ws).await;
    assert_eq!(v_err["t"], "error");
    assert_eq!(v_err["reason"], "VERSION");

    // Host + Guest + Relay + bad-guest BURNED
    let (mut host, _) = connect_async(&ws_url).await.expect("host ws");
    host.send(Message::Text(json!({ "t": "host", "v": 2 }).to_string().into()))
        .await
        .unwrap();
    let hosted = next_json(&mut host).await;
    assert_eq!(hosted["t"], "hosted");
    let token = hosted["token"].as_str().unwrap().to_string();
    assert_eq!(token.len(), 4);
    assert!(token.chars().all(|c| c.is_ascii_digit()));

    // Link mode genera token largo base64url (16 chars)
    let (mut link_host, _) = connect_async(&ws_url).await.expect("link host");
    link_host
        .send(Message::Text(
            json!({ "t": "host", "v": 2, "link": true }).to_string().into(),
        ))
        .await
        .unwrap();
    let link_hosted = next_json(&mut link_host).await;
    assert_eq!(link_hosted["token"].as_str().unwrap().len(), 16);

    let (mut guest, _) = connect_async(&ws_url).await.expect("guest ws");
    guest
        .send(Message::Text(
            json!({ "t": "join", "token": "zzzz" }).to_string().into(),
        ))
        .await
        .unwrap();
    let nf = next_json(&mut guest).await;
    assert_eq!(nf["reason"], "NOT_FOUND");

    guest
        .send(Message::Text(
            json!({ "t": "join", "token": token, "name": "receptor-1" })
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    let joined = next_json(&mut guest).await;
    assert_eq!(joined["t"], "joined");
    let guest_id = joined["guestId"].as_u64().unwrap() as u32;

    let notice = next_json(&mut host).await;
    assert_eq!(notice["t"], "guest");
    assert_eq!(notice["guestId"], guest_id);
    assert_eq!(notice["name"], "receptor-1");

    // Señalizacion host -> guest y guest -> host
    host.send(Message::Text(
        json!({ "t": "signal", "to": guest_id, "data": { "hello": 1 } })
            .to_string()
            .into(),
    ))
    .await
    .unwrap();
    let sig_g = next_json(&mut guest).await;
    assert_eq!(sig_g["t"], "signal");
    assert_eq!(sig_g["from"], 0);
    assert_eq!(sig_g["data"]["hello"], 1);

    // Relay binario host -> guest (4 bytes BE guestId + payload)
    let mut packet = guest_id.to_be_bytes().to_vec();
    packet.extend_from_slice(b"hola-binario");
    host.send(Message::Binary(packet.into()))
        .await
        .unwrap();
    let bin_g = loop {
        match guest.next().await.unwrap().unwrap() {
            Message::Binary(b) => break b,
            Message::Ping(_) => continue,
            other => panic!("esperaba binario, recibi {other:?}"),
        }
    };
    assert_eq!(bin_g.as_ref(), b"hola-binario");

    // 5 bad-guest queman la sala y mandan BURNED al emisor
    for _ in 0..5 {
        host.send(Message::Text(
            json!({ "t": "bad-guest", "guestId": guest_id })
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    }
    let g_err = next_json(&mut guest).await;
    assert_eq!(g_err["reason"], "BAD_SECRET");
    let h_err = next_json(&mut host).await;
    assert_eq!(h_err["reason"], "BURNED");

    // /healthz refleja salas abiertas, bytes y rechazos
    let (_, _, hz_body) = http_raw(
        port,
        "GET /healthz HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
    )
    .await;
    let hz: Value = serde_json::from_slice(&hz_body).unwrap();
    assert_eq!(hz["roomsOpened"], 2);
    assert_eq!(hz["relay"]["frames"], 1);
    assert!(hz["relay"]["bytes"].as_u64().unwrap() >= 16);
    assert_eq!(hz["rejected"]["BURNED"], 1);

    srv.shutdown().await;
}
