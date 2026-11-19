// Subcomando `drop config`: menu interactivo, asistente inicial y gestion de preferencias.

use std::io::{self, BufRead, IsTerminal, Write};

use crate::config::{
    CONFIG_KEY_NAMES, CONFIG_KEYS, Config, Section, SetOutcome, ValueKind, ValueOrigin,
    config_file_path, delete_config_at, format_bool_es, key_spec, load_config_from, normalize_key,
    parse_bool_str, save_config_to,
};
use crate::ui::{BOLD, CYAN, DIM, GREEN, RED, RESET, YELLOW};

pub const CONFIG_SUBCOMMANDS: &[&str] = &["init", "show", "get", "set", "unset", "reset", "path"];

fn print_config_usage() {
    eprintln!(
        "\n  {BOLD}Uso de drop config:{RESET}
    drop config                     Abre el menú interactivo (o muestra la configuración sin TTY)
    drop config init                Ejecuta el asistente guiado de configuración inicial
    drop config show                Muestra la configuración activa y el origen de cada valor
    drop config get <clave>         Imprime el valor guardado para una clave
    drop config set <clave> <valor> Valida y guarda una preferencia
    drop config unset <clave>       Restablece una clave al valor por defecto
    drop config reset [-y]          Elimina el archivo de configuración
    drop config path                Imprime la ruta del archivo de configuración

  {DIM}Claves disponibles:{RESET} {}
",
        CONFIG_KEY_NAMES.join(", ")
    );
}

pub fn run_config(args: &[String]) -> i32 {
    if args.is_empty() {
        let force_prompt = std::env::var("DROP_FORCE_PROMPT").ok().as_deref() == Some("1");
        if (io::stdin().is_terminal() && io::stdout().is_terminal()) || force_prompt {
            return run_menu();
        }
        return run_show();
    }

    match args[0].as_str() {
        "init" | "wizard" => {
            if args.len() > 1 {
                eprintln!("\n  {RED}Argumento inesperado en `drop config init`: {}{RESET}", args[1]);
                print_config_usage();
                return 1;
            }
            run_wizard()
        }
        "show" | "list" => {
            if args.len() > 1 {
                eprintln!("\n  {RED}Argumento inesperado en `drop config show`: {}{RESET}", args[1]);
                print_config_usage();
                return 1;
            }
            run_show()
        }
        "path" => {
            if args.len() > 1 {
                eprintln!("\n  {RED}Argumento inesperado en `drop config path`: {}{RESET}", args[1]);
                print_config_usage();
                return 1;
            }
            println!("{}", config_file_path().display());
            0
        }
        "get" => {
            if args.len() != 2 {
                eprintln!("\n  {RED}Uso: drop config get <clave>{RESET}");
                print_config_usage();
                return 1;
            }
            run_get(&args[1])
        }
        "set" => {
            if args.len() < 3 {
                eprintln!("\n  {RED}Uso: drop config set <clave> <valor>{RESET}");
                print_config_usage();
                return 1;
            }
            let val = args[2..].join(" ");
            run_set(&args[1], &val)
        }
        "unset" | "rm" | "del" => {
            if args.len() != 2 {
                eprintln!("\n  {RED}Uso: drop config unset <clave>{RESET}");
                print_config_usage();
                return 1;
            }
            run_unset(&args[1])
        }
        "reset" => {
            let mut auto_yes = false;
            for arg in &args[1..] {
                match arg.as_str() {
                    "-y" | "--yes" => auto_yes = true,
                    other => {
                        eprintln!("\n  {RED}Opción desconocida en `drop config reset`: {other}{RESET}");
                        print_config_usage();
                        return 1;
                    }
                }
            }
            run_reset(auto_yes)
        }
        other => {
            eprintln!("\n  {RED}Subcomando desconocido en `drop config`: {other}{RESET}");
            print_config_usage();
            1
        }
    }
}

fn load_for_edit() -> Result<(std::path::PathBuf, Config), i32> {
    let path = config_file_path();
    match load_config_from(&path) {
        Ok(Some(cfg)) => Ok((path, cfg)),
        Ok(None) => Ok((path, Config::default())),
        Err(err) => {
            eprintln!("\n  {RED}✖ {err}{RESET}");
            eprintln!(
                "  {DIM}Puedes restablecer el archivo con `drop config reset -y`.{RESET}\n"
            );
            Err(1)
        }
    }
}

