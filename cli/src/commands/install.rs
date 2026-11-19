// Instalacion de `drop` en el sistema y registro en el PATH del usuario.

use std::env;
use std::fs;
use std::io::{self, IsTerminal, Write};
use std::path::{Path, PathBuf};

use crate::ui::{BOLD, CYAN, DIM, GREEN, RED, RESET};
#[cfg(windows)]
use crate::ui::YELLOW;

pub fn home_dir() -> PathBuf {
    #[cfg(windows)]
    {
        env::var_os("USERPROFILE")
            .or_else(|| env::var_os("HOME"))
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."))
    }
    #[cfg(not(windows))]
    {
        env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."))
    }
}

pub fn bin_name() -> &'static str {
    if cfg!(windows) {
        "drop.exe"
    } else {
        "drop"
    }
}

pub fn normalize_cmp_path(p: &Path) -> String {
    let real = fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let mut s = real.to_string_lossy().replace('\\', "/");
    if let Some(stripped) = s.strip_prefix("//?/") {
        s = stripped.to_string();
    }
    let s = s.trim_end_matches('/').to_string();
    if cfg!(windows) {
        s.to_ascii_lowercase()
    } else {
        s
    }
}

#[cfg(not(windows))]
fn is_dir_writable(dir: &Path) -> bool {
    if !dir.is_dir() {
        return false;
    }
    let probe = dir.join(format!(".drop-write-probe-{}", std::process::id()));
    match fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&probe)
    {
        Ok(_) => {
            let _ = fs::remove_file(probe);
            true
        }
        Err(_) => false,
    }
}

pub fn install_dir() -> PathBuf {
    if let Ok(custom) = env::var("DROP_INSTALL_DIR")
        && !custom.trim().is_empty()
    {
        return PathBuf::from(custom.trim());
    }
    #[cfg(windows)]
    {
        let local_app_data = env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home_dir().join("AppData").join("Local"));
        local_app_data.join("Programs").join("drop")
    }
    #[cfg(not(windows))]
    {
        let sys_bin = PathBuf::from("/usr/local/bin");
        if is_dir_writable(&sys_bin) {
            sys_bin
        } else {
            home_dir().join(".local").join("bin")
        }
    }
}

pub fn target_bin_path() -> PathBuf {
    install_dir().join(bin_name())
}

pub fn is_installed(exec_path: &Path) -> bool {
    let Some(parent) = exec_path.parent() else {
        return false;
    };
    normalize_cmp_path(parent) == normalize_cmp_path(&install_dir())
}

pub fn cleanup_old_binary(target: &Path) {
    let old = PathBuf::from(format!("{}.old", target.display()));
    if old.exists() {
        let _ = fs::remove_file(old);
    }
}

