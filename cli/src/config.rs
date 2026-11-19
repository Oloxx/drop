// Configuracion persistente del CLI (`config.json`) y utilidades de validacion.

use std::env;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use url::Url;

use crate::cli::parse_duration;
use crate::commands::install::home_dir;
use crate::throttle::parse_rate;

pub const DEFAULT_SERVER_URL: &str = "https://drop.oloxx.dev";
pub const CONFIG_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct Config {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<u32>,

    // Red y general
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relay: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,

    // Envio (drop send)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub yes: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub once: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expire: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub no_qr: Option<bool>,

    // Recepcion (drop recv)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub out: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overwrite: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub no_resume: Option<bool>,

    // Velocidad, servidor y actualizaciones
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speed_time: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub direct_only: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub serve_host: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub serve_port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_update: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Section {
    Network,
    Send,
    Recv,
    Advanced,
}

impl Section {
    pub fn title(self) -> &'static str {
        match self {
            Section::Network => "Red y general",
            Section::Send => "Envío (drop send)",
            Section::Recv => "Recepción (drop recv)",
            Section::Advanced => "Velocidad, servidor y actualizaciones",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ValueKind {
    Bool,
    Text,
}

#[derive(Debug, Clone, Copy)]
pub struct KeySpec {
    pub key: &'static str,
    pub section: Section,
    pub label: &'static str,
    pub default_display: &'static str,
    pub hint: &'static str,
    pub kind: ValueKind,
}

pub const CONFIG_KEYS: &[KeySpec] = &[
    KeySpec {
        key: "server",
        section: Section::Network,
        label: "Servidor de señalización",
        default_display: DEFAULT_SERVER_URL,
        hint: "URL http:// o https:// (ej. https://drop.oloxx.dev)",
        kind: ValueKind::Text,
    },
    KeySpec {
        key: "relay",
        section: Section::Network,
        label: "Forzar transferencia por relay",
        default_display: "no",
        hint: "true / false (equivalente a --relay)",
        kind: ValueKind::Bool,
    },
    KeySpec {
        key: "limit",
        section: Section::Network,
        label: "Límite de ancho de banda",
        default_display: "sin límite",
        hint: "Ejemplos: 500K, 10M, 1.5G (0 o '-' para quitar)",
        kind: ValueKind::Text,
    },
    KeySpec {
        key: "port",
        section: Section::Network,
        label: "Puerto TCP local (send/speed)",
        default_display: "aleatorio",
        hint: "Entero 1-65535 (0 o '-' para aleatorio)",
        kind: ValueKind::Text,
    },
    KeySpec {
        key: "yes",
        section: Section::Send,
        label: "Aceptar sin pedir confirmación",
        default_display: "no",
        hint: "true / false (equivalente a -y / --yes)",
        kind: ValueKind::Bool,
    },
    KeySpec {
        key: "once",
        section: Section::Send,
        label: "Cerrar tras la primera descarga",
        default_display: "no",
        hint: "true / false (equivalente a --once)",
        kind: ValueKind::Bool,
    },
    KeySpec {
        key: "expire",
        section: Section::Send,
        label: "Caducidad automática del canal",
        default_display: "sin caducidad",
        hint: "Ejemplos: 90s, 10m, 2h (0 o '-' para quitar)",
        kind: ValueKind::Text,
    },
    KeySpec {
        key: "no_qr",
        section: Section::Send,
        label: "Ocultar código QR al enviar",
        default_display: "no",
        hint: "true / false (equivalente a --no-qr)",
        kind: ValueKind::Bool,
    },
    KeySpec {
        key: "out",
        section: Section::Recv,
        label: "Carpeta de descargas por defecto",
        default_display: "directorio actual",
        hint: "Ruta de directorio, ej. ~/Downloads ('-' para directorio actual)",
        kind: ValueKind::Text,
    },
    KeySpec {
        key: "overwrite",
        section: Section::Recv,
        label: "Sobrescribir archivos existentes",
        default_display: "no",
        hint: "true / false (equivalente a --overwrite)",
        kind: ValueKind::Bool,
    },
    KeySpec {
        key: "no_resume",
        section: Section::Recv,
        label: "No reanudar descargas .part",
        default_display: "no",
        hint: "true / false (equivalente a --no-resume)",
        kind: ValueKind::Bool,
    },
    KeySpec {
        key: "speed_time",
        section: Section::Advanced,
        label: "Segundos por fase en drop speed",
        default_display: "5",
        hint: "Entero positivo en segundos (ej. 5, 10)",
        kind: ValueKind::Text,
    },
    KeySpec {
        key: "direct_only",
        section: Section::Advanced,
        label: "Solo TCP directo en drop speed",
        default_display: "no",
        hint: "true / false (equivalente a --direct-only)",
        kind: ValueKind::Bool,
    },
    KeySpec {
        key: "serve_host",
        section: Section::Advanced,
        label: "Dirección de escucha (drop serve)",
        default_display: "0.0.0.0 / ::",
        hint: "IP o dirección de escucha (ej. 127.0.0.1)",
        kind: ValueKind::Text,
    },
    KeySpec {
        key: "serve_port",
        section: Section::Advanced,
        label: "Puerto de escucha (drop serve)",
        default_display: "3000",
        hint: "Entero 1-65535 (ej. 3000, 8080)",
        kind: ValueKind::Text,
    },
    KeySpec {
        key: "auto_update",
        section: Section::Advanced,
        label: "Comprobar actualizaciones en 2º plano",
        default_display: "sí",
        hint: "true / false (por defecto true)",
        kind: ValueKind::Bool,
    },
];

pub const CONFIG_KEY_NAMES: &[&str] = &[
    "server",
    "relay",
    "limit",
    "port",
    "yes",
    "once",
    "expire",
    "no_qr",
    "out",
    "overwrite",
    "no_resume",
    "speed_time",
    "direct_only",
    "serve_host",
    "serve_port",
    "auto_update",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ValueOrigin {
    Config,
    Env,
    Default,
}

impl ValueOrigin {
    pub fn label(self) -> &'static str {
        match self {
            ValueOrigin::Config => "config",
            ValueOrigin::Env => "env",
            ValueOrigin::Default => "defecto",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SetOutcome {
    Set(String),
    Cleared,
}

pub fn config_disabled_by_env() -> bool {
    if let Ok(val) = env::var("DROP_NO_CONFIG") {
        let v = val.trim().to_ascii_lowercase();
        if !v.is_empty() && v != "0" && v != "false" && v != "no" {
            return true;
        }
    }
    false
}

/// Ruta al archivo de configuracion (`config.json`).
/// Prioridad: `DROP_CONFIG` > `DROP_CONFIG_DIR/config.json` > ruta estandar del SO.
pub fn config_file_path() -> PathBuf {
    if let Ok(custom) = env::var("DROP_CONFIG")
        && !custom.trim().is_empty()
    {
        return PathBuf::from(custom.trim());
    }
    if let Ok(dir) = env::var("DROP_CONFIG_DIR")
        && !dir.trim().is_empty()
    {
        return PathBuf::from(dir.trim()).join("config.json");
    }
    #[cfg(windows)]
    {
        let app_data = env::var_os("APPDATA")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home_dir().join("AppData").join("Roaming"));
        app_data.join("drop").join("config.json")
    }
    #[cfg(not(windows))]
    {
        let base = env::var_os("XDG_CONFIG_HOME")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home_dir().join(".config"));
        base.join("drop").join("config.json")
    }
}

/// Expande `~` o `~/...` al directorio home del usuario.
pub fn expand_tilde(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed == "~" {
        return home_dir().to_string_lossy().to_string();
    }
    if let Some(rest) = trimmed.strip_prefix("~/").or_else(|| trimmed.strip_prefix("~\\")) {
        return home_dir().join(rest).to_string_lossy().to_string();
    }
    trimmed.to_string()
}

pub fn normalize_key(raw: &str) -> Option<&'static str> {
    let norm = raw.trim().to_ascii_lowercase().replace('-', "_");
    CONFIG_KEYS
        .iter()
        .find(|spec| spec.key == norm)
        .map(|spec| spec.key)
}

pub fn key_spec(key: &str) -> Option<&'static KeySpec> {
    let canonical = normalize_key(key)?;
    CONFIG_KEYS.iter().find(|s| s.key == canonical)
}

pub fn parse_bool_str(raw: &str) -> Result<bool, String> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "true" | "1" | "s" | "si" | "sí" | "y" | "yes" | "on" => Ok(true),
        "false" | "0" | "n" | "no" | "off" => Ok(false),
        _ => Err(format!(
            "Valor booleano no válido: \"{raw}\". Usa true/false (o sí/no)."
        )),
    }
}

