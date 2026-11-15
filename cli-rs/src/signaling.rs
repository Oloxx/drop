// Cliente WebSocket del servidor de señalizacion (`host`, `join`, `signal`, `bad-guest`, binario relay).

use std::env;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use url::Url;

pub fn get_signaling_url(server_url: &str) -> Result<String, String> {
    let url = Url::parse(server_url)
        .map_err(|e| format!("URL de servidor invalida ({server_url}): {e}"))?;
    let proto = if url.scheme().eq_ignore_ascii_case("https") {
        "wss:"
    } else {
        "ws:"
    };
    let host = url.host_str().unwrap_or("");
    let host_port = match url.port() {
        Some(p) => format!("{host}:{p}"),
        None => host.to_string(),
    };
    Ok(format!("{proto}//{host_port}"))
}

pub fn default_server_url() -> String {
    env::var("DROP_SERVER")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "https://drop.oloxx.dev".to_string())
}

pub fn translate_error(reason: &str) -> String {
    match reason {
        "NOT_FOUND" => "Sala no encontrada: el codigo ha caducado o el emisor ha cerrado.".to_string(),
        "RATE_LIMITED" => "Demasiados intentos fallidos desde esta IP. Espera un minuto.".to_string(),
        "BAD_SECRET" => "El emisor ha rechazado el codigo: las palabras no coinciden.".to_string(),
        "BURNED" => "La sala se ha cerrado tras varios intentos con codigos incorrectos.".to_string(),
        "ROOM_FULL" => "La sala esta llena: ya tiene todos los receptores que admite.".to_string(),
        "TOO_MANY_ROOMS" => "Demasiadas salas abiertas desde esta IP. Espera un minuto.".to_string(),
        "EXPIRED" => "La sala ha caducado por inactividad.".to_string(),
        "FLOOD" => "El servidor ha cortado la conexion: demasiados mensajes seguidos.".to_string(),
        "VERSION" => "El servidor ya no admite esta version del CLI. Ejecuta `drop update`.".to_string(),
        other => other.to_string(),
    }
}

#[derive(Debug, Clone)]
pub enum WsEvent {
    Json(Value),
    Binary(Vec<u8>),
    Closed,
}

#[derive(Clone)]
pub struct SignalingSender {
    tx: mpsc::UnboundedSender<(Message, usize)>,
    queued_bytes: Arc<AtomicUsize>,
    queued_tx: watch::Sender<usize>,
    writer_done: watch::Sender<bool>,
}

impl SignalingSender {
    pub fn queued_bytes(&self) -> usize {
        self.queued_bytes.load(Ordering::SeqCst)
    }

    pub async fn wait_below(&self, max_bytes: usize) {
        let mut rx = self.queued_tx.subscribe();
        let _ = rx.wait_for(|&v| v <= max_bytes).await;
    }

    pub async fn drain(&self) {
        self.wait_below(0).await;
    }

    pub fn send_json(&self, val: &Value) -> Result<(), String> {
        let txt = val.to_string();
        let len = txt.len();
        let new_total = self.queued_bytes.fetch_add(len, Ordering::SeqCst) + len;
        let _ = self.queued_tx.send(new_total);
        if self.tx.send((Message::Text(txt.into()), len)).is_err() {
            let dec = self.queued_bytes.fetch_sub(len, Ordering::SeqCst).saturating_sub(len);
            let _ = self.queued_tx.send(dec);
            return Err("WebSocket de señalización cerrado".to_string());
        }
        Ok(())
    }

    pub fn send_binary(&self, data: Vec<u8>) -> Result<(), String> {
        let len = data.len();
        let new_total = self.queued_bytes.fetch_add(len, Ordering::SeqCst) + len;
        let _ = self.queued_tx.send(new_total);
        if self.tx.send((Message::Binary(data.into()), len)).is_err() {
            let dec = self.queued_bytes.fetch_sub(len, Ordering::SeqCst).saturating_sub(len);
            let _ = self.queued_tx.send(dec);
            return Err("WebSocket de señalización cerrado".to_string());
        }
        Ok(())
    }

    pub fn report_bad_guest(&self, guest_id: u64) {
        let _ = self.send_json(&json!({ "t": "bad-guest", "guestId": guest_id }));
    }

    pub fn send_signal(&self, to: Option<u64>, data: &Value) -> Result<(), String> {
        let msg = match to {
            Some(id) => json!({ "t": "signal", "to": id, "data": data }),
            None => json!({ "t": "signal", "data": data }),
        };
        self.send_json(&msg)
    }

    pub fn close(&self) {
        let _ = self.tx.send((Message::Close(None), 0));
    }

    pub async fn close_and_wait(&self) {
        let mut rx = self.writer_done.subscribe();
        self.close();
        let _ = tokio::time::timeout(Duration::from_secs(2), rx.wait_for(|&done| done)).await;
    }
}

pub struct SignalingClient {
    pub sender: SignalingSender,
    pub events: mpsc::UnboundedReceiver<WsEvent>,
    pub public_ip: Option<String>,
}

#[derive(Debug, Clone)]
pub struct RoomInfo {
    pub room_id: String,
    pub public_ip: Option<String>,
}

#[derive(Debug, Clone)]
pub struct JoinedInfo {
    pub guest_id: Value,
    pub public_ip: Option<String>,
}

