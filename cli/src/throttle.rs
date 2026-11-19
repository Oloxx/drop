// Limite de ancho de banda para `--limit 10M` mediante cubo de fichas con deficit.

use std::sync::OnceLock;

use regex::Regex;
use tokio::time::{Duration, Instant, sleep};

/// `--limit 10M` -> bytes por segundo. K/M/G en base 1024, sin sufijo son bytes.
pub fn parse_rate(text: &str) -> Result<u64, String> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r"(?i)^(\d+(?:\.\d+)?)\s*([kmg])?(?:b|ib|b/s)?$").expect("regex rate")
    });
    let trimmed = text.trim();
    let Some(caps) = re.captures(trimmed) else {
        return Err(format!(
            "Límite no válido: \"{text}\". Ejemplos: 500K, 10M, 1.5G (bytes por segundo)."
        ));
    };
    let num: f64 = caps[1]
        .parse()
        .map_err(|_| format!("Límite no válido: \"{text}\". Ejemplos: 500K, 10M, 1.5G (bytes por segundo)."))?;
    let factor: f64 = match caps.get(2).map(|m| m.as_str().to_ascii_lowercase()).as_deref() {
        Some("k") => 1024.0,
        Some("m") => (1024u64.pow(2)) as f64,
        Some("g") => (1024u64.pow(3)) as f64,
        _ => 1.0,
    };
    let rate = (num * factor).round();
    if !rate.is_finite() || rate <= 0.0 {
        return Err(format!("El límite tiene que ser mayor que cero: \"{text}\"."));
    }
    Ok(rate as u64)
}

#[derive(Debug)]
pub struct Throttle {
    pub rate: u64,
    tokens: f64,
    last: Instant,
}

impl Throttle {
    pub fn new(bytes_per_sec: u64) -> Self {
        Self {
            rate: bytes_per_sec,
            tokens: bytes_per_sec as f64,
            last: Instant::now(),
        }
    }

    pub async fn take(&mut self, bytes: usize) {
        if self.rate == 0 {
            return;
        }
        let now = Instant::now();
        let elapsed = now.duration_since(self.last).as_secs_f64();
        let rate_f = self.rate as f64;
        self.tokens = rate_f.min(self.tokens + elapsed * rate_f);
        self.last = now;
        self.tokens -= bytes as f64;
        if self.tokens < 0.0 {
            let wait_secs = (-self.tokens) / rate_f;
            sleep(Duration::from_secs_f64(wait_secs)).await;
        }
    }
}