pub fn validate_server_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim().trim_end_matches('/');
    let parsed = Url::parse(trimmed).map_err(|_| {
        format!("URL de servidor no válida: \"{raw}\". Debe empezar por http:// o https://.")
    })?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err(format!(
            "URL de servidor no válida: \"{raw}\". Debe usar http:// o https:// e incluir un host."
        ));
    }
    Ok(trimmed.to_string())
}

fn is_clear_sentinel(raw: &str) -> bool {
    matches!(
        raw.trim().to_ascii_lowercase().as_str(),
        "0" | "none" | "off" | "default" | "reset" | "-"
    )
}

pub fn format_bool_es(v: bool) -> &'static str {
    if v { "sí" } else { "no" }
}

impl Config {
    pub fn is_empty(&self) -> bool {
        self.server.is_none()
            && self.relay.is_none()
            && self.limit.is_none()
            && self.port.is_none()
            && self.yes.is_none()
            && self.once.is_none()
            && self.expire.is_none()
            && self.no_qr.is_none()
            && self.out.is_none()
            && self.overwrite.is_none()
            && self.no_resume.is_none()
            && self.speed_time.is_none()
            && self.direct_only.is_none()
            && self.serve_host.is_none()
            && self.serve_port.is_none()
            && self.auto_update.is_none()
    }

