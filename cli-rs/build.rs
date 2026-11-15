use std::fs;
use std::path::{Path, PathBuf};

fn collect_public_files(root: &Path, dir: &Path, out: &mut Vec<(String, PathBuf)>) {
    println!("cargo:rerun-if-changed={}", dir.display());
    let mut entries: Vec<_> = fs::read_dir(dir)
        .unwrap_or_else(|e| panic!("No se pudo leer {}: {e}", dir.display()))
        .map(|res| res.expect("Error leyendo entrada en public/"))
        .collect();
    entries.sort_by_key(|e| e.file_name());

    for entry in entries {
        let path = entry.path();
        let file_type = entry
            .file_type()
            .unwrap_or_else(|e| panic!("No se pudo inspeccionar {}: {e}", path.display()));
        if file_type.is_dir() {
            collect_public_files(root, &path, out);
        } else if file_type.is_file() {
            println!("cargo:rerun-if-changed={}", path.display());
            let rel = path
                .strip_prefix(root)
                .expect("Ruta relativa invalida dentro de public/");
            let web_path = format!(
                "/{}",
                rel.components()
                    .map(|c| c.as_os_str().to_string_lossy().into_owned())
                    .collect::<Vec<_>>()
                    .join("/")
            );
            out.push((web_path, path));
        }
    }
}

fn escape_rust_str(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

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

    let public_dir = Path::new(&manifest_dir).join("..").join("public");
    assert!(
        public_dir.is_dir(),
        "No se encontro la carpeta ../public para embeberla en el binario"
    );
    let mut assets = Vec::new();
    collect_public_files(&public_dir, &public_dir, &mut assets);
    assets.sort_by(|a, b| a.0.cmp(&b.0));

    let out_dir = std::env::var("OUT_DIR").expect("OUT_DIR no definido");
    let dest = Path::new(&out_dir).join("embedded_public.rs");
    let mut generated = String::from("pub static PUBLIC_ASSETS: &[(&str, &[u8])] = &[\n");
    for (web_path, fs_path) in assets {
        let abs = fs_path.to_str().expect("Ruta no UTF-8 en public/");
        generated.push_str(&format!(
            "    (\"{}\", include_bytes!(\"{}\")),\n",
            escape_rust_str(&web_path),
            escape_rust_str(abs)
        ));
    }
    generated.push_str("];\n");
    fs::write(&dest, generated).expect("No se pudo escribir embedded_public.rs");
}