pub async fn connect_signaling(server_url: &str) -> Result<SignalingClient, String> {
    let target = get_signaling_url(server_url)?;
    let (ws_stream, _) = connect_async(&target)
        .await
        .map_err(|_| format!("No se pudo conectar al servidor de señalización: {target}"))?;

    let (mut sink, mut stream) = ws_stream.split();
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<(Message, usize)>();
    let (ev_tx, ev_rx) = mpsc::unbounded_channel::<WsEvent>();
    let queued_bytes = Arc::new(AtomicUsize::new(0));
    let (queued_tx, _queued_rx) = watch::channel(0usize);
    let (writer_done_tx, _writer_done_rx) = watch::channel(false);

    let qb_writer = Arc::clone(&queued_bytes);
    let qt_writer = queued_tx.clone();
    let wd_writer = writer_done_tx.clone();
    tokio::spawn(async move {
        while let Some((msg, len)) = out_rx.recv().await {
            let is_close = matches!(msg, Message::Close(_));
            let res = sink.send(msg).await;
            let rem = if len > 0 {
                qb_writer.fetch_sub(len, Ordering::SeqCst).saturating_sub(len)
            } else {
                qb_writer.load(Ordering::SeqCst)
            };
            let _ = qt_writer.send(rem);
            if res.is_err() || is_close {
                break;
            }
        }
        qb_writer.store(0, Ordering::SeqCst);
        let _ = qt_writer.send(0);
        let _ = sink.close().await;
        let _ = wd_writer.send(true);
    });

    tokio::spawn(async move {
        while let Some(item) = stream.next().await {
            match item {
                Ok(Message::Text(txt)) => {
                    if let Ok(val) = serde_json::from_str::<Value>(txt.as_str())
                        && ev_tx.send(WsEvent::Json(val)).is_err()
                    {
                        break;
                    }
                }
                Ok(Message::Binary(bin)) => {
                    if ev_tx.send(WsEvent::Binary(bin.to_vec())).is_err() {
                        break;
                    }
                }
                Ok(Message::Close(_)) | Err(_) => {
                    let _ = ev_tx.send(WsEvent::Closed);
                    break;
                }
                Ok(_) => {}
            }
        }
        let _ = ev_tx.send(WsEvent::Closed);
    });

    Ok(SignalingClient {
        sender: SignalingSender {
            tx: out_tx,
            queued_bytes,
            queued_tx,
            writer_done: writer_done_tx,
        },
        events: ev_rx,
        public_ip: None,
    })
}

pub async fn create_room(client: &mut SignalingClient) -> Result<RoomInfo, String> {
    client.sender.send_json(&json!({ "t": "host", "v": 2 }))?;
    while let Some(ev) = client.events.recv().await {
        match ev {
            WsEvent::Json(msg) => match msg.get("t").and_then(|v| v.as_str()) {
                Some("hosted") => {
                    let public_ip = msg
                        .get("publicIp")
                        .and_then(|v| v.as_str())
                        .map(str::to_string);
                    let room_id = msg
                        .get("room")
                        .or_else(|| msg.get("token"))
                        .and_then(|v| v.as_str())
                        .ok_or_else(|| "Respuesta hosted sin sala".to_string())?
                        .to_string();
                    client.public_ip = public_ip.clone();
                    return Ok(RoomInfo { room_id, public_ip });
                }
                Some("error") => {
                    let reason = msg.get("reason").and_then(|v| v.as_str()).unwrap_or("ERROR");
                    if reason == "NO_ROOMS" {
                        return Err(
                            "El servidor no tiene salas libres ahora mismo. Prueba en unos segundos."
                                .to_string(),
                        );
                    }
                    return Err(reason.to_string());
                }
                _ => {}
            },
            WsEvent::Closed => return Err("Conexión cerrada antes de crear la sala".to_string()),
            WsEvent::Binary(_) => {}
        }
    }
    Err("Conexión cerrada antes de crear la sala".to_string())
}

pub async fn join_room(
    client: &mut SignalingClient,
    room_id: &str,
    name: Option<&str>,
) -> Result<JoinedInfo, String> {
    let mut payload = json!({ "t": "join", "token": room_id });
    if let Some(n) = name
        && !n.is_empty()
    {
        payload["name"] = Value::String(n.to_string());
    }
    client.sender.send_json(&payload)?;

    while let Some(ev) = client.events.recv().await {
        match ev {
            WsEvent::Json(msg) => match msg.get("t").and_then(|v| v.as_str()) {
                Some("joined") => {
                    let public_ip = msg
                        .get("publicIp")
                        .and_then(|v| v.as_str())
                        .map(str::to_string);
                    let guest_id = msg.get("guestId").cloned().unwrap_or(Value::Null);
                    client.public_ip = public_ip.clone();
                    return Ok(JoinedInfo {
                        guest_id,
                        public_ip,
                    });
                }
                Some("error") => {
                    let reason = msg.get("reason").and_then(|v| v.as_str()).unwrap_or("ERROR");
                    return Err(translate_error(reason));
                }
                _ => {}
            },
            WsEvent::Closed => return Err("Conexión cerrada antes de entrar en la sala".to_string()),
            WsEvent::Binary(_) => {}
        }
    }
    Err("Conexión cerrada antes de entrar en la sala".to_string())
}