    /// Devuelve el valor guardado en config.json (si existe) en formato texto plano.
    pub fn get_raw(&self, key: &str) -> Result<Option<String>, String> {
        let Some(k) = normalize_key(key) else {
            return Err(unknown_key_error(key));
        };
        let val = match k {
            "server" => self.server.clone(),
            "relay" => self.relay.map(|b| b.to_string()),
            "limit" => self.limit.clone(),
            "port" => self.port.map(|p| p.to_string()),
            "yes" => self.yes.map(|b| b.to_string()),
            "once" => self.once.map(|b| b.to_string()),
            "expire" => self.expire.clone(),
            "no_qr" => self.no_qr.map(|b| b.to_string()),
            "out" => self.out.clone(),
            "overwrite" => self.overwrite.map(|b| b.to_string()),
            "no_resume" => self.no_resume.map(|b| b.to_string()),
            "speed_time" => self.speed_time.map(|t| t.to_string()),
            "direct_only" => self.direct_only.map(|b| b.to_string()),
            "serve_host" => self.serve_host.clone(),
            "serve_port" => self.serve_port.map(|p| p.to_string()),
            "auto_update" => self.auto_update.map(|b| b.to_string()),
            _ => None,
        };
        Ok(val)
    }

    /// Valida y establece una clave en la configuracion.
    pub fn set_value(&mut self, key: &str, raw: &str) -> Result<SetOutcome, String> {
        let Some(k) = normalize_key(key) else {
            return Err(unknown_key_error(key));
        };
        let trimmed = raw.trim();
        match k {
            "server" => {
                if matches!(trimmed.to_ascii_lowercase().as_str(), "-" | "default" | "reset") {
                    self.server = None;
                    return Ok(SetOutcome::Cleared);
                }
                let clean = validate_server_url(trimmed)?;
                self.server = Some(clean.clone());
                Ok(SetOutcome::Set(clean))
            }
            "relay" => {
                let b = parse_bool_str(trimmed)?;
                self.relay = Some(b);
                Ok(SetOutcome::Set(b.to_string()))
            }
            "limit" => {
                if is_clear_sentinel(trimmed) {
                    self.limit = None;
                    return Ok(SetOutcome::Cleared);
                }
                parse_rate(trimmed)?;
                self.limit = Some(trimmed.to_string());
                Ok(SetOutcome::Set(trimmed.to_string()))
            }
            "port" => {
                if is_clear_sentinel(trimmed) {
                    self.port = None;
                    return Ok(SetOutcome::Cleared);
                }
                let port: u16 = if !trimmed.is_empty() && trimmed.bytes().all(|b| b.is_ascii_digit()) {
                    trimmed.parse().map_err(|_| {
                        format!("Puerto no válido: \"{raw}\". Debe ser un entero entre 0 y 65535.")
                    })?
                } else {
                    return Err(format!(
                        "Puerto no válido: \"{raw}\". Debe ser un entero entre 0 y 65535."
                    ));
                };
                if port == 0 {
                    self.port = None;
                    return Ok(SetOutcome::Cleared);
                }
                self.port = Some(port);
                Ok(SetOutcome::Set(port.to_string()))
            }
            "yes" => {
                let b = parse_bool_str(trimmed)?;
                self.yes = Some(b);
                Ok(SetOutcome::Set(b.to_string()))
            }
            "once" => {
                let b = parse_bool_str(trimmed)?;
                self.once = Some(b);
                Ok(SetOutcome::Set(b.to_string()))
            }
            "expire" => {
                if is_clear_sentinel(trimmed) {
                    self.expire = None;
                    return Ok(SetOutcome::Cleared);
                }
                parse_duration(trimmed)?;
                self.expire = Some(trimmed.to_string());
                Ok(SetOutcome::Set(trimmed.to_string()))
            }
            "no_qr" => {
                let b = parse_bool_str(trimmed)?;
                self.no_qr = Some(b);
                Ok(SetOutcome::Set(b.to_string()))
            }
            "out" => {
                if matches!(trimmed.to_ascii_lowercase().as_str(), "-" | "default" | "reset") {
                    self.out = None;
                    return Ok(SetOutcome::Cleared);
                }
                if trimmed.is_empty() {
                    return Err("La carpeta de destino no puede estar vacía.".to_string());
                }
                self.out = Some(trimmed.to_string());
                Ok(SetOutcome::Set(trimmed.to_string()))
            }
            "overwrite" => {
                let b = parse_bool_str(trimmed)?;
                self.overwrite = Some(b);
                Ok(SetOutcome::Set(b.to_string()))
            }
            "no_resume" => {
                let b = parse_bool_str(trimmed)?;
                self.no_resume = Some(b);
                Ok(SetOutcome::Set(b.to_string()))
            }
            "speed_time" => {
                if matches!(trimmed.to_ascii_lowercase().as_str(), "-" | "default" | "reset") {
                    self.speed_time = None;
                    return Ok(SetOutcome::Cleared);
                }
                let secs: u64 = if !trimmed.is_empty() && trimmed.bytes().all(|b| b.is_ascii_digit()) {
                    trimmed.parse().unwrap_or(0)
                } else {
                    0
                };
                if secs == 0 {
                    return Err(format!(
                        "Duración no válida para speed_time: \"{raw}\". Debe ser un entero positivo en segundos."
                    ));
                }
                self.speed_time = Some(secs);
                Ok(SetOutcome::Set(secs.to_string()))
            }
            "direct_only" => {
                let b = parse_bool_str(trimmed)?;
                self.direct_only = Some(b);
                Ok(SetOutcome::Set(b.to_string()))
            }
            "serve_host" => {
                if matches!(trimmed.to_ascii_lowercase().as_str(), "-" | "default" | "reset") {
                    self.serve_host = None;
                    return Ok(SetOutcome::Cleared);
                }
                if trimmed.is_empty() || trimmed.chars().any(char::is_whitespace) {
                    return Err(format!(
                        "Dirección de escucha no válida para serve_host: \"{raw}\"."
                    ));
                }
                self.serve_host = Some(trimmed.to_string());
                Ok(SetOutcome::Set(trimmed.to_string()))
            }
            "serve_port" => {
                if matches!(trimmed.to_ascii_lowercase().as_str(), "-" | "default" | "reset") {
                    self.serve_port = None;
                    return Ok(SetOutcome::Cleared);
                }
                let port: u16 = if !trimmed.is_empty() && trimmed.bytes().all(|b| b.is_ascii_digit()) {
                    trimmed.parse().map_err(|_| {
                        format!("Puerto no válido: \"{raw}\". Debe ser un entero entre 1 y 65535.")
                    })?
                } else {
                    return Err(format!(
                        "Puerto no válido: \"{raw}\". Debe ser un entero entre 1 y 65535."
                    ));
                };
                if port == 0 {
                    return Err("El puerto de serve_port debe estar entre 1 y 65535.".to_string());
                }
                self.serve_port = Some(port);
                Ok(SetOutcome::Set(port.to_string()))
            }
            "auto_update" => {
                let b = parse_bool_str(trimmed)?;
                self.auto_update = Some(b);
                Ok(SetOutcome::Set(b.to_string()))
            }
            _ => Err(unknown_key_error(key)),
        }
    }

