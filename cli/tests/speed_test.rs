use std::time::Duration;

use serde_json::json;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;

use drop::signaling::WsEvent;
use drop::speed::{SpeedChannel, run_speed_test};

#[tokio::test]
async fn test_tcp_speed_channel_control_and_bidirectional_loopback() {
    let code = "5310-cargo-velvet-jungle-anchor";
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();

    let accept_task = tokio::spawn(async move {
        let (sock, _) = listener.accept().await.unwrap();
        SpeedChannel::from_tcp(sock, code, true, "Loopback TCP")
    });

    let client_sock = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let mut guest = SpeedChannel::from_tcp(client_sock, code, false, "Loopback TCP");
    let mut host = accept_task.await.unwrap();

    // Handshake basico cifrado
    guest
        .send_control(&json!({ "k": "hello", "val": 42 }))
        .await
        .unwrap();
    let hello = host
        .wait_control(|m| m.get("k").and_then(|v| v.as_str()) == Some("hello"), 2000)
        .await
        .unwrap();
    assert_eq!(hello["val"], 42);
    host.send_control(&json!({ "k": "welcome" })).await.unwrap();
    let _ = guest
        .wait_control(|m| m.get("k").and_then(|v| v.as_str()) == Some("welcome"), 2000)
        .await
        .unwrap();

    // Prueba bidireccional real de 1s
    let (h_res, g_res) = tokio::join!(run_speed_test(&mut host, true, 1), run_speed_test(&mut guest, false, 1));
    let hr = h_res.unwrap();
    let gr = g_res.unwrap();

    assert!(hr.rtt_ms >= 0.0);
    assert!(hr.out_bytes > 0);
    assert!(hr.in_bytes > 0);
    assert!(hr.out_rate > 0.0);
    assert!(hr.in_rate > 0.0);
    assert_eq!(hr.out_bytes, gr.in_bytes);
    assert_eq!(hr.in_bytes, gr.out_bytes);

    host.close();
    guest.close();
}

#[tokio::test]
async fn test_relay_speed_channel_bidirectional_mock_ws() {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::accept_async;
    use tokio_tungstenite::tungstenite::Message;

    // Mini relay mock que reenvia entre el primer socket (host) y el segundo (guest)
    // aplicando exactamente la regla de server/index.js sobre los primeros 4 bytes host->guest.
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();

    let relay_srv = tokio::spawn(async move {
        let (s_host, _) = listener.accept().await.unwrap();
        let ws_h = accept_async(s_host).await.unwrap();
        let (s_guest, _) = listener.accept().await.unwrap();
        let ws_g = accept_async(s_guest).await.unwrap();
        let (mut hw, mut hr) = ws_h.split();
        let (mut gw, mut gr) = ws_g.split();

        let (h_tx, mut h_rx) = mpsc::unbounded_channel::<Message>();
        let (g_tx, mut g_rx) = mpsc::unbounded_channel::<Message>();

        tokio::spawn(async move {
            while let Some(m) = h_rx.recv().await {
                if hw.send(m).await.is_err() {
                    break;
                }
            }
        });
        tokio::spawn(async move {
            while let Some(m) = g_rx.recv().await {
                if gw.send(m).await.is_err() {
                    break;
                }
            }
        });

        let p1 = async {
            while let Some(Ok(msg)) = hr.next().await {
                match msg {
                    Message::Binary(bin) if bin.len() >= 4 => {
                        let _ = g_tx.send(Message::Binary(bin.slice(4..)));
                    }
                    Message::Text(txt) => {
                        let _ = g_tx.send(Message::Text(txt));
                    }
                    _ => {}
                }
            }
        };
        let p2 = async {
            while let Some(Ok(msg)) = gr.next().await {
                match msg {
                    Message::Binary(bin) => {
                        let _ = h_tx.send(Message::Binary(bin));
                    }
                    Message::Text(txt) => {
                        let _ = h_tx.send(Message::Text(txt));
                    }
                    _ => {}
                }
            }
        };
        tokio::join!(p1, p2);
    });

    let url = format!("http://127.0.0.1:{port}");
    let ch_client = drop::signaling::connect_signaling(&url).await.unwrap();
    tokio::time::sleep(Duration::from_millis(20)).await;
    let cg_client = drop::signaling::connect_signaling(&url).await.unwrap();

    // Aseguramos los canales filtrando mensajes no-signal si hubiera
    let mut host = SpeedChannel::from_relay(ch_client.sender, ch_client.events, Some(1), true, "Mock Relay");
    let mut guest = SpeedChannel::from_relay(cg_client.sender, cg_client.events, None, false, "Mock Relay");
    let _ = WsEvent::Closed;

    let (h_res, g_res) = tokio::join!(run_speed_test(&mut host, true, 1), run_speed_test(&mut guest, false, 1));
    let hr = h_res.unwrap();
    let gr = g_res.unwrap();
    assert!(hr.out_bytes > 0);
    assert!(hr.in_bytes > 0);
    assert_eq!(hr.out_bytes, gr.in_bytes);
    assert_eq!(hr.in_bytes, gr.out_bytes);

    host.close();
    guest.close();
    relay_srv.abort();
}
