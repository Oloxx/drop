# CLI Migration to Rust: Benchmarks & Engineering Evaluation

Empirical evaluation of rewriting the **Drop** CLI from **Node.js SEA** (*Single Executable Application*, previously `cli/`) to **native Rust** ([`cli-rs/`](../cli-rs/), shipped in `v0.13.0`), while keeping **Protocol 5 (`1.x`)** frozen and maintaining full interoperability with the web client ([`public/`](../public/)) and Node.js signaling/relay server ([`server/index.js`](../server/index.js)).

---

## Executive Summary

Replacing the embedded Node.js/V8 runtime with a natively compiled `cargo` binary yields:

- **Binary size (Windows x64):** drops from **`84,456,080 bytes` (`80.54 MiB`)** (SEA `node.exe` base) to **`5,637,632 bytes` (`5.38 MiB`)** (**~15× smaller**, **−93.3%**).
- **Cold start (`--version`, 10 runs):** improves from **`108.79 ms`** in Node to **`15.01 ms`** in Rust (**~7.2× faster**).
- **Active memory (`speed` loopback):** drops from **`55.6–62.3 MB`** working set (`82.9–105.5 MB` peak) in Node to **`9.9–10.0 MB`** working set (`41.2–41.7 MB` peak) in Rust (**~5.5×–6.3× less active RAM**).
- **In-memory encrypted TCP throughput:** increases from **`661.7 / 650.3 MB/s`** in Node to **`2697.3 / 2728.4 MB/s`** in Rust (**>4× faster**), with **`0.1 ms`** loopback RTT vs **`0.4 ms`**.
- **CLI ↔ CLI WebSocket relay:** rises from **`88.4 / 67.2 MB/s`** in Node to **`297.4 / 336.7 MB/s`** in Rust (**3.4×–5.0× faster**) through the exact same Node.js relay server.
- **Main trade-off:** CLI source code grows from `6,237` to `12,241` lines due to strict typing and reimplementing shared modules previously imported directly from [`public/shared/`](../public/shared/), plus native per-target builds in CI.

---

## Test Environment

All startup, memory, and throughput measurements were collected locally on loopback (`127.0.0.1` / `::1`) on the same machine:

- **CPU:** AMD Ryzen 7 5700X 8-Core Processor (8 cores / 16 threads)
- **RAM:** 15.9 GiB
- **OS:** Microsoft Windows 11 Pro 64-bit
- **Toolchains:** `rustc 1.100.0 (0ef1bc386 2026-11-09)` / `cargo 1.100.0 (3acc79c0c 2026-11-05)` and `Node.js v22.15.0`

> Comparative JS vs. Rust numbers were measured against the Rust release binary (`5,639,168 bytes` at benchmark time) and the `v0.12.0` Node.js implementation in `cli/src/` prior to removing legacy SEA files. After final documentation tweaks, the release binary measured `5,637,632 bytes` (`5.38 MiB`).

---

## 1. Binary Size, Dependencies & Source Footprint

| Metric | Previous CLI (Node.js SEA) | New CLI (Rust) | Delta |
| :--- | :--- | :--- | :--- |
| **Executable (`Windows x64`)** | `84,456,080 bytes` (`80.54 MiB`, SEA `node.exe` base) | `5,637,632 bytes` (`5.38 MiB`, release `drop.exe`) | **−93.3% (~15× smaller)** |
| **User runtime dependencies** | Embedded Node/V8/OpenSSL per binary | `0` external dependencies (static native binary) | No embedded JS runtime |
| **CLI build tooling** | `node` + `esbuild` + `postject` + `nodejs.org` downloads | `244` crates in `cli-rs/Cargo.lock` | No post-build binary injection |
| **Server runtime dependencies (`package.json`)** | `2` (`express`, `ws`) | `2` (`express`, `ws`) | Unchanged |
| **CLI source code** | `16` files · `281,267 bytes` · `6,237` lines (`cli/src/`) | `32` files · `405,449 bytes` · `12,241` lines (`cli-rs/src/`) | **+96% CLI lines** |
| **Shared web/CLI modules (`public/shared/`)** | `9` files · `92,770 bytes` · `1,858` lines (imported directly) | Ported into [`cli-rs/src/shared/`](../cli-rs/src/shared/) | Synced via shared test vectors |
| **CLI integration suites** | Covered only in `test/*.test.mjs` | `5` `.rs` suites (`2,001` lines in [`cli-rs/tests/`](../cli-rs/tests/)) + `test/*.test.mjs` | Native + E2E coverage |