pub fn run_show() -> i32 {
    let path = config_file_path();
    let (cfg, file_status) = match load_config_from(&path) {
        Ok(Some(c)) => (c, format!("{GREEN}activo{RESET}")),
        Ok(None) => (
            Config::default(),
            format!("{DIM}aún no creado (usando valores por defecto){RESET}"),
        ),
        Err(err) => {
            eprintln!("\n  {YELLOW}Aviso: {err}{RESET}");
            (
                Config::default(),
                format!("{RED}inválido (usa `drop config reset`){RESET}"),
            )
        }
    };

    println!(
        "\n{BOLD}================================================================{RESET}"
    );
    println!("  {CYAN}drop config{RESET} — {BOLD}Configuración activa{RESET}");
    println!(
        "{BOLD}================================================================{RESET}"
    );
    println!(
        "  {DIM}Archivo:{RESET} {} ({file_status})",
        path.display()
    );

    let sections = [
        Section::Network,
        Section::Send,
        Section::Recv,
        Section::Advanced,
    ];

    for sec in sections {
        println!("\n  {BOLD}{}{RESET}", sec.title());
        for spec in CONFIG_KEYS.iter().filter(|k| k.section == sec) {
            let (val, origin) = cfg.effective_display(spec.key);
            let val_fmt = match origin {
                ValueOrigin::Config => format!("{GREEN}{val}{RESET}"),
                ValueOrigin::Env => format!("{YELLOW}{val}{RESET}"),
                ValueOrigin::Default => format!("{DIM}{val}{RESET}"),
            };
            let origin_fmt = match origin {
                ValueOrigin::Config => format!("{CYAN}(config){RESET}"),
                ValueOrigin::Env => format!("{YELLOW}(env){RESET}"),
                ValueOrigin::Default => format!("{DIM}(defecto){RESET}"),
            };
            println!(
                "    {CYAN}{:<12}{RESET} {:<36} {} {}",
                spec.key, spec.label, val_fmt, origin_fmt
            );
        }
    }

    println!(
        "\n  {DIM}Edita interactivamente con `drop config` o cambia una clave con `drop config set <clave> <valor>`.{RESET}\n"
    );
    0
}

fn run_get(key: &str) -> i32 {
    let Some(canonical) = normalize_key(key) else {
        eprintln!("\n  {RED}✖ {}{RESET}\n", crate::config::unknown_key_error(key));
        return 1;
    };
    let Ok((_path, cfg)) = load_for_edit() else {
        return 1;
    };
    match cfg.get_raw(canonical) {
        Ok(Some(v)) => {
            println!("{v}");
            0
        }
        Ok(None) => {
            let (eff, origin) = cfg.effective_display(canonical);
            eprintln!(
                "  {DIM}La clave \"{canonical}\" no está fijada en config.json (valor actual: {eff}, origen: {}).{RESET}",
                origin.label()
            );
            1
        }
        Err(err) => {
            eprintln!("\n  {RED}✖ {err}{RESET}\n");
            1
        }
    }
}

fn run_set(key: &str, value: &str) -> i32 {
    let Some(canonical) = normalize_key(key) else {
        eprintln!("\n  {RED}✖ {}{RESET}\n", crate::config::unknown_key_error(key));
        return 1;
    };
    let Ok((path, mut cfg)) = load_for_edit() else {
        return 1;
    };
    match cfg.set_value(canonical, value) {
        Ok(SetOutcome::Set(v)) => {
            if let Err(err) = save_config_to(&path, &cfg) {
                eprintln!("\n  {RED}✖ {err}{RESET}\n");
                return 1;
            }
            println!(
                "\n  {GREEN}✔ {BOLD}{canonical}{RESET}{GREEN} = {v}{RESET} {DIM}({}){RESET}\n",
                path.display()
            );
            0
        }
        Ok(SetOutcome::Cleared) => {
            if let Err(err) = save_config_to(&path, &cfg) {
                eprintln!("\n  {RED}✖ {err}{RESET}\n");
                return 1;
            }
            println!(
                "\n  {GREEN}✔ {BOLD}{canonical}{RESET}{GREEN} restablecido al valor por defecto{RESET} {DIM}({}){RESET}\n",
                path.display()
            );
            0
        }
        Err(err) => {
            eprintln!("\n  {RED}✖ {err}{RESET}\n");
            1
        }
    }
}

