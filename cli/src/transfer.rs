// Protocolo de transferencia TCP P2P y Relay WS (Protocol 5):
// enmarcado AES-256-GCM, verificacion SHA-256, proteccion de rutas y reanudacion `.part`.

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::future::Future;
use std::io::SeekFrom;
use std::path::{Component, Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, Instant};

use aes_gcm::Aes256Gcm;
use aes_gcm::KeyInit;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::fs::{self, File, OpenOptions};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio::time::{sleep, timeout};

use crate::crypto::{decrypt_chunk, derive_key, encrypt_chunk, seal_frame, unseal_frame};
use crate::discovery::{is_local_address, plain_address};
use crate::select::select_files;
use crate::shared::protocol::{FileEntry, PROTOCOL_VERSION, picked_files};
use crate::signaling::{SignalingSender, WsEvent};
use crate::throttle::Throttle;

pub const CHUNK_SIZE: usize = 512 * 1024;
pub const RELAY_ACK_EVERY: u64 = 2 * 1024 * 1024;
pub const RELAY_IDLE_TIMEOUT_MS: u64 = 60_000;
pub const PEER_SETTLE_MS: u64 = 400;
const MAX_FRAME_LEN: usize = 64 * 1024 * 1024;
const FRAME_CONTROL: u8 = 0x00;
const FRAME_DATA: u8 = 0x01;

#[derive(Debug, Clone)]
pub struct TransferError {
    pub code: &'static str,
    pub message: String,
    pub resumable: bool,
    pub part_bytes: u64,
    pub available: Vec<String>,
}

impl TransferError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            resumable: false,
            part_bytes: 0,
            available: Vec::new(),
        }
    }

    pub fn with_resumable(mut self, part_bytes: u64) -> Self {
        if part_bytes > 0 {
            self.resumable = true;
            self.part_bytes = part_bytes;
        }
        self
    }

    pub fn with_available(mut self, available: Vec<String>) -> Self {
        self.available = available;
        self
    }
}

impl fmt::Display for TransferError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for TransferError {}

#[derive(Debug, Clone)]
pub struct SendItem {
    pub entry: FileEntry,
    pub fs_path: Option<PathBuf>,
    pub inline_data: Option<Arc<[u8]>>,
    pub is_stdin: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReservedPath {
    pub final_path: PathBuf,
    pub part_path: PathBuf,
    pub resume_from: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ResumeEntry {
    pub index: usize,
    pub offset: u64,
    pub sha256: String,
}

#[derive(Debug, Clone)]
pub struct VerifiedPrefix {
    pub offset: u64,
    pub sha256: String,
    pub hasher: Sha256,
}

#[derive(Debug, Clone)]
pub struct ReceivedFile {
    pub name: String,
    pub size: u64,
    pub path: PathBuf,
    pub rel: Option<String>,
    pub sha256: String,
}

#[derive(Debug, Clone)]
pub struct TransferStats {
    pub files: Vec<ReceivedFile>,
    pub total_bytes: u64,
    pub resumed_bytes: u64,
    pub total_time_sec: f64,
    pub avg_speed: f64,
    pub canceled: bool,
    pub interrupted: bool,
}

#[derive(Debug, Clone)]
pub struct PeerInfo {
    pub who: String,
    pub address: String,
    pub sas: String,
    pub path: String,
}

pub type PeerGateFn =
    Arc<dyn Fn(PeerInfo) -> Pin<Box<dyn Future<Output = bool> + Send>> + Send + Sync>;
pub type SasGateFn =
    Box<dyn FnOnce(&[FileEntry], &str) -> Pin<Box<dyn Future<Output = bool> + Send>> + Send>;
pub type ProgressFn = Box<dyn FnMut(u64, Option<u64>, f64, &[FileEntry]) + Send>;
pub type ResumeNoticeFn = Box<dyn FnMut(&str, u64) + Send>;

#[derive(Clone)]
pub struct ReceiveOptions {
    pub overwrite: bool,
    pub resume: bool,
    pub only: Vec<String>,
    pub limit: u64,
}

impl Default for ReceiveOptions {
    fn default() -> Self {
        Self {
            overwrite: false,
            resume: true,
            only: Vec::new(),
            limit: 0,
        }
    }
}

/// Suma total de tamanos del manifiesto si todos los archivos tienen tamano conocido.
pub fn total_of(files: &[FileEntry]) -> Option<u64> {
    let mut sum = 0u64;
    for f in files {
        sum = sum.checked_add(f.size?)?;
    }
    Some(sum)
}

fn is_drive_segment(seg: &str) -> bool {
    let b = seg.as_bytes();
    b.len() == 2 && b[0].is_ascii_alphabetic() && b[1] == b':'
}

fn lexically_clean(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::Prefix(p) => out.push(p.as_os_str()),
            Component::RootDir => out.push(comp.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    out.push("..");
                }
            }
            Component::Normal(s) => out.push(s),
        }
    }
    out
}

/// Resuelve la ruta de destino garantizando que queda estrictamente dentro de `output_dir`.
/// Rechaza path traversal, segmentos vacios, bytes NUL, o prefijos de unidad (`C:`).
pub fn safe_output_path(
    output_dir: &Path,
    raw_name: &str,
    raw_path: Option<&str>,
) -> Result<PathBuf, TransferError> {
    let root = lexically_clean(output_dir);
    let unsafe_err = || {
        TransferError::new(
            "UNSAFE_NAME",
            format!("Nombre de archivo o ruta insegura rechazada: {raw_name:?}"),
        )
    };

    if raw_name.contains('\0') {
        return Err(unsafe_err());
    }

    let dest = if let Some(rp) = raw_path {
        if rp.is_empty() || rp.contains('\0') {
            return Err(unsafe_err());
        }
        let norm = rp.replace('\\', "/");
        if norm.starts_with('/') || norm.ends_with('/') {
            return Err(unsafe_err());
        }
        let mut p = root.clone();
        for seg in norm.split('/') {
            if seg.is_empty()
                || seg == "."
                || seg == ".."
                || seg.trim().is_empty()
                || is_drive_segment(seg)
            {
                return Err(unsafe_err());
            }
            p.push(seg);
        }
        p
    } else {
        let norm = raw_name.replace('\\', "/");
        if norm.ends_with('/') {
            return Err(unsafe_err());
        }
        let base = norm.rsplit('/').next().unwrap_or("");
        if base.is_empty()
            || base.trim().is_empty()
            || base == "."
            || base == ".."
            || is_drive_segment(base)
        {
            return Err(unsafe_err());
        }
        root.join(base)
    };

    let clean_dest = lexically_clean(&dest);
    if !clean_dest.starts_with(&root) || clean_dest == root {
        return Err(unsafe_err());
    }
    Ok(clean_dest)
}

pub fn same_file_key(path: &Path) -> String {
    let cleaned = lexically_clean(path);
    let s = cleaned.to_string_lossy().to_string();
    if cfg!(any(target_os = "windows", target_os = "macos")) {
        s.to_lowercase()
    } else {
        s
    }
}

pub fn part_path_for(dest: &Path) -> PathBuf {
    let mut os = dest.as_os_str().to_os_string();
    os.push(".part");
    PathBuf::from(os)
}

fn split_name_ext(file_name: &str) -> (&str, &str) {
    match file_name.rfind('.') {
        Some(idx) if idx > 0 => (&file_name[..idx], &file_name[idx..]),
        _ => (file_name, ""),
    }
}

