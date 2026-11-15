// Codigos de sala memorizables: `4271-lemon-radar-tiger-orbit`.

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::sync::OnceLock;

use rand::RngCore;
use unicode_normalization::UnicodeNormalization;

use super::wordlist::WORDLIST;

pub const ROOM_ID_DIGITS: usize = 4;
pub const SECRET_WORDS: usize = 4;
pub const SECRET_BITS: usize = SECRET_WORDS * 11; // 44 bits
pub const MIN_PREFIX: usize = 3;

const EXAMPLE: &str = "4271-lemon-radar-tiger-orbit";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lang {
    Es,
    En,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodeError {
    pub key: &'static str,
    pub message: String,
    pub hint: String,
}

impl CodeError {
    pub fn full_message(&self) -> String {
        if self.hint.is_empty() {
            self.message.clone()
        } else {
            format!("{} {}", self.message, self.hint)
        }
    }
}

impl fmt::Display for CodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.full_message())
    }
}

impl std::error::Error for CodeError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedCode {
    pub room_id: String,
    pub words: Vec<String>,
    pub secret: String,
    pub code: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeySplit {
    pub room_id: String,
    pub secret: String,
}

struct WordIndex {
    set: HashSet<&'static str>,
    by_prefix: HashMap<String, Vec<&'static str>>,
}

fn word_index() -> &'static WordIndex {
    static INDEX: OnceLock<WordIndex> = OnceLock::new();
    INDEX.get_or_init(|| {
        let mut set = HashSet::with_capacity(WORDLIST.len());
        let mut by_prefix: HashMap<String, Vec<&'static str>> = HashMap::new();
        for &word in &WORDLIST {
            set.insert(word);
            let len = word.len();
            for n in MIN_PREFIX..=len {
                by_prefix.entry(word[..n].to_string()).or_default().push(word);
            }
        }
        WordIndex { set, by_prefix }
    })
}

fn fail_empty(lang: Lang) -> CodeError {
    match lang {
        Lang::Es => CodeError {
            key: "empty",
            message: "Codigo vacio.".to_string(),
            hint: format!("Formato: {}", EXAMPLE),
        },
        Lang::En => CodeError {
            key: "empty",
            message: "Empty code.".to_string(),
            hint: format!("Format: {}", EXAMPLE),
        },
    }
}

fn fail_bad_room(lang: Lang, room_id: &str) -> CodeError {
    match lang {
        Lang::Es => CodeError {
            key: "badRoom",
            message: format!("\"{}\" no es un identificador de sala valido.", room_id),
            hint: format!("Un codigo empieza por {} digitos: {}", ROOM_ID_DIGITS, EXAMPLE),
        },
        Lang::En => CodeError {
            key: "badRoom",
            message: format!("\"{}\" is not a valid room id.", room_id),
            hint: format!("A code starts with {} digits: {}", ROOM_ID_DIGITS, EXAMPLE),
        },
    }
}

fn fail_word_count(lang: Lang, n: usize) -> CodeError {
    match lang {
        Lang::Es => CodeError {
            key: "wordCount",
            message: format!("Un codigo lleva {} palabras y has escrito {}.", SECRET_WORDS, n),
            hint: format!("Formato: {}", EXAMPLE),
        },
        Lang::En => CodeError {
            key: "wordCount",
            message: format!("A code has {} words and you typed {}.", SECRET_WORDS, n),
            hint: format!("Format: {}", EXAMPLE),
        },
    }
}

fn fail_ambiguous(lang: Lang, token: &str, matches: &[&'static str]) -> CodeError {
    let sample = matches.iter().take(3).copied().collect::<Vec<_>>().join(", ");
    match lang {
        Lang::Es => CodeError {
            key: "ambiguous",
            message: format!("\"{}\" es ambiguo: encaja con {} palabras.", token, matches.len()),
            hint: format!("Escribe al menos 4 letras ({}...).", sample),
        },
        Lang::En => CodeError {
            key: "ambiguous",
            message: format!("\"{}\" is ambiguous: it matches {} words.", token, matches.len()),
            hint: format!("Type at least 4 letters ({}...).", sample),
        },
    }
}

fn fail_unknown(lang: Lang, token: &str, near: &[&'static str]) -> CodeError {
    match lang {
        Lang::Es => CodeError {
            key: "unknown",
            message: format!("\"{}\" no esta en la lista de palabras.", token),
            hint: if near.is_empty() {
                String::new()
            } else {
                format!("¿Querias decir {}?", near.join(" o "))
            },
        },
        Lang::En => CodeError {
            key: "unknown",
            message: format!("\"{}\" is not in the word list.", token),
            hint: if near.is_empty() {
                String::new()
            } else {
                format!("Did you mean {}?", near.join(" or "))
            },
        },
    }
}

/// Genera un identificador publico de sala de `ROOM_ID_DIGITS` digitos mediante
/// muestreo por rechazo sin sesgo.
pub fn random_room_id() -> String {
    let mut rng = rand::rngs::OsRng;
    random_room_id_with(|buf| rng.fill_bytes(buf))
}

pub fn random_room_id_with<F: FnMut(&mut [u8])>(mut fill_bytes: F) -> String {
    let range = 10u32.pow(ROOM_ID_DIGITS as u32);
    let limit = (65536 / range) * range;
    let mut b = [0u8; 2];
    loop {
        fill_bytes(&mut b);
        let value = ((b[0] as u32) << 8) | (b[1] as u32);
        if value < limit {
            return format!("{:0width$}", value % range, width = ROOM_ID_DIGITS);
        }
    }
}

/// Genera `SECRET_WORDS` palabras aleatorias de 11 bits cada una.
pub fn random_secret_words() -> Vec<&'static str> {
    let mut rng = rand::rngs::OsRng;
    random_secret_words_with(|buf| rng.fill_bytes(buf))
}

pub fn random_secret_words_with<F: FnMut(&mut [u8])>(mut fill_bytes: F) -> Vec<&'static str> {
    let mut bytes = [0u8; SECRET_WORDS * 2];
    fill_bytes(&mut bytes);
    let mut words = Vec::with_capacity(SECRET_WORDS);
    for i in 0..SECRET_WORDS {
        let index = (((bytes[i * 2] as usize) << 8) | (bytes[i * 2 + 1] as usize)) & 0x7ff;
        words.push(WORDLIST[index]);
    }
    words
}