fn run_unset(key: &str) -> i32 {
    let Some(canonical) = normalize_key(key) else {
        eprintln!("\n  {RED}✖ {}{RESET}\n", crate::config::unknown_key_error(key));
        return 1;
    };
    let Ok((path, mut cfg)) = load_for_edit() else {
        return 1;
    };
    match cfg.unset_value(canonical) {
        Ok(existed) => {
            if (path.exists() || existed)
                && let Err(err) = save_config_to(&path, &cfg)
            {
                eprintln!("\n  {RED}✖ {err}{RESET}\n");
                return 1;
            }
            if existed {
                println!(
                    "\n  {GREEN}✔ {BOLD}{canonical}{RESET}{GREEN} restablecido al valor por defecto.{RESET}\n"
                );
            } else {
                println!(
                    "\n  {DIM}La clave \"{canonical}\" ya usaba el valor por defecto.{RESET}\n"
                );
            }
            0
        }
        Err(err) => {
            eprintln!("\n  {RED}✖ {err}{RESET}\n");
            1
        }
    }
}

fn run_reset(auto_yes: bool) -> i32 {
    let path = config_file_path();
    if !path.exists() {
        println!(
            "\n  {DIM}No hay archivo de configuración en {} (ya se usan los valores por defecto).{RESET}\n",
            path.display()
        );
        return 0;
    }

    let force_prompt = std::env::var("DROP_FORCE_PROMPT").ok().as_deref() == Some("1");
    if !auto_yes && (io::stdin().is_terminal() || force_prompt) {
        let mut stdin = io::stdin().lock();
        let prompt = format!(
            "\n  ¿Eliminar la configuración guardada en {}? (s/N): ",
            path.display()
        );
        match read_prompt_line(&mut stdin, &prompt) {
            Some(ans) if is_yes(&ans) => {}
            _ => {
                println!("  {DIM}Operación cancelada.{RESET}\n");
                return 0;
            }
        }
    }

    match delete_config_at(&path) {
        Ok(true) => {
            println!(
                "\n  {GREEN}✔ Configuración restablecida (eliminado {}).{RESET}\n",
                path.display()
            );
            0
        }
        Ok(false) => {
            println!("\n  {DIM}Ya se usaban los valores por defecto.{RESET}\n");
            0
        }
        Err(err) => {
            eprintln!("\n  {RED}✖ {err}{RESET}\n");
            1
        }
    }
}

fn read_prompt_line<R: BufRead>(reader: &mut R, prompt: &str) -> Option<String> {
    print!("{prompt}");
    let _ = io::stdout().flush();
    let mut line = String::new();
    match reader.read_line(&mut line) {
        Ok(0) => None,
        Ok(_) => Some(line.trim().to_string()),
        Err(_) => None,
    }
}

fn is_yes(ans: &str) -> bool {
    matches!(
        ans.trim().to_ascii_lowercase().as_str(),
        "s" | "si" | "sí" | "y" | "yes"
    )
}

fn render_menu(cfg: &Config, path: &std::path::Path, dirty: bool) {
    println!(
        "\n{BOLD}================================================================{RESET}"
    );
    let dirty_badge = if dirty {
        format!(" {YELLOW}* cambios sin guardar{RESET}")
    } else {
        String::new()
    };
    println!(
        "  {CYAN}drop config{RESET} — {BOLD}Menú de preferencias por defecto{RESET}{dirty_badge}"
    );
    println!(
        "{BOLD}================================================================{RESET}"
    );
    println!("  {DIM}Archivo:{RESET} {}", path.display());

    let sections = [
        Section::Network,
        Section::Send,
        Section::Recv,
        Section::Advanced,
    ];

    let mut idx = 1usize;
    for sec in sections {
        println!("\n  {BOLD}{}{RESET}", sec.title());
        for spec in CONFIG_KEYS.iter().filter(|k| k.section == sec) {
            let (val, origin) = cfg.effective_display(spec.key);
            let val_fmt = match origin {
                ValueOrigin::Config => format!("{GREEN}[{val}]{RESET}"),
                ValueOrigin::Env => format!("{YELLOW}[{val} · env]{RESET}"),
                ValueOrigin::Default => format!("{DIM}[{val}]{RESET}"),
            };
            println!(
                "    {CYAN}[{:>2}]{RESET} {:<12} {:<36} {val_fmt}",
                idx, spec.key, spec.label
            );
            idx += 1;
        }
    }

    println!("\n  {BOLD}Acciones{RESET}");
    println!("    {CYAN}[ a]{RESET} Asistente guiado paso a paso");
    println!("    {CYAN}[ r]{RESET} Restablecer todo a valores por defecto");
    println!("    {GREEN}[ g]{RESET} Guardar y salir");
    println!("    {DIM}[ q]{RESET} Salir sin guardar");
}