fn numbered_candidate(base: &Path, attempt: u32) -> PathBuf {
    if attempt <= 1 {
        return base.to_path_buf();
    }
    let name = base
        .file_name()
        .map(|n| n.to_string_lossy())
        .unwrap_or_default();
    let (stem, ext) = split_name_ext(&name);
    let next_name = format!("{stem} ({attempt}){ext}");
    match base.parent() {
        Some(parent) => parent.join(next_name),
        None => PathBuf::from(next_name),
    }
}

/// Reserva un nombre libre en `output_dir`, detectando si existe un `.part` reanudable.
pub fn reserve_output_path(
    output_dir: &Path,
    raw_name: &str,
    reserved: &mut HashSet<String>,
    overwrite: bool,
    resume: bool,
    size: Option<u64>,
    subpath: Option<&str>,
) -> Result<ReservedPath, TransferError> {
    let base = safe_output_path(output_dir, raw_name, subpath)?;

    for attempt in 1..=9999 {
        let cand = numbered_candidate(&base, attempt);
        let key = same_file_key(&cand);
        if reserved.contains(&key) {
            continue;
        }

        let part = part_path_for(&cand);

        if !overwrite {
            match std::fs::symlink_metadata(&cand) {
                Ok(_) => continue,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => {
                    return Err(TransferError::new(
                        "IO",
                        format!("No se pudo inspeccionar {}: {e}", cand.display()),
                    ));
                }
            }
        }

        let resume_from = match std::fs::symlink_metadata(&part) {
            Ok(meta) => {
                if !meta.is_file() {
                    continue;
                }
                let len = meta.len();
                let fits = size.is_none_or(|sz| len <= sz);
                if resume && fits {
                    if len > 0 { Some(len) } else { None }
                } else if overwrite {
                    None
                } else {
                    continue;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => {
                return Err(TransferError::new(
                    "IO",
                    format!("No se pudo inspeccionar {}: {e}", part.display()),
                ));
            }
        };

        reserved.insert(key);
        return Ok(ReservedPath {
            final_path: cand,
            part_path: part,
            resume_from,
        });
    }

    Err(TransferError::new(
        "DEST_COLLISION",
        format!(
            "Demasiados archivos con el mismo nombre para {}",
            base.file_name().unwrap_or_default().to_string_lossy()
        ),
    ))
}

/// Calcula el SHA-256 en hex minusculas de los primeros `limit` bytes de `path`.
/// Devuelve `None` si el archivo tiene menos de `limit` bytes.
pub async fn hash_partial(path: &Path, limit: u64) -> std::io::Result<Option<String>> {
    let mut f = File::open(path).await?;
    let mut hasher = Sha256::new();
    let mut remaining = limit;
    let mut buf = vec![0u8; 256 * 1024];

    while remaining > 0 {
        let max_read = remaining.min(buf.len() as u64) as usize;
        let n = f.read(&mut buf[..max_read]).await?;
        if n == 0 {
            return Ok(None);
        }
        hasher.update(&buf[..n]);
        remaining -= n as u64;
    }

    Ok(Some(hex::encode(hasher.finalize())))
}

fn parse_prefix_request(
    max_size: Option<u64>,
    req: Option<&Value>,
) -> Option<(u64, &str)> {
    let obj = req.and_then(|v| v.as_object())?;
    let offset = obj.get("offset").and_then(|v| v.as_u64())?;
    if offset == 0 {
        return None;
    }
    if let Some(sz) = max_size
        && offset > sz
    {
        return None;
    }
    let expected = obj.get("sha256").and_then(|v| v.as_str())?;
    Some((offset, expected))
}

/// Valida `{ offset, sha256 }` contra un buffer inline en memoria.
pub fn verify_inline_prefix(bytes: &[u8], req: Option<&Value>) -> Option<VerifiedPrefix> {
    let (offset, expected) = parse_prefix_request(Some(bytes.len() as u64), req)?;
    let end = usize::try_from(offset).ok()?;
    let slice = bytes.get(..end)?;
    let mut hasher = Sha256::new();
    hasher.update(slice);
    let actual = hex::encode(hasher.clone().finalize());
    if actual == expected {
        Some(VerifiedPrefix {
            offset,
            sha256: actual,
            hasher,
        })
    } else {
        None
    }
}

/// Valida `{ offset, sha256 }` de una peticion de reanudacion contra el archivo fuente.
/// Si coincide, devuelve `VerifiedPrefix` con el hasher listo para seguir hasheando el resto.
pub async fn verify_prefix(
    path: &Path,
    max_size: Option<u64>,
    req: Option<&Value>,
) -> std::io::Result<Option<VerifiedPrefix>> {
    let Some((offset, expected)) = parse_prefix_request(max_size, req) else {
        return Ok(None);
    };

    let mut f = File::open(path).await?;
    let mut hasher = Sha256::new();
    let mut remaining = offset;
    let mut buf = vec![0u8; 256 * 1024];

    while remaining > 0 {
        let max_read = remaining.min(buf.len() as u64) as usize;
        let n = f.read(&mut buf[..max_read]).await?;
        if n == 0 {
            return Ok(None);
        }
        hasher.update(&buf[..n]);
        remaining -= n as u64;
    }

    let actual = hex::encode(hasher.clone().finalize());
    if actual == expected {
        Ok(Some(VerifiedPrefix {
            offset,
            sha256: actual,
            hasher,
        }))
    } else {
        Ok(None)
    }
}

/// Verifica el prefijo de reanudacion de un `SendItem` (en memoria o en disco).
pub async fn verify_item_prefix(
    item: &SendItem,
    req: Option<&Value>,
) -> std::io::Result<Option<VerifiedPrefix>> {
    if item.is_stdin {
        return Ok(None);
    }
    if let Some(inline) = &item.inline_data {
        return Ok(verify_inline_prefix(inline, req));
    }
    if let Some(fs_path) = &item.fs_path {
        return verify_prefix(fs_path, item.entry.size, req).await;
    }
    Ok(None)
}

pub struct FileSink {
    pub part_path: PathBuf,
    pub final_path: PathBuf,
    overwrite: bool,
    file: Option<File>,
    hasher: Sha256,
    pub bytes_written: u64,
}

/// Abre o reanuda un archivo temporal `.part` y mantiene el SHA-256 acumulado.
pub async fn open_file_sink(
    reserved: &ReservedPath,
    overwrite: bool,
    resume_from: Option<u64>,
) -> Result<FileSink, TransferError> {
    if let Some(parent) = reserved.part_path.parent() {
        fs::create_dir_all(parent).await.map_err(|e| {
            TransferError::new("IO", format!("No se pudo crear carpeta destino: {e}"))
        })?;
    }

    let mut hasher = Sha256::new();
    let mut bytes_written = 0u64;

    let file = if let Some(offset) = resume_from.filter(|&o| o > 0) {
        let mut f = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&reserved.part_path)
            .await
            .map_err(|e| TransferError::new("IO", format!("No se pudo reabrir .part: {e}")))?;

        let mut remaining = offset;
        let mut buf = vec![0u8; 256 * 1024];
        while remaining > 0 {
            let max_read = remaining.min(buf.len() as u64) as usize;
            let n = f
                .read(&mut buf[..max_read])
                .await
                .map_err(|e| TransferError::new("IO", format!("Error leyendo .part: {e}")))?;
            if n == 0 {
                return Err(TransferError::new(
                    "IO",
                    "El archivo .part es más corto que el offset acordado",
                ));
            }
            hasher.update(&buf[..n]);
            remaining -= n as u64;
        }

        f.set_len(offset)
            .await
            .map_err(|e| TransferError::new("IO", format!("No se pudo truncar .part: {e}")))?;
        f.seek(SeekFrom::Start(offset))
            .await
            .map_err(|e| TransferError::new("IO", format!("Error posicionando .part: {e}")))?;
        bytes_written = offset;
        f
    } else {
        OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&reserved.part_path)
            .await
            .map_err(|e| TransferError::new("IO", format!("No se pudo crear .part: {e}")))?
    };

    Ok(FileSink {
        part_path: reserved.part_path.clone(),
        final_path: reserved.final_path.clone(),
        overwrite,
        file: Some(file),
        hasher,
        bytes_written,
    })
}