#[cfg(windows)]
fn to_utf16_z(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
fn broadcast_env_change() {
    #[link(name = "user32")]
    unsafe extern "system" {
        fn SendMessageTimeoutW(
            hwnd: isize,
            msg: u32,
            wparam: usize,
            lparam: *const u16,
            flags: u32,
            timeout: u32,
            result: *mut usize,
        ) -> isize;
    }
    const HWND_BROADCAST: isize = 0xffff;
    const WM_SETTINGCHANGE: u32 = 0x001a;
    const SMTO_ABORTIFHUNG: u32 = 0x0002;
    let wide = to_utf16_z("Environment");
    let mut res: usize = 0;
    // Avisamos a Explorer y nuevas terminales de que HKCU\Environment ha cambiado.
    unsafe {
        SendMessageTimeoutW(
            HWND_BROADCAST,
            WM_SETTINGCHANGE,
            0,
            wide.as_ptr(),
            SMTO_ABORTIFHUNG,
            1000,
            &mut res,
        );
    }
}

#[cfg(windows)]
pub fn add_dir_to_windows_registry_path(dir_str: &str) -> Result<bool, String> {
    use winreg::RegKey;
    use winreg::RegValue;
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE, REG_EXPAND_SZ};

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (env_key, _) = hkcu
        .create_subkey("Environment")
        .map_err(|e| format!("No se pudo abrir HKCU\\Environment: {e}"))?;
    let env_rw = hkcu
        .open_subkey_with_flags("Environment", KEY_READ | KEY_WRITE)
        .unwrap_or(env_key);

    let current: String = env_rw.get_value("Path").unwrap_or_default();
    let target_norm = dir_str.trim().trim_end_matches(['\\', '/']).to_ascii_lowercase();
    let already = current
        .split(';')
        .map(|s| s.trim().trim_end_matches(['\\', '/']).to_ascii_lowercase())
        .any(|s| !s.is_empty() && s == target_norm);

    if already {
        return Ok(false);
    }

    let trimmed = current.trim_end_matches(';');
    let next = if trimmed.is_empty() {
        dir_str.to_string()
    } else {
        format!("{trimmed};{dir_str}")
    };

    let mut bytes = Vec::with_capacity((next.len() + 1) * 2);
    for unit in next.encode_utf16().chain(std::iter::once(0)) {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    let val = RegValue {
        bytes,
        vtype: REG_EXPAND_SZ,
    };
    env_rw
        .set_raw_value("Path", &val)
        .map_err(|e| format!("No se pudo escribir Path en el registro: {e}"))?;
    broadcast_env_change();
    Ok(true)
}

#[cfg(windows)]
pub fn remove_dir_from_windows_registry_path(dir_str: &str) -> Result<bool, String> {
    use winreg::RegKey;
    use winreg::RegValue;
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE, REG_EXPAND_SZ};

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let Ok(env_rw) = hkcu.open_subkey_with_flags("Environment", KEY_READ | KEY_WRITE) else {
        return Ok(false);
    };

    let Ok(current) = env_rw.get_value::<String, _>("Path") else {
        return Ok(false);
    };
    let target_norm = dir_str.trim().trim_end_matches(['\\', '/']).to_ascii_lowercase();
    let parts: Vec<&str> = current
        .split(';')
        .filter(|s| {
            let p = s.trim();
            !p.is_empty() && p.trim_end_matches(['\\', '/']).to_ascii_lowercase() != target_norm
        })
        .collect();

    let next = parts.join(";");
    if next == current.trim_end_matches(';') {
        return Ok(false);
    }

    let mut bytes = Vec::with_capacity((next.len() + 1) * 2);
    for unit in next.encode_utf16().chain(std::iter::once(0)) {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    let val = RegValue {
        bytes,
        vtype: REG_EXPAND_SZ,
    };
    env_rw
        .set_raw_value("Path", &val)
        .map_err(|e| format!("No se pudo actualizar Path en el registro: {e}"))?;
    broadcast_env_change();
    Ok(true)
}

/// Anade la exportacion al PATH en archivos rc POSIX si falta. Funciona en cualquier plataforma para poder testearla.
pub fn ensure_path_in_posix_rc(rc_path: &Path, dir_str: &str) -> io::Result<bool> {
    let existing = if rc_path.exists() {
        fs::read_to_string(rc_path)?
    } else {
        String::new()
    };
    if existing.lines().any(|line| {
        let l = line.trim();
        l.contains(dir_str) && l.contains("PATH") && !l.starts_with('#')
    }) {
        return Ok(false);
    }

    if let Some(parent) = rc_path.parent() {
        fs::create_dir_all(parent)?;
    }
    let sep = if existing.is_empty() || existing.ends_with('\n') {
        ""
    } else {
        "\n"
    };
    let updated = format!("{existing}{sep}export PATH=\"$PATH:{dir_str}\" # drop PATH\n");
    fs::write(rc_path, updated)?;
    Ok(true)
}

pub fn remove_drop_path_lines(rc_path: &Path, dir_str: &str) -> io::Result<bool> {
    if !rc_path.exists() {
        return Ok(false);
    }
    let content = fs::read_to_string(rc_path)?;
    let mut changed = false;
    let mut kept = Vec::new();
    for line in content.lines() {
        if line.contains("# drop PATH") || (line.contains("export PATH") && line.contains(dir_str)) {
            changed = true;
        } else {
            kept.push(line);
        }
    }
    if changed {
        let mut out = kept.join("\n");
        if !out.is_empty() {
            out.push('\n');
        }
        fs::write(rc_path, out)?;
    }
    Ok(changed)
}

#[cfg(not(windows))]
fn posix_rc_files(home: &Path) -> Vec<PathBuf> {
    let mut files = vec![home.join(".profile")];
    let bashrc = home.join(".bashrc");
    if bashrc.exists() {
        files.push(bashrc);
    }
    let zshrc = home.join(".zshrc");
    if zshrc.exists() || cfg!(target_os = "macos") {
        files.push(zshrc);
    }
    files
}

fn copy_binary_into_place(src: &Path, dst: &Path) -> Result<(), String> {
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("No se pudo crear {}: {e}", parent.display()))?;
    }
    cleanup_old_binary(dst);

    let same_file = dst.exists() && normalize_cmp_path(src) == normalize_cmp_path(dst);
    if same_file {
        return Ok(());
    }

    let tmp = dst.with_file_name(format!(".drop-install-{}.tmp", std::process::id()));
    fs::copy(src, &tmp).map_err(|e| format!("No se pudo copiar el ejecutable: {e}"))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o755));
    }

    #[cfg(windows)]
    {
        let old = PathBuf::from(format!("{}.old", dst.display()));
        let had_old = if dst.exists() {
            fs::rename(dst, &old).is_ok()
        } else {
            false
        };
        if let Err(e) = fs::rename(&tmp, dst) {
            if had_old {
                let _ = fs::rename(&old, dst);
            }
            let _ = fs::remove_file(&tmp);
            return Err(format!("No se pudo instalar en {}: {e}", dst.display()));
        }
        if had_old {
            let _ = fs::remove_file(&old);
        }
    }

    #[cfg(not(windows))]
    {
        if let Err(e) = fs::rename(&tmp, dst) {
            let _ = fs::remove_file(&tmp);
            return Err(format!("No se pudo instalar en {}: {e}", dst.display()));
        }
    }

    Ok(())
}

