// Interfaz de linea de comandos y parseo de argumentos de drop.

use std::env;
use std::path::{Path, PathBuf};
use std::process;
use std::sync::OnceLock;

use regex::Regex;

use crate::completion::{SHELLS, completion_script};
use crate::pkgmgr::package_manager_of;
use crate::select::parse_patterns;
use crate::throttle::parse_rate;
use crate::ui::{BOLD, CYAN, DIM, GREEN, RED, RESET, YELLOW};

pub const VERSION: &str = env!("DROP_VERSION");
pub const PUBLIC_KEY: &str = "RWQqNnfqvCrj+eavJ9njz2vCoHaC8YnLqjsvNBMndz3hBroQLpou7+Kp";

pub fn default_server() -> String {
    env::var("DROP_SERVER")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "https://drop.oloxx.dev".to_string())
}

pub fn get_install_dir() -> PathBuf {
    if cfg!(windows) {
        let local_app_data = env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                let profile = env::var_os("USERPROFILE")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| PathBuf::from("C:\\"));
                profile.join("AppData").join("Local")
            });
        local_app_data.join("Programs").join("drop")
    } else {
        let home = env::var_os("HOME")
            .or_else(|| env::var_os("USERPROFILE"))
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/tmp"));
        home.join(".local").join("bin")
    }
}

pub fn is_installed(exec_path: &Path) -> bool {
    let install_dir = get_install_dir();
    let Some(current_dir) = exec_path.parent() else {
        return false;
    };
    let a = std::fs::canonicalize(&install_dir).unwrap_or(install_dir);
    let b = std::fs::canonicalize(current_dir).unwrap_or_else(|_| current_dir.to_path_buf());
    a.to_string_lossy().eq_ignore_ascii_case(&b.to_string_lossy())
}

