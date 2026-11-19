// Desinstalacion de `drop` del directorio de usuario y limpieza del PATH.

use std::env;
use std::fs;
use std::io::{self, IsTerminal, Write};
#[cfg(windows)]
use std::path::PathBuf;

#[cfg(not(windows))]
use crate::commands::install::{home_dir, remove_drop_path_lines};
use crate::commands::install::{bin_name, cleanup_old_binary, install_dir, normalize_cmp_path};
#[cfg(windows)]
use crate::commands::install::remove_dir_from_windows_registry_path;
use crate::ui::{DIM, GREEN, RED, RESET, YELLOW};

pub fn run_uninstall() -> i32 {
    let dir = install_dir();
    let target = dir.join(bin_name());
    cleanup_old_binary(&target);
    crate::commands::update::cleanup_state_files();

    let dir_str = dir.to_string_lossy().to_string();
    let skip_sys_path = env::var_os("DROP_INSTALL_DIR").is_some_and(|v| !v.is_empty());
    let mut removed_path = false;

    if !skip_sys_path {
        #[cfg(windows)]
        {
            match remove_dir_from_windows_registry_path(&dir_str) {
                Ok(changed) => removed_path = changed,
                Err(err) => println!("  {YELLOW}Aviso: {err}{RESET}"),
            }
        }

        #[cfg(not(windows))]
        {
            let home = home_dir();
            for rc in [
                home.join(".profile"),
                home.join(".bashrc"),
                home.join(".zshrc"),
            ] {
                if remove_drop_path_lines(&rc, &dir_str).unwrap_or(false) {
                    removed_path = true;
                }
            }
        }
    }

    println!();
    if removed_path {
        println!("  {GREEN}✔ Eliminado del PATH del usuario.{RESET}");
    }

    if !target.exists() {
        println!(
            "  {YELLOW}drop no estaba instalado en {}.{RESET}\n",
            target.display()
        );
        return 0;
    }

    let running_self = env::current_exe()
        .map(|p| normalize_cmp_path(&p) == normalize_cmp_path(&target))
        .unwrap_or(false);

    #[cfg(windows)]
    {
        if running_self || fs::remove_file(&target).is_err() {
            let old = PathBuf::from(format!("{}.old", target.display()));
            let _ = fs::remove_file(&old);
            if let Err(e) = fs::rename(&target, &old) {
                eprintln!(
                    "  {RED}✖ No se pudo eliminar {}: {e}{RESET}\n",
                    target.display()
                );
                return 1;
            }
            // En Windows un binario en ejecucion se borra despues de salir mediante cmd.
            let old_s = old.to_string_lossy().replace('"', "");
            let dir_s = dir.to_string_lossy().replace('"', "");
            let cmdline = format!(
                "ping -n 2 127.0.0.1 >nul & del /f /q \"{old_s}\" & rmdir \"{dir_s}\" 2>nul"
            );
            let _ = std::process::Command::new("cmd")
                .args(["/C", &cmdline])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn();
        } else {
            let _ = fs::remove_dir(&dir);
        }
    }

    #[cfg(not(windows))]
    {
        let _ = running_self;
        if let Err(e) = fs::remove_file(&target) {
            eprintln!(
                "  {RED}✖ No se pudo eliminar {}: {e}{RESET}\n",
                target.display()
            );
            return 1;
        }
        let _ = fs::remove_dir(&dir);
    }

    println!(
        "  {GREEN}✔ drop desinstalado ({}).{RESET}",
        target.display()
    );

    let cfg_path = crate::config::config_file_path();
    if cfg_path.exists() {
        if io::stdin().is_terminal() && !skip_sys_path {
            print!(
                "  ¿Eliminar también tu archivo de configuración ({})? (s/N): ",
                cfg_path.display()
            );
            let _ = io::stdout().flush();
            let mut line = String::new();
            if io::stdin().read_line(&mut line).is_ok()
                && matches!(
                    line.trim().to_ascii_lowercase().as_str(),
                    "s" | "si" | "sí" | "y" | "yes"
                )
            {
                if crate::config::delete_config_at(&cfg_path).unwrap_or(false) {
                    println!("  {GREEN}✔ Configuración eliminada.{RESET}");
                }
            } else {
                println!(
                    "  {DIM}Configuración conservada en {}. {RESET}",
                    cfg_path.display()
                );
            }
        } else {
            println!(
                "  {DIM}Configuración conservada en {}. {RESET}",
                cfg_path.display()
            );
        }
    }

    println!("  {DIM}Puede que necesites abrir una terminal nueva para refrescar el PATH.{RESET}\n");
    0
}
