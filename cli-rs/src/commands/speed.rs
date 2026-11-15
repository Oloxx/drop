// Subcomando `drop speed` (modo anfitrion sin argumentos, modo cliente con codigo).

use std::env;
use std::io::Write;
use std::sync::Arc;
use std::time::Duration;

use serde_json::json;
use tokio::sync::{Mutex, Notify};
use tokio::time::timeout;

use crate::cli::Options;
use crate::discovery::{
    Broadcaster, connect_host, get_candidate_ips, is_local_address, listen_for_lan, plain_address,
    probe_candidate_ips, rank_candidates, start_broadcasting,
};
use crate::listen::listen_any_family;
use crate::shared::codes::{Lang, new_code, parse_code, random_room_id};
use crate::signaling::{WsEvent, connect_signaling, create_room, join_room, translate_error};
use crate::speed::{SpeedChannel, run_speed_test};
use crate::stun::{StunResult, discover_public_ip, merge_offer_candidates};
use crate::ui::{BOLD, CYAN, DIM, GREEN, RED, RESET, YELLOW};
use crate::upnp::{MapOutcome, MapPortOptions, UpnpMapping, UpnpResult, map_port};

pub async fn run_speed_host(options: Options) -> i32 {
    let duration_sec = options.time.max(1);

    println!("\n{BOLD}================================================================{RESET}");
    println!("  {CYAN}drop speed{RESET} — {BOLD}Medidor de Velocidad de Transferencia P2P{RESET}");
    println!("{BOLD}================================================================{RESET}\n");

    let listener = match listen_any_family(options.port) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("\n  {RED}{}{RESET}\n", e.message);
            return 1;
        }
    };
    let tcp_port = listener.local_addr().map(|a| a.port()).unwrap_or(0);

    let upnp_mapping_slot: Arc<Mutex<Option<Arc<UpnpMapping>>>> = Arc::new(Mutex::new(None));
    let upnp_res_slot: Arc<Mutex<Option<UpnpResult>>> = Arc::new(Mutex::new(None));
    let upnp_done = Arc::new(Notify::new());
    if !options.relay && env::var_os("DROP_NO_UPNP").is_none_or(|v| v.is_empty()) {
        let m_slot = Arc::clone(&upnp_mapping_slot);
        let r_slot = Arc::clone(&upnp_res_slot);
        let done = Arc::clone(&upnp_done);
        let pref = if options.port > 0 {
            Some(options.port)
        } else {
            Some(tcp_port)
        };
        tokio::spawn(async move {
            let opts = MapPortOptions {
                description: "drop-speed".to_string(),
                ..Default::default()
            };
            match map_port(tcp_port, pref, opts).await {
                MapOutcome::Mapped(m) => {
                    let res = m.as_result();
                    *r_slot.lock().await = Some(res.clone());
                    *m_slot.lock().await = Some(m);
                    println!(
                        "  {GREEN}✔ Puerto mapeado por UPnP en router:{RESET} {CYAN}:{}{RESET} {DIM}(IP WAN: {}){RESET}\n",
                        res.external_port.unwrap_or(tcp_port),
                        res.public_ip.as_deref().unwrap_or("detectada")
                    );
                }
                MapOutcome::Failed(res) => {
                    *r_slot.lock().await = Some(res);
                }
            }
            done.notify_waiters();
        });
    } else {
        upnp_done.notify_waiters();
    }

    let stun_res_slot: Arc<Mutex<Option<StunResult>>> = Arc::new(Mutex::new(None));
    let stun_done = Arc::new(Notify::new());
    if !options.relay && env::var_os("DROP_NO_STUN").is_none_or(|v| v.is_empty()) {
        let r_slot = Arc::clone(&stun_res_slot);
        let done = Arc::clone(&stun_done);
        tokio::spawn(async move {
            *r_slot.lock().await = discover_public_ip(None, 2500).await;
            done.notify_waiters();
        });
    } else {
        stun_done.notify_waiters();
    }

    let mut sig_client = match connect_signaling(&options.server).await {
        Ok(mut c) => match create_room(&mut c).await {
            Ok(info) => Some((c, info)),
            Err(_) => {
                println!(
                    "  {YELLOW}Aviso: Sin conexión con el servidor. Operando en modo LAN local pura.{RESET}"
                );
                None
            }
        },
        Err(_) => {
            println!(
                "  {YELLOW}Aviso: Sin conexión con el servidor. Operando en modo LAN local pura.{RESET}"
            );
            None
        }
    };

    let (room_id, ws_public_ip) = match &sig_client {
        Some((_, info)) => (info.room_id.clone(), info.public_ip.clone()),
        None => (random_room_id(), None),
    };
    let code = new_code(&room_id);
    let mut broadcaster: Option<Broadcaster> = if !options.relay {
        Some(start_broadcasting(&code, tcp_port))
    } else {
        None
    };

    println!("  {GREEN}✔ Canal de prueba abierto.{RESET}");
    println!("  {BOLD}Código:{RESET}  {CYAN}{BOLD}{code}{RESET}");
    println!("  {BOLD}Comando en el segundo cliente:{RESET}");
    println!(
        "    {YELLOW}drop speed {code}{}{RESET}\n",
        if options.relay { " --relay" } else { "" }
    );
    println!("  {DIM}Esperando a que el segundo cliente CLI se conecte...{RESET}\n");

    let local_ips = get_candidate_ips();
    let ws_sender_opt = sig_client.as_ref().map(|(c, _)| c.sender.clone());

    let mut channel: Option<SpeedChannel> = None;

    // Esperar conexion TCP valida (`hello`) o aceptacion Relay (`cli-speed-accept`)
    loop {
        let ws_next = async {
            match sig_client.as_mut() {
                Some((client, _)) => client.events.recv().await,
                None => std::future::pending().await,
            }
        };

        tokio::select! {
            _ = tokio::signal::ctrl_c() => {
                break;
            }
            Ok((stream, addr)) = listener.accept() => {
                if options.relay {
                    continue;
                }
                let remote = plain_address(&addr.ip().to_string()).to_string();
                let desc = if is_local_address(&remote) {
                    format!("Directa TCP (LAN/Loopback - {remote})")
                } else {
                    format!("Directa TCP (Internet/P2P - {remote})")
                };
                let mut ch = SpeedChannel::from_tcp(stream, &code, true, desc.clone());
                let expected_room = room_id.clone();
                if let Ok(msg) = ch
                    .wait_control(
                        |m| m.get("k").and_then(|v| v.as_str()) == Some("hello")
                            && m.get("room").and_then(|v| v.as_str()) == Some(expected_room.as_str()),
                        3500,
                    )
                    .await
                {
                    let _ = msg;
                    let _ = ch.send_control(&json!({ "k": "welcome" })).await;
                    println!("  {GREEN}✔ Cliente conectado:{RESET} {desc}\n");
                    channel = Some(ch);
                    break;
                } else {
                    ch.close();
                }
            }
            ev_opt = ws_next => {
                let Some(WsEvent::Json(msg)) = ev_opt else {
                    if matches!(ev_opt, None | Some(WsEvent::Closed)) {
                        sig_client = None;
                    }
                    continue;
                };
                let Some(ws_sender) = ws_sender_opt.as_ref() else {
                    continue;
                };
                if msg.get("t").and_then(|v| v.as_str()) == Some("guest")
                    && let Some(guest_id) = msg.get("guestId").and_then(|v| v.as_u64())
                {
                    let ws = ws_sender.clone();
                    let ips = local_ips.clone();
                    let ws_pub = ws_public_ip.clone();
                    let force_relay = options.relay;
                    let u_slot = Arc::clone(&upnp_res_slot);
                    let s_slot = Arc::clone(&stun_res_slot);
                    let u_done = Arc::clone(&upnp_done);
                    let s_done = Arc::clone(&stun_done);
                    tokio::spawn(async move {
                        if !force_relay {
                            if u_slot.lock().await.is_none() {
                                let _ = timeout(Duration::from_millis(1500), u_done.notified()).await;
                            }
                            if s_slot.lock().await.is_none() {
                                let _ = timeout(Duration::from_millis(1500), s_done.notified()).await;
                            }
                        }
                        let u_res = u_slot.lock().await.clone();
                        let s_res = s_slot.lock().await.clone();
                        let upnp_ok = u_res.as_ref().is_some_and(|r| r.success);
                        let offer_port = if force_relay {
                            0
                        } else {
                            u_res.as_ref().and_then(|r| r.external_port).unwrap_or(tcp_port)
                        };
                        let merged = merge_offer_candidates(
                            &ips,
                            u_res,
                            s_res,
                            ws_pub.as_deref(),
                            force_relay,
                        );
                        let _ = ws.send_signal(
                            Some(guest_id),
                            &json!({
                                "type": "cli-speed-offer",
                                "ips": merged.candidate_ips,
                                "port": offer_port,
                                "upnp": upnp_ok,
                            }),
                        );
                    });
                } else if msg.get("t").and_then(|v| v.as_str()) == Some("signal")
                    && msg.get("data").and_then(|d| d.get("type")).and_then(|v| v.as_str())
                        == Some("cli-speed-accept")
                    && let Some(guest_id) = msg.get("from").and_then(|v| v.as_u64())
                {
                    let host_label = url::Url::parse(&options.server)
                        .ok()
                        .and_then(|u| u.host_str().map(|h| match u.port() {
                            Some(p) => format!("{h}:{p}"),
                            None => h.to_string(),
                        }))
                        .unwrap_or_else(|| options.server.clone());
                    let desc = format!("Relay por servidor ({host_label})");
                    println!("  {CYAN}✔ Cliente conectado:{RESET} {desc}\n");
                    let _ = ws_sender.send_signal(
                        Some(guest_id),
                        &json!({ "type": "cli-speed-ready" }),
                    );
                    let (client, _) = sig_client.take().expect("just matched");
                    channel = Some(SpeedChannel::from_relay(
                        client.sender,
                        client.events,
                        Some(guest_id),
                        true,
                        desc,
                    ));
                    break;
                }
            }
        }
    }

    if let Some(ref mut b) = broadcaster {
        b.stop();
    }

    let exit_code = if let Some(mut ch) = channel {
        let is_tcp_direct = sig_client.is_some();
        if is_tcp_direct && let Some((c, _)) = sig_client.take() {
            c.sender.close();
        }
        let res = tokio::select! {
            r = run_speed_test(&mut ch, true, duration_sec) => r,
            _ = tokio::signal::ctrl_c() => Err("Cancelado por el usuario".to_string()),
        };
        ch.close();
        if let Err(e) = res {
            eprintln!("\n  {RED}Error en prueba de velocidad: {e}{RESET}\n");
            1
        } else {
            0
        }
    } else {
        0
    };

    if let Some(m) = upnp_mapping_slot.lock().await.take() {
        let _ = timeout(Duration::from_secs(2), m.unmap()).await;
    }
    exit_code
}