fn prompt_edit_text_key<R: BufRead>(reader: &mut R, cfg: &mut Config, key: &str) -> bool {
    let Some(spec) = key_spec(key) else {
        return false;
    };
    let (current, _) = cfg.effective_display(spec.key);
    println!("\n  {BOLD}{}{RESET} — {}", spec.key, spec.label);
    println!("  {DIM}{}{RESET}", spec.hint);
    println!(
        "  {DIM}Valor actual: [{current}] · Pulsa Enter para mantener o '-' para volver al defecto.{RESET}"
    );
    loop {
        let Some(input) = read_prompt_line(reader, "  Nuevo valor: ") else {
            return false;
        };
        if input.is_empty() {
            println!("  {DIM}Sin cambios.{RESET}");
            return false;
        }
        match cfg.set_value(spec.key, &input) {
            Ok(SetOutcome::Set(v)) => {
                println!("  {GREEN}✔ {} = {v}{RESET}", spec.key);
                return true;
            }
            Ok(SetOutcome::Cleared) => {
                println!("  {GREEN}✔ {} restablecido al valor por defecto{RESET}", spec.key);
                return true;
            }
            Err(err) => {
                println!("  {RED}✖ {err}{RESET}");
            }
        }
    }
}

/// Menu interactivo principal (`drop config`).
pub fn run_menu() -> i32 {
    let path = config_file_path();
    let mut cfg = match load_config_from(&path) {
        Ok(Some(c)) => c,
        Ok(None) => Config::default(),
        Err(err) => {
            eprintln!("\n  {YELLOW}Aviso: {err}{RESET}");
            eprintln!("  {DIM}Se empezará desde valores por defecto (al guardar se corregirá el archivo).{RESET}");
            Config::default()
        }
    };

    let mut dirty = false;
    let mut stdin = io::stdin().lock();

    loop {
        render_menu(&cfg, &path, dirty);
        let prompt = format!(
            "\n  Elige una opción (1-{}, a, r, g, q): ",
            CONFIG_KEYS.len()
        );
        let Some(choice) = read_prompt_line(&mut stdin, &prompt) else {
            println!();
            return 0;
        };
        let lower = choice.trim().to_ascii_lowercase();
        match lower.as_str() {
            "g" | "guardar" | "save" | "w" => {
                if let Err(err) = save_config_to(&path, &cfg) {
                    eprintln!("\n  {RED}✖ {err}{RESET}\n");
                    return 1;
                }
                println!(
                    "\n  {GREEN}✔ Configuración guardada en {}.{RESET}\n",
                    path.display()
                );
                return 0;
            }
            "q" | "salir" | "exit" => {
                if dirty {
                    println!("  {DIM}Cambios descartados.{RESET}\n");
                } else {
                    println!();
                }
                return 0;
            }
            "r" | "reset" => {
                cfg = Config::default();
                dirty = true;
                println!("  {YELLOW}Todas las opciones restablecidas a defecto (pulsa 'g' para guardar).{RESET}");
            }
            "a" | "init" | "asistente" => {
                drop(stdin);
                let code = run_wizard_on(&mut cfg, &path);
                if code == 0 {
                    return 0;
                }
                return code;
            }
            _ => {
                if let Ok(num) = lower.parse::<usize>()
                    && (1..=CONFIG_KEYS.len()).contains(&num)
                {
                    let spec = CONFIG_KEYS[num - 1];
                    match spec.kind {
                        ValueKind::Bool => match cfg.toggle_bool(spec.key) {
                            Ok(val) => {
                                dirty = true;
                                println!(
                                    "  {GREEN}✔ {} = {}{RESET}",
                                    spec.key,
                                    format_bool_es(val)
                                );
                            }
                            Err(err) => println!("  {RED}✖ {err}{RESET}"),
                        },
                        ValueKind::Text => {
                            if prompt_edit_text_key(&mut stdin, &mut cfg, spec.key) {
                                dirty = true;
                            }
                        }
                    }
                } else {
                    println!(
                        "  {RED}Opción no reconocida: \"{choice}\". Usa un número del 1 al {}, 'a', 'r', 'g' o 'q'.{RESET}",
                        CONFIG_KEYS.len()
                    );
                }
            }
        }
    }
}