impl FileSink {
    pub async fn write_chunk(&mut self, data: &[u8]) -> Result<(), TransferError> {
        let f = self
            .file
            .as_mut()
            .ok_or_else(|| TransferError::new("IO", "Archivo ya cerrado"))?;
        f.write_all(data)
            .await
            .map_err(|e| TransferError::new("IO", format!("Error escribiendo en disco: {e}")))?;
        self.hasher.update(data);
        self.bytes_written += data.len() as u64;
        Ok(())
    }

    pub async fn commit(mut self, expected_sha256: &str) -> Result<String, TransferError> {
        if let Some(mut f) = self.file.take() {
            f.flush().await.map_err(|e| {
                TransferError::new("IO", format!("Error volcando archivo al disco: {e}"))
            })?;
            drop(f);
        }

        let actual = hex::encode(self.hasher.finalize());
        if !expected_sha256.is_empty() && actual != expected_sha256 {
            let _ = fs::remove_file(&self.part_path).await;
            return Err(TransferError::new(
                "INTEGRITY_MISMATCH",
                "El código o los datos fueron alterados: la comprobación SHA-256 falló.",
            ));
        }

        if let Err(first_err) = fs::rename(&self.part_path, &self.final_path).await {
            if self.overwrite {
                let _ = fs::remove_file(&self.final_path).await;
                fs::rename(&self.part_path, &self.final_path)
                    .await
                    .map_err(|e| {
                        TransferError::new(
                            "IO",
                            format!("No se pudo renombrar {}: {e}", self.final_path.display()),
                        )
                    })?;
            } else {
                let _ = fs::remove_file(&self.part_path).await;
                return Err(TransferError::new(
                    "IO",
                    format!(
                        "No se pudo instalar {}: {first_err}",
                        self.final_path.display()
                    ),
                ));
            }
        }

        Ok(actual)
    }

    pub async fn abort(mut self) {
        if let Some(f) = self.file.take() {
            drop(f);
        }
        let _ = fs::remove_file(&self.part_path).await;
    }

    /// Libera el descriptor conservando el `.part` si ya tiene bytes para reanudar luego.
    pub async fn detach(mut self) -> u64 {
        if let Some(mut f) = self.file.take() {
            let _ = f.flush().await;
            drop(f);
        }
        if self.bytes_written == 0 {
            let _ = fs::remove_file(&self.part_path).await;
            0
        } else {
            self.bytes_written
        }
    }
}

pub enum DecodedFrame {
    Control(Value),
    Data(Vec<u8>),
}

pub async fn write_control_frame(
    stream: &mut TcpStream,
    cipher: &Aes256Gcm,
    msg: &Value,
) -> std::io::Result<()> {
    let raw = serde_json::to_vec(msg).map_err(std::io::Error::other)?;
    let mut plain = Vec::with_capacity(1 + raw.len());
    plain.push(FRAME_CONTROL);
    plain.extend_from_slice(&raw);
    write_encrypted_payload(stream, cipher, &plain).await
}

pub async fn write_data_frame(
    stream: &mut TcpStream,
    cipher: &Aes256Gcm,
    data: &[u8],
) -> std::io::Result<()> {
    let mut plain = Vec::with_capacity(1 + data.len());
    plain.push(FRAME_DATA);
    plain.extend_from_slice(data);
    write_encrypted_payload(stream, cipher, &plain).await
}

async fn write_encrypted_payload(
    stream: &mut TcpStream,
    cipher: &Aes256Gcm,
    plain: &[u8],
) -> std::io::Result<()> {
    let boxed = encrypt_with_cipher(plain, cipher);
    let len = u32::try_from(boxed.len()).map_err(|_| std::io::Error::other("frame overflow"))?;
    let mut framed = Vec::with_capacity(4 + boxed.len());
    framed.extend_from_slice(&len.to_be_bytes());
    framed.extend_from_slice(&boxed);
    stream.write_all(&framed).await
}

fn encrypt_with_cipher(plain: &[u8], cipher: &Aes256Gcm) -> Vec<u8> {
    use aes_gcm::Nonce;
    use aes_gcm::aead::Aead;
    use rand::RngCore;

    let mut iv = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut iv);
    let nonce = Nonce::from_slice(&iv);
    let mut ct_and_tag = cipher
        .encrypt(nonce, plain)
        .expect("AES-256-GCM encryption cannot fail");

    let tag_start = ct_and_tag.len() - 16;
    let tag = ct_and_tag[tag_start..].to_vec();
    ct_and_tag.truncate(tag_start);

    let mut out = Vec::with_capacity(28 + ct_and_tag.len());
    out.extend_from_slice(&iv);
    out.extend_from_slice(&tag);
    out.extend_from_slice(&ct_and_tag);
    out
}

fn decrypt_with_cipher(packet: &[u8], key: &[u8; 32]) -> Result<Vec<u8>, String> {
    decrypt_chunk(packet, key)
}

pub async fn read_tcp_frame(
    stream: &mut TcpStream,
    key: &[u8; 32],
) -> Result<Option<DecodedFrame>, TransferError> {
    let mut len_buf = [0u8; 4];
    match stream.read_exact(&mut len_buf).await {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => {
            return Err(TransferError::new(
                "IO",
                format!("Conexión TCP interrumpida: {e}"),
            ));
        }
    }
    let len = u32::from_be_bytes(len_buf) as usize;
    if len == 0 || len > MAX_FRAME_LEN {
        return Err(TransferError::new(
            "PROTOCOL_FRAME",
            "Trama TCP fuera de rango o código incorrecto.",
        ));
    }

    let mut body = vec![0u8; len];
    stream.read_exact(&mut body).await.map_err(|e| {
        if e.kind() == std::io::ErrorKind::UnexpectedEof {
            TransferError::new("TRUNCATED", "Conexión cerrada a mitad de una trama")
        } else {
            TransferError::new("IO", format!("Error leyendo trama TCP: {e}"))
        }
    })?;

    let plain = decrypt_with_cipher(&body, key).map_err(|_| {
        TransferError::new(
            "BAD_CODE",
            "El código no coincide o la conexión fue alterada.",
        )
    })?;
    if plain.is_empty() {
        return Err(TransferError::new("PROTOCOL_FRAME", "Trama vacía"));
    }

    match plain[0] {
        FRAME_CONTROL => {
            let val: Value = serde_json::from_slice(&plain[1..]).map_err(|_| {
                TransferError::new("PROTOCOL_ERROR", "Mensaje de control JSON inválido")
            })?;
            Ok(Some(DecodedFrame::Control(val)))
        }
        FRAME_DATA => Ok(Some(DecodedFrame::Data(plain[1..].to_vec()))),
        other => Err(TransferError::new(
            "PROTOCOL_FRAME",
            format!("Tipo de trama desconocido: {other}"),
        )),
    }
}

