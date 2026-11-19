<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/logo-light.svg">
  <img alt="drop logo" src="docs/assets/logo-dark.svg" width="230">
</picture>

<p>
  <strong>End-to-end encrypted peer-to-peer file transfer</strong> — from a browser or terminal.<br>
  No accounts, no cloud storage, no file size limits.
</p>

<p>
  <a href="https://github.com/Oloxx/drop/releases/latest"><img src="https://img.shields.io/github/v/release/Oloxx/drop?style=flat-square&color=22c55e&labelColor=111113" alt="Latest release"></a>
  <a href="https://github.com/Oloxx/drop/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/Oloxx/drop/ci.yml?branch=main&style=flat-square&label=CI&labelColor=111113" alt="CI status"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-f4f4f5?style=flat-square&labelColor=111113" alt="Apache 2.0 License"></a>
</p>

<p>
  <a href="https://drop.oloxx.dev"><strong>Try Live Web App</strong></a> ·
  <a href="#quick-start">Quick Start</a> ·
  <a href="#installation">Install</a> ·
  <a href="#usage">Usage</a> ·
  <a href="#architecture--security">Security</a> ·
  <a href="#self-hosting--development">Self-Hosting</a>
</p>

<p><strong>English</strong> · <a href="README.es.md">Español</a></p>

</div>

---

## Quick Start

### Option 1 · Browser (zero install)