    pub fn unset_value(&mut self, key: &str) -> Result<bool, String> {
        let Some(k) = normalize_key(key) else {
            return Err(unknown_key_error(key));
        };
        let existed = match k {
            "server" => self.server.take().is_some(),
            "relay" => self.relay.take().is_some(),
            "limit" => self.limit.take().is_some(),
            "port" => self.port.take().is_some(),
            "yes" => self.yes.take().is_some(),
            "once" => self.once.take().is_some(),
            "expire" => self.expire.take().is_some(),
            "no_qr" => self.no_qr.take().is_some(),
            "out" => self.out.take().is_some(),
            "overwrite" => self.overwrite.take().is_some(),
            "no_resume" => self.no_resume.take().is_some(),
            "speed_time" => self.speed_time.take().is_some(),
            "direct_only" => self.direct_only.take().is_some(),
            "serve_host" => self.serve_host.take().is_some(),
            "serve_port" => self.serve_port.take().is_some(),
            "auto_update" => self.auto_update.take().is_some(),
            _ => false,
        };
        Ok(existed)
    }

    /// Alterna un campo booleano tomando su valor efectivo actual como base.
    pub fn toggle_bool(&mut self, key: &str) -> Result<bool, String> {
        let Some(k) = normalize_key(key) else {
            return Err(unknown_key_error(key));
        };
        let next = match k {
            "relay" => {
                let v = !self.relay.unwrap_or(false);
                self.relay = if v { Some(true) } else { None };
                v
            }
            "yes" => {
                let v = !self.yes.unwrap_or(false);
                self.yes = if v { Some(true) } else { None };
                v
            }
            "once" => {
                let v = !self.once.unwrap_or(false);
                self.once = if v { Some(true) } else { None };
                v
            }
            "no_qr" => {
                let v = !self.no_qr.unwrap_or(false);
                self.no_qr = if v { Some(true) } else { None };
                v
            }
            "overwrite" => {
                let v = !self.overwrite.unwrap_or(false);
                self.overwrite = if v { Some(true) } else { None };
                v
            }
            "no_resume" => {
                let v = !self.no_resume.unwrap_or(false);
                self.no_resume = if v { Some(true) } else { None };
                v
            }
            "direct_only" => {
                let v = !self.direct_only.unwrap_or(false);
                self.direct_only = if v { Some(true) } else { None };
                v
            }
            "auto_update" => {
                let v = !self.auto_update.unwrap_or(true);
                self.auto_update = if !v { Some(false) } else { None };
                v
            }
            _ => return Err(format!("La clave \"{k}\" no es booleana.")),
        };
        Ok(next)
    }

