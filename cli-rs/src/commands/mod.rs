// Subcomandos del CLI (`send`, `recv`, `speed`, y en Fase 4 los de sistema).

pub mod install;
pub mod recv;
pub mod send;
pub mod serve;
pub mod speed;
pub mod uninstall;
pub mod update;
pub mod verify_web;

use std::io::{self, IsTerminal, Write};
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::transfer::{PeerGateFn, PeerInfo};
use crate::ui::{BOLD, CYAN, DIM, GREEN, RED, RESET, YELLOW};

pub fn log_out(use_stderr: bool, msg: &str) {
    if use_stderr {
        let _ = writeln!(io::stderr(), "{msg}");
    } else {
        let _ = writeln!(io::stdout(), "{msg}");
    }
}

pub fn log_inline(use_stderr: bool, msg: &str) {
    if use_stderr {
        let mut err = io::stderr().lock();
        let _ = err.write_all(msg.as_bytes());
        let _ = err.flush();
    } else {
        let mut out = io::stdout().lock();
        let _ = out.write_all(msg.as_bytes());
        let _ = out.flush();
    }
}

/// Pregunta si/no al usuario solo si stdin es una terminal interactiva (o `force_prompt` esta activo).
pub async fn ask_tty_confirm_with_force(
    prompt: &str,
    default_yes: bool,
    use_stderr: bool,
    force_prompt: bool,
) -> bool {
    if !io::stdin().is_terminal() && !force_prompt {
        return default_yes;
    }
    let prompt = prompt.to_string();
    tokio::task::spawn_blocking(move || {
        log_inline(use_stderr, &prompt);
        let mut line = String::new();
        if io::stdin().read_line(&mut line).is_err() {
            return default_yes;
        }
        let ans = line.trim().to_ascii_lowercase();
        if ans.is_empty() {
            return default_yes;
        }
        matches!(ans.as_str(), "s" | "si" | "sí" | "y" | "yes")
    })
    .await
    .unwrap_or(default_yes)
}

/// Pregunta si/no al usuario solo si stdin es una terminal interactiva.
/// Sin TTY (pipes, CI, tests) o con `auto_yes` devuelve `default_yes`.
pub async fn ask_tty_confirm(prompt: &str, default_yes: bool, use_stderr: bool) -> bool {
    ask_tty_confirm_with_force(prompt, default_yes, use_stderr, false).await
}

/// Crea una puerta de confirmacion serializada para el emisor.
/// Si `yes` es true o no hay TTY (salvo `DROP_FORCE_PROMPT=1`), acepta tras mostrar los datos.
pub fn make_peer_gate(yes: bool) -> PeerGateFn {
    let lock = Arc::new(Mutex::new(()));
    let force_prompt = std::env::var("DROP_FORCE_PROMPT").ok().as_deref() == Some("1");
    Arc::new(move |info: PeerInfo| {
        let lock = Arc::clone(&lock);
        Box::pin(async move {
            let _guard = lock.lock().await;
            println!(
                "\n  {BOLD}Conexión entrante:{RESET} {CYAN}{}{RESET} {DIM}({}){RESET}",
                info.who, info.path
            );
            println!(
                "  {BOLD}Huella de la sesión:{RESET} {YELLOW}{BOLD}{}{RESET}",
                info.sas
            );
            if yes || (!io::stdin().is_terminal() && !force_prompt) {
                if !yes {
                    println!(
                        "  {GREEN}✔ Sin terminal interactiva: aceptado automáticamente.{RESET}\n"
                    );
                } else {
                    println!();
                }
                return true;
            }
            let ok = ask_tty_confirm_with_force(
                "  ¿Le dejas descargar? (S/n): ",
                true,
                false,
                force_prompt,
            )
            .await;
            if !ok {
                println!("  {RED}✖ Rechazado.{RESET}\n");
            } else {
                println!("  {GREEN}✔ Autorizado.{RESET}\n");
            }
            ok
        })
    })
}

pub fn print_sas_and_wait_prompt(sas: &str, yes: bool, use_stderr: bool) -> impl std::future::Future<Output = bool> {
    let sas = sas.to_string();
    async move {
        log_out(
            use_stderr,
            &format!(
                "  {BOLD}Huella de la sesión:{RESET} {YELLOW}{BOLD}{sas}{RESET} {DIM}(compruebe que coincide con el emisor){RESET}"
            ),
        );
        if yes || !io::stdin().is_terminal() {
            return true;
        }
        let ok = ask_tty_confirm(
            "  Pulsa ENTER para aceptar (o 'n' para cancelar): ",
            true,
            use_stderr,
        )
        .await;
        if !ok {
            log_out(use_stderr, &format!("  {RED}Cancelado por el usuario.{RESET}\n"));
        }
        ok
    }
}
