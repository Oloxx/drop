// Cifrado de extremo a extremo (scrypt + AES-256-GCM + pruebas HMAC + SAS).

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use aes_gcm::aead::{AeadInPlace, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce, Tag};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use hmac::{Hmac, Mac};
use rand::RngCore;
use scrypt::{Params as ScryptParams, scrypt};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

use crate::shared::codes::split_for_key;
use crate::shared::sas::{format_sas, sas_input, sas_words};

type HmacSha256 = Hmac<Sha256>;

const SCRYPT_LOG_N: u8 = 15; // N = 32768 = 2^15
const SCRYPT_R: u32 = 8;
const SCRYPT_P: u32 = 1;

fn key_cache() -> &'static Mutex<HashMap<String, [u8; 32]>> {
    static CACHE: OnceLock<Mutex<HashMap<String, [u8; 32]>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Deriva la clave AES-256-GCM de la sala a partir del codigo usando scrypt(N=2^15, r=8, p=1).
pub fn derive_key(code: &str) -> [u8; 32] {
    {
        let guard = key_cache().lock().unwrap_or_else(|e| e.into_inner());
        if let Some(&key) = guard.get(code) {
            return key;
        }
    }

    let split = split_for_key(code);
    let mut hasher = Sha256::new();
    hasher.update(format!("drop-code-v2|{}", split.room_id).as_bytes());
    let salt = hasher.finalize();

    let params =
        ScryptParams::new(SCRYPT_LOG_N, SCRYPT_R, SCRYPT_P, 32).expect("parametros scrypt validos");
    let mut key = [0u8; 32];
    scrypt(split.secret.as_bytes(), &salt, &params, &mut key).expect("scrypt derive");

    let mut guard = key_cache().lock().unwrap_or_else(|e| e.into_inner());
    guard.insert(code.to_string(), key);
    key
}

/// Prueba de conocimiento del secreto para receptores web (`sha256("drop-proof-v2|nonce|secret")`).
pub fn secret_proof(nonce: &str, secret: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(format!("drop-proof-v2|{}|{}", nonce, secret).as_bytes());
    hex::encode(hasher.finalize())
}

/// Huella corta de la sesion para TCP directo entre dos CLI.
pub fn sas_from_key(key: &[u8; 32], room_id: &str) -> String {
    let mut mac = <HmacSha256 as Mac>::new_from_slice(key).expect("HMAC key len");
    mac.update(sas_input("tcp", &[room_id]).as_bytes());
    let digest = hex::encode(mac.finalize().into_bytes());
    let words = sas_words(&digest).expect("HMAC SHA-256 tiene 64 chars hex");
    format_sas(&words)
}

/// Cifra un bloque con AES-256-GCM: `[12B IV][16B AuthTag][N bytes cifrados]`.
pub fn encrypt_chunk(chunk: &[u8], key: &[u8; 32]) -> Vec<u8> {
    let mut iv = [0u8; 12];
    rand::rngs::OsRng.fill_bytes(&mut iv);
    let cipher = Aes256Gcm::new(key.into());
    let nonce = Nonce::from_slice(&iv);
    let mut buf = chunk.to_vec();
    let tag = cipher
        .encrypt_in_place_detached(nonce, &[], &mut buf)
        .expect("AES-GCM encrypt");

    let mut out = Vec::with_capacity(12 + 16 + buf.len());
    out.extend_from_slice(&iv);
    out.extend_from_slice(tag.as_slice());
    out.extend_from_slice(&buf);
    out
}

/// Descifra un paquete AES-256-GCM en formato `[12B IV][16B AuthTag][N bytes cifrados]`.
pub fn decrypt_chunk(packet: &[u8], key: &[u8; 32]) -> Result<Vec<u8>, String> {
    if packet.len() < 28 {
        return Err("Paquete demasiado corto para descifrar".to_string());
    }
    let iv = Nonce::from_slice(&packet[..12]);
    let tag = Tag::from_slice(&packet[12..28]);
    let mut buf = packet[28..].to_vec();

    let cipher = Aes256Gcm::new(key.into());
    cipher
        .decrypt_in_place_detached(iv, &[], &mut buf, tag)
        .map_err(|_| "Autenticacion AES-GCM fallida".to_string())?;
    Ok(buf)
}

/// Prueba de conocimiento de clave para relay: `hmac_sha256(key, "drop-proof-v3|" + nonce)`.
pub fn proof_from_key(key: &[u8; 32], nonce: &str) -> String {
    let mut mac = <HmacSha256 as Mac>::new_from_slice(key).expect("HMAC key len");
    mac.update(format!("drop-proof-v3|{}", nonce).as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

/// Compara `candidate` contra `proof_from_key(key, nonce)` en tiempo constante.
pub fn verify_proof(key: &[u8; 32], nonce: &str, candidate: &str) -> bool {
    if candidate.len() != 64 || !candidate.bytes().all(|b| b.is_ascii_hexdigit()) {
        return false;
    }
    let expected_hex = proof_from_key(key, nonce);
    let Ok(expected) = hex::decode(expected_hex) else {
        return false;
    };
    let Ok(actual) = hex::decode(candidate) else {
        return false;
    };
    actual.len() == expected.len() && bool::from(actual.ct_eq(&expected))
}

/// Empaqueta un JSON en `{ "type": "cli-sealed", "box": "<base64>" }`.
pub fn seal_frame(obj: &serde_json::Value, key: &[u8; 32]) -> serde_json::Value {
    let raw = serde_json::to_vec(obj).expect("serialize frame JSON");
    let boxed = encrypt_chunk(&raw, key);
    serde_json::json!({
        "type": "cli-sealed",
        "box": B64.encode(boxed),
    })
}

/// Abre un marco `cli-sealed`.
pub fn unseal_frame(frame_box: &str, key: &[u8; 32]) -> Result<serde_json::Value, String> {
    let raw = B64
        .decode(frame_box)
        .map_err(|e| format!("base64 invalido en cli-sealed: {e}"))?;
    let plain = decrypt_chunk(&raw, key)?;
    serde_json::from_slice(&plain).map_err(|e| format!("JSON invalido en cli-sealed: {e}"))
}