    /// Valor efectivo para mostrar en `drop config show` y en el menu interactivo.
    pub fn effective_display(&self, key: &str) -> (String, ValueOrigin) {
        match key {
            "server" => effective_server(self),
            "relay" => match self.relay {
                Some(v) => (format_bool_es(v).to_string(), ValueOrigin::Config),
                None => ("no".to_string(), ValueOrigin::Default),
            },
            "limit" => match &self.limit {
                Some(v) => (v.clone(), ValueOrigin::Config),
                None => ("sin límite".to_string(), ValueOrigin::Default),
            },
            "port" => match self.port {
                Some(p) if p > 0 => (p.to_string(), ValueOrigin::Config),
                _ => ("aleatorio".to_string(), ValueOrigin::Default),
            },
            "yes" => match self.yes {
                Some(v) => (format_bool_es(v).to_string(), ValueOrigin::Config),
                None => ("no".to_string(), ValueOrigin::Default),
            },
            "once" => match self.once {
                Some(v) => (format_bool_es(v).to_string(), ValueOrigin::Config),
                None => ("no".to_string(), ValueOrigin::Default),
            },
            "expire" => match &self.expire {
                Some(v) => (v.clone(), ValueOrigin::Config),
                None => ("sin caducidad".to_string(), ValueOrigin::Default),
            },
            "no_qr" => match self.no_qr {
                Some(v) => (format_bool_es(v).to_string(), ValueOrigin::Config),
                None => ("no".to_string(), ValueOrigin::Default),
            },
            "out" => match &self.out {
                Some(v) => (v.clone(), ValueOrigin::Config),
                None => ("directorio actual".to_string(), ValueOrigin::Default),
            },
            "overwrite" => match self.overwrite {
                Some(v) => (format_bool_es(v).to_string(), ValueOrigin::Config),
                None => ("no".to_string(), ValueOrigin::Default),
            },
            "no_resume" => match self.no_resume {
                Some(v) => (format_bool_es(v).to_string(), ValueOrigin::Config),
                None => ("no".to_string(), ValueOrigin::Default),
            },
            "speed_time" => match self.speed_time {
                Some(t) if t > 0 => (format!("{t}s"), ValueOrigin::Config),
                _ => ("5s".to_string(), ValueOrigin::Default),
            },
            "direct_only" => match self.direct_only {
                Some(v) => (format_bool_es(v).to_string(), ValueOrigin::Config),
                None => ("no".to_string(), ValueOrigin::Default),
            },
            "serve_host" => match &self.serve_host {
                Some(h) => (h.clone(), ValueOrigin::Config),
                None => ("0.0.0.0 / ::".to_string(), ValueOrigin::Default),
            },
            "serve_port" => match self.serve_port {
                Some(p) if p > 0 => (p.to_string(), ValueOrigin::Config),
                _ => ("3000".to_string(), ValueOrigin::Default),
            },
            "auto_update" => {
                let (enabled, origin) = effective_auto_update(self);
                (format_bool_es(enabled).to_string(), origin)
            }
            _ => ("-".to_string(), ValueOrigin::Default),
        }
    }
}