async fn settle_peer(stream: &TcpStream) -> bool {
    let deadline = Instant::now() + Duration::from_millis(PEER_SETTLE_MS);
    let mut probe = [0u8; 1];
    loop {
        let now = Instant::now();
        if now >= deadline {
            return true;
        }
        let rem = deadline - now;
        match timeout(rem, stream.readable()).await {
            Err(_) => return true,
            Ok(Err(_)) => return false,
            Ok(Ok(())) => match stream.try_read(&mut probe) {
                Ok(0) => return false,
                Ok(_) => return true,
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => continue,
                Err(_) => return false,
            },
        }
    }
}

fn manifest_json(items: &[SendItem]) -> Vec<Value> {
    items
        .iter()
        .map(|it| {
            let mut obj = json!({
                "name": it.entry.name,
                "size": it.entry.size,
            });
            if let Some(p) = &it.entry.path {
                obj["path"] = json!(p);
            }
            obj
        })
        .collect()
}

/// Atiende una conexion TCP entrante del lado emisor.
/// Espera `PEER_SETTLE_MS` antes de pedir confirmacion, envia el manifiesto y
/// retransmite los archivos solicitados con reanudacion y verificacion SHA-256.
#[allow(clippy::too_many_arguments)]
pub async fn attach_sender(
    mut stream: TcpStream,
    items: &[SendItem],
    code: &str,
    room_id: &str,
    limit: u64,
    on_peer: Option<PeerGateFn>,
    mut on_progress: Option<ProgressFn>,
    mut on_resume: Option<ResumeNoticeFn>,
    is_closed: Option<Arc<std::sync::atomic::AtomicBool>>,
) -> Result<TransferStats, TransferError> {
    let _ = stream.set_nodelay(true);
    let key = derive_key(code);
    let cipher = Aes256Gcm::new_from_slice(&key).expect("32B key");
    let sas = crate::crypto::sas_from_key(&key, room_id);

    // Sondeos de puerto (`probe_candidate_ips`) cierran al instante: no molestan al usuario.
    if !settle_peer(&stream).await {
        return Err(TransferError::new("PROBE", "Conexión cerrada durante sondeo"));
    }
    if let Some(flag) = &is_closed
        && flag.load(std::sync::atomic::Ordering::SeqCst)
    {
        return Err(TransferError::new("CANCELLED", "Transferencia cancelada"));
    }

    let peer_addr = stream
        .peer_addr()
        .map(|a| plain_address(&a.ip().to_string()).to_string())
        .unwrap_or_else(|_| "desconocido".to_string());
    let path_desc = if is_local_address(&peer_addr) {
        format!("TCP directo local ({peer_addr})")
    } else {
        format!("TCP directo internet ({peer_addr})")
    };

    if let Some(gate) = on_peer {
        let info = PeerInfo {
            who: peer_addr.clone(),
            address: peer_addr.clone(),
            sas,
            path: path_desc,
        };
        if !gate(info).await {
            return Err(TransferError::new(
                "DENIED",
                "Conexión rechazada por el emisor",
            ));
        }
    }

    write_control_frame(
        &mut stream,
        &cipher,
        &json!({
            "v": PROTOCOL_VERSION,
            "files": manifest_json(items),
        }),
    )
    .await
    .map_err(|e| TransferError::new("IO", format!("No se pudo enviar manifiesto: {e}")))?;

    let ready_msg = match read_tcp_frame(&mut stream, &key).await? {
        Some(DecodedFrame::Control(v)) if v.get("k").and_then(|k| k.as_str()) == Some("ready") => {
            v
        }
        Some(_) => {
            return Err(TransferError::new(
                "PROTOCOL_ERROR",
                "Se esperaba mensaje 'ready' del receptor",
            ));
        }
        None => {
            return Err(TransferError::new(
                "CANCELLED",
                "El receptor cerró la conexión antes de aceptar",
            ));
        }
    };

    let req_files: Option<Vec<i64>> = ready_msg
        .get("files")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|x| x.as_i64()).collect());
    let picked = picked_files(req_files.as_deref(), items.len());

    let mut resume_map: HashMap<usize, Value> = HashMap::new();
    if let Some(arr) = ready_msg.get("resume").and_then(|v| v.as_array()) {
        for r in arr {
            if let Some(idx) = r.get("index").and_then(|x| x.as_u64()) {
                resume_map.insert(idx as usize, r.clone());
            }
        }
    }

    let selected_indices: Vec<usize> = match picked {
        Some(p) => p,
        None => (0..items.len()).collect(),
    };
    let selected_entries: Vec<FileEntry> = selected_indices
        .iter()
        .map(|&idx| items[idx].entry.clone())
        .collect();
    let total_expected = total_of(&selected_entries);

    let start_ts = Instant::now();
    let mut throttle = Throttle::new(limit);
    let mut sent_total = 0u64;
    let mut resumed_bytes = 0u64;
    let mut delivered_files = Vec::new();
    let mut buf = vec![0u8; CHUNK_SIZE];

    for &idx in &selected_indices {
        let item = &items[idx];
        let mut offset = 0u64;
        let mut hasher = Sha256::new();

        if let Some(req) = resume_map.get(&idx)
            && let Ok(Some(verified)) = verify_item_prefix(item, Some(req)).await
        {
            offset = verified.offset;
            hasher = verified.hasher;
            resumed_bytes += offset;
            sent_total += offset;
            if let Some(cb) = &mut on_resume {
                let label = item.entry.path.as_deref().unwrap_or(&item.entry.name);
                cb(label, offset);
            }
        }

        write_control_frame(
            &mut stream,
            &cipher,
            &json!({ "k": "start", "index": idx, "offset": offset }),
        )
        .await
        .map_err(|e| TransferError::new("IO", format!("Error iniciando archivo: {e}")))?;

        let mut file_bytes = offset;
        if item.is_stdin {
            let mut stdin = tokio::io::stdin();
            loop {
                let n = stdin
                    .read(&mut buf)
                    .await
                    .map_err(|e| TransferError::new("IO", format!("Error leyendo stdin: {e}")))?;
                if n == 0 {
                    break;
                }
                throttle.take(n).await;
                hasher.update(&buf[..n]);
                write_data_frame(&mut stream, &cipher, &buf[..n])
                    .await
                    .map_err(|e| TransferError::new("IO", format!("Error enviando datos: {e}")))?;
                file_bytes += n as u64;
                sent_total += n as u64;
                if let Some(cb) = &mut on_progress {
                    let secs = start_ts.elapsed().as_secs_f64().max(0.001);
                    cb(sent_total, total_expected, (sent_total - resumed_bytes) as f64 / secs, &selected_entries);
                }
            }
        } else if let Some(inline) = &item.inline_data {
            let start = usize::try_from(offset).unwrap_or(inline.len());
            for chunk in inline[start..].chunks(CHUNK_SIZE) {
                throttle.take(chunk.len()).await;
                hasher.update(chunk);
                write_data_frame(&mut stream, &cipher, chunk)
                    .await
                    .map_err(|e| TransferError::new("IO", format!("Error enviando datos: {e}")))?;
                file_bytes += chunk.len() as u64;
                sent_total += chunk.len() as u64;
                if let Some(cb) = &mut on_progress {
                    let secs = start_ts.elapsed().as_secs_f64().max(0.001);
                    cb(
                        sent_total,
                        total_expected,
                        (sent_total - resumed_bytes) as f64 / secs,
                        &selected_entries,
                    );
                }
            }
        } else if let Some(fs_path) = &item.fs_path {
            let mut f = File::open(fs_path)
                .await
                .map_err(|e| TransferError::new("IO", format!("No se pudo abrir archivo: {e}")))?;
            if offset > 0 {
                f.seek(SeekFrom::Start(offset))
                    .await
                    .map_err(|e| TransferError::new("IO", format!("Error buscando offset: {e}")))?;
            }
            loop {
                let n = f
                    .read(&mut buf)
                    .await
                    .map_err(|e| TransferError::new("IO", format!("Error leyendo archivo: {e}")))?;
                if n == 0 {
                    break;
                }
                throttle.take(n).await;
                hasher.update(&buf[..n]);
                write_data_frame(&mut stream, &cipher, &buf[..n])
                    .await
                    .map_err(|e| TransferError::new("IO", format!("Error enviando datos: {e}")))?;
                file_bytes += n as u64;
                sent_total += n as u64;
                if let Some(cb) = &mut on_progress {
                    let secs = start_ts.elapsed().as_secs_f64().max(0.001);
                    cb(
                        sent_total,
                        total_expected,
                        (sent_total - resumed_bytes) as f64 / secs,
                        &selected_entries,
                    );
                }
            }
        }

        let sha_hex = hex::encode(hasher.finalize());
        write_control_frame(
            &mut stream,
            &cipher,
            &json!({ "k": "end", "index": idx, "sha256": sha_hex }),
        )
        .await
        .map_err(|e| TransferError::new("IO", format!("Error finalizando archivo: {e}")))?;

        delivered_files.push(ReceivedFile {
            name: item.entry.name.clone(),
            size: file_bytes,
            path: item.fs_path.clone().unwrap_or_default(),
            rel: item.entry.path.clone(),
            sha256: sha_hex,
        });
    }

    write_control_frame(&mut stream, &cipher, &json!({ "k": "done" }))
        .await
        .map_err(|e| TransferError::new("IO", format!("Error enviando cierre: {e}")))?;
    let _ = stream.shutdown().await;
    let mut drain_buf = [0u8; 16];
    let _ = timeout(Duration::from_millis(2000), stream.read(&mut drain_buf)).await;

    let elapsed = start_ts.elapsed().as_secs_f64().max(0.001);
    let wire_bytes = sent_total - resumed_bytes;
    Ok(TransferStats {
        files: delivered_files,
        total_bytes: sent_total,
        resumed_bytes,
        total_time_sec: elapsed,
        avg_speed: wire_bytes as f64 / elapsed,
        canceled: false,
        interrupted: false,
    })
}