### Takeaways

1. **Distribution:** SEA bundled the entire Node.js runtime (~80 MiB uncompressed on Windows) via `postject`. Dropping to **`5.38 MiB`** makes initial downloads, `drop update`, and package-manager updates substantially faster.
2. **More Rust source, less packaging glue:** Rust requires explicit types, buffer management, and async channels, and cannot import [`public/shared/`](../public/shared/) directly; in exchange, the custom runtime-download and injection scripts (`scripts/build-cross.mjs`, `scripts/shasums.mjs`, `sea-config.json`) were eliminated.

---

## 2. Cold Start & Memory Usage

Measured on Windows via `WorkingSet64` and `PeakWorkingSet64`, and 10 consecutive runs for cold startup:

| Scenario | Node.js (`v22.15.0`) | Rust (release `drop.exe`) | Improvement |
| :--- | :--- | :--- | :--- |
| **Cold start (`--version`, 10 runs)** | `108.79 ms` avg (`min 103.60 ms`, `max 118.42 ms`) | `15.01 ms` avg (`min 12.50 ms`, `max 27.72 ms`) | **7.2× faster** |
| **Idle RAM (`send --no-qr`)** | `51.4 MiB` working · `83.1 MiB` peak | `10.4 MiB` working · `42.0 MiB` peak | **~4.9× less active RAM** |
| **RAM under load (`speed` loopback) — Host** | `55.6 MB` working · `82.9 MB` peak | `10.0 MB` working · `41.7 MB` peak | **~5.6× less active RAM** |
| **RAM under load (`speed` loopback) — Guest** | `62.3 MB` working · `105.5 MB` peak | `9.9 MB` working · `41.2 MB` peak | **~6.3× less active RAM** |

Short commands (`--help`, `completion`, `verify-web`, invalid argument errors) previously paid >`100 ms` just to initialize V8 and ES modules; Rust finishes in **`~15 ms`**.

---

## 3. Speed & Latency Benchmarks

### 3.1 E2E File Transfer (`test/cli.bench.mjs`, 128 MB over TCP loopback)

Includes spawning both processes, signaling, `scrypt` key derivation, disk I/O, AES-256-GCM encryption/decryption, and SHA-256 verification:

| Implementation | Total time | Effective throughput |
| :--- | :--- | :--- |
| **Node.js CLI** | `1.86 s` | `68.7 MB/s` (`550 Mbit/s`) |
| **Rust CLI** | `1.55 s` | `82.4 MB/s` (`660 Mbit/s`) |

**Analysis:** on a 128 MB local disk transfer, local I/O and fixed `scrypt` setup account for much of the wall clock (+20% / `0.31 s` faster). Rust's CPU advantage becomes dramatic on fast networks or sustained streams.

### 3.2 Pure Direct TCP Benchmark (`test/speed.bench.mjs`, 2.00 s per direction, in-memory AES-256-GCM)

| Implementation | Upload (Host) | Download (Host) | RTT Latency |
| :--- | :--- | :--- | :--- |
| **Node.js CLI** | `661.7 MB/s` (`5294 Mbit/s`, `1.3 GB/2.0s`) | `650.3 MB/s` (`5203 Mbit/s`, `1.3 GB/2.0s`) | `0.4 ms` |
| **Rust CLI** | `2697.3 MB/s` (`21579 Mbit/s`, `5.3 GB/2.00s`) | `2728.4 MB/s` (`21827 Mbit/s`, `5.3 GB/2.00s`) | `0.1 ms` (Guest `0.0 ms`) |

**Analysis:** without disk or physical NIC limits, Rust sustains **`>2.7 GB/s` (~`21.8 Gbit/s`) of real-time AES-256-GCM**, **>4×** higher than Node.js (`~650–662 MB/s`) by removing JS/C++ `Buffer` copies, per-chunk allocations, and GC pauses.

### 3.3 WebSocket Relay Benchmark (`test/speed.bench.mjs --relay` via Node.js `ws` server)

Both CLIs route through the exact same Node.js relay server on loopback:

| Implementation | Upload (Host) | Download (Host) | RTT Latency |
| :--- | :--- | :--- | :--- |
| **Node.js CLI** | `88.4 MB/s` (`707 Mbit/s`, `179 MB/2.0s`) | `67.2 MB/s` (`537 Mbit/s`, `136 MB/2.0s`) | `0.7 ms` |
| **Rust CLI** | `297.4 MB/s` (`2379 Mbit/s`, `622 MB/2.09s`) | `336.7 MB/s` (`2693 Mbit/s`, `809 MB/2.40s`) | `0.4 ms` |

