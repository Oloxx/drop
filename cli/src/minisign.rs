// Firma Ed25519 en formato Minisign (solo verificacion en el binario CLI).

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};

const ALG_LEGACY: &[u8; 2] = b"Ed";
const ALG_PREHASHED: &[u8; 2] = b"ED";
const KEY_ID_BYTES: usize = 8;
const SIG_BYTES: usize = 64;
const KEY_BYTES: usize = 32;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedPublicKey {
    pub key_id: [u8; KEY_ID_BYTES],
    pub key: [u8; KEY_BYTES],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedSignature {
    pub alg: [u8; 2],
    pub key_id: [u8; KEY_ID_BYTES],
    pub signature: [u8; SIG_BYTES],
    pub trusted_comment: String,
    pub global_signature: [u8; SIG_BYTES],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifyResult {
    pub ok: bool,
    pub reason: Option<String>,
    pub trusted_comment: Option<String>,
}

fn base64_lines(text: &str) -> Vec<&str> {
    text.lines()
        .map(str::trim)
        .filter(|line| {
            !line.is_empty()
                && !line.starts_with("untrusted comment:")
                && !line.starts_with("trusted comment:")
        })
        .collect()
}

pub fn parse_public_key(text: &str) -> Result<ParsedPublicKey, String> {
    let lines = base64_lines(text);
    let Some(line) = lines.first() else {
        return Err("clave publica vacia".to_string());
    };
    let raw = B64
        .decode(line)
        .map_err(|_| "clave publica con base64 invalido".to_string())?;
    if raw.len() != 2 + KEY_ID_BYTES + KEY_BYTES {
        return Err("clave publica con longitud invalida".to_string());
    }
    if &raw[..2] != ALG_LEGACY {
        let alg = String::from_utf8_lossy(&raw[..2]);
        return Err(format!("algoritmo de clave no soportado: {alg}"));
    }
    let mut key_id = [0u8; KEY_ID_BYTES];
    key_id.copy_from_slice(&raw[2..2 + KEY_ID_BYTES]);
    let mut key = [0u8; KEY_BYTES];
    key.copy_from_slice(&raw[2 + KEY_ID_BYTES..]);
    Ok(ParsedPublicKey { key_id, key })
}

pub fn parse_signature(text: &str) -> Result<ParsedSignature, String> {
    let lines = base64_lines(text);
    if lines.len() < 2 {
        return Err("firma incompleta".to_string());
    }
    let head = B64
        .decode(lines[0])
        .map_err(|_| "firma con base64 invalido".to_string())?;
    if head.len() != 2 + KEY_ID_BYTES + SIG_BYTES {
        return Err("firma con longitud invalida".to_string());
    }
    let alg: [u8; 2] = [head[0], head[1]];
    if &alg != ALG_LEGACY && &alg != ALG_PREHASHED {
        let s = String::from_utf8_lossy(&alg);
        return Err(format!("algoritmo de firma no soportado: {s}"));
    }
    let global_sig = B64
        .decode(lines[1])
        .map_err(|_| "firma global con base64 invalido".to_string())?;
    if global_sig.len() != SIG_BYTES {
        return Err("firma global con longitud invalida".to_string());
    }

    let trusted_comment = text
        .lines()
        .find_map(|line| {
            let trimmed = line.trim_end_matches('\r');
            trimmed.strip_prefix("trusted comment: ")
        })
        .ok_or_else(|| "falta el comentario de confianza".to_string())?
        .to_string();

    let mut key_id = [0u8; KEY_ID_BYTES];
    key_id.copy_from_slice(&head[2..2 + KEY_ID_BYTES]);
    let mut signature = [0u8; SIG_BYTES];
    signature.copy_from_slice(&head[2 + KEY_ID_BYTES..]);
    let mut global_signature = [0u8; SIG_BYTES];
    global_signature.copy_from_slice(&global_sig);

    Ok(ParsedSignature {
        alg,
        key_id,
        signature,
        trusted_comment,
        global_signature,
    })
}

pub fn verify_signature(content: &[u8], signature_text: &str, public_key_text: &str) -> VerifyResult {
    let pub_key = match parse_public_key(public_key_text) {
        Ok(p) => p,
        Err(reason) => {
            return VerifyResult {
                ok: false,
                reason: Some(reason),
                trusted_comment: None,
            };
        }
    };
    let sig = match parse_signature(signature_text) {
        Ok(s) => s,
        Err(reason) => {
            return VerifyResult {
                ok: false,
                reason: Some(reason),
                trusted_comment: None,
            };
        }
    };

    if &sig.alg == ALG_PREHASHED {
        return VerifyResult {
            ok: false,
            reason: Some(
                "la firma es de tipo prehashed y este verificador solo admite Ed".to_string(),
            ),
            trusted_comment: None,
        };
    }

    if sig.key_id != pub_key.key_id {
        return VerifyResult {
            ok: false,
            reason: Some(format!(
                "la firma es de otra clave ({}, esperada {})",
                hex::encode(sig.key_id),
                hex::encode(pub_key.key_id)
            )),
            trusted_comment: None,
        };
    }

    let Ok(verifying) = VerifyingKey::from_bytes(&pub_key.key) else {
        return VerifyResult {
            ok: false,
            reason: Some("clave publica Ed25519 invalida".to_string()),
            trusted_comment: None,
        };
    };
    let ed_sig = Signature::from_bytes(&sig.signature);
    if verifying.verify(content, &ed_sig).is_err() {
        return VerifyResult {
            ok: false,
            reason: Some("la firma no corresponde al contenido".to_string()),
            trusted_comment: None,
        };
    }

    let mut global = Vec::with_capacity(SIG_BYTES + sig.trusted_comment.len());
    global.extend_from_slice(&sig.signature);
    global.extend_from_slice(sig.trusted_comment.as_bytes());
    let ed_global = Signature::from_bytes(&sig.global_signature);
    if verifying.verify(&global, &ed_global).is_err() {
        return VerifyResult {
            ok: false,
            reason: Some("el comentario de confianza no cuadra con la firma global".to_string()),
            trusted_comment: None,
        };
    }

    VerifyResult {
        ok: true,
        reason: None,
        trusted_comment: Some(sig.trusted_comment),
    }
}
