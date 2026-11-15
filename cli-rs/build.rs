use std::fs;
use std::path::Path;

fn main() {
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap();
    let pkg_path = Path::new(&manifest_dir).join("..").join("package.json");
    println!("cargo:rerun-if-changed={}", pkg_path.display());

    let raw = fs::read_to_string(&pkg_path).expect("No se pudo leer ../package.json");
    // Parser minimo sin anadir serde_json como build-dependency: busca `"version": "..."`.
    let version = raw
        .lines()
        .find_map(|line| {
            let trimmed = line.trim();
            let rest = trimmed.strip_prefix("\"version\"")?;
            let after_colon = rest.trim_start().strip_prefix(':')?;
            let q1 = after_colon.find('"')?;
            let tail = &after_colon[q1 + 1..];
            let q2 = tail.find('"')?;
            Some(tail[..q2].to_string())
        })
        .expect("No se encontro el campo \"version\" en ../package.json");

    println!("cargo:rustc-env=DROP_VERSION={version}");
}