**Analysis:** the previous `67–88 MB/s` ceiling was **not** in the Node.js WebSocket server — it was in the Node.js CLI client handling binary frames, AES-GCM, and backpressure. With the Rust client, the same Node.js server delivers **3.4×–5.0× higher throughput** (`297–337 MB/s`).

### 3.4 CLI ↔ Chrome Interoperability (`test/webrelay.bench.mjs`, 12 MB via WS relay, SHA-256 verified)

| Direction | Node.js CLI | Rust CLI | Notes |
| :--- | :--- | :--- | :--- |
| **CLI `send` → Chrome** | Handshake `0.71 s` · Transfer `0.50 s` (`23.9 MB/s`) | Handshake `0.72 s` · Transfer `0.59 s` (`20.2 MB/s`) | Technical tie; bound by Chrome WebCrypto/WS thread |
| **Chrome → CLI `recv`** | Handshake `0.54 s` · Transfer `0.25 s` (`48.2 MB/s`) | Handshake `0.36 s` · Transfer `0.26 s` (`46.9 MB/s`) | Identical transfer rate; Rust trims `0.18 s` from handshake |

**Analysis:** when one peer is a browser, Chrome's WebCrypto/WebSocket worker and the 8 MiB `cli-ack` window dominate, not the CLI binary.

---

## 4. Protocol Parity & Cross-Implementation Testing

1. **Binary interoperability JS `v0.12.0` ↔ Rust `v0.12.0`:** verified with a **`9,437,261-byte`** file and SHA-256 check across all 4 paths:
   - `Node send → Rust recv` (Direct TCP): **PASS**
   - `Node send → Rust recv` (WebSocket Relay): **PASS**
   - `Rust send → Node recv` (Direct TCP): **PASS**
   - `Rust send → Node recv` (WebSocket Relay): **PASS**
2. **Cross-language shared vectors ([`cli-rs/tests/shared_vectors_test.rs`](../cli-rs/tests/shared_vectors_test.rs)):** **8 tests** enforce bit-for-bit parity against [`public/shared/`](../public/shared/) (wordlists, codes, key derivation, AES-256-GCM, SAS, QR, `--only` globs, shell completions, Minisign).
3. **Rust test suite (`cargo test`):** **33 tests** across 5 suites (`network_test`, `shared_vectors_test`, `speed_test`, `system_test`, `transfer_test`), zero warnings under `cargo clippy --all-targets -- -D warnings`.

---

## 5. Engineering Assessment

### Clear Wins

- **Distribution & UX:** `5.38 MiB` binary vs `80.54 MiB` SEA baseline, `~15 ms` cold start, ~5× lower memory footprint.
- **Cleaner release pipeline:** removes `sea-config.json`, Node runtime tarball fetching, and `postject` / Mach-O re-signing hacks while preserving Minisign release verification with the same embedded public key in [`cli-rs/src/cli.rs`](../cli-rs/src/cli.rs).
- **Network headroom unlocked:** `>21 Gbit/s` encrypted in-memory TCP and `>2.3 Gbit/s` WS relay remove the CLI as a bottleneck on 2.5/10 Gbit/s Ethernet.
- **Clean architecture split:** signaling server remains minimal Node.js (2 dependencies: `express`, `ws`), while the user-installed binary is self-contained in `cli-rs/`.

### Real Costs

- **Dual `shared/` implementation:** changes to [`public/shared/`](../public/shared/) must be mirrored in [`cli-rs/src/shared/`](../cli-rs/src/shared/) per [`COMPATIBILITY.md`](COMPATIBILITY.md).
- **Cold build time:** a full local `release` build takes **`34.01 s`** on the test machine (incremental `dev` / `clippy` builds take a few seconds, and CI caches crates).
- **Cross-platform CI matrix:** [`.github/workflows/release.yml`](../.github/workflows/release.yml) builds native/musl binaries per platform (`windows-x64`, `linux-x64`, `linux-arm64`, `macos-arm64`).

### Verdict

Migrating the CLI to Rust is a **clear net win**: shrinking a standalone P2P binary from ~80 MiB to `5.38 MiB`, cutting active RAM to `~10 MB`, and increasing encrypted throughput by >`4×` eliminates the core limitations of Node.js SEA at a manageable cost in duplicated protocol constants (guarded by cross-language vector tests).