pub fn format_code(room_id: &str, words: &[&str]) -> String {
    let mut out = String::with_capacity(room_id.len() + words.len() * 8);
    out.push_str(room_id);
    for w in words {
        out.push('-');
        out.push_str(w);
    }
    out
}

pub fn new_code(room_id: &str) -> String {
    let words = random_secret_words();
    format_code(room_id, &words)
}

/// Deja el codigo en forma canonica: corta tras la ultima `#`, quita tildes NFD,
/// pasa a minusculas y colapsa separadores a `-`.
pub fn normalize_code(input: &str) -> String {
    let mut text = input.trim();
    if let Some(hash) = text.rfind('#') {
        text = &text[hash + 1..];
    }

    let stripped: String = text
        .nfd()
        .filter(|&ch| !matches!(ch as u32, 0x0300..=0x036F))
        .collect::<String>()
        .to_lowercase();

    let mut out = String::with_capacity(stripped.len());
    let mut prev_dash = true; // evita guiones iniciales
    for ch in stripped.chars() {
        let is_sep = ch == '-'
            || ch.is_whitespace()
            || matches!(ch, '_' | '.' | ',' | ';' | ':' | '/' | '\\' | '|' | '+');
        if is_sep {
            if !prev_dash {
                out.push('-');
                prev_dash = true;
            }
        } else {
            out.push(ch);
            prev_dash = false;
        }
    }
    if out.ends_with('-') {
        out.pop();
    }
    out
}

fn is_distance_one(a: &[char], b: &[char]) -> bool {
    let alen = a.len();
    let blen = b.len();
    if alen.abs_diff(blen) > 1 || a == b {
        return false;
    }
    if alen == blen {
        let mut diff = 0;
        for (ca, cb) in a.iter().zip(b.iter()) {
            if ca != cb {
                diff += 1;
                if diff > 1 {
                    return false;
                }
            }
        }
        return diff == 1;
    }
    let (short, long) = if alen < blen { (a, b) } else { (b, a) };
    let (mut i, mut j) = (0, 0);
    let mut skipped = false;
    while i < short.len() && j < long.len() {
        if short[i] == long[j] {
            i += 1;
            j += 1;
        } else {
            if skipped {
                return false;
            }
            skipped = true;
            j += 1;
        }
    }
    true
}

fn suggest_for(token: &str) -> Vec<&'static str> {
    let chars: Vec<char> = token.chars().collect();
    let mut out = Vec::new();
    for &w in &WORDLIST {
        let wc: Vec<char> = w.chars().collect();
        if is_distance_one(&chars, &wc) {
            out.push(w);
            if out.len() >= 3 {
                break;
            }
        }
    }
    out
}

pub fn resolve_word(token: &str, lang: Lang) -> Result<&'static str, CodeError> {
    let idx = word_index();
    if let Some(&exact) = idx.set.get(token) {
        return Ok(exact);
    }
    if token.chars().count() >= MIN_PREFIX
        && let Some(matches) = idx.by_prefix.get(token)
    {
        if matches.len() == 1 {
            return Ok(matches[0]);
        }
        if matches.len() > 1 {
            return Err(fail_ambiguous(lang, token, matches));
        }
    }
    let near = suggest_for(token);
    Err(fail_unknown(lang, token, &near))
}

pub fn is_room_id(value: &str) -> bool {
    value.len() == ROOM_ID_DIGITS && value.bytes().all(|b| b.is_ascii_digit())
}

pub fn parse_code(input: &str, lang: Lang) -> Result<ParsedCode, CodeError> {
    let normalized = normalize_code(input.trim());
    if normalized.is_empty() {
        return Err(fail_empty(lang));
    }

    let parts: Vec<&str> = normalized.split('-').filter(|s| !s.is_empty()).collect();
    let room_id = parts[0];
    if !is_room_id(room_id) {
        return Err(fail_bad_room(lang, room_id));
    }

    let rest = &parts[1..];
    if rest.len() != SECRET_WORDS {
        return Err(fail_word_count(lang, rest.len()));
    }

    let mut words = Vec::with_capacity(SECRET_WORDS);
    for w in rest {
        words.push(resolve_word(w, lang)?);
    }
    let secret = words.join("-");
    let code = format_code(room_id, &words);
    Ok(ParsedCode {
        room_id: room_id.to_string(),
        words: words.into_iter().map(str::to_string).collect(),
        secret,
        code,
    })
}

/// Version tolerante para derivar claves: no valida nada, solo separa por el primer guion.
pub fn split_for_key(input: &str) -> KeySplit {
    let normalized = normalize_code(input.trim());
    match normalized.find('-') {
        None => KeySplit {
            room_id: normalized,
            secret: String::new(),
        },
        Some(cut) => KeySplit {
            room_id: normalized[..cut].to_string(),
            secret: normalized[cut + 1..].to_string(),
        },
    }
}
