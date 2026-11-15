use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rand::RngCore;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;

use drop::crypto::{derive_key, encrypt_chunk, seal_frame};
use drop::shared::codes::new_code;
use drop::shared::protocol::FileEntry;
use drop::signaling::{SignalingSender, WsEvent};
use drop::transfer::{
    RELAY_ACK_EVERY, ReceiveOptions, SendItem, attach_sender, hash_partial, receive_files,
    receive_from_relay, reserve_output_path, safe_output_path, verify_prefix,
};

fn scratch(prefix: &str) -> PathBuf {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "{prefix}-{}-{ts}-{:08x}",
        std::process::id(),
        rand::thread_rng().next_u32()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

struct CleanDir(PathBuf);
impl Drop for CleanDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn sha_hex(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

#[test]
fn test_safe_output_path_accepts_subpaths_and_flattens_bare_names() {
    let out = scratch("drop-safe-ok");
    let _g = CleanDir(out.clone());

    assert_eq!(
        safe_output_path(&out, "playa.jpg", Some("fotos/verano/playa.jpg")).unwrap(),
        out.join("fotos").join("verano").join("playa.jpg")
    );
    assert_eq!(
        safe_output_path(&out, "a.txt", Some(r"dir\sub\a.txt")).unwrap(),
        out.join("dir").join("sub").join("a.txt")
    );
    assert_eq!(
        safe_output_path(&out, "suelto.bin", None).unwrap(),
        out.join("suelto.bin")
    );
    assert_eq!(
        safe_output_path(&out, "sub/dir/foto.jpg", None).unwrap(),
        out.join("foto.jpg")
    );
    assert_eq!(
        safe_output_path(&out, "/etc/passwd", None).unwrap(),
        out.join("passwd")
    );
    assert_eq!(
        safe_output_path(&out, "../../.zshrc", None).unwrap(),
        out.join(".zshrc")
    );
    assert_eq!(
        safe_output_path(&out, r"..\..\evil.txt", None).unwrap(),
        out.join("evil.txt")
    );
}

#[test]
fn test_safe_output_path_rejects_unsafe_names_and_traversal() {
    let out = scratch("drop-safe-bad");
    let _g = CleanDir(out.clone());

    for bad in ["", "   ", ".", "..", "../..", "sub/", "mal\0nombre", "C:"] {
        let err = safe_output_path(&out, bad, None).unwrap_err();
        assert_eq!(err.code, "UNSAFE_NAME", "bare {bad:?} should fail");
    }

    for bad_rel in [
        "",
        "/",
        "/etc/passwd",
        "../fuera.txt",
        "fotos/../../fuera.txt",
        "fotos/./a.jpg",
        "fotos//a.jpg",
        "fotos/",
        "C:/Windows/win.ini",
        "C:",
        "mal\0sub/a.txt",
    ] {
        let err = safe_output_path(&out, "x.txt", Some(bad_rel)).unwrap_err();
        assert_eq!(err.code, "UNSAFE_NAME", "rel {bad_rel:?} should fail");
    }
}

#[test]
fn test_reserve_output_path_numbering_and_resume() {
    let out = scratch("drop-reserve");
    let _g = CleanDir(out.clone());

    std::fs::write(out.join("a.bin.part"), vec![0u8; 10]).unwrap();

    // Con resume y tamano >= .part: reanuda
    let r = reserve_output_path(&out, "a.bin", &mut HashSet::new(), false, true, Some(100), None)
        .unwrap();
    assert_eq!(r.final_path, out.join("a.bin"));
    assert_eq!(r.resume_from, Some(10));

    // .part mas largo que el archivo que viene: nombre nuevo
    let r = reserve_output_path(&out, "a.bin", &mut HashSet::new(), false, true, Some(5), None)
        .unwrap();
    assert_eq!(r.final_path, out.join("a (2).bin"));
    assert_eq!(r.resume_from, None);

    // Sin resume (--no-resume): el .part ocupa el nombre
    let r = reserve_output_path(&out, "a.bin", &mut HashSet::new(), false, false, Some(100), None)
        .unwrap();
    assert_eq!(r.final_path, out.join("a (2).bin"));
    assert_eq!(r.resume_from, None);

    // Si existe el final, el .part no se toca y numera
    std::fs::write(out.join("a.bin"), b"hecho").unwrap();
    let r = reserve_output_path(&out, "a.bin", &mut HashSet::new(), false, true, Some(100), None)
        .unwrap();
    assert_eq!(r.final_path, out.join("a (2).bin"));
    assert_eq!(r.resume_from, None);

    // Colisiones dentro de subcarpetas y mismo lote
    let mut reserved = HashSet::new();
    let r1 = reserve_output_path(&out, "a.txt", &mut reserved, false, true, Some(1), Some("dir/a.txt")).unwrap();
    let r2 = reserve_output_path(&out, "a.txt", &mut reserved, false, true, Some(1), Some("dir/a.txt")).unwrap();
    let r3 = reserve_output_path(&out, "a.txt", &mut reserved, false, true, Some(1), Some("otra/a.txt")).unwrap();
    assert_eq!(r1.final_path, out.join("dir").join("a.txt"));
    assert_eq!(r2.final_path, out.join("dir").join("a (2).txt"));
    assert_eq!(r3.final_path, out.join("otra").join("a.txt"));

    // Overwrite reutiliza nombre en disco pero evita pisar otro archivo del mismo lote
    let mut ov_set = HashSet::new();
    let o1 = reserve_output_path(&out, "a.bin", &mut ov_set, true, false, Some(5), None).unwrap();
    let o2 = reserve_output_path(&out, "a.bin", &mut ov_set, true, false, Some(5), None).unwrap();
    assert_eq!(o1.final_path, out.join("a.bin"));
    assert_eq!(o2.final_path, out.join("a (2).bin"));
}

#[tokio::test]
async fn test_hash_partial_and_verify_prefix() {
    let dir = scratch("drop-prefix");
    let _g = CleanDir(dir.clone());
    let fpath = dir.join("blob.bin");
    let mut data = vec![0u8; 300_000];
    rand::thread_rng().fill_bytes(&mut data);
    std::fs::write(&fpath, &data).unwrap();

    let h = hash_partial(&fpath, 1024).await.unwrap().unwrap();
    assert_eq!(h, sha_hex(&data[..1024]));
    assert!(hash_partial(&fpath, 999_999).await.unwrap().is_none());

    let verified = verify_prefix(
        &fpath,
        Some(data.len() as u64),
        Some(&json!({ "offset": 1024, "sha256": h })),
    )
    .await
    .unwrap()
    .expect("prefix should verify");
    assert_eq!(verified.offset, 1024);
    let mut hasher = verified.hasher;
    hasher.update(&data[1024..]);
    assert_eq!(hex::encode(hasher.finalize()), sha_hex(&data));

    // Rechazos
    assert!(
        verify_prefix(
            &fpath,
            Some(data.len() as u64),
            Some(&json!({ "offset": "1024", "sha256": sha_hex(&data[..1024]) }))
        )
        .await
        .unwrap()
        .is_none()
    );
    assert!(
        verify_prefix(
            &fpath,
            Some(data.len() as u64),
            Some(&json!({ "offset": 999_999, "sha256": sha_hex(&data[..1024]) }))
        )
        .await
        .unwrap()
        .is_none()
    );
    assert!(
        verify_prefix(
            &fpath,
            Some(data.len() as u64),
            Some(&json!({ "offset": 1024, "sha256": "deadbeef" }))
        )
        .await
        .unwrap()
        .is_none()
    );
}

#[tokio::test]
async fn test_tcp_roundtrip_folders_select_and_wrong_code() {
    let src = scratch("drop-tcp-src");
    let out = scratch("drop-tcp-out");
    let _g1 = CleanDir(src.clone());
    let _g2 = CleanDir(out.clone());

    let mut b1 = vec![0u8; 700_000];
    rand::thread_rng().fill_bytes(&mut b1);
    let b2 = b"contenido pequeno\n".to_vec();
    let b3 = b"".to_vec();

    let f1 = src.join("uno.bin");
    let f2 = src.join("sub").join("dos.txt");
    let f3 = src.join("vacio.dat");
    std::fs::create_dir_all(f2.parent().unwrap()).unwrap();
    std::fs::write(&f1, &b1).unwrap();
    std::fs::write(&f2, &b2).unwrap();
    std::fs::write(&f3, &b3).unwrap();

    let items = vec![
        SendItem {
            entry: FileEntry {
                name: "uno.bin".into(),
                size: Some(b1.len() as u64),
                path: Some("carpeta/uno.bin".into()),
            },
            fs_path: Some(f1),
            is_stdin: false,
        },
        SendItem {
            entry: FileEntry {
                name: "dos.txt".into(),
                size: Some(b2.len() as u64),
                path: Some("carpeta/sub/dos.txt".into()),
            },
            fs_path: Some(f2),
            is_stdin: false,
        },
        SendItem {
            entry: FileEntry {
                name: "vacio.dat".into(),
                size: Some(0),
                path: Some("carpeta/vacio.dat".into()),
            },
            fs_path: Some(f3),
            is_stdin: false,
        },
    ];

    let code = new_code("4271");
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();

    let items_arc = Arc::new(items);
    let code_srv = code.clone();
    let srv_items = Arc::clone(&items_arc);
    let srv = tokio::spawn(async move {
        for _ in 0..3 {
            let (sock, _) = listener.accept().await.unwrap();
            let it = Arc::clone(&srv_items);
            let c = code_srv.clone();
            tokio::spawn(async move {
                let _ = attach_sender(sock, &it, &c, "4271", 0, None, None, None, None).await;
            });
        }
    });

    // 1. Codigo malo rechazado sin dejar basura
    let bad_out = out.join("bad");
    std::fs::create_dir_all(&bad_out).unwrap();
    let s_bad = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let err = receive_files(
        s_bad,
        "4271-apple-bacon-cabin-dance",
        "4271",
        &bad_out,
        ReceiveOptions::default(),
        None,
        None,
        None,
    )
    .await
    .unwrap_err();
    assert_eq!(err.code, "BAD_CODE");
    assert_eq!(std::fs::read_dir(&bad_out).unwrap().count(), 0);

    // 2. --only sin coincidencias -> NOTHING_SELECTED + available
    let miss_out = out.join("miss");
    std::fs::create_dir_all(&miss_out).unwrap();
    let s_miss = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let err = receive_files(
        s_miss,
        &code,
        "4271",
        &miss_out,
        ReceiveOptions {
            only: vec!["*.mp4".into()],
            ..Default::default()
        },
        None,
        None,
        None,
    )
    .await
    .unwrap_err();
    assert_eq!(err.code, "NOTHING_SELECTED");
    assert_eq!(err.available.len(), 3);

    // 3. Recepcion completa incluyendo archivo vacio y subcarpetas
    let full_out = out.join("full");
    std::fs::create_dir_all(&full_out).unwrap();
    let s_ok = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let stats = receive_files(
        s_ok,
        &code,
        "4271",
        &full_out,
        ReceiveOptions::default(),
        None,
        None,
        None,
    )
    .await
    .unwrap();
    assert_eq!(stats.files.len(), 3);
    assert_eq!(
        sha_hex(&std::fs::read(full_out.join("carpeta").join("uno.bin")).unwrap()),
        sha_hex(&b1)
    );
    assert_eq!(
        std::fs::read(full_out.join("carpeta").join("sub").join("dos.txt")).unwrap(),
        b2
    );
    assert_eq!(
        std::fs::read(full_out.join("carpeta").join("vacio.dat")).unwrap(),
        b3
    );

    srv.abort();
}

#[tokio::test]
async fn test_tcp_probe_and_deny_and_resume_after_cut() {
    let src = scratch("drop-tcp-cut-src");
    let out = scratch("drop-tcp-cut-out");
    let _g1 = CleanDir(src.clone());
    let _g2 = CleanDir(out.clone());

    let mut body = vec![0u8; 2_400_000];
    rand::thread_rng().fill_bytes(&mut body);
    let fpath = src.join("grande.bin");
    std::fs::write(&fpath, &body).unwrap();

    let items = vec![SendItem {
        entry: FileEntry {
            name: "grande.bin".into(),
            size: Some(body.len() as u64),
            path: None,
        },
        fs_path: Some(fpath),
        is_stdin: false,
    }];

    let code = new_code("7712");
    let prompts = Arc::new(AtomicUsize::new(0));
    let deny_next = Arc::new(std::sync::atomic::AtomicBool::new(true));

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let items_arc = Arc::new(items);
    let p_cnt = Arc::clone(&prompts);
    let deny_flag = Arc::clone(&deny_next);
    let code_srv = code.clone();

    let srv = tokio::spawn(async move {
        for _ in 0..4 {
            let (sock, _) = listener.accept().await.unwrap();
            let it = Arc::clone(&items_arc);
            let c = code_srv.clone();
            let pc = Arc::clone(&p_cnt);
            let df = Arc::clone(&deny_flag);
            let gate = Arc::new(move |_info| {
                let pc = Arc::clone(&pc);
                let df = Arc::clone(&df);
                Box::pin(async move {
                    pc.fetch_add(1, Ordering::SeqCst);
                    !df.swap(false, Ordering::SeqCst)
                }) as std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send>>
            });
            tokio::spawn(async move {
                let _ = attach_sender(sock, &it, &c, "7712", 0, Some(gate), None, None, None).await;
            });
        }
    });

    // 1. Sondeo TCP instantaneo no debe llamar al gate ni una vez
    {
        let probe = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        drop(probe);
    }
    tokio::time::sleep(Duration::from_millis(550)).await;
    assert_eq!(prompts.load(Ordering::SeqCst), 0);

    // 2. Conexion denegada por el gate: no filtra ni manifiesto ni crea nada
    {
        let s = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let res = receive_files(
            s,
            &code,
            "7712",
            &out,
            ReceiveOptions::default(),
            None,
            None,
            None,
        )
        .await;
        assert!(res.is_err());
        assert_eq!(std::fs::read_dir(&out).unwrap().count(), 0);
        assert_eq!(prompts.load(Ordering::SeqCst), 1);
    }

    // 3. Proxy que corta a mitad (~800 KB): deja .part reanudable
    let proxy_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy_port = proxy_listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let (mut cli, _) = proxy_listener.accept().await.unwrap();
        let mut upstream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let (mut cr, mut cw) = cli.split();
        let (mut ur, mut uw) = upstream.split();
        let c2u = tokio::io::copy(&mut cr, &mut uw);
        let u2c = async {
            let mut total = 0usize;
            let mut b = vec![0u8; 64 * 1024];
            loop {
                let n = ur.read(&mut b).await.unwrap_or(0);
                if n == 0 {
                    break;
                }
                let take = n.min(800_000usize.saturating_sub(total));
                if take > 0 {
                    let _ = cw.write_all(&b[..take]).await;
                    total += take;
                }
                if total >= 800_000 {
                    break;
                }
            }
        };
        tokio::select! {
            _ = c2u => {},
            _ = u2c => {},
        }
    });

    let cut_sock = TcpStream::connect(("127.0.0.1", proxy_port)).await.unwrap();
    let cut_err = receive_files(
        cut_sock,
        &code,
        "7712",
        &out,
        ReceiveOptions::default(),
        None,
        None,
        None,
    )
    .await
    .unwrap_err();
    assert!(cut_err.resumable, "deberia dejar .part reanudable");
    assert!(cut_err.part_bytes > 0);
    assert!(out.join("grande.bin.part").exists());

    // 4. Reanudar hasta completar y verificar hash
    let resumed_notice = Arc::new(AtomicUsize::new(0));
    let rn = Arc::clone(&resumed_notice);
    let s_res = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let stats = receive_files(
        s_res,
        &code,
        "7712",
        &out,
        ReceiveOptions::default(),
        None,
        None,
        Some(Box::new(move |_name, _off| {
            rn.fetch_add(1, Ordering::SeqCst);
        })),
    )
    .await
    .unwrap();
    assert!(stats.resumed_bytes > 0);
    assert_eq!(resumed_notice.load(Ordering::SeqCst), 1);
    assert_eq!(sha_hex(&std::fs::read(out.join("grande.bin")).unwrap()), sha_hex(&body));
    assert!(!out.join("grande.bin.part").exists());

    srv.abort();
}