pub fn unknown_key_error(key: &str) -> String {
    format!(
        "Clave de configuración desconocida: \"{key}\". Claves válidas: {}.",
        CONFIG_KEY_NAMES.join(", ")
    )
}

/// Servidor efectivo con precedencia `DROP_SERVER > config.server > DEFAULT_SERVER_URL`.
pub fn effective_server(cfg: &Config) -> (String, ValueOrigin) {
    if let Ok(env_srv) = env::var("DROP_SERVER")
        && !env_srv.trim().is_empty()
    {
        return (env_srv.trim().to_string(), ValueOrigin::Env);
    }
    if let Some(ref cfg_srv) = cfg.server
        && !cfg_srv.trim().is_empty()
    {
        return (cfg_srv.trim().to_string(), ValueOrigin::Config);
    }
    (DEFAULT_SERVER_URL.to_string(), ValueOrigin::Default)
}

/// Estado efectivo de auto_update con precedencia `DROP_NO_AUTO_UPDATE > config.auto_update > true`.
pub fn effective_auto_update(cfg: &Config) -> (bool, ValueOrigin) {
    if let Ok(val) = env::var("DROP_NO_AUTO_UPDATE") {
        let v = val.trim().to_ascii_lowercase();
        if !v.is_empty() {
            if matches!(v.as_str(), "0" | "false" | "no") {
                return (true, ValueOrigin::Env);
            }
            return (false, ValueOrigin::Env);
        }
    }
    if let Some(enabled) = cfg.auto_update {
        return (enabled, ValueOrigin::Config);
    }
    (true, ValueOrigin::Default)
}