pub fn run_install(interactive_pause: bool) -> i32 {
    let Ok(exec_path) = env::current_exe() else {
        eprintln!("\n  {RED}✖ No se pudo localizar el binario actual.{RESET}\n");
        return 1;
    };
    let dir = install_dir();
    let target = dir.join(bin_name());

    println!();
    if let Err(err) = copy_binary_into_place(&exec_path, &target) {
        eprintln!("  {RED}✖ {err}{RESET}\n");
        if interactive_pause && io::stdin().is_terminal() {
            pause_for_enter();
        }
        return 1;
    }
    println!(
        "  {GREEN}✔ {BOLD}drop{RESET}{GREEN} instalado en {CYAN}{}{RESET}",
        target.display()
    );

    let dir_str = dir.to_string_lossy().to_string();
    let skip_sys_path = env::var_os("DROP_INSTALL_DIR").is_some_and(|v| !v.is_empty());
    let mut path_added = false;

    if !skip_sys_path {
        #[cfg(windows)]
        {
            match add_dir_to_windows_registry_path(&dir_str) {
                Ok(added) => {
                    path_added = added;
                }
                Err(err) => {
                    println!("  {YELLOW}Aviso: {err}{RESET}");
                }
            }
        }

        #[cfg(not(windows))]
        {
            let current_path = env::var("PATH").unwrap_or_default();
            let in_path = current_path.split(':').any(|p| p == dir_str);
            if !in_path {
                for rc in posix_rc_files(&home_dir()) {
                    if ensure_path_in_posix_rc(&rc, &dir_str).unwrap_or(false) {
                        path_added = true;
                    }
                }
            }
        }
    }

    if path_added {
        println!(
            "  {GREEN}✔ Añadido al PATH del usuario ({dir_str}){RESET}"
        );
        println!("  {DIM}Abre una terminal nueva para usar `drop` desde cualquier carpeta.{RESET}");
    } else {
        println!("  {DIM}Ya está disponible en tu PATH.{RESET}");
    }
    println!("  {DIM}Prueba: drop --help  ·  Preferencias por defecto: drop config{RESET}\n");

    let cfg_path = crate::config::config_file_path();
    let offer_wizard = io::stdin().is_terminal() && !skip_sys_path && !cfg_path.exists();
    if offer_wizard {
        print!("  ¿Quieres configurar tus opciones por defecto ahora? (s/N): ");
        let _ = io::stdout().flush();
        let mut line = String::new();
        if io::stdin().read_line(&mut line).is_ok() {
            let ans = line.trim().to_ascii_lowercase();
            if matches!(ans.as_str(), "s" | "si" | "sí" | "y" | "yes") {
                let _ = crate::commands::config::run_wizard();
            }
        }
    }

    if interactive_pause && cfg!(windows) && io::stdin().is_terminal() {
        pause_for_enter();
    }
    0
}

fn pause_for_enter() {
    print!("  Pulsa Enter para salir...");
    let _ = io::stdout().flush();
    let mut line = String::new();
    let _ = io::stdin().read_line(&mut line);
}