pub fn parse_manifest_entries(val: &Value) -> Result<Vec<FileEntry>, TransferError> {
    let arr = val
        .as_array()
        .ok_or_else(|| TransferError::new("PROTOCOL_ERROR", "Manifiesto inválido"))?;
    let mut entries = Vec::with_capacity(arr.len());
    for item in arr {
        let name = item
            .get("name")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .ok_or_else(|| TransferError::new("UNSAFE_NAME", "Entrada sin nombre válido"))?;
        let size = match item.get("size") {
            None | Some(Value::Null) => None,
            Some(v) => Some(v.as_u64().ok_or_else(|| {
                TransferError::new("PROTOCOL_ERROR", "Tamaño inválido en manifiesto")
            })?),
        };
        let path = item
            .get("path")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        entries.push(FileEntry { name, size, path });
    }
    Ok(entries)
}

struct PreparedReceive {
    picked: Option<Vec<usize>>,
    target_indices: Vec<usize>,
    targets: HashMap<usize, ReservedPath>,
    reserved_set: HashSet<String>,
    resume_reqs: Vec<ResumeEntry>,
    expected_entries: Vec<FileEntry>,
}

struct StartSinkOutcome {
    sink: FileSink,
    resume_offset: Option<u64>,
}

#[allow(clippy::too_many_arguments)]
async fn open_start_sink(
    idx: usize,
    req_offset: u64,
    manifest: &[FileEntry],
    output_dir: &Path,
    opts: &ReceiveOptions,
    reserved_set: &mut HashSet<String>,
    targets: &HashMap<usize, ReservedPath>,
    resumed_bytes: &mut u64,
    received_total: &mut u64,
    on_resume: &mut Option<ResumeNoticeFn>,
) -> Result<StartSinkOutcome, TransferError> {
    let target = targets
        .get(&idx)
        .ok_or_else(|| TransferError::new("PROTOCOL_ERROR", "Índice inesperado"))?;

    let resume_offset = if req_offset > 0 && target.resume_from == Some(req_offset) {
        *resumed_bytes += req_offset;
        *received_total += req_offset;
        if let Some(cb) = on_resume {
            let label = manifest[idx].path.as_deref().unwrap_or(&manifest[idx].name);
            cb(label, req_offset);
        }
        Some(req_offset)
    } else {
        None
    };

    // Si se pidio reanudar pero el emisor rechazo el prefijo (offset 0), respetamos el .part ajeno.
    let effective = if target.resume_from.is_some() && resume_offset.is_none() && !opts.overwrite {
        reserve_output_path(
            output_dir,
            &manifest[idx].name,
            reserved_set,
            false,
            false,
            manifest[idx].size,
            manifest[idx].path.as_deref(),
        )?
    } else {
        target.clone()
    };

    let sink = open_file_sink(&effective, opts.overwrite, resume_offset).await?;
    Ok(StartSinkOutcome {
        sink,
        resume_offset,
    })
}

async fn prepare_receive(
    manifest: &[FileEntry],
    output_dir: &Path,
    opts: &ReceiveOptions,
) -> Result<PreparedReceive, TransferError> {
    let picked = select_files(manifest, &opts.only);
    if let Some(ref p) = picked
        && p.is_empty()
    {
        let available = manifest
            .iter()
            .map(|e| e.path.clone().unwrap_or_else(|| e.name.clone()))
            .collect();
        return Err(
            TransferError::new("NOTHING_SELECTED", "Ningún archivo coincide con --only")
                .with_available(available),
        );
    }

    let target_indices: Vec<usize> = match &picked {
        Some(p) => p.clone(),
        None => (0..manifest.len()).collect(),
    };

    let mut reserved_set = HashSet::new();
    let mut targets: HashMap<usize, ReservedPath> = HashMap::new();
    let mut resume_reqs = Vec::new();
    let mut expected_entries = Vec::new();

    for &idx in &target_indices {
        let entry = &manifest[idx];
        let res = reserve_output_path(
            output_dir,
            &entry.name,
            &mut reserved_set,
            opts.overwrite,
            opts.resume,
            entry.size,
            entry.path.as_deref(),
        )?;
        if let Some(offset) = res.resume_from
            && let Ok(Some(sha)) = hash_partial(&res.part_path, offset).await
        {
            resume_reqs.push(ResumeEntry {
                index: idx,
                offset,
                sha256: sha,
            });
        }
        expected_entries.push(entry.clone());
        targets.insert(idx, res);
    }

    Ok(PreparedReceive {
        picked,
        target_indices,
        targets,
        reserved_set,
        resume_reqs,
        expected_entries,
    })
}

