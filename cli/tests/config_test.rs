// Tests unitarios y de persistencia para `config.rs` y `Options::from_config`.

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use drop::cli::Options;
use drop::config::{
    CONFIG_SCHEMA_VERSION, Config, SetOutcome, delete_config_at, expand_tilde, load_config_from,
    normalize_key, parse_bool_str, save_config_to, validate_server_url,
};

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn temp_config_path(tag: &str) -> PathBuf {
    let n = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "drop-cfg-test-{}-{}-{n}",
        tag,
        std::process::id()
    ));
    dir.join("config.json")
}

#[test]
fn save_load_delete_round_trip_and_unknown_keys() {
    let path = temp_config_path("roundtrip");
    let _ = fs::remove_dir_all(path.parent().unwrap());

    assert_eq!(load_config_from(&path).unwrap(), None);

    let mut cfg = Config::default();
    assert_eq!(
        cfg.set_value("server", "https://mi-drop.example/").unwrap(),
        SetOutcome::Set("https://mi-drop.example".to_string())
    );
    assert_eq!(
        cfg.set_value("out", "~/Downloads").unwrap(),
        SetOutcome::Set("~/Downloads".to_string())
    );
    assert_eq!(
        cfg.set_value("once", "true").unwrap(),
        SetOutcome::Set("true".to_string())
    );
    assert_eq!(
        cfg.set_value("no-qr", "sí").unwrap(),
        SetOutcome::Set("true".to_string())
    );
    assert_eq!(
        cfg.set_value("limit", "10M").unwrap(),
        SetOutcome::Set("10M".to_string())
    );
    assert_eq!(
        cfg.set_value("expire", "15m").unwrap(),
        SetOutcome::Set("15m".to_string())
    );
    assert_eq!(
        cfg.set_value("serve-port", "8080").unwrap(),
        SetOutcome::Set("8080".to_string())
    );
    assert_eq!(
        cfg.set_value("auto-update", "false").unwrap(),
        SetOutcome::Set("false".to_string())
    );

    save_config_to(&path, &cfg).unwrap();

    let loaded = load_config_from(&path).unwrap().expect("config loaded");
    assert_eq!(loaded.version, Some(CONFIG_SCHEMA_VERSION));
    assert_eq!(loaded.server.as_deref(), Some("https://mi-drop.example"));
    assert_eq!(loaded.out.as_deref(), Some("~/Downloads"));
    assert_eq!(loaded.once, Some(true));
    assert_eq!(loaded.no_qr, Some(true));
    assert_eq!(loaded.limit.as_deref(), Some("10M"));
    assert_eq!(loaded.expire.as_deref(), Some("15m"));
    assert_eq!(loaded.serve_port, Some(8080));
    assert_eq!(loaded.auto_update, Some(false));

    // Compatibilidad hacia delante: claves desconocidas se ignoran sin fallar.
    fs::write(
        &path,
        r#"{ "version": 99, "once": true, "future_feature": "ok" }"#,
    )
    .unwrap();
    let forward = load_config_from(&path).unwrap().expect("forward loaded");
    assert_eq!(forward.once, Some(true));

    // JSON corrupto devuelve error con la ruta.
    fs::write(&path, "{ esto no es json").unwrap();
    let err = load_config_from(&path).unwrap_err();
    assert!(err.contains("config.json"));

    // Borrar funciona incluso con archivo corrupto.
    assert!(delete_config_at(&path).unwrap());
    assert!(!delete_config_at(&path).unwrap());
    let _ = fs::remove_dir_all(path.parent().unwrap());
}

