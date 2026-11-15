// `drop recv --only <patrones>`: seleccionar archivos del manifiesto.

use regex::{Regex, RegexBuilder};

use crate::shared::protocol::FileEntry;

fn escape_regex_char(ch: char, out: &mut String) {
    if matches!(
        ch,
        '\\' | '^' | '$' | '.' | '*' | '+' | '?' | '(' | ')' | '[' | ']' | '{' | '}' | '|'
    ) {
        out.push('\\');
    }
    out.push(ch);
}

/// Traduce un patron glob a expresion regular anclada (sin distinguir mayusculas).
pub fn glob_to_regex(pattern: &str) -> Result<Regex, regex::Error> {
    let chars: Vec<char> = pattern.chars().collect();
    let mut re = String::from("^");
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        if ch == '*' {
            if chars.get(i + 1) == Some(&'*') {
                if chars.get(i + 2) == Some(&'/') {
                    re.push_str("(?:.*/)?");
                    i += 3;
                } else {
                    re.push_str(".*");
                    i += 2;
                }
            } else {
                re.push_str("[^/]*");
                i += 1;
            }
        } else if ch == '?' {
            re.push_str("[^/]");
            i += 1;
        } else {
            escape_regex_char(ch, &mut re);
            i += 1;
        }
    }
    re.push('$');
    RegexBuilder::new(&re).case_insensitive(true).build()
}

/// `"*.jpg, docs/**"` -> `["*.jpg", "docs/**"]`. Vacios fuera; `./x` -> `/x`.
pub fn parse_patterns(text: &str) -> Vec<String> {
    text.split(',')
        .map(|part| {
            let p = part.trim().replace('\\', "/");
            if let Some(rest) = p.strip_prefix("./") {
                format!("/{rest}")
            } else {
                p
            }
        })
        .filter(|p| !p.is_empty() && p != "/")
        .collect()
}

/// Indices del manifiesto que casan con algun patron, en orden.
/// Devuelve `None` si `patterns` esta vacio ("todos").
pub fn select_files(entries: &[FileEntry], patterns: &[String]) -> Option<Vec<usize>> {
    if patterns.is_empty() {
        return None;
    }

    enum Matcher {
        Full(Regex),
        Base(Regex),
    }

    let matchers: Vec<Matcher> = patterns
        .iter()
        .filter_map(|p| {
            if let Some(stripped) = p.strip_prefix('/') {
                glob_to_regex(stripped).ok().map(Matcher::Full)
            } else if p.contains('/') {
                glob_to_regex(&format!("**/{p}")).ok().map(Matcher::Full)
            } else {
                glob_to_regex(p).ok().map(Matcher::Base)
            }
        })
        .collect();

    let mut picked = Vec::new();
    for (idx, entry) in entries.iter().enumerate() {
        let full = entry.path.as_deref().unwrap_or(&entry.name);
        let base = full.rsplit('/').next().unwrap_or(full);
        let matched = matchers.iter().any(|m| match m {
            Matcher::Full(re) => re.is_match(full),
            Matcher::Base(re) => re.is_match(base),
        });
        if matched {
            picked.push(idx);
        }
    }
    Some(picked)
}
