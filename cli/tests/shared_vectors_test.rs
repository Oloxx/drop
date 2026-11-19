// Tests cruzados contra vectores compartidos (public/shared/*.js y la implementacion JS previa del CLI).

use std::fs;
use std::path::PathBuf;

use serde::Deserialize;

use drop::cli;
use drop::completion::{SHELLS, completion_script};
use drop::crypto::{
    decrypt_chunk, derive_key, encrypt_chunk, proof_from_key, sas_from_key, seal_frame,
    secret_proof, unseal_frame, verify_proof,
};
use drop::minisign::{parse_public_key, parse_signature, verify_signature};
use drop::select::{parse_patterns, select_files};
use drop::shared::codes::{Lang, normalize_code, parse_code, resolve_word, split_for_key};
use drop::shared::protocol::{FileEntry, PROTOCOL_VERSION, picked_files};
use drop::shared::qr::{Ecl, encode_qr, qr_to_blocks, qr_to_svg};
use drop::shared::sas::{format_sas, sas_input, sas_words};
use drop::shared::wordlist::WORDLIST;
use drop::throttle::parse_rate;
use drop::ui::{file_at, fmt_bytes, fmt_duration, fmt_ms};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixtures {
    version: String,
    protocol_version: u32,
    wordlist_count: usize,
    wordlist: Vec<String>,
    crypto_vectors: Vec<CryptoVector>,
    code_vectors: Vec<CodeVector>,
    word_vectors: Vec<WordVector>,
    sas_vectors: Vec<SasVector>,
    sas_input_vectors: Vec<SasInputVector>,
    picked_files_vectors: Vec<PickedFilesVector>,
    qr_vectors: Vec<QrVector>,
    select_files_list: Vec<FileEntry>,
    select_vectors: Vec<SelectVector>,
    completions: std::collections::HashMap<String, String>,
    help_text: String,
    version_text: String,
    minisign_vector: MinisignVector,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CryptoVector {
    code: String,
    room_id: String,
    secret: String,
    key_hex: String,
    sas_formatted: String,
    proofs: Vec<ProofVector>,
    encrypted_frames: Vec<FrameVector>,
    sealed: SealedVector,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProofVector {
    nonce: String,
    proof_v2: String,
    proof_v3: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FrameVector {
    plain_hex: String,
    box_hex: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SealedVector {
    obj: serde_json::Value,
    frame: serde_json::Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodeVector {
    input: String,
    split: KeySplitJson,
    normalized: String,
    parsed: Option<ParsedCodeJson>,
    error: Option<CodeErrJson>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct KeySplitJson {
    room_id: String,
    secret: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ParsedCodeJson {
    room_id: String,
    words: Vec<String>,
    secret: String,
    code: String,
}

#[derive(Deserialize)]
struct CodeErrJson {
    key: Option<String>,
    message: String,
    hint: Option<String>,
}

#[derive(Deserialize)]
struct WordVector {
    input: String,
    ok: Option<String>,
    error: Option<CodeErrJson>,
}

#[derive(Deserialize)]
struct SasVector {
    digest: String,
    words: Vec<String>,
    formatted: String,
}

#[derive(Deserialize)]
struct SasInputVector {
    kind: String,
    parts: Vec<String>,
    result: String,
}

#[derive(Deserialize)]
struct PickedFilesVector {
    files: Option<Vec<i64>>,
    count: usize,
    expected: Option<Vec<usize>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct QrVector {
    text: String,
    version: usize,
    size: usize,
    modules: Vec<Vec<u8>>,
    blocks_ansi: String,
    blocks_plain: String,
    svg: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SelectVector {
    raw: String,
    patterns: Vec<String>,
    selected_indices: Option<Vec<usize>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MinisignVector {
    public_key: String,
    public_key_full: String,
    content_utf8: String,
    sig_ed: String,
}

fn load_fixtures() -> Fixtures {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("shared-vectors.json");
    let raw = fs::read_to_string(path).expect("read shared-vectors.json");
    serde_json::from_str(&raw).expect("parse shared-vectors.json")
}

#[test]
fn test_version_protocol_and_wordlist_parity() {
    let f = load_fixtures();
    let pkg_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("repo root")
        .join("package.json");
    let pkg: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(pkg_path).expect("read package.json"),
    )
    .expect("parse package.json");
    assert_eq!(Some(cli::VERSION), pkg["version"].as_str());
    assert_eq!(
        format!("drop v{}\n", cli::VERSION),
        f.version_text.replace(&f.version, cli::VERSION)
    );
    assert_eq!(PROTOCOL_VERSION, f.protocol_version);
    assert_eq!(WORDLIST.len(), f.wordlist_count);
    for (i, (a, b)) in WORDLIST.iter().zip(f.wordlist.iter()).enumerate() {
        assert_eq!(*a, b.as_str(), "wordlist mismatch at {i}");
    }
    let expected_help = f
        .help_text
        .replace(&format!("v{}", f.version), &format!("v{}", cli::VERSION));
    assert_eq!(format!("{}\n", cli::format_help()), expected_help);
}

#[test]
fn test_codes_and_word_resolution_parity() {
    let f = load_fixtures();
    for cv in &f.code_vectors {
        assert_eq!(normalize_code(&cv.input), cv.normalized, "norm: {}", cv.input);
        let sp = split_for_key(&cv.input);
        assert_eq!(sp.room_id, cv.split.room_id, "split room: {}", cv.input);
        assert_eq!(sp.secret, cv.split.secret, "split secret: {}", cv.input);

        match (parse_code(&cv.input, Lang::Es), &cv.parsed, &cv.error) {
            (Ok(got), Some(exp), None) => {
                assert_eq!(got.room_id, exp.room_id);
                assert_eq!(got.words, exp.words);
                assert_eq!(got.secret, exp.secret);
                assert_eq!(got.code, exp.code);
            }
            (Err(got), None, Some(exp)) => {
                assert_eq!(Some(got.key), exp.key.as_deref().map(|_| got.key));
                if let Some(k) = &exp.key {
                    assert_eq!(got.key, k.as_str());
                }
                assert_eq!(got.full_message(), exp.message);
                if let Some(h) = &exp.hint {
                    assert_eq!(&got.hint, h);
                }
            }
            other => panic!("parse_code mismatch for {:?}: {:?}", cv.input, other.0),
        }
    }

    for wv in &f.word_vectors {
        match (resolve_word(&wv.input, Lang::Es), &wv.ok, &wv.error) {
            (Ok(got), Some(exp), None) => assert_eq!(got, exp),
            (Err(got), None, Some(exp)) => {
                if let Some(k) = &exp.key {
                    assert_eq!(got.key, k.as_str());
                }
                assert_eq!(got.full_message(), exp.message);
            }
            other => panic!("resolve_word mismatch for {:?}: {:?}", wv.input, other.0),
        }
    }
}

#[test]
fn test_sas_and_protocol_parity() {
    let f = load_fixtures();
    for sv in &f.sas_vectors {
        let words = sas_words(&sv.digest).unwrap();
        let w_str: Vec<String> = words.iter().map(|s| s.to_string()).collect();
        assert_eq!(w_str, sv.words);
        assert_eq!(format_sas(&words), sv.formatted);
    }
    for siv in &f.sas_input_vectors {
        let refs: Vec<&str> = siv.parts.iter().map(String::as_str).collect();
        assert_eq!(sas_input(&siv.kind, &refs), siv.result);
    }

    assert!(f.picked_files_vectors.len() >= 3);
    for pv in &f.picked_files_vectors {
        assert_eq!(picked_files(pv.files.as_deref(), pv.count), pv.expected);
    }
}

#[test]
fn test_crypto_parity() {
    let f = load_fixtures();
    for v in &f.crypto_vectors {
        let key = derive_key(&v.code);
        assert_eq!(hex::encode(key), v.key_hex, "derive_key {}", v.code);
        assert_eq!(sas_from_key(&key, &v.room_id), v.sas_formatted);

        for p in &v.proofs {
            assert_eq!(secret_proof(&p.nonce, &v.secret), p.proof_v2);
            assert_eq!(proof_from_key(&key, &p.nonce), p.proof_v3);
            assert!(verify_proof(&key, &p.nonce, &p.proof_v3));
            assert!(!verify_proof(&key, &p.nonce, &"0".repeat(64)));
            assert!(!verify_proof(&key, &p.nonce, "short"));
        }

        for fr in &v.encrypted_frames {
            let box_bytes = hex::decode(&fr.box_hex).unwrap();
            let plain = decrypt_chunk(&box_bytes, &key).unwrap();
            assert_eq!(hex::encode(&plain), fr.plain_hex);

            // Roundtrip cifrado en Rust -> descifrado en Rust
            let rust_box = encrypt_chunk(&plain, &key);
            let rt = decrypt_chunk(&rust_box, &key).unwrap();
            assert_eq!(rt, plain);
        }

        let js_box = v.sealed.frame["box"].as_str().unwrap();
        let unsealed_js = unseal_frame(js_box, &key).unwrap();
        assert_eq!(unsealed_js, v.sealed.obj);

        let rust_sealed = seal_frame(&v.sealed.obj, &key);
        let rt_sealed = unseal_frame(rust_sealed["box"].as_str().unwrap(), &key).unwrap();
        assert_eq!(rt_sealed, v.sealed.obj);
    }
}

#[test]
fn test_qr_parity() {
    let f = load_fixtures();
    for qv in &f.qr_vectors {
        let qr = encode_qr(&qv.text, Ecl::M).unwrap();
        assert_eq!(qr.version, qv.version, "qr version {}", qv.text);
        assert_eq!(qr.size, qv.size, "qr size {}", qv.text);
        assert_eq!(qr.modules, qv.modules, "qr modules {}", qv.text);
        assert_eq!(qr_to_blocks(&qr, 2, true), qv.blocks_ansi);
        assert_eq!(qr_to_blocks(&qr, 2, false), qv.blocks_plain);
        assert_eq!(qr_to_svg(&qr, 4, "#080809", "#fafafa"), qv.svg);
    }
}

#[test]
fn test_select_and_completion_parity() {
    let f = load_fixtures();
    for sv in &f.select_vectors {
        let pats = parse_patterns(&sv.raw);
        assert_eq!(pats, sv.patterns);
        let idx = select_files(&f.select_files_list, &pats);
        assert_eq!(idx, sv.selected_indices, "select {}", sv.raw);
    }

    for (sh, expected) in &f.completions {
        let got = completion_script(Some(sh)).unwrap();
        assert_eq!(&got, expected, "completion {sh}");
    }
    assert!(SHELLS.contains(&"bash"));
    assert!(completion_script(Some("csh")).is_err());
    assert!(completion_script(None).is_err());
}

#[test]
fn test_minisign_parity() {
    let f = load_fixtures();
    let mv = &f.minisign_vector;
    assert_eq!(
        cli::PUBLIC_KEY,
        "RWQqNnfqvCrj+eavJ9njz2vCoHaC8YnLqjsvNBMndz3hBroQLpou7+Kp"
    );

    assert!(parse_public_key(&mv.public_key).is_ok());
    assert!(parse_public_key(&mv.public_key_full).is_ok());
    assert!(parse_signature(&mv.sig_ed).is_ok());

    let res = verify_signature(mv.content_utf8.as_bytes(), &mv.sig_ed, &mv.public_key);
    assert!(res.ok, "minisign ok failed: {:?}", res.reason);
    assert_eq!(
        res.trusted_comment.as_deref(),
        Some("timestamp:1700000000\tfile:drop-test")
    );

    let bad = verify_signature(b"tampered", &mv.sig_ed, &mv.public_key);
    assert!(!bad.ok);
}

#[test]
fn test_ui_and_cli_parsers() {
    assert_eq!(fmt_bytes(0), "0 B");
    assert_eq!(fmt_bytes(1024), "1.0 KB");
    assert_eq!(fmt_bytes(10 * 1024 * 1024), "10 MB");
    assert_eq!(fmt_duration(0.05), "< 0.1s");
    assert_eq!(fmt_duration(65.0), "1m 5s");
    assert_eq!(fmt_ms(None), "—");
    assert_eq!(fmt_ms(Some(4.23)), "4.2 ms");

    let list = vec![
        FileEntry { name: "a.bin".into(), size: Some(100), path: None },
        FileEntry { name: "b.bin".into(), size: Some(200), path: None },
    ];
    let p = file_at(&list, 150).unwrap();
    assert_eq!(p.index, 1);
    assert_eq!(p.done, 50);

    assert_eq!(parse_rate("500K").unwrap(), 500 * 1024);
    assert_eq!(parse_rate("10M").unwrap(), 10 * 1024 * 1024);
    assert!(parse_rate("0").is_err());

    assert_eq!(cli::parse_duration("90s").unwrap(), 90_000);
    assert_eq!(cli::parse_duration("10").unwrap(), 600_000);
    assert_eq!(cli::parse_duration("2h").unwrap(), 7_200_000);
    assert!(cli::parse_duration("0m").is_err());
}
