// Subcomando `drop verify-web [url]`.

use crate::ui::{BOLD, DIM, GREEN, RED, RESET};
use crate::verifyweb::{verify_web, DEFAULT_REPO, VerifyOptions};

pub async fn run_verify_web(raw_url: &str, version: &str) -> i32 {
    let url = if raw_url.contains("://") {
        raw_url.trim_end_matches('/').to_string()
    } else {
        format!("https://{}", raw_url.trim_end_matches('/'))
    };

    println!("\n  {DIM}Comprobando {url} contra github.com/{DEFAULT_REPO}...{RESET}");
    let ua = format!("drop-cli/{version}");
    let opts = VerifyOptions {
        repo: DEFAULT_REPO,
        github_api: None,
        user_agent: &ua,
    };

    match verify_web(&url, opts).await {
        Ok(report) => {
            let mismatches: Vec<_> = report.files.iter().filter(|f| !f.ok).collect();
            let short = &report.commit[..12.min(report.commit.len())];
            if mismatches.is_empty() {
                println!(
                    "  {GREEN}✔ Todos los archivos ({}) son idénticos a public/ del commit {short}{RESET}\n",
                    report.files.len()
                );
                0
            } else {
                println!(
                    "\n  {RED}{BOLD}✖ La web NO coincide con public/ del commit {short} ({}/{} distinto(s)):{RESET}\n",
                    mismatches.len(),
                    report.files.len()
                );
                for f in mismatches {
                    let detail = match &f.actual {
                        None => format!("HTTP {}", f.status),
                        Some(actual) => {
                            let s_act = &actual[..8.min(actual.len())];
                            let s_exp = &f.expected[..8.min(f.expected.len())];
                            format!("distinto al commit (servidor {s_act}, repo {s_exp})")
                        }
                    };
                    println!("    {RED}✖ {}{RESET}  {DIM}({detail}){RESET}", f.path);
                }
                println!("\n  {DIM}Puede que el servidor esté ejecutando otra versión, un fork o código modificado.{RESET}\n");
                1
            }
        }
        Err(err) => {
            println!("\n  {RED}✖ {}{RESET}", err.message);
            if let Some(detail) = err.detail {
                println!("  {DIM}{detail}{RESET}");
            }
            println!();
            1
        }
    }
}