pub fn format_help() -> String {
    let default_srv = default_server();
    format!(
        r#"
{BOLD}drop{RESET} — transferencia P2P de archivos a máxima velocidad ({CYAN}v{VERSION}{RESET})

{BOLD}USO:{RESET}
  drop send <archivo1> [archivo2 ...]   Envía uno o varios archivos
  drop send <carpeta>                   Envía una carpeta entera, con su árbol
  drop send --text "..."                Envía un texto sin crear un archivo antes
  drop send --clipboard                 Envía el contenido del portapapeles
  ... | drop send -                     Envía lo que llegue por la entrada estándar
  drop recv <código-o-enlace>           Recibe los archivos
  drop recv <código> --stdout           Escribe lo recibido en la salida estándar
  drop speed [código-o-enlace]          Mide la velocidad de transferencia entre 2 clientes CLI
  drop serve [-p <puerto>] [-H <dir>]   Levanta el servidor web y de señalización local
  drop verify-web [url]                 Comprueba que una web de drop sirve el código del repositorio
  drop update                           Busca e instala la última versión disponible
  drop install                          Instala drop en el sistema y lo añade al PATH
  drop uninstall                        Desinstala drop del sistema
  drop completion <shell>               Imprime el autocompletado (bash, zsh, fish, powershell)

{BOLD}OPCIONES:{RESET}
  -t, --time <segundos>  Duración de cada fase del test de velocidad (por defecto: 5s)
  -p, --port <puerto>    Puerto TCP local para escucha (por defecto: aleatorio; 3000 en 'serve')
  -H, --host <dir>       Dirección de escucha para 'drop serve' (por defecto: 0.0.0.0 y ::)
  -s, --server <url>     Servidor de señalización (por defecto: {default_srv})
  -o, --out <directorio> Directorio de destino para descargas (por defecto: actual)
  --stdout               Vuelca lo recibido a stdout en vez de a disco (también -o -);
                         los mensajes y el progreso se van a stderr
  --text <texto>         Envía ese texto como message.txt
  --clipboard            Envía el portapapeles como clipboard.txt
  --name <nombre>        Nombre con el que llega lo que entra por stdin
                         (por defecto: stdin). Solo con "drop send -"
  --relay                Fuerza la transferencia a través del servidor de Relay
  --direct-only          Fuerza conexión TCP directa sin relay (solo en test de velocidad)
  --overwrite            Sobrescribe los archivos que ya existan en el destino
                         (por defecto se guarda como "archivo (2).zip")
  --no-resume            No reanuda un .part que hubiera de una descarga
                         cortada: empieza de cero (por defecto se sigue donde
                         se quedó si el emisor confirma que es el mismo archivo)
  --only <patrones>      Recibe solo los archivos que casen, separados por comas:
                         "*.jpg" (por nombre, en cualquier carpeta), "fotos/*.jpg"
                         o "fotos/**" (por ruta). Sin distinguir mayúsculas
  --limit <tasa>         Límite de ancho de banda: 500K, 10M, 1.5G (bytes/s).
                         Vale para enviar y para recibir
  --no-qr                No pinta el código QR del enlace (se omite solo si la
                         salida no es una terminal)
  --once                 Cierra el canal tras la primera descarga completa
  --expire <duración>    El canal caduca solo pasado ese tiempo: 90s, 10m, 2h
                         (un número suelto son minutos)
  --update               Comprueba y actualiza a la última versión
  --force                Fuerza la reinstalación en 'drop update'
  -y, --yes              No pide confirmación antes de servir a cada receptor
                         (se activa solo si no hay terminal interactiva)
  --allow-unsigned       Permite actualizar a una release sin firma (anteriores a la v0.5.2)
  --skip-verify          Omite firma y hash en 'drop update' (no recomendado)
  -h, --help             Muestra esta ayuda
  -v, --version          Muestra la versión

{BOLD}EL CÓDIGO:{RESET}
  {CYAN}4271-lemon-radar-tiger-orbit{RESET}
  {DIM}El número identifica la sala y es lo único que ve el servidor. Las cuatro
  palabras son el secreto del que sale el cifrado y no salen de tu equipo.
  Al teclearlo da igual usar mayúsculas, espacios en vez de guiones o solo las
  4 primeras letras de cada palabra: 4271-lemo-rada-tige-orbi vale igual.{RESET}

{BOLD}EJEMPLOS:{RESET}
  drop send video.mp4
  drop send backup.tar --once --expire 10m
  drop send pelicula.mkv --limit 10M
  drop send --text "la clave del wifi es ..."
  drop recv 4271-lemon-radar-tiger-orbit --stdout | pbcopy
  tar czf - proyecto/ | drop send - --name proyecto.tgz
  drop recv 4271-lemon-radar-tiger-orbit -o - | tar xzf -
  drop recv 4271-lemon-radar-tiger-orbit
  drop recv 4271-lemon-radar-tiger-orbit --only "*.jpg,*.png"
  drop recv https://drop.oloxx.dev/#4271-lemon-radar-tiger-orbit
  drop speed
  drop speed 4271-lemon-radar-tiger-orbit
  drop speed 4271-lemon-radar-tiger-orbit -t 10
  drop serve
  drop serve -p 8080 -H 127.0.0.1
  drop update
  drop verify-web https://drop.oloxx.dev
  eval "$(drop completion bash)"        # o zsh; fish y powershell en la ayuda del script
"#
    )
}

/// `--expire 10m` -> milisegundos. Acepta `s`, `m`, `h`, `min`, `seg`, `sec`;
/// un numero suelto son minutos.
pub fn parse_duration(text: &str) -> Result<u64, String> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r"(?i)^(\d+(?:\.\d+)?)\s*(s|m|h|min|seg|sec)?$").expect("regex duration")
    });
    let trimmed = text.trim();
    let Some(caps) = re.captures(trimmed) else {
        return Err(format!(
            "Duración no válida: \"{text}\". Ejemplos: 90s, 10m, 2h."
        ));
    };
    let n: f64 = caps[1]
        .parse()
        .map_err(|_| format!("Duración no válida: \"{text}\". Ejemplos: 90s, 10m, 2h."))?;
    let unit = caps
        .get(2)
        .map(|m| m.as_str().to_ascii_lowercase())
        .unwrap_or_else(|| "m".to_string());
    let factor: f64 = match unit.chars().next() {
        Some('s') => 1000.0,
        Some('h') => 3_600_000.0,
        _ => 60_000.0,
    };
    let ms = (n * factor).round();
    if !ms.is_finite() || ms <= 0.0 {
        return Err(format!(
            "La duración tiene que ser mayor que cero: \"{text}\"."
        ));
    }
    Ok(ms as u64)
}

