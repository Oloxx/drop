// Utilidades de formato y barra de progreso en terminal.

use std::io::{self, Write};
use std::sync::atomic::{AtomicBool, Ordering};

use crate::shared::protocol::FileEntry;

pub const RESET: &str = "\x1b[0m";
pub const BOLD: &str = "\x1b[1m";
pub const DIM: &str = "\x1b[2m";
pub const GREEN: &str = "\x1b[32m";
pub const CYAN: &str = "\x1b[36m";
pub const YELLOW: &str = "\x1b[33m";
pub const RED: &str = "\x1b[31m";
pub const MAGENTA: &str = "\x1b[35m";

static PROGRESS_TO_STDERR: AtomicBool = AtomicBool::new(false);
static HAS_FILE_LINE: AtomicBool = AtomicBool::new(false);

pub fn set_progress_stderr(use_stderr: bool) {
    PROGRESS_TO_STDERR.store(use_stderr, Ordering::SeqCst);
}

pub fn reset_file_line_state() {
    HAS_FILE_LINE.store(false, Ordering::SeqCst);
}

fn write_progress(text: &str) {
    if PROGRESS_TO_STDERR.load(Ordering::SeqCst) {
        let mut err = io::stderr().lock();
        let _ = err.write_all(text.as_bytes());
        let _ = err.flush();
    } else {
        let mut out = io::stdout().lock();
        let _ = out.write_all(text.as_bytes());
        let _ = out.flush();
    }
}

fn terminal_columns() -> Option<usize> {
    terminal_size::terminal_size().map(|(w, _)| w.0 as usize)
}

fn get_bar_width(preferred: usize) -> usize {
    match terminal_columns() {
        Some(cols) if cols < 105 => cols.saturating_sub(72).clamp(10, preferred),
        _ => preferred,
    }
}

pub fn fmt_bytes(n: u64) -> String {
    if n < 1024 {
        return format!("{n} B");
    }
    const UNITS: [&str; 4] = ["KB", "MB", "GB", "TB"];
    let mut val = n as f64;
    let mut i = -1isize;
    loop {
        val /= 1024.0;
        i += 1;
        if val < 1024.0 || (i as usize) >= UNITS.len() - 1 {
            break;
        }
    }
    if val < 10.0 {
        format!("{:.1} {}", val, UNITS[i as usize])
    } else {
        format!("{} {}", val.round() as u64, UNITS[i as usize])
    }
}

pub fn fmt_speed(bytes_per_sec: f64) -> String {
    if bytes_per_sec < 1024.0 * 1024.0 {
        let kbps = bytes_per_sec / 1024.0;
        let kbit = (bytes_per_sec * 8.0) / 1024.0;
        format!(
            "{GREEN}{:.1} KB/s{RESET} {DIM}({:.0} Kbit/s){RESET}",
            kbps, kbit
        )
    } else {
        let mbps = bytes_per_sec / (1024.0 * 1024.0);
        let mbit = (bytes_per_sec * 8.0) / (1024.0 * 1024.0);
        format!(
            "{GREEN}{:.1} MB/s{RESET} {DIM}({:.0} Mbit/s){RESET}",
            mbps, mbit
        )
    }
}

pub fn fmt_eta(seconds: f64) -> String {
    if !seconds.is_finite() || seconds < 0.0 {
        return String::new();
    }
    if seconds < 60.0 {
        return format!("{}s", seconds.ceil() as u64);
    }
    let m = (seconds / 60.0).floor() as u64;
    let s = (seconds % 60.0).round() as u64;
    format!("{m}m {s}s")
}

pub fn fmt_duration(seconds: f64) -> String {
    if !seconds.is_finite() || seconds < 0.0 {
        return "0s".to_string();
    }
    if seconds < 0.1 {
        return "< 0.1s".to_string();
    }
    if seconds < 1.0 {
        return format!("{:.1}s", seconds);
    }
    if seconds < 60.0 {
        return format!("{}s", seconds.round() as u64);
    }
    let m = (seconds / 60.0).floor() as u64;
    let s = (seconds % 60.0).round() as u64;
    if m < 60 {
        return format!("{m}m {s}s");
    }
    let h = m / 60;
    format!("{h}h {}m {s}s", m % 60)
}