pub async fn run_speed_guest(input: &str, options: Options) -> i32 {
    let parsed = match parse_code(input, Lang::Es) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("\n{RED}Código inválido:{RESET} {}\n", e.message);
            return 1;
        }
    };
    let duration_sec = options.time.max(1);
    let force_relay = options.relay
        || env::var_os("DROP_FORCE_RELAY").is_some_and(|v| !v.is_empty());

    println!("\n{BOLD}================================================================{RESET}");
    println!("  {CYAN}drop speed{RESET} — {BOLD}Medidor de Velocidad de Transferencia P2P{RESET}");
    println!("{BOLD}================================================================{RESET}\n");
    println!(
        "  {DIM}Buscando anfitrión para el código:{RESET} {CYAN}{}{RESET}",
        parsed.code
    );

    if !force_relay {
        {
            let mut out = std::io::stdout().lock();
            let _ = write!(out, "  {DIM}Explorando red local (LAN)...{RESET}");
            let _ = out.flush();
        }
        if let Some((host, port)) = listen_for_lan(&parsed.code, 1200).await {
            print!("\r\x1b[K");
            let desc = format!("Directa TCP (LAN - {host}:{port})");
            println!("  {GREEN}✔ Anfitrión encontrado en red local:{RESET} {desc}\n");
            if let Ok(stream) = connect_host(&host, port).await {
                let mut ch = SpeedChannel::from_tcp(stream, &parsed.code, false, desc);
                if ch
                    .send_control(&json!({ "k": "hello", "room": parsed.room_id }))
                    .await
                    .is_ok()
                    && ch
                        .wait_control(|m| m.get("k").and_then(|v| v.as_str()) == Some("welcome"), 3500)
                        .await
                        .is_ok()
                {
                    let res = run_speed_test(&mut ch, false, duration_sec).await;
                    ch.close();
                    return if res.is_ok() { 0 } else { 1 };
                }
                ch.close();
            }
        } else {
            print!("\r\x1b[K");
        }
    }

    println!(
        "  {DIM}No detectado en LAN directa, conectando por servidor de señalización...{RESET}"
    );

    let mut client = match connect_signaling(&options.server).await {
        Ok(c) => c,
        Err(e) => {
            eprintln!("\n  {RED}Error de conexión:{RESET} {e}\n");
            return 1;
        }
    };
    if let Err(e) = join_room(&mut client, &parsed.room_id, None).await {
        eprintln!("\n  {RED}Error de conexión:{RESET} {e}\n");
        return 1;
    }

    let offer = {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            let rem = deadline.saturating_duration_since(tokio::time::Instant::now());
            if rem.is_zero() {
                eprintln!("\n  {RED}Error de conexión:{RESET} Tiempo de espera agotado esperando datos del anfitrión\n");
                return 1;
            }
            match timeout(rem, client.events.recv()).await {
                Ok(Some(WsEvent::Json(msg))) => {
                    if msg.get("t").and_then(|v| v.as_str()) == Some("error") {
                        let reason = msg.get("reason").and_then(|v| v.as_str()).unwrap_or("ERROR");
                        eprintln!("\n  {RED}Error:{RESET} {}\n", translate_error(reason));
                        return 1;
                    }
                    if msg.get("t").and_then(|v| v.as_str()) == Some("signal")
                        && let Some(d) = msg.get("data")
                        && d.get("type").and_then(|v| v.as_str()) == Some("cli-speed-offer")
                    {
                        break d.clone();
                    }
                }
                Ok(Some(WsEvent::Closed)) | Ok(None) | Err(_) => {
                    eprintln!("\n  {RED}Error de conexión:{RESET} No se recibió oferta del anfitrión\n");
                    return 1;
                }
                Ok(Some(_)) => {}
            }
        }
    };

    let ips: Vec<String> = offer
        .get("ips")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let port = offer.get("port").and_then(|v| v.as_u64()).unwrap_or(0) as u16;

    if !force_relay && port > 0 && !ips.is_empty() {
        {
            let mut out = std::io::stdout().lock();
            let _ = write!(out, "  {DIM}Comprobando ruta TCP directa con el anfitrión...{RESET}");
            let _ = out.flush();
        }
        let ranked = rank_candidates(&ips, &get_candidate_ips());
        let probe = probe_candidate_ips(&ranked, port, 2500).await;
        print!("\r\x1b[K");
        if let Some((stream, ip)) = probe {
            client.sender.close();
            let desc = if is_local_address(&ip) {
                format!("Directa TCP ({ip}:{port})")
            } else {
                format!("Directa TCP (Internet/P2P - {ip}:{port})")
            };
            println!("  {GREEN}✔ Conectado por TCP directo:{RESET} {desc}\n");
            let mut ch = SpeedChannel::from_tcp(stream, &parsed.code, false, desc);
            if ch
                .send_control(&json!({ "k": "hello", "room": parsed.room_id }))
                .await
                .is_err()
                || ch
                    .wait_control(|m| m.get("k").and_then(|v| v.as_str()) == Some("welcome"), 3500)
                    .await
                    .is_err()
            {
                eprintln!("\n  {RED}Error: Timeout en handshake TCP{RESET}\n");
                return 1;
            }
            let res = run_speed_test(&mut ch, false, duration_sec).await;
            ch.close();
            return if res.is_ok() { 0 } else { 1 };
        }
    }

    if options.direct_only {
        client.sender.close();
        eprintln!("\n  {RED}Error: No fue posible establecer conexión directa TCP y se especificó --direct-only.{RESET}\n");
        return 1;
    }

    let host_label = url::Url::parse(&options.server)
        .ok()
        .and_then(|u| u.host_str().map(|h| match u.port() {
            Some(p) => format!("{h}:{p}"),
            None => h.to_string(),
        }))
        .unwrap_or_else(|| options.server.clone());
    let desc = format!("Relay por servidor ({host_label})");
    println!(
        "  {CYAN}[MODO RELAY]{RESET} {DIM}Conexión directa no disponible, usando retransmisión por servidor...{RESET}\n"
    );

    if client
        .sender
        .send_signal(None, &json!({ "type": "cli-speed-accept" }))
        .is_err()
    {
        return 1;
    }

    {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
        loop {
            let rem = deadline.saturating_duration_since(tokio::time::Instant::now());
            if rem.is_zero() {
                eprintln!("\n  {RED}Timeout esperando confirmación Relay del anfitrión{RESET}\n");
                return 1;
            }
            match timeout(rem, client.events.recv()).await {
                Ok(Some(WsEvent::Json(msg))) => {
                    if msg.get("t").and_then(|v| v.as_str()) == Some("signal")
                        && msg.get("data").and_then(|d| d.get("type")).and_then(|v| v.as_str())
                            == Some("cli-speed-ready")
                    {
                        break;
                    }
                }
                Ok(Some(WsEvent::Closed)) | Ok(None) | Err(_) => {
                    eprintln!("\n  {RED}Timeout esperando confirmación Relay del anfitrión{RESET}\n");
                    return 1;
                }
                Ok(Some(_)) => {}
            }
        }
    }

    let mut ch = SpeedChannel::from_relay(client.sender, client.events, None, false, desc);
    let res = tokio::select! {
        r = run_speed_test(&mut ch, false, duration_sec) => r,
        _ = tokio::signal::ctrl_c() => Err("Cancelado".to_string()),
    };
    ch.close();
    if let Err(e) = res {
        eprintln!("\n  {RED}Error en prueba Relay: {e}{RESET}\n");
        1
    } else {
        0
    }
}