/// Asistente guiado paso a paso (`drop config init` y oferta tras `drop install`).
pub fn run_wizard() -> i32 {
    let path = config_file_path();
    let mut cfg = match load_config_from(&path) {
        Ok(Some(c)) => c,
        Ok(None) => Config::default(),
        Err(err) => {
            eprintln!("\n  {YELLOW}Aviso: {err}{RESET}");
            Config::default()
        }
    };
    run_wizard_on(&mut cfg, &path)
}

fn wizard_ask_text<R: BufRead>(
    reader: &mut R,
    cfg: &mut Config,
    step: &str,
    key: &str,
    question: &str,
) -> Option<()> {
    let spec = key_spec(key)?;
    let (current, _) = cfg.effective_display(spec.key);
    println!("\n  {CYAN}[{step}]{RESET} {BOLD}{question}{RESET}");
    println!("  {DIM}{} · '-' vuelve al valor por defecto{RESET}", spec.hint);
    loop {
        let prompt = format!("  [{current}]: ");
        let input = read_prompt_line(reader, &prompt)?;
        if input.is_empty() {
            return Some(());
        }
        match cfg.set_value(spec.key, &input) {
            Ok(_) => return Some(()),
            Err(err) => println!("  {RED}✖ {err}{RESET}"),
        }
    }
}

fn wizard_ask_bool<R: BufRead>(
    reader: &mut R,
    cfg: &mut Config,
    step: &str,
    key: &str,
    question: &str,
    default_val: bool,
) -> Option<()> {
    let current = match key {
        "relay" => cfg.relay.unwrap_or(default_val),
        "yes" => cfg.yes.unwrap_or(default_val),
        "once" => cfg.once.unwrap_or(default_val),
        "no_qr" => cfg.no_qr.unwrap_or(default_val),
        "overwrite" => cfg.overwrite.unwrap_or(default_val),
        "no_resume" => cfg.no_resume.unwrap_or(default_val),
        "direct_only" => cfg.direct_only.unwrap_or(default_val),
        "auto_update" => cfg.auto_update.unwrap_or(default_val),
        _ => default_val,
    };
    let hint = if current { "S/n" } else { "s/N" };
    println!("\n  {CYAN}[{step}]{RESET} {BOLD}{question}{RESET}");
    loop {
        let prompt = format!("  ({hint}): ");
        let input = read_prompt_line(reader, &prompt)?;
        if input.is_empty() {
            return Some(());
        }
        match parse_bool_str(&input) {
            Ok(v) => {
                if v == default_val {
                    let _ = cfg.unset_value(key);
                } else {
                    let _ = cfg.set_value(key, if v { "true" } else { "false" });
                }
                return Some(());
            }
            Err(err) => println!("  {RED}✖ {err}{RESET}"),
        }
    }
}