#[derive(Debug, Clone)]
pub struct Options {
    pub server: String,
    pub out: Option<String>,
    pub time: u64,
    pub port: u16,
    pub port_explicit: bool,
    pub host: Option<String>,
    pub direct_only: bool,
    pub relay: bool,
    pub overwrite: bool,
    pub no_resume: bool,
    pub yes: bool,
    pub once: bool,
    pub expire_ms: Option<u64>,
    pub no_qr: bool,
    pub stdout: bool,
    pub text: Option<String>,
    pub clipboard: bool,
    pub name: Option<String>,
    pub limit: u64,
    pub only: Vec<String>,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            server: default_server(),
            out: None,
            time: 5,
            port: 0,
            port_explicit: false,
            host: None,
            direct_only: false,
            relay: false,
            overwrite: false,
            no_resume: false,
            yes: false,
            once: false,
            expire_ms: None,
            no_qr: false,
            stdout: false,
            text: None,
            clipboard: false,
            name: None,
            limit: 0,
            only: Vec::new(),
        }
    }
}

fn die_msg(msg: &str) -> ! {
    eprintln!("\n{RED}{msg}{RESET}\n");
    process::exit(1);
}

fn die_with_help(msg: &str) -> ! {
    eprintln!("\n{RED}{msg}{RESET}\n  Usa {CYAN}drop --help{RESET} para ver las opciones disponibles.\n");
    process::exit(1);
}

