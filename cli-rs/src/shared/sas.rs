// Huella corta de sesion (SAS, "short authentication string").

use std::collections::BTreeSet;

use super::wordlist::WORDLIST;

pub const SAS_WORDS: usize = 3;

/// Cadena canonica que se hashea. Las partes se limpian y ordenan lexicograficamente.
pub fn sas_input(context: &str, parts: &[&str]) -> String {
    let mut limpio: Vec<String> = parts
        .iter()
        .map(|p| p.trim().to_lowercase())
        .filter(|p| !p.is_empty())
        .collect();
    limpio.sort();
    format!("drop-sas-v1|{}|{}", context, limpio.join("|"))
}

/// Convierte un digest hexadecimal (>= 32 chars hex) en 3 palabras BIP-39 (11 bits cada una).
pub fn sas_words(digest_hex: &str) -> Result<Vec<&'static str>, String> {
    let hex = digest_hex.trim();
    if hex.len() < 32 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("digest hexadecimal no valido para la huella".to_string());
    }
    let mut words = Vec::with_capacity(SAS_WORDS);
    for i in 0..SAS_WORDS {
        let slice = &hex[i * 4..i * 4 + 4];
        let chunk = u16::from_str_radix(slice, 16)
            .map_err(|_| "digest hexadecimal no valido para la huella".to_string())?;
        words.push(WORDLIST[(chunk & 0x7ff) as usize]);
    }
    Ok(words)
}

/// La huella tal como se ensena: `lemon-radar-tiger`.
pub fn format_sas(words: &[&str]) -> String {
    words.join("-")
}

/// Extrae fingerprints DTLS normalizados a `sha-256 AA:BB:...` de un SDP (sin duplicados).
pub fn dtls_fingerprints(sdp: &str) -> Vec<String> {
    let mut out = BTreeSet::new();
    let mut ordered = Vec::new();
    for line in sdp.lines() {
        let trimmed = line.trim();
        // Caso insensible al prefijo `a=fingerprint:`
        let prefix = "a=fingerprint:";
        if trimmed.len() <= prefix.len()
            || !trimmed[..prefix.len()].eq_ignore_ascii_case(prefix)
        {
            continue;
        }
        let rest = &trimmed[prefix.len()..];
        let mut parts = rest.split_whitespace();
        if let (Some(alg), Some(fp), None) = (parts.next(), parts.next(), parts.next()) {
            let formatted = format!("{} {}", alg.to_lowercase(), fp.to_uppercase());
            if out.insert(formatted.clone()) {
                ordered.push(formatted);
            }
        }
    }
    ordered
}
