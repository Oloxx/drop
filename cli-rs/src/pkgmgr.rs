// Deteccion de gestor de paquetes (Homebrew o Scoop) por la ruta real del binario.

use std::fs;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackageManager {
    pub name: &'static str,
    pub upgrade: &'static str,
    pub uninstall: &'static str,
}

fn contains_digits_segment(p: &str) -> bool {
    if let Some(rest) = p.split("/apps/drop/").nth(1)
        && let Some((seg, _)) = rest.split_once('/')
    {
        return seg == "current" || seg.starts_with(|c: char| c.is_ascii_digit());
    }
    false
}

pub fn package_manager_of(exec_path: &Path) -> Option<PackageManager> {
    let real = fs::canonicalize(exec_path).unwrap_or_else(|_| exec_path.to_path_buf());
    let mut p = real.to_string_lossy().replace('\\', "/").to_ascii_lowercase();
    // Windows canonicalize devuelve prefijo `//?/C:/...`; normalizamos por si acaso.
    if let Some(stripped) = p.strip_prefix("//?/") {
        p = stripped.to_string();
    }

    if p.contains("/cellar/drop/") || p.contains("/homebrew/") || p.contains("/linuxbrew/") {
        return Some(PackageManager {
            name: "Homebrew",
            upgrade: "brew upgrade drop",
            uninstall: "brew uninstall drop",
        });
    }

    if p.contains("/scoop/apps/") || p.contains("/scoop/shims/") || contains_digits_segment(&p) {
        return Some(PackageManager {
            name: "Scoop",
            upgrade: "scoop update drop",
            uninstall: "scoop uninstall drop",
        });
    }

    None
}