Open **[`drop.oloxx.dev`](https://drop.oloxx.dev)** — drop, select, or paste (`Ctrl+V` / `Cmd+V`) files, screenshots, or text, then share the one-time code, link, or QR.

### Option 2 · Terminal CLI (full line speed)

```bash
# Install via Homebrew (macOS / Linux) or WinGet / Scoop (Windows)
brew install oloxx/tap/drop      # or: winget install Oloxx.drop
```

```bash
# Send a file, folder, or clipboard
drop send movie.mkv

# Receive on another machine (or from the browser)
drop recv 4271-lemon-radar-tiger-orbit
```

### Web vs. CLI at a Glance

| | Web ([`drop.oloxx.dev`](https://drop.oloxx.dev)) | Terminal CLI (`drop`) |
|---|---|---|
| **Best for** | Phones, tablets, quick browser transfers | Large files (ISOs, backups, videos, folder trees) |
| **Install** | Zero — open in any modern browser | Single static binary (~5.4 MB, zero runtime deps) |
| **Transport** | WebRTC DataChannel (or TURN) | Direct TCP + LAN UDP/mDNS + UPnP/NAT-PMP/STUN (or E2EE relay) |
| **Typical speed** | ~15 MB/s (browser SCTP limit) | **100–115 MB/s** on LAN; WAN bound by ISP link |
| **Interoperability** | Talks to Web and CLI | Talks to CLI and Web (all 4 combinations) |
| **Self-hosting** | Docker Compose / Node.js | Built-in `drop serve` (embedded web UI + WebSocket relay) |

---

## How It Works

* **Direct by default:** Peers exchange files directly over WebRTC DataChannels (browser) or direct TCP (CLI, with < 10 ms LAN discovery via IPv4 broadcast, IPv6 multicast, and mDNS). When NATs block direct sockets, traffic flows through a relay using end-to-end AES-256-GCM encryption — the server only forwards ciphertext.
* **Zero server secrets:** The share code separates routing from cryptography. Only the 4-digit room number touches the signaling server; the four BIP-39 words derive the encryption key locally and **never leave your device**.
* **Multi-receiver without extra uplink:** Browser transfers form a cut-through fanout chain (`Sender → A → B → C`) so sending to 5 people uploads only one copy from your connection.
* **Verifiable builds & web assets:** Every release is signed with Minisign and SHA-256, and `drop verify-web` lets you check byte-for-byte that any web instance matches GitHub's `public/` tree.

```text
  Sender                 Server                     Receiver
  │  1. Create room ─────► (returns "4271")            ▲
  │     + draw 4 words locally                         │
  │                                                    │
  │  2. Share 4271-lemon-radar-tiger-orbit ────────────┤ 3. Enter code or open link
  │◄── 4. Signaling (SDP/ICE or local/STUN IPs) ──────►│
  │                                                    │
  │  5. DIRECT E2EE P2P TRANSFER ─────────────────────►│
  └────────────────────────────────────────────────────┘
```

---

## Installation

### Quick Install (One-liner)

Downloads the latest release, verifies its `SHA256SUMS` hash, installs `drop` and adds it to your `PATH`:

```powershell
# Windows (PowerShell)
irm https://drop.oloxx.dev/install.ps1 | iex
```

```cmd
:: Windows (CMD)
curl -fsSL https://drop.oloxx.dev/install.cmd -o "%TEMP%\drop-install.cmd" && "%TEMP%\drop-install.cmd" && del "%TEMP%\drop-install.cmd"
```

```bash
# macOS & Linux
curl -fsSL https://drop.oloxx.dev/install.sh | sh
```

### Package Managers

```bash
# macOS & Linux (Homebrew)
brew install oloxx/tap/drop
```

```powershell
# Windows (WinGet — microsoft/winget-pkgs)
winget install Oloxx.drop

# Windows (Scoop)
scoop bucket add oloxx https://github.com/Oloxx/scoop-bucket
scoop install oloxx/drop
```

Managed installations upgrade through your package manager (`brew upgrade drop`, `winget upgrade Oloxx.drop`, or `scoop update drop`) rather than `drop update` — `drop` detects its install path and guides you automatically. All manifests are updated only after verifying the release `SHA256SUMS.minisig` signature ([homebrew-tap](https://github.com/Oloxx/homebrew-tap), [scoop-bucket](https://github.com/Oloxx/scoop-bucket), [`scripts/winget.mjs`](scripts/winget.mjs)).

### Direct Downloads (`v0.14.1`)

Standalone static binaries with zero external dependencies (no Node.js or Visual C++ Redistributable) from the [v0.14.1 Release](https://github.com/Oloxx/drop/releases/tag/v0.14.1):

| Platform | Binary | Install |
|---|---|---|
| **Windows (x64)** | [`drop-v0.14.1-windows-x64.exe`](https://github.com/Oloxx/drop/releases/download/v0.14.1/drop-v0.14.1-windows-x64.exe) | Double-click or run `install` (copies to `%LOCALAPPDATA%\Programs\drop\` & adds to `PATH`) |
| **Linux (x64)** | [`drop-v0.14.1-linux-x64.tar.gz`](https://github.com/Oloxx/drop/releases/download/v0.14.1/drop-v0.14.1-linux-x64.tar.gz) | `tar -xzf drop-v0.14.1-linux-x64.tar.gz && ./drop-v0.14.1-linux-x64 install` |
| **Linux (ARM64)** | [`drop-v0.14.1-linux-arm64.tar.gz`](https://github.com/Oloxx/drop/releases/download/v0.14.1/drop-v0.14.1-linux-arm64.tar.gz) | `tar -xzf drop-v0.14.1-linux-arm64.tar.gz && ./drop-v0.14.1-linux-arm64 install` |
| **macOS (Apple Silicon)** | [`drop-v0.14.1-macos-arm64.tar.gz`](https://github.com/Oloxx/drop/releases/download/v0.14.1/drop-v0.14.1-macos-arm64.tar.gz) | `tar -xzf drop-v0.14.1-macos-arm64.tar.gz && ./drop-v0.14.1-macos-arm64 install` |

<details>
<summary><strong>Verify downloads with Minisign & SHA-256</strong></summary>

Every release includes `SHA256SUMS` and its Ed25519 signature `SHA256SUMS.minisig`. Checking both confirms who published the release and that the binary arrived intact:

```bash
# 1. Verify signature (releases v0.5.2+) with minisign
minisign -Vm SHA256SUMS -P RWQqNnfqvCrj+eavJ9njz2vCoHaC8YnLqjsvNBMndz3hBroQLpou7+Kp

# 2. Verify binary checksum (Linux / macOS)
sha256sum -c SHA256SUMS --ignore-missing
```

```powershell
# 2. Verify binary checksum (Windows PowerShell)
Get-FileHash drop-v0.14.1-windows-x64.exe -Algorithm SHA256
```

`drop update` automatically runs both Minisign and SHA-256 verification before replacing the executable and aborts on any mismatch (`--allow-unsigned` is required for pre-`v0.5.2` releases). Installed standalone binaries also check for updates silently in the background (at most once every 24h) and apply verified releases for the next run; package-manager installs only print an upgrade hint. Set `DROP_NO_AUTO_UPDATE=1` to disable background checks.

</details>

<details>
<summary><strong>macOS Gatekeeper & Windows SmartScreen warnings</strong></summary>

Releases are signed with the project's Minisign key rather than paid Apple Developer or Microsoft Authenticode certificates, so browser-downloaded binaries trigger an OS quarantine prompt on first run. Downloading via `curl` / `curl.exe` (or installing via Homebrew / WinGet / Scoop) avoids quarantine flags completely:

```bash
# macOS (Apple Silicon)
curl -LO https://github.com/Oloxx/drop/releases/download/v0.14.1/drop-v0.14.1-macos-arm64.tar.gz
tar -xzf drop-v0.14.1-macos-arm64.tar.gz && ./drop-v0.14.1-macos-arm64 install
```

```powershell
# Windows (curl.exe is preinstalled on Windows 10 & 11)
curl.exe -LO https://github.com/Oloxx/drop/releases/download/v0.14.1/drop-v0.14.1-windows-x64.exe
.\drop-v0.14.1-windows-x64.exe
```

If already downloaded in a browser:
- **macOS:** run `xattr -d com.apple.quarantine ./drop-v0.14.1-macos-arm64`, or open **System Settings → Privacy & Security → Open Anyway**.
- **Windows:** click **More info → Run anyway** in SmartScreen, or run `Unblock-File .\drop-v0.14.1-windows-x64.exe` in PowerShell.

</details>

---

## Usage

### Web App (`https://drop.oloxx.dev`)

1. **Send:** Drop, browse, or paste (`Ctrl+V` / `Cmd+V`) files, screenshots, or text (`clipboard.txt`) and click **open channel**. Share the code, direct link (`#code`), or locally rendered **qr** ([`public/shared/qr.js`](public/shared/qr.js)). Keep the tab open until transfers finish; multiple receivers can join the same channel.
2. **Receive:** Open the link or paste the code under **receive · enter a code**. Uncheck files to skip or enable **download as .zip** (auto-enabled for 4+ files or CLI folder trees, streaming ZIP64 via [`public/shared/zip.js`](public/shared/zip.js)).
   * **< 32 MB:** buffered in memory (`Blob`) and saved after SHA-256 passes.
   * **>= 32 MB or streamed `.zip`:** written directly to disk via the Service Worker ([`public/sw.js`](public/sw.js)) with constant RAM usage; if SHA-256 fails on completion, the HTTP download stream is aborted cleanly.
3. **Speed test (`/speed`):** Open [`https://drop.oloxx.dev/speed`](https://drop.oloxx.dev/speed) between two browsers to check RTT, bidirectional throughput, and direct vs. TURN path.

### Terminal CLI (`drop`)

| Command | Purpose |
|---|---|
| `drop send <paths...>` | Send files, folders, `--text`, `--clipboard`, or `stdin` (`-`) |
| `drop recv <code\|url>` | Receive files with selective globs, atomic `.part` writes, and resume |
| `drop speed [code\|url]` | Measure RTT, bidirectional speed, and path (direct vs. relay) |
| `drop serve` | Run an offline/LAN web UI + WebSocket signaling & relay server |
| `drop config` | Interactive setup menu & persistent default preferences (`config.json`) |
| `drop verify-web [url]` | Verify a live Drop web server against GitHub commit blobs |
| `drop update` | Self-update from GitHub Releases with Minisign + SHA-256 verification |
| `drop install` / `uninstall` | Install or remove binary from user `PATH` |
| `drop completion <shell>` | Print shell completions (`bash`, `zsh`, `fish`, `powershell`) |

#### Sending (`drop send`)

```bash
drop send movie.mkv                          # single file
drop send a.jpg b.pdf photos/                # multiple files & entire folder trees
drop send movie.mkv --limit 10M --once       # cap bandwidth (500K, 10M, 1.5G) & exit after 1 download
drop send backup.tar -y --expire 30m --no-qr # auto-accept peers, close room in 30m, hide terminal QR
drop send --text "wifi password"             # send text as message.txt
drop send --clipboard                        # send OS clipboard as clipboard.txt
tar czf - src/ | drop send - --name src.tgz  # stream stdin (single receiver, implies --once)
```

* Folder transfers preserve relative paths and skip symlinks and empty directories; receivers strictly reject traversal segments (`../`).
* Before sending any metadata or file bytes, `drop` shows the peer IP, transport, and 3-word session fingerprint (`SAS`) and prompts `(S/n)` unless `-y` / `--yes` is passed (or `stdin` is non-interactive).

#### Receiving (`drop recv`)

```bash
drop recv 4271-lemon-radar-tiger-orbit
drop recv "4271 LEMON Radar tiger orbit"     # spaces, mixed case, or 4-letter word prefixes accepted
drop recv https://drop.oloxx.dev/#4271-lemon-radar-tiger-orbit
drop recv 4271-lemon-radar-tiger-orbit -o ./downloads --only "*.jpg,photos/**"
drop recv 4271-lemon-radar-tiger-orbit --overwrite --limit 2M --no-resume
drop recv 4271-lemon-radar-tiger-orbit --stdout | tar xzf -
```

* **Atomic & safe:** downloads write to `<name>.part` and rename only after SHA-256 verification. Existing files are preserved as `name (2).ext` unless `--overwrite` is set.
* **Automatic resume:** interrupted transfers verify the `.part` prefix SHA-256 against the sender (CLI or Web) and resume from that byte offset (`--no-resume` starts fresh).
* **Piping (`--stdout` / `-o -`):** progress prints to `stderr`, and verified bytes emit to `stdout` after SHA-256 confirmation.

#### Default Preferences (`drop config`)

```bash
drop config                                  # interactive menu to toggle & edit defaults
drop config init                             # step-by-step initial setup wizard
drop config show                             # display active settings and their origin (config / env / default)
drop config set out ~/Downloads              # save a single preference (also: get, unset, reset, path)
```

* Saved to `%APPDATA%\drop\config.json` (Windows) or `$XDG_CONFIG_HOME/drop/config.json` / `~/.config/drop/config.json` (Linux/macOS); override path with `DROP_CONFIG` or `DROP_CONFIG_DIR`.
* Precedence is strictly **CLI flags > environment variables (`DROP_SERVER`, `DROP_NO_AUTO_UPDATE`) > `config.json` > built-in defaults**. Override saved preferences on any command with `--no-config`, `--no-once`, `--no-yes`, `--qr`, `--no-overwrite`, `--resume`, `--no-relay`, `--no-expire`, `--no-direct-only`, or `--limit 0`.

#### Standalone Server, Speed Test & Integrity Check

```bash
drop serve                                   # embedded static web + WS relay on port 3000 (0.0.0.0 & ::)
drop serve -p 8080 -H 127.0.0.1              # pass -s http://<lan-ip>:8080 (or DROP_SERVER) to peers

drop speed                                   # host bidirectional CLI speed test (--direct-only, --relay, -t <s>)
drop verify-web https://drop.oloxx.dev       # verify served public/ files match /version commit (uses GITHUB_TOKEN if set)
```

<details>
<summary><strong>Shell completions & CLI self-management</strong></summary>

```bash
eval "$(drop completion bash)"                                  # ~/.bashrc
eval "$(drop completion zsh)"                                   # ~/.zshrc
drop completion fish > ~/.config/fish/completions/drop.fish     # fish
drop completion powershell | Out-String | Invoke-Expression     # $PROFILE
```

```bash
drop update       # download & verify latest signed release
drop install      # install binary to PATH
drop uninstall    # remove binary & PATH entry
drop --help       # full option reference
```

</details>

---

## Compatibility & Performance

All four CLI/Web pairs work seamlessly under frozen **Protocol 5** ([`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md), [`docs/PROTOCOL.md`](docs/PROTOCOL.md)):

| Sender → Receiver | Transport | Encryption | Resume across cuts |
|---|---|---|---|
| **Web → Web** | WebRTC DataChannel (direct or TURN) | DTLS | Starts over (recovers mid-session if a chain peer drops) |
| **CLI → CLI** | Direct TCP (LAN, UPnP/NAT-PMP, STUN, IPv4/IPv6) or WS relay | AES-256-GCM (scrypt) | Yes (direct TCP & relay; not `stdin` pipes) |
| **CLI → Web** | Encrypted WebSocket relay | AES-256-GCM (scrypt) | No (browsers cannot append to prior Downloads files) |
| **Web → CLI** | Encrypted WebSocket relay | AES-256-GCM (scrypt) | Yes (`.part` prefix verified via SHA-256) |

### Expected Speeds

| Path | How peers connect | Typical speed |
|---|---|---|
| **CLI ↔ CLI (LAN)** | Parallel IPv4 broadcast + IPv6 multicast (`ff02::1:42424`) + mDNS (`_drop._tcp.local`) + `TCP_NODELAY` | **100–115 MB/s** (saturates Gigabit / Wi-Fi 6) |
| **CLI ↔ CLI (WAN direct)** | Global IPv6, UPnP / NAT-PMP (`5351`), or forwarded `-p` port | Full ISP upload/download bandwidth |
| **CLI ↔ CLI (relay) / CLI ↔ Web** | End-to-end `AES-256-GCM` WebSocket relay | Server bandwidth & `DROP_RELAY_LIMIT` |
| **Web ↔ Web** | Direct WebRTC DataChannel (or TURN fallback) | **~15 MB/s** direct (browser SCTP ceiling) |

---

## Architecture & Security

### Split-Code Model

| Component | Role | Exposed to server / LAN? |
|---|---|---|
| `4271` | Public ephemeral room ID | Yes (sent to server; hashed as `roomHash` in LAN pings) |
| `lemon-radar-tiger-orbit` | Shared secret drawn locally from BIP-39 (2048 words) | **Never** (neither plaintext nor hashed) |

* **Key derivation & verification:** 4 BIP-39 words (**44 bits**) are stretched with **`scrypt`** (`N = 32768`, `r = 8`, `p = 1`, 32 MiB RAM) salted with `SHA-256("drop-code-v2|" + roomId)`. Peers verify knowledge before any metadata leaves and compute a 3-word **SAS fingerprint** (`beef-grit-two`) from DTLS fingerprints or the derived key for out-of-band MITM checks.
* **Transport optimization:** The Rust CLI (`cli/`) negotiates LAN discovery in < 10 ms and uses hardware `AES-NI` acceleration for AES-256-GCM; the web engine (`public/app.js`) uses reactive watermarks (`HIGH_WATER = 8 MB`, `LOW_WATER = 1 MB`) over ordered DataChannels.
* **Known trade-offs:** No paid third-party cryptographic audit; no PAKE (relies on rate limiting and room burning on brute force); and a compromised web server can serve targeted malicious JS to one browser even if `drop verify-web` passes elsewhere (run the native CLI or local `drop serve` for high-assurance transfers). See [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md) and [`SECURITY.md`](SECURITY.md).

---

## Self-Hosting & Development

### Docker Compose (Production Stack)

```bash
cp .env.example .env
docker compose up -d --build
```

Spins up the stateless Node.js signaling server, **Caddy** (automatic Let's Encrypt HTTPS), and **coturn** (ephemeral HMAC TURN credentials). See [`DEPLOY-VPS.md`](DEPLOY-VPS.md) for firewall rules, `DROP_RELAY_LIMIT`, and secret rotation.

### Local Build & Test

Requires **Node.js >= 22.9** and **Rust / Cargo (stable)**:

```bash
npm install
npm run dev           # local signaling server on http://localhost:3000
npm run build:cli     # build release CLI binary into cli/target/release/drop(.exe)
npm run cli -- send file.bin

cargo test --manifest-path cli/Cargo.toml
npm test              # full integration, serve, security header & Chrome E2E suite
```

Cross-platform release targets (`build:exe`, `build:linux`, `build:arm`, `build:macos`) and throughput benchmarks (`bench`, `bench:cli`, `bench:speed`, `bench:fanout`, `bench:webrelay`) are defined in [`package.json`](package.json).

---

## Documentation & License

| Document | Contents |
|---|---|
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Environment setup, benchmarks, coding conventions, release checklist |
| [`docs/PROTOCOL.md`](docs/PROTOCOL.md) | Frozen Protocol 5 wire frames, signaling limits, E2EE & flow control |
| [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md) | Cross-version & CLI/Web compatibility guarantees |
| [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md) | Full security boundaries, attack vectors, and trade-offs |
| [`docs/RUST-MIGRATION.md`](docs/RUST-MIGRATION.md) | Rust CLI architecture and benchmarks vs. legacy Node.js SEA |
| [`DEPLOY-VPS.md`](DEPLOY-VPS.md) | VPS setup, firewall ports, Caddy, TURN, monitoring |
| [`SECURITY.md`](SECURITY.md) | Vulnerability disclosure policy and supported versions |
| [`CHANGELOG.md`](CHANGELOG.md) | Version history (Spanish) |
| [`ROADMAP.md`](ROADMAP.md) | Progress toward `v1.0` |

Licensed under the [Apache License 2.0](LICENSE).