#[tokio::test]
async fn test_relay_receive_acks_and_tamper_detection() {
    let out = scratch("drop-relay-unit");
    let _g = CleanDir(out.clone());

    let code = "4271-lemon-radar-tiger-orbit";
    let key = derive_key(code);
    let other_key = derive_key("4271-apple-bacon-cabin-dance");

    // 1. Transferencia de 5 MB (> RELAY_ACK_EVERY = 2 MB) -> acuses ordenados hasta 5 MB + cli-complete
    let mut body = vec![0u8; 5 * 1024 * 1024 + 123];
    rand::thread_rng().fill_bytes(&mut body);

    // Conectar un ws mock server local para obtener un real SignalingSender + recorder
    let tcp_ws = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let ws_port = tcp_ws.local_addr().unwrap().port();
    let sent_msgs = Arc::new(tokio::sync::Mutex::new(Vec::<Value>::new()));
    let sent_rec = Arc::clone(&sent_msgs);

    let ws_srv = tokio::spawn(async move {
        use futures_util::StreamExt;
        use tokio_tungstenite::accept_async;
        use tokio_tungstenite::tungstenite::Message;

        let (stream, _) = tcp_ws.accept().await.unwrap();
        let ws = accept_async(stream).await.unwrap();
        let (mut wr, mut rd) = ws.split();
        // Al conectarse no mandamos nada hasta que el test emita, solo grabamos mensajes entrantes
        let rec = sent_rec;
        tokio::spawn(async move {
            while let Some(Ok(Message::Text(txt))) = rd.next().await {
                if let Ok(v) = serde_json::from_str::<Value>(&txt) {
                    rec.lock().await.push(v);
                }
            }
        });
        // Mantener abierto el sink hasta abort
        let _keep = &mut wr;
        futures_util::future::pending::<()>().await;
    });

    // Conectamos SignalingSender real para verificar lo enviado, y empujamos eventos por canal directo a receive_from_relay
    let client = drop::signaling::connect_signaling(&format!("http://127.0.0.1:{ws_port}"))
        .await
        .unwrap();
    let sender: SignalingSender = client.sender.clone();
    let (ev_tx, mut ev_rx) = mpsc::unbounded_channel();

    let manifest = vec![FileEntry {
        name: "grande.bin".into(),
        size: Some(body.len() as u64),
        path: None,
    }];
    let out_c = out.clone();
    let sender_c = sender.clone();
    let recv_task = tokio::spawn(async move {
        receive_from_relay(
            &sender_c,
            &mut ev_rx,
            &manifest,
            &key,
            &out_c,
            ReceiveOptions::default(),
            None,
            None,
        )
        .await
    });

    // Esperar a cli-accept
    tokio::time::sleep(Duration::from_millis(60)).await;
    ev_tx
        .send(WsEvent::Json(json!({
            "t": "signal",
            "data": seal_frame(&json!({ "type": "cli-start", "index": 0, "name": "grande.bin", "size": body.len(), "offset": 0 }), &key)
        })))
        .unwrap();

    for chunk in body.chunks(256 * 1024) {
        ev_tx.send(WsEvent::Binary(encrypt_chunk(chunk, &key))).unwrap();
    }
    ev_tx
        .send(WsEvent::Json(json!({
            "t": "signal",
            "data": seal_frame(&json!({ "type": "cli-end", "index": 0, "sha256": sha_hex(&body) }), &key)
        })))
        .unwrap();
    ev_tx
        .send(WsEvent::Json(json!({
            "t": "signal",
            "data": seal_frame(&json!({ "type": "cli-done" }), &key)
        })))
        .unwrap();

    let stats = recv_task.await.unwrap().unwrap();
    assert_eq!(stats.total_bytes as usize, body.len());
    assert_eq!(sha_hex(&std::fs::read(out.join("grande.bin")).unwrap()), sha_hex(&body));

    tokio::time::sleep(Duration::from_millis(80)).await;
    let recorded = sent_msgs.lock().await;
    let acks: Vec<u64> = recorded
        .iter()
        .filter_map(|m| {
            let d = m.get("data")?;
            (d.get("type")?.as_str()? == "cli-ack").then(|| d.get("bytes")?.as_u64())?
        })
        .collect();
    assert!(acks.len() >= (body.len() as u64 / RELAY_ACK_EVERY) as usize);
    assert_eq!(*acks.last().unwrap(), body.len() as u64);
    assert_eq!(
        recorded.last().unwrap()["data"]["type"].as_str(),
        Some("cli-complete")
    );

    // 2. Paquete cifrado con otra clave -> BAD_CODE
    let (ev_tx2, mut ev_rx2) = mpsc::unbounded_channel();
    let manifest2 = vec![FileEntry {
        name: "bad.bin".into(),
        size: Some(10),
        path: None,
    }];
    let out2 = out.join("bad_relay");
    std::fs::create_dir_all(&out2).unwrap();
    let bad_task = tokio::spawn(async move {
        receive_from_relay(
            &sender,
            &mut ev_rx2,
            &manifest2,
            &key,
            &out2,
            ReceiveOptions::default(),
            None,
            None,
        )
        .await
    });
    ev_tx2
        .send(WsEvent::Json(json!({
            "t": "signal",
            "data": seal_frame(&json!({ "type": "cli-start", "index": 0, "name": "bad.bin", "size": 10, "offset": 0 }), &key)
        })))
        .unwrap();
    ev_tx2
        .send(WsEvent::Binary(encrypt_chunk(&[1u8; 10], &other_key)))
        .unwrap();
    let err = bad_task.await.unwrap().unwrap_err();
    assert_eq!(err.code, "BAD_CODE");

    ws_srv.abort();
}