/// Conecta y recibe archivos directamente sobre un flujo TCP ya abierto.
#[allow(clippy::too_many_arguments)]
pub async fn receive_files(
    mut stream: TcpStream,
    code: &str,
    room_id: &str,
    output_dir: &Path,
    opts: ReceiveOptions,
    on_sas: Option<SasGateFn>,
    mut on_progress: Option<ProgressFn>,
    mut on_resume: Option<ResumeNoticeFn>,
) -> Result<TransferStats, TransferError> {
    let _ = stream.set_nodelay(true);
    let key = derive_key(code);
    let cipher = Aes256Gcm::new_from_slice(&key).expect("32B key");
    let sas = crate::crypto::sas_from_key(&key, room_id);

    let first = read_tcp_frame(&mut stream, &key).await?.ok_or_else(|| {
        TransferError::new(
            "CANCELLED",
            "El emisor cerró la conexión o rechazó la transferencia.",
        )
    })?;
    let DecodedFrame::Control(manifest_msg) = first else {
        return Err(TransferError::new(
            "PROTOCOL_ERROR",
            "Se esperaba el manifiesto inicial",
        ));
    };
    // Aceptar manifiestos sin campo "k" (Node/v0.12) y rechazar cualquier otro tipo explícito.
    if let Some(k) = manifest_msg.get("k").and_then(|v| v.as_str())
        && k != "manifest"
    {
        return Err(TransferError::new(
            "PROTOCOL_ERROR",
            "Primera trama inválida: se esperaba el manifiesto de archivos.",
        ));
    }

    let remote_v = manifest_msg.get("v").and_then(|v| v.as_u64());
    if remote_v != Some(PROTOCOL_VERSION as u64) {
        return Err(TransferError::new(
            "PROTOCOL_VERSION",
            format!(
                "Versión de protocolo incompatible (emisor: {}, local: {PROTOCOL_VERSION}).",
                remote_v
                    .map(|v| v.to_string())
                    .unwrap_or_else(|| "0".to_string())
            ),
        ));
    }

    if !manifest_msg.get("files").is_some_and(|v| v.is_array()) {
        return Err(TransferError::new(
            "PROTOCOL_ERROR",
            "El primer marco del emisor no es el manifiesto de archivos.",
        ));
    }

    let manifest = parse_manifest_entries(manifest_msg.get("files").unwrap_or(&Value::Null))?;
    if let Some(gate) = on_sas
        && !gate(&manifest, &sas).await
    {
        return Err(TransferError::new("CANCELLED", "Cancelado por el usuario"));
    }

    let PreparedReceive {
        picked,
        target_indices,
        targets,
        mut reserved_set,
        resume_reqs,
        expected_entries,
    } = prepare_receive(&manifest, output_dir, &opts).await?;

    let mut ready = json!({
        "k": "ready",
        "resume": resume_reqs,
    });
    if let Some(p) = picked {
        ready["files"] = json!(p);
    }
    write_control_frame(&mut stream, &cipher, &ready)
        .await
        .map_err(|e| TransferError::new("IO", format!("Error enviando 'ready': {e}")))?;

    receive_tcp_loop(
        &manifest,
        output_dir,
        &opts,
        &target_indices,
        &mut reserved_set,
        &targets,
        &expected_entries,
        &mut stream,
        &key,
        &mut on_progress,
        &mut on_resume,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn receive_tcp_loop(
    manifest: &[FileEntry],
    output_dir: &Path,
    opts: &ReceiveOptions,
    target_indices: &[usize],
    reserved_set: &mut HashSet<String>,
    targets: &HashMap<usize, ReservedPath>,
    expected_entries: &[FileEntry],
    stream: &mut TcpStream,
    key: &[u8; 32],
    on_progress: &mut Option<ProgressFn>,
    on_resume: &mut Option<ResumeNoticeFn>,
) -> Result<TransferStats, TransferError> {

    let total_expected = total_of(expected_entries);
    let start_ts = Instant::now();
    let mut throttle = Throttle::new(opts.limit);
    let mut received_total = 0u64;
    let mut resumed_bytes = 0u64;
    let mut completed_files = Vec::new();
    let mut completed_set = HashSet::new();
    let mut current: Option<(usize, FileSink)> = None;

    loop {
        let frame = match read_tcp_frame(stream, key).await {
            Ok(Some(f)) => f,
            Ok(None) => {
                let mut part_bytes = 0u64;
                if let Some((_, sink)) = current.take() {
                    part_bytes = sink.detach().await;
                }
                return Err(TransferError::new(
                    "TRUNCATED",
                    "Conexión cerrada antes de completar la transferencia",
                )
                .with_resumable(part_bytes));
            }
            Err(e) => {
                let mut part_bytes = 0u64;
                if let Some((_, sink)) = current.take() {
                    part_bytes = sink.detach().await;
                }
                return Err(e.with_resumable(part_bytes));
            }
        };

        match frame {
            DecodedFrame::Control(msg) => match msg.get("k").and_then(|v| v.as_str()) {
                Some("start") => {
                    if let Some((_, sink)) = current.take() {
                        sink.abort().await;
                        return Err(TransferError::new(
                            "PROTOCOL_ERROR",
                            "Nuevo archivo iniciado antes de cerrar el anterior",
                        ));
                    }
                    let idx = msg
                        .get("index")
                        .and_then(|v| v.as_u64())
                        .ok_or_else(|| TransferError::new("PROTOCOL_ERROR", "start sin índice"))?
                        as usize;
                    let req_offset = msg.get("offset").and_then(|v| v.as_u64()).unwrap_or(0);
                    let outcome = open_start_sink(
                        idx,
                        req_offset,
                        manifest,
                        output_dir,
                        opts,
                        reserved_set,
                        targets,
                        &mut resumed_bytes,
                        &mut received_total,
                        on_resume,
                    )
                    .await?;
                    current = Some((idx, outcome.sink));
                }
                Some("end") => {
                    let Some((idx, sink)) = current.take() else {
                        return Err(TransferError::new(
                            "PROTOCOL_ERROR",
                            "'end' recibido sin archivo abierto",
                        ));
                    };
                    let expected_sha = msg.get("sha256").and_then(|v| v.as_str()).unwrap_or("");
                    let entry = &manifest[idx];
                    if let Some(exp_size) = entry.size
                        && sink.bytes_written != exp_size
                    {
                        sink.abort().await;
                        return Err(TransferError::new(
                            "TRUNCATED",
                            format!("El tamaño recibido para {} no coincide con el esperado", entry.name),
                        ));
                    }
                    let final_path = sink.final_path.clone();
                    let size = sink.bytes_written;
                    let sha = sink.commit(expected_sha).await?;
                    completed_set.insert(idx);
                    completed_files.push(ReceivedFile {
                        name: entry.name.clone(),
                        size,
                        path: final_path,
                        rel: entry.path.clone(),
                        sha256: sha,
                    });
                }
                Some("done") => {
                    if let Some((_, sink)) = current.take() {
                        sink.abort().await;
                        return Err(TransferError::new(
                            "TRUNCATED",
                            "Transferencia cerrada antes de finalizar el último archivo",
                        ));
                    }
                    if completed_set.len() != target_indices.len() {
                        return Err(TransferError::new(
                            "TRUNCATED",
                            "Faltan archivos seleccionados en la transferencia",
                        ));
                    }
                    break;
                }
                _ => {
                    // Compatibilidad hacia adelante (docs/COMPATIBILITY.md): marcos `k` futuros se ignoran.
                }
            },
            DecodedFrame::Data(bytes) => {
                let Some((_, ref mut sink)) = current else {
                    return Err(TransferError::new(
                        "PROTOCOL_ERROR",
                        "Datos recibidos sin cabecera 'start'",
                    ));
                };
                throttle.take(bytes.len()).await;
                if let Err(e) = sink.write_chunk(&bytes).await {
                    let part_bytes = sink.bytes_written;
                    if let Some((_, s)) = current.take() {
                        let _ = s.detach().await;
                    }
                    return Err(e.with_resumable(part_bytes));
                }
                received_total += bytes.len() as u64;
                if let Some(cb) = on_progress {
                    let secs = start_ts.elapsed().as_secs_f64().max(0.001);
                    cb(
                        received_total,
                        total_expected,
                        (received_total - resumed_bytes) as f64 / secs,
                        expected_entries,
                    );
                }
            }
        }
    }

    let elapsed = start_ts.elapsed().as_secs_f64().max(0.001);
    let wire_bytes = received_total - resumed_bytes;
    Ok(TransferStats {
        files: completed_files,
        total_bytes: received_total,
        resumed_bytes,
        total_time_sec: elapsed,
        avg_speed: wire_bytes as f64 / elapsed,
        canceled: false,
        interrupted: false,
    })
}

/// Recibe archivos por retransmision WebSocket Relay usando la sesion ya autenticada.
///
/// Protocolo relay CLI <-> CLI / Web (`cli-*` sobre trama JSON cifrada o directa en sala):
/// - Handshake: el host espera `cli-offer` (`mode`: `"single"` | `"cli-stream"`), responde `cli-proof`
///   con HMAC de clave compartida (o corta con `cli-denied` si falla).
/// - Negociacion: `cli-sealed` / `cli-manifest` (metadatos y listado de archivos) -> receptor responde
///   `cli-accept` -> emisor envia `cli-start` (fileIdx/offset).
/// - Datos y control de flujo: frames binarios `[4B senderId=0 | u16 seq | ...AES-GCM(nonce, chunk)]`
///   cifrados con la clave derivada, ventana de 8 MiB confirmada mediante `cli-ack` (`bytes`).
/// - Cierre y espera multiarchivo: `cli-end` por archivo -> `cli-done`; si el emisor aun prepara
///   mas elementos puede mandar `cli-wait`; al terminar todo emite `cli-complete` (o `cli-error` ante fallo).
///   Los campos o tipos `k` futuros desconocidos se ignoran para mantener compatibilidad hacia adelante.
#[allow(clippy::too_many_arguments)]
pub async fn receive_from_relay(
    ws_sender: &SignalingSender,
    ws_events: &mut mpsc::UnboundedReceiver<WsEvent>,
    manifest: &[FileEntry],
    key: &[u8; 32],
    output_dir: &Path,
    opts: ReceiveOptions,
    mut on_progress: Option<ProgressFn>,
    mut on_resume: Option<ResumeNoticeFn>,
) -> Result<TransferStats, TransferError> {
    let PreparedReceive {
        picked,
        target_indices,
        targets,
        mut reserved_set,
        resume_reqs,
        expected_entries,
    } = prepare_receive(manifest, output_dir, &opts).await?;

    let mut accept = json!({ "type": "cli-accept" });
    if let Some(p) = &picked {
        accept["files"] = json!(p);
    }
    if !resume_reqs.is_empty() {
        accept["resume"] = json!(resume_reqs);
    }
    if let Err(e) = ws_sender.send_signal(None, &accept) {
        return Err(TransferError::new("IO", e));
    }

    let total_expected = total_of(&expected_entries);
    let start_ts = Instant::now();
    let mut throttle = Throttle::new(opts.limit);
    let mut received_total = 0u64;
    let mut resumed_bytes = 0u64;
    let mut last_ack = 0u64;
    let mut completed_files = Vec::new();
    let mut completed_set = HashSet::new();
    let mut current: Option<(usize, FileSink)> = None;

    let fail_with = |ws: &SignalingSender, msg: &str| {
        let _ = ws.send_signal(None, &json!({ "type": "cli-error", "message": msg }));
    };

    loop {
        let ev = match timeout(
            Duration::from_millis(RELAY_IDLE_TIMEOUT_MS),
            ws_events.recv(),
        )
        .await
        {
            Ok(Some(ev)) => ev,
            Ok(None) => {
                let part_bytes = if let Some((_, sink)) = current.take() {
                    sink.detach().await
                } else {
                    0
                };
                return Err(TransferError::new(
                    "TRUNCATED",
                    "El servidor o el emisor cerraron la conexión Relay",
                )
                .with_resumable(part_bytes));
            }
            Err(_) => {
                let part_bytes = if let Some((_, sink)) = current.take() {
                    sink.detach().await
                } else {
                    0
                };
                fail_with(ws_sender, "Tiempo de espera agotado en Relay");
                return Err(TransferError::new(
                    "TIMEOUT",
                    "Sin actividad del emisor durante 60 segundos.",
                )
                .with_resumable(part_bytes));
            }
        };

        match ev {
            WsEvent::Closed => {
                let part_bytes = if let Some((_, sink)) = current.take() {
                    sink.detach().await
                } else {
                    0
                };
                return Err(TransferError::new(
                    "TRUNCATED",
                    "Conexión Relay cerrada antes de completar la recepción",
                )
                .with_resumable(part_bytes));
            }
            WsEvent::Binary(packet) => {
                let plain = match decrypt_with_cipher(&packet, key) {
                    Ok(p) => p,
                    Err(_) => {
                        let part_bytes = if let Some((_, sink)) = current.take() {
                            sink.detach().await
                        } else {
                            0
                        };
                        fail_with(ws_sender, "Error de descifrado AES-GCM");
                        return Err(TransferError::new(
                            "BAD_CODE",
                            "El código no coincide o un paquete Relay fue adulterado.",
                        )
                        .with_resumable(part_bytes));
                    }
                };
                let Some((_, ref mut sink)) = current else {
                    fail_with(ws_sender, "Paquete binario fuera de secuencia");
                    return Err(TransferError::new(
                        "PROTOCOL_ERROR",
                        "Datos Relay recibidos sin 'cli-start'",
                    ));
                };
                throttle.take(plain.len()).await;
                if let Err(e) = sink.write_chunk(&plain).await {
                    let part_bytes = if let Some((_, s)) = current.take() {
                        s.detach().await
                    } else {
                        0
                    };
                    fail_with(ws_sender, &e.message);
                    return Err(e.with_resumable(part_bytes));
                }

                received_total += plain.len() as u64;
                if received_total - last_ack >= RELAY_ACK_EVERY {
                    last_ack = received_total;
                    let _ = ws_sender.send_signal(
                        None,
                        &json!({ "type": "cli-ack", "bytes": received_total }),
                    );
                }
                if let Some(cb) = &mut on_progress {
                    let secs = start_ts.elapsed().as_secs_f64().max(0.001);
                    cb(
                        received_total,
                        total_expected,
                        (received_total - resumed_bytes) as f64 / secs,
                        &expected_entries,
                    );
                }
            }
            WsEvent::Json(msg) => {
                match msg.get("t").and_then(|v| v.as_str()) {
                    Some("error") => {
                        let reason = msg
                            .get("reason")
                            .and_then(|v| v.as_str())
                            .unwrap_or("ERROR");
                        let part_bytes = if let Some((_, sink)) = current.take() {
                            sink.detach().await
                        } else {
                            0
                        };
                        return Err(
                            TransferError::new("PROTOCOL_ERROR", reason).with_resumable(part_bytes)
                        );
                    }
                    Some("signal") => {
                        let Some(data) = msg.get("data") else {
                            continue;
                        };
                        let inner = if data.get("type").and_then(|v| v.as_str()) == Some("cli-sealed")
                        {
                            let Some(boxed) = data.get("box").and_then(|v| v.as_str()) else {
                                return Err(TransferError::new(
                                    "PROTOCOL_ERROR",
                                    "Sobre cli-sealed sin contenido",
                                ));
                            };
                            match unseal_frame(boxed, key) {
                                Ok(v) => v,
                                Err(_) => {
                                    let part_bytes = if let Some((_, sink)) = current.take() {
                                        sink.detach().await
                                    } else {
                                        0
                                    };
                                    fail_with(ws_sender, "BAD_CODE");
                                    return Err(TransferError::new(
                                        "BAD_CODE",
                                        "No se pudo descifrar el control Relay.",
                                    )
                                    .with_resumable(part_bytes));
                                }
                            }
                        } else if data.get("type").and_then(|v| v.as_str()) == Some("cli-error") {
                            let part_bytes = if let Some((_, sink)) = current.take() {
                                sink.detach().await
                            } else {
                                0
                            };
                            let m = data
                                .get("message")
                                .and_then(|v| v.as_str())
                                .unwrap_or("El emisor canceló la transferencia.");
                            return Err(TransferError::new("CANCELLED", m).with_resumable(part_bytes));
                        } else {
                            continue;
                        };

                        match inner.get("type").and_then(|v| v.as_str()) {
                            Some("cli-wait") => {
                                // Rearma el temporizador de inactividad mientras el emisor verifica un .part grande.
                            }
                            Some("cli-start") => {
                                if let Some((_, sink)) = current.take() {
                                    sink.abort().await;
                                    fail_with(ws_sender, "cli-start antes de cli-end");
                                    return Err(TransferError::new(
                                        "PROTOCOL_ERROR",
                                        "Nuevo archivo iniciado antes de cerrar el anterior",
                                    ));
                                }
                                let idx = inner
                                    .get("index")
                                    .and_then(|v| v.as_u64())
                                    .ok_or_else(|| {
                                        TransferError::new("PROTOCOL_ERROR", "cli-start sin index")
                                    })? as usize;
                                let req_offset =
                                    inner.get("offset").and_then(|v| v.as_u64()).unwrap_or(0);
                                let outcome = open_start_sink(
                                    idx,
                                    req_offset,
                                    manifest,
                                    output_dir,
                                    &opts,
                                    &mut reserved_set,
                                    &targets,
                                    &mut resumed_bytes,
                                    &mut received_total,
                                    &mut on_resume,
                                )
                                .await?;
                                if outcome.resume_offset.is_some() {
                                    last_ack = received_total;
                                    let _ = ws_sender.send_signal(
                                        None,
                                        &json!({ "type": "cli-ack", "bytes": received_total }),
                                    );
                                }
                                current = Some((idx, outcome.sink));
                            }
                            Some("cli-end") => {
                                let Some((idx, sink)) = current.take() else {
                                    return Err(TransferError::new(
                                        "PROTOCOL_ERROR",
                                        "cli-end sin archivo abierto",
                                    ));
                                };
                                let expected_sha =
                                    inner.get("sha256").and_then(|v| v.as_str()).unwrap_or("");
                                let entry = &manifest[idx];
                                if let Some(exp_size) = entry.size
                                    && sink.bytes_written != exp_size
                                {
                                    sink.abort().await;
                                    fail_with(ws_sender, "Tamaño recibido incorrecto");
                                    return Err(TransferError::new(
                                        "TRUNCATED",
                                        format!("Tamaño incorrecto para {}", entry.name),
                                    ));
                                }
                                let final_path = sink.final_path.clone();
                                let size = sink.bytes_written;
                                let sha = match sink.commit(expected_sha).await {
                                    Ok(s) => s,
                                    Err(e) => {
                                        fail_with(ws_sender, &e.message);
                                        return Err(e);
                                    }
                                };
                                completed_set.insert(idx);
                                completed_files.push(ReceivedFile {
                                    name: entry.name.clone(),
                                    size,
                                    path: final_path,
                                    rel: entry.path.clone(),
                                    sha256: sha,
                                });
                            }
                            Some("cli-done") => {
                                if let Some((_, sink)) = current.take() {
                                    sink.abort().await;
                                    fail_with(ws_sender, "cli-done prematuro");
                                    return Err(TransferError::new(
                                        "TRUNCATED",
                                        "cli-done antes de cerrar el archivo actual",
                                    ));
                                }
                                if completed_set.len() != target_indices.len() {
                                    fail_with(ws_sender, "Transferencia incompleta");
                                    return Err(TransferError::new(
                                        "TRUNCATED",
                                        "Faltan archivos en la transferencia Relay",
                                    ));
                                }
                                if received_total > last_ack {
                                    let _ = ws_sender.send_signal(
                                        None,
                                        &json!({ "type": "cli-ack", "bytes": received_total }),
                                    );
                                }
                                let _ = ws_sender
                                    .send_signal(None, &json!({ "type": "cli-complete" }));
                                let _ = timeout(Duration::from_secs(2), ws_sender.drain()).await;
                                break;
                            }
                            _ => {}
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    let elapsed = start_ts.elapsed().as_secs_f64().max(0.001);
    let wire_bytes = received_total - resumed_bytes;
    Ok(TransferStats {
        files: completed_files,
        total_bytes: received_total,
        resumed_bytes,
        total_time_sec: elapsed,
        avg_speed: wire_bytes as f64 / elapsed,
        canceled: false,
        interrupted: false,
    })
}

/// Helper para empaquetar un paquete binario dirigido a `guest_id` en el Relay.
pub fn relay_binary_packet(guest_id: u32, key: &[u8; 32], chunk: &[u8]) -> Vec<u8> {
    let encrypted = encrypt_chunk(chunk, key);
    let mut pkt = Vec::with_capacity(4 + encrypted.len());
    pkt.extend_from_slice(&guest_id.to_be_bytes());
    pkt.extend_from_slice(&encrypted);
    pkt
}

/// Helper para enviar una trama sellada por Relay.
pub fn send_sealed(
    sender: &SignalingSender,
    to: Option<u64>,
    payload: &Value,
    key: &[u8; 32],
) -> Result<(), String> {
    sender.send_signal(to, &seal_frame(payload, key))
}

pub fn flush_progress_after_transfer(progress: impl FnOnce()) {
    progress();
}

pub fn idle_sleep(ms: u64) -> impl Future<Output = ()> {
    sleep(Duration::from_millis(ms))
}