pub fn load_config_from(path: &Path) -> Result<Option<Config>, String> {
    match fs::read_to_string(path) {
        Ok(raw) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                return Ok(Some(Config::default()));
            }
            let cfg: Config = serde_json::from_str(trimmed).map_err(|e| {
                format!(
                    "Error leyendo la configuración en {}: {e}",
                    path.display()
                )
            })?;
            Ok(Some(cfg))
        }
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!(
            "No se pudo abrir la configuración en {}: {e}",
            path.display()
        )),
    }
}

pub fn save_config_to(path: &Path, cfg: &Config) -> Result<(), String> {
    if let Some(parent) = path.parent()
        && !parent.as_os_str().is_empty()
    {
        fs::create_dir_all(parent).map_err(|e| {
            format!(
                "No se pudo crear el directorio de configuración {}: {e}",
                parent.display()
            )
        })?;
    }
    let mut to_save = cfg.clone();
    to_save.version = Some(CONFIG_SCHEMA_VERSION);
    let mut json = serde_json::to_string_pretty(&to_save)
        .map_err(|e| format!("No se pudo serializar la configuración: {e}"))?;
    json.push('\n');

    let tmp_name = format!(
        ".{}.tmp-{}",
        path.file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("config.json"),
        std::process::id()
    );
    let tmp_path = path.with_file_name(tmp_name);
    fs::write(&tmp_path, json.as_bytes()).map_err(|e| {
        format!(
            "No se pudo escribir la configuración en {}: {e}",
            path.display()
        )
    })?;
    if fs::rename(&tmp_path, path).is_err() {
        // En Windows, rename sobre archivo existente puede fallar; fallback a escritura directa.
        let res = fs::write(path, json.as_bytes()).map_err(|e| {
            format!(
                "No se pudo guardar la configuración en {}: {e}",
                path.display()
            )
        });
        let _ = fs::remove_file(&tmp_path);
        res?;
    }
    Ok(())
}

pub fn delete_config_at(path: &Path) -> Result<bool, String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(false),
        Err(e) => Err(format!(
            "No se pudo eliminar la configuración en {}: {e}",
            path.display()
        )),
    }
}

/// Carga la configuracion activa si no esta deshabilitada por `--no-config` o `DROP_NO_CONFIG`.
/// Si el archivo esta corrupto, imprime un aviso claro a stderr y devuelve `Config::default()`.
pub fn load_active_config(no_config_flag: bool) -> Config {
    if no_config_flag || config_disabled_by_env() {
        return Config::default();
    }
    let path = config_file_path();
    match load_config_from(&path) {
        Ok(Some(cfg)) => cfg,
        Ok(None) => Config::default(),
        Err(err) => {
            eprintln!(
                "  Aviso: {err}\n  Se usarán los valores por defecto. Puedes repararlo con `drop config reset` o ignorarlo con `--no-config`."
            );
            Config::default()
        }
    }
}