#[test]
fn validation_aliases_and_clear_sentinels() {
    let mut cfg = Config::default();

    // Aliases kebab-case y snake_case
    assert_eq!(normalize_key("no-qr"), Some("no_qr"));
    assert_eq!(normalize_key("NO_RESUME"), Some("no_resume"));
    assert_eq!(normalize_key("speed-time"), Some("speed_time"));
    assert_eq!(normalize_key("direct-only"), Some("direct_only"));
    assert_eq!(normalize_key("serve-host"), Some("serve_host"));
    assert_eq!(normalize_key("serve-port"), Some("serve_port"));
    assert_eq!(normalize_key("auto-update"), Some("auto_update"));
    assert_eq!(normalize_key("desconocida"), None);

    // Validacion de errores
    assert!(cfg.set_value("server", "ftp://mal.example").is_err());
    assert!(cfg.set_value("server", "no-es-url").is_err());
    assert!(cfg.set_value("limit", "rapido").is_err());
    assert!(cfg.set_value("expire", "manana").is_err());
    assert!(cfg.set_value("port", "70000").is_err());
    assert!(cfg.set_value("port", "abc").is_err());
    assert!(cfg.set_value("serve_port", "0").is_err());
    assert!(cfg.set_value("speed_time", "0").is_err());
    assert!(cfg.set_value("relay", "quizas").is_err());
    assert!(cfg.set_value("serve_host", "127.0.0.1 extra").is_err());
    assert!(cfg.set_value("no_existe", "1").is_err());

    // Sentinels de limpieza
    cfg.set_value("limit", "5M").unwrap();
    assert_eq!(cfg.set_value("limit", "0").unwrap(), SetOutcome::Cleared);
    assert_eq!(cfg.limit, None);

    cfg.set_value("expire", "10m").unwrap();
    assert_eq!(cfg.set_value("expire", "none").unwrap(), SetOutcome::Cleared);
    assert_eq!(cfg.expire, None);

    cfg.set_value("port", "4242").unwrap();
    assert_eq!(cfg.set_value("port", "0").unwrap(), SetOutcome::Cleared);
    assert_eq!(cfg.port, None);

    cfg.set_value("out", "/tmp/descargas").unwrap();
    assert_eq!(cfg.set_value("out", "-").unwrap(), SetOutcome::Cleared);
    assert_eq!(cfg.out, None);

    // Booleanos y URLs
    assert!(parse_bool_str("sí").unwrap());
    assert!(parse_bool_str("YES").unwrap());
    assert!(!parse_bool_str("off").unwrap());
    assert!(!parse_bool_str("0").unwrap());
    assert_eq!(
        validate_server_url("http://127.0.0.1:3000/").unwrap(),
        "http://127.0.0.1:3000"
    );
}

#[test]
fn toggle_bool_respects_defaults() {
    let mut cfg = Config::default();

    // Por defecto false -> pasa a true (Some(true)) -> vuelve a false (None)
    assert!(cfg.toggle_bool("once").unwrap());
    assert_eq!(cfg.once, Some(true));
    assert!(!cfg.toggle_bool("once").unwrap());
    assert_eq!(cfg.once, None);

    // auto_update es true por defecto -> pasa a false (Some(false)) -> vuelve a true (None)
    assert!(!cfg.toggle_bool("auto_update").unwrap());
    assert_eq!(cfg.auto_update, Some(false));
    assert!(cfg.toggle_bool("auto_update").unwrap());
    assert_eq!(cfg.auto_update, None);

    assert!(cfg.toggle_bool("server").is_err());
}

#[test]
fn options_from_config_applies_fields_and_ignores_invalid_values() {
    let cfg = Config {
        server: Some("http://127.0.0.1:4444".to_string()),
        relay: Some(true),
        limit: Some("2M".to_string()),
        port: Some(5555),
        yes: Some(true),
        once: Some(true),
        expire: Some("30s".to_string()),
        no_qr: Some(true),
        out: Some("~/Descargas".to_string()),
        overwrite: Some(true),
        no_resume: Some(true),
        speed_time: Some(12),
        direct_only: Some(true),
        serve_host: Some("127.0.0.1".to_string()),
        serve_port: Some(9090),
        auto_update: Some(false),
        version: Some(1),
    };

    let opts = Options::from_config(&cfg);
    assert_eq!(opts.server, "http://127.0.0.1:4444");
    assert!(opts.relay);
    assert_eq!(opts.limit, 2 * 1024 * 1024);
    assert_eq!(opts.port, 5555);
    assert!(!opts.port_explicit);
    assert!(opts.yes);
    assert!(opts.once);
    assert_eq!(opts.expire_ms, Some(30_000));
    assert!(opts.no_qr);
    assert_eq!(opts.out.as_deref(), Some(expand_tilde("~/Descargas").as_str()));
    assert!(!opts.out.as_deref().unwrap().starts_with('~'));
    assert!(opts.overwrite);
    assert!(opts.no_resume);
    assert_eq!(opts.time, 12);
    assert!(opts.direct_only);

    // Valores invalidos escritos a mano en JSON no provocan panic y caen al defecto.
    let broken = Config {
        server: Some("not-a-url".to_string()),
        limit: Some("invalid".to_string()),
        expire: Some("invalid".to_string()),
        ..Config::default()
    };
    let opts_broken = Options::from_config(&broken);
    assert_eq!(opts_broken.limit, 0);
    assert_eq!(opts_broken.expire_ms, None);
    assert!(opts_broken.server.starts_with("http"));
}