pub fn fmt_ms(ms: Option<f64>) -> String {
    match ms {
        Some(v) if v.is_finite() => {
            if v < 10.0 {
                format!("{:.1} ms", v)
            } else {
                format!("{} ms", v.round() as u64)
            }
        }
        _ => "—".to_string(),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileProgress<'a> {
    pub index: usize,
    pub count: usize,
    pub name: &'a str,
    pub size: u64,
    pub done: u64,
}

pub fn file_at<'a>(files: &'a [FileEntry], done: u64) -> Option<FileProgress<'a>> {
    if files.is_empty() {
        return None;
    }
    let mut offset = 0u64;
    let count = files.len();
    for (i, f) in files.iter().enumerate() {
        let size = f.size.unwrap_or(0);
        if done < offset.saturating_add(size) || i == count - 1 {
            let file_done = done.saturating_sub(offset).min(size);
            return Some(FileProgress {
                index: i,
                count,
                name: &f.name,
                size,
                done: file_done,
            });
        }
        offset = offset.saturating_add(size);
    }
    None
}

fn file_line_for(files: &[FileEntry], current: u64) -> String {
    let Some(f) = file_at(files, current) else {
        return String::new();
    };
    let cols = terminal_columns().unwrap_or(120);
    let head = format!("[{}/{}] ", f.index + 1, f.count);
    let pct = (f.done * 100).checked_div(f.size).unwrap_or(100).min(100);
    let tail = format!(
        " {}% · {} / {}",
        pct,
        fmt_bytes(f.done),
        fmt_bytes(f.size)
    );
    let room = cols.saturating_sub(head.len() + tail.len() + 6).max(8);
    let name = if f.name.chars().count() > room {
        let truncated: String = f.name.chars().take(room - 1).collect();
        format!("{truncated}…")
    } else {
        f.name.to_string()
    };
    format!("{DIM}{head}{RESET}{name}{DIM}{tail}{RESET}")
}

pub fn format_progress_bar(
    current: u64,
    total: Option<u64>,
    speed: f64,
    width: usize,
    files: Option<&[FileEntry]>,
) -> String {
    let bar_width = get_bar_width(width);
    let Some(total) = total else {
        HAS_FILE_LINE.store(false, Ordering::SeqCst);
        let dots = "·".repeat(bar_width);
        return format!(
            "\r  {CYAN}{dots}{RESET} {} · {} {DIM}(sin total: stdin){RESET}   \x1b[K",
            fmt_bytes(current),
            fmt_speed(speed)
        );
    };

    let pct = if total > 0 {
        ((current as f64) / (total as f64)).min(1.0)
    } else {
        0.0
    };
    let filled = ((bar_width as f64) * pct).round() as usize;
    let empty = bar_width.saturating_sub(filled);
    let bar = format!(
        "{CYAN}{}{DIM}{}{RESET}",
        "█".repeat(filled),
        "░".repeat(empty)
    );
    let pct_str = format!("{:>4}", format!("{:.0}%", pct * 100.0));
    let eta = if current < total && speed > 0.0 {
        fmt_eta(((total - current) as f64) / speed)
    } else {
        String::new()
    };
    let eta_str = if eta.is_empty() {
        String::new()
    } else {
        format!("· ETA {eta}")
    };
    let bar_line = format!(
        "  {bar} {pct_str} · {} / {} · {} {eta_str}   \x1b[K",
        fmt_bytes(current),
        fmt_bytes(total),
        fmt_speed(speed)
    );

    if let Some(list) = files
        && list.len() > 1
    {
        HAS_FILE_LINE.store(true, Ordering::SeqCst);
        return format!(
            "\r\x1b[K  {}\n\r{}\x1b[1A",
            file_line_for(list, current),
            bar_line
        );
    }
    HAS_FILE_LINE.store(false, Ordering::SeqCst);
    format!("\r{bar_line}")
}

pub fn render_progress_bar(
    current: u64,
    total: Option<u64>,
    speed: f64,
    width: usize,
    files: Option<&[FileEntry]>,
) {
    write_progress(&format_progress_bar(current, total, speed, width, files));
}

pub fn render_progress_bar_complete(
    total: u64,
    total_time_sec: f64,
    avg_speed: f64,
    width: usize,
) {
    let bar_width = get_bar_width(width);
    let bar = format!("{CYAN}{}{RESET}", "█".repeat(bar_width));
    let duration_str = fmt_duration(total_time_sec);
    let speed_str = fmt_speed(avg_speed);

    let mut out = String::new();
    if HAS_FILE_LINE.swap(false, Ordering::SeqCst) {
        out.push_str(&format!("\r\x1b[K  {DIM}[✔] todos los archivos{RESET}\n"));
    }
    out.push_str(&format!(
        "\r  {bar} 100% · {} / {} · {duration_str} · Media: {speed_str}   \x1b[K\n",
        fmt_bytes(total),
        fmt_bytes(total)
    ));
    write_progress(&out);
}