fn run_wizard_on(cfg: &mut Config, path: &std::path::Path) -> i32 {
    println!(
        "\n{BOLD}================================================================{RESET}"
    );
    println!("  {CYAN}drop config init{RESET} — {BOLD}Asistente de configuración inicial{RESET}");
    println!(
        "{BOLD}================================================================{RESET}"
    );
    println!("  {DIM}Pulsa Enter en cualquier paso para mantener el valor entre corchetes.{RESET}");
    println!("  {DIM}Siempre podrás anular cualquier preferencia puntualmente con flags en el comando.{RESET}");

    let mut stdin = io::stdin().lock();

    let steps_ok = (|| -> Option<()> {
        wizard_ask_text(
            &mut stdin,
            cfg,
            "1/10",
            "server",
            "Servidor de señalización por defecto",
        )?;
        wizard_ask_text(
            &mut stdin,
            cfg,
            "2/10",
            "out",
            "Carpeta de destino por defecto al recibir (drop recv)",
        )?;
        wizard_ask_bool(
            &mut stdin,
            cfg,
            "3/10",
            "overwrite",
            "¿Sobrescribir archivos existentes en destino (--overwrite)?",
            false,
        )?;
        wizard_ask_bool(
            &mut stdin,
            cfg,
            "4/10",
            "no_resume",
            "¿Desactivar la reanudación de descargas .part (--no-resume)?",
            false,
        )?;
        wizard_ask_bool(
            &mut stdin,
            cfg,
            "5/10",
            "yes",
            "¿Aceptar conexiones sin pedir confirmación (-y / --yes)?",
            false,
        )?;
        wizard_ask_bool(
            &mut stdin,
            cfg,
            "6/10",
            "once",
            "¿Cerrar el canal automáticamente tras la primera descarga (--once)?",
            false,
        )?;
        wizard_ask_text(
            &mut stdin,
            cfg,
            "7/10",
            "expire",
            "Caducidad automática al enviar (--expire, ej. 10m o 2h)",
        )?;
        wizard_ask_bool(
            &mut stdin,
            cfg,
            "8/10",
            "no_qr",
            "¿Ocultar el código QR al enviar (--no-qr)?",
            false,
        )?;
        wizard_ask_text(
            &mut stdin,
            cfg,
            "9/10",
            "limit",
            "Límite de ancho de banda por defecto (--limit, ej. 10M)",
        )?;
        wizard_ask_bool(
            &mut stdin,
            cfg,
            "10/10",
            "relay",
            "¿Forzar siempre transferencia por servidor relay (--relay)?",
            false,
        )?;

        println!();
        let adv = read_prompt_line(
            &mut stdin,
            "  ¿Configurar opciones avanzadas (puerto, speed, serve, auto-update)? (s/N): ",
        )?;
        if is_yes(&adv) {
            wizard_ask_text(
                &mut stdin,
                cfg,
                "adv 1/6",
                "port",
                "Puerto TCP local fijo para send/speed (-p)",
            )?;
            wizard_ask_text(
                &mut stdin,
                cfg,
                "adv 2/6",
                "speed_time",
                "Segundos por fase en drop speed (-t)",
            )?;
            wizard_ask_bool(
                &mut stdin,
                cfg,
                "adv 3/6",
                "direct_only",
                "¿Forzar solo TCP directo en drop speed (--direct-only)?",
                false,
            )?;
            wizard_ask_text(
                &mut stdin,
                cfg,
                "adv 4/6",
                "serve_host",
                "Dirección de escucha por defecto para drop serve (-H)",
            )?;
            wizard_ask_text(
                &mut stdin,
                cfg,
                "adv 5/6",
                "serve_port",
                "Puerto de escucha por defecto para drop serve (-p)",
            )?;
            wizard_ask_bool(
                &mut stdin,
                cfg,
                "adv 6/6",
                "auto_update",
                "¿Comprobar actualizaciones en segundo plano automáticamente?",
                true,
            )?;
        }

        Some(())
    })();

    if steps_ok.is_none() {
        println!("\n  {DIM}Asistente cancelado.{RESET}\n");
        return 0;
    }

    // Resumen de valores personalizados
    println!("\n  {BOLD}Resumen de preferencias personalizadas:{RESET}");
    let mut custom_count = 0usize;
    for spec in CONFIG_KEYS {
        if let Ok(Some(v)) = cfg.get_raw(spec.key) {
            println!("    {CYAN}{:<12}{RESET} = {GREEN}{v}{RESET}", spec.key);
            custom_count += 1;
        }
    }
    if custom_count == 0 {
        println!("    {DIM}(Todas las opciones en su valor por defecto){RESET}");
    }

    let confirm_prompt = format!(
        "\n  ¿Guardar configuración en {}? (S/n): ",
        path.display()
    );
    match read_prompt_line(&mut stdin, &confirm_prompt) {
        Some(ans) if !ans.is_empty() && !is_yes(&ans) => {
            println!("  {DIM}No se han guardado cambios.{RESET}\n");
            0
        }
        None => {
            println!("  {DIM}No se han guardado cambios.{RESET}\n");
            0
        }
        _ => match save_config_to(path, cfg) {
            Ok(()) => {
                println!(
                    "\n  {GREEN}✔ Configuración guardada en {}.",
                    path.display()
                );
                println!(
                    "  {DIM}Puedes revisarla o editarla en cualquier momento con `drop config`.{RESET}\n"
                );
                0
            }
            Err(err) => {
                eprintln!("\n  {RED}✖ {err}{RESET}\n");
                1
            }
        },
    }
}