pub async fn run_cli(argv: Vec<String>) {
    let exec_path = env::current_exe().unwrap_or_else(|_| PathBuf::from("drop"));

    // Limpiar binario anterior de una autoactualizacion en Windows (`.old`).
    let old_exe = PathBuf::from(format!("{}.old", exec_path.to_string_lossy()));
    if old_exe.exists() {
        let _ = std::fs::remove_file(&old_exe);
    }

    if argv.iter().any(|a| a == "-v" || a == "--version") {
        println!("drop v{VERSION}");
        return;
    }

    if argv.iter().any(|a| a == "-h" || a == "--help") {
        println!("{}", format_help());
        return;
    }

    let manager = package_manager_of(&exec_path);
    let managed = |what: &str, cmd: &str, mgr_name: &str| {
        println!("\n  {YELLOW}Este drop lo instaló {mgr_name}:{RESET} para {what}, usa {CYAN}{cmd}{RESET}\n");
    };

    if argv.first().map(String::as_str) == Some("install") {
        if let Some(mgr) = manager {
            println!("\n  {GREEN}✔ Ya está instalado con {}. {RESET}\n", mgr.name);
            return;
        }
        let code = crate::commands::install::run_install(false);
        if code != 0 {
            process::exit(code);
        }
        return;
    }

    if argv.first().map(String::as_str) == Some("uninstall") {
        if let Some(mgr) = manager {
            managed("desinstalarlo", mgr.uninstall, mgr.name);
            return;
        }
        let code = crate::commands::uninstall::run_uninstall();
        if code != 0 {
            process::exit(code);
        }
        return;
    }

    if argv.first().map(String::as_str) == Some("completion") {
        let shell = argv.get(1).map(String::as_str);
        match completion_script(shell) {
            Ok(script) => {
                print!("{script}");
                return;
            }
            Err(err) => {
                eprintln!("\n{RED}{err}{RESET}\n  Uso: drop completion <{}>\n", SHELLS.join("|"));
                process::exit(1);
            }
        }
    }

    if argv.first().map(String::as_str) == Some("verify-web") {
        let mut raw_url: Option<String> = None;
        for arg in &argv[1..] {
            if arg.starts_with('-') {
                die_with_help(&format!("Opción desconocida: {arg}"));
            } else if raw_url.is_none() {
                raw_url = Some(arg.clone());
            }
        }
        let url = raw_url.unwrap_or_else(default_server);
        let code = crate::commands::verify_web::run_verify_web(&url, VERSION).await;
        if code != 0 {
            process::exit(code);
        }
        return;
    }

    if argv.first().map(String::as_str) == Some("update") || argv.iter().any(|a| a == "--update") {
        const UPDATE_FLAGS: &[&str] = &["--update", "--force", "--skip-verify", "--allow-unsigned"];
        for arg in &argv {
            if arg.starts_with('-') && !UPDATE_FLAGS.contains(&arg.as_str()) {
                die_with_help(&format!("Opción desconocida para update: {arg}"));
            }
        }
        if let Some(mgr) = manager {
            managed("actualizarlo", mgr.upgrade, mgr.name);
            return;
        }
        let mut uopts = crate::commands::update::UpdateOptions::default();
        for arg in argv {
            match arg.as_str() {
                "update" | "--update" => {}
                "--force" => uopts.force = true,
                "--allow-unsigned" => uopts.allow_unsigned = true,
                "--skip-verify" => uopts.skip_verify = true,
                other if other.starts_with('-') => die_with_help(&format!("Opción desconocida: {other}")),
                other => die_with_help(&format!("Argumento inesperado en update: {other}")),
            }
        }
        let code = crate::commands::update::run_update(
            uopts,
            crate::verifyweb::DEFAULT_REPO,
            VERSION,
            PUBLIC_KEY,
        )
        .await;
        if code != 0 {
            process::exit(code);
        }
        return;
    }

    if argv.is_empty() {
        let is_drop_bin = env::current_exe()
            .ok()
            .map(|p| {
                let stem_ok = p
                    .file_name()
                    .and_then(|s| s.to_str())
                    .map(|n| matches!(n.to_ascii_lowercase().as_str(), "drop" | "drop.exe"))
                    .unwrap_or(false);
                (stem_ok, p)
            })
            .map(|(stem_ok, p)| {
                stem_ok
                    && std::io::IsTerminal::is_terminal(&std::io::stdin())
                    && manager.is_none()
                    && !crate::commands::install::is_installed(&p)
            })
            .unwrap_or(false);
        if is_drop_bin {
            let code = crate::commands::install::run_install(true);
            if code != 0 {
                process::exit(code);
            }
            return;
        }
        println!("{}", format_help());
        return;
    }

    let mut options = Options::default();
    let mut clean_args = Vec::new();
    let mut i = 0;

    let require_val = |idx: usize, flag: &str| -> String {
        if idx >= argv.len() {
            die_msg(&format!("{flag} necesita un valor."));
        }
        argv[idx].clone()
    };

    while i < argv.len() {
        let arg = argv[i].as_str();
        if arg == "--" {
            clean_args.extend(argv[i + 1..].iter().cloned());
            break;
        } else if arg == "-s" || arg == "--server" {
            options.server = require_val(i + 1, arg);
            i += 2;
        } else if arg == "-o" || arg == "--out" {
            let val = require_val(i + 1, arg);
            if val == "-" {
                options.out = None;
                options.stdout = true;
            } else {
                options.out = Some(val);
            }
            i += 2;
        } else if arg == "--stdout" {
            options.stdout = true;
            i += 1;
        } else if arg == "--text" {
            options.text = Some(require_val(i + 1, arg));
            i += 2;
        } else if arg == "--clipboard" {
            options.clipboard = true;
            i += 1;
        } else if arg == "--name" {
            let val = require_val(i + 1, arg);
            if val.is_empty() {
                die_msg("--name necesita el nombre del archivo.");
            }
            options.name = Some(val);
            i += 2;
        } else if arg == "-p" || arg == "--port" {
            let raw = require_val(i + 1, arg);
            let port: u16 = if raw.bytes().all(|b| b.is_ascii_digit()) {
                raw.parse().unwrap_or_else(|_| {
                    die_msg(&format!(
                        "Puerto no válido: \"{raw}\". Debe ser un entero entre 0 y 65535."
                    ))
                })
            } else {
                die_msg(&format!(
                    "Puerto no válido: \"{raw}\". Debe ser un entero entre 0 y 65535."
                ));
            };
            options.port = port;
            options.port_explicit = true;
            i += 2;
        } else if arg == "-H" || arg == "--host" {
            let val = require_val(i + 1, arg);
            if val.is_empty() {
                die_msg("--host necesita una dirección IP.");
            }
            options.host = Some(val);
            i += 2;
        } else if arg == "-t" || arg == "--time" {
            let raw = require_val(i + 1, arg);
            let secs: u64 = if !raw.is_empty() && raw.bytes().all(|b| b.is_ascii_digit()) {
                raw.parse().unwrap_or(0)
            } else {
                0
            };
            if secs == 0 {
                die_msg(&format!(
                    "Duración no válida para -t/--time: \"{raw}\". Debe ser un entero positivo en segundos."
                ));
            }
            options.time = secs;
            i += 2;
        } else if arg == "--direct-only" {
            options.direct_only = true;
            i += 1;
        } else if arg == "--relay" {
            options.relay = true;
            i += 1;
        } else if arg == "--overwrite" {
            options.overwrite = true;
            i += 1;
        } else if arg == "--no-resume" {
            options.no_resume = true;
            i += 1;
        } else if arg == "--only" {
            let raw = require_val(i + 1, arg);
            let patterns = parse_patterns(&raw);
            if patterns.is_empty() {
                die_msg("--only necesita al menos un patrón, como \"*.jpg\" o \"fotos/**\".");
            }
            options.only.extend(patterns);
            i += 2;
        } else if arg == "--once" {
            options.once = true;
            i += 1;
        } else if arg == "--no-qr" {
            options.no_qr = true;
            i += 1;
        } else if arg == "--limit" {
            let raw = require_val(i + 1, arg);
            match parse_rate(&raw) {
                Ok(rate) => options.limit = rate,
                Err(msg) => die_msg(&msg),
            }
            i += 2;
        } else if arg == "--expire" {
            let raw = require_val(i + 1, arg);
            match parse_duration(&raw) {
                Ok(ms) => options.expire_ms = Some(ms),
                Err(msg) => die_msg(&msg),
            }
            i += 2;
        } else if arg == "-y" || arg == "--yes" {
            options.yes = true;
            i += 1;
        } else if arg.starts_with('-') && arg != "-" {
            die_with_help(&format!("Opción desconocida: {arg}"));
        } else {
            clean_args.push(argv[i].clone());
            i += 1;
        }
    }

    if clean_args.is_empty() && options.text.is_none() && !options.clipboard {
        die_with_help("Falta la orden, archivo o código.");
    }

    // Auto-actualizacion silenciosa en segundo plano (max. cada 24h, sin bloquear ni ensuciar stdout).
    let auto_update = crate::commands::update::spawn_auto_update(
        &exec_path,
        manager,
        crate::verifyweb::DEFAULT_REPO,
        VERSION,
        PUBLIC_KEY,
    );

    let code = if clean_args.is_empty() {
        crate::commands::send::run_send(&[], options).await
    } else {
        let command = &clean_args[0];
        let rest = &clean_args[1..];
        match command.as_str() {
            "send" => {
                if rest.is_empty() && options.text.is_none() && !options.clipboard {
                    die_with_help("Falta el archivo o carpeta a enviar (o usa --text / --clipboard).");
                }
                crate::commands::send::run_send(rest, options).await
            }
            "recv" | "get" => {
                if rest.is_empty() {
                    die_with_help("Falta el código para recibir.");
                }
                crate::commands::recv::run_recv(&rest.join(" "), options).await
            }
            "speed" | "test" => {
                if rest.is_empty() {
                    crate::commands::speed::run_speed_host(options).await
                } else {
                    crate::commands::speed::run_speed_guest(&rest.join(" "), options).await
                }
            }
            "serve" => {
                if !rest.is_empty() {
                    die_with_help(&format!("Argumento inesperado en serve: {}", rest.join(" ")));
                }
                let port = if options.port_explicit {
                    options.port
                } else {
                    3000
                };
                crate::commands::serve::run_serve(options.host.as_deref(), port).await
            }
            _ => {
                if Path::new(command).exists() {
                    crate::commands::send::run_send(&clean_args, options).await
                } else {
                    crate::commands::recv::run_recv(&clean_args.join(" "), options).await
                }
            }
        }
    };

    if let Some(handle) = auto_update {
        handle.finish_and_notify().await;
    }

    if code != 0 {
        process::exit(code);
    }
}
