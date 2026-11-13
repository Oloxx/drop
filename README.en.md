[Español](README.md) | **English**

# Drop 📦⚡

End-to-end encrypted P2P file transfer with no accounts and no file size limits.

Files travel **directly between devices**: the signaling server only pairs peers (or forwards E2EE encrypted noise when a direct route is unavailable) and never sees your words or plaintext files.

```text
  You                    Server                     Receiver
  │  1. Create room ─────► (returns "4271")            ▲
  │     + draw 4 words locally                         │
  │                                                    │
  │  2. Share 4271-lemon-radar-tiger-orbit ────────────┤ 3. Type code or open link
  │◄── 4. Signaling (SDP/ICE or local/STUN IPs) ──────►│
  │                                                    │
  │  5. DIRECT E2EE P2P TRANSFER ─────────────────────►│
  └────────────────────────────────────────────────────┘
```

The code has two halves with separate roles: **`4271` identifies the room** and is the only part sent to the server; **the four words are the shared secret** used to derive the encryption key and never leave your device. Details in [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md).

---

## 🚀 Two Ways to Use Drop

| Feature | 🌐 Drop Web | 💻 Drop CLI (`drop`) |
|---|---|---|
| **Best for** | Friends, phones, tablets, quick sends | Large files (ISOs, backups, videos, folders) |
| **Install** | **Zero**. Open the browser | **Single binary** (no runtime dependencies) |
| **Transport** | WebRTC DataChannel (or TURN) | Direct TCP + LAN UDP + UPnP/STUN (or E2EE relay) |
| **Speed** | ~15 MB/s (browser SCTP limit) | **100–115 MB/s** on LAN; WAN depends on route (see below) |
| **Interoperability** | Talks to Web and CLI | Talks to CLI and Web (all 4 combinations) |

---

## 📥 Downloads (Version v0.11.0)

Standalone executables (no Node.js required) on the [v0.11.0 Release](https://github.com/Oloxx/drop/releases/tag/v0.11.0):

* **Windows (x64):** [`drop-v0.11.0-windows-x64.exe`](https://github.com/Oloxx/drop/releases/download/v0.11.0/drop-v0.11.0-windows-x64.exe)
* **Linux (x64):** [`drop-v0.11.0-linux-x64.tar.gz`](https://github.com/Oloxx/drop/releases/download/v0.11.0/drop-v0.11.0-linux-x64.tar.gz)
* **Linux (ARM64):** [`drop-v0.11.0-linux-arm64.tar.gz`](https://github.com/Oloxx/drop/releases/download/v0.11.0/drop-v0.11.0-linux-arm64.tar.gz) *(Raspberry Pi, Oracle ARM VPS, AWS Graviton)*
* **macOS (Apple Silicon):** [`drop-v0.11.0-macos-arm64.tar.gz`](https://github.com/Oloxx/drop/releases/download/v0.11.0/drop-v0.11.0-macos-arm64.tar.gz) *(M1, M2, M3, M4)*
* **macOS (Intel):** [`drop-v0.11.0-macos-x64.tar.gz`](https://github.com/Oloxx/drop/releases/download/v0.11.0/drop-v0.11.0-macos-x64.tar.gz)

### Verify your download

Every release publishes `SHA256SUMS` and an Ed25519 signature `SHA256SUMS.minisig`. Verify the signature with [minisign](https://jedisct1.github.io/minisign/) and then the binary hash:

```bash
minisign -Vm SHA256SUMS -P RWQqNnfqvCrj+eavJ9njz2vCoHaC8YnLqjsvNBMndz3hBroQLpou7+Kp

# Linux / macOS
sha256sum -c SHA256SUMS --ignore-missing
```

```powershell
# Windows (PowerShell)
Get-FileHash drop-v0.11.0-windows-x64.exe -Algorithm SHA256
```

`drop update` checks both the minisign signature and the SHA-256 hash automatically before replacing the executable.

---

## 🛠️ Installation

### Package managers (recommended)

```bash
# macOS and Linux via Homebrew
brew install oloxx/tap/drop
```

```powershell
# Windows via Scoop
scoop bucket add oloxx https://github.com/Oloxx/scoop-bucket
scoop install oloxx/drop
```

Upgrade via `brew upgrade drop` or `scoop update drop` (the CLI detects package-manager installs and points you to the manager instead of self-updating). Both manifests are regenerated automatically only after verifying the release `SHA256SUMS.minisig` signature.

### Manual installation

- **Windows:** download [`drop-v0.11.0-windows-x64.exe`](https://github.com/Oloxx/drop/releases/download/v0.11.0/drop-v0.11.0-windows-x64.exe) and double-click it (installs to `%LOCALAPPDATA%\Programs\drop\` and adds it to `PATH`), or install from terminal via `curl.exe`:
  ```powershell
  curl.exe -LO https://github.com/Oloxx/drop/releases/download/v0.11.0/drop-v0.11.0-windows-x64.exe
  .\drop-v0.11.0-windows-x64.exe
  ```
- **Linux / macOS:**
  ```bash
  curl -LO https://github.com/Oloxx/drop/releases/download/v0.11.0/drop-v0.11.0-linux-x64.tar.gz
  tar -xzf drop-v0.11.0-linux-x64.tar.gz && ./drop-v0.11.0-linux-x64 install
  ```

> **macOS Gatekeeper & Windows SmartScreen:** Binaries are signed with the project's minisign key, not paid Apple/Microsoft certificates. Downloading with `curl`/`curl.exe` or a package manager avoids browser quarantine warnings. If downloaded via browser, clear quarantine with `xattr -d com.apple.quarantine ./drop-*` (macOS) or `Unblock-File .\drop-*.exe` (PowerShell).

---

## 📖 Usage

### Web (`https://drop.oloxx.dev`)

1. **Send:** drop files or folders (*pick a folder*), click **open channel**, and share the code (`4271-lemon-radar-tiger-orbit`), link, or generated QR code.
2. **Receive:** open the link or enter the code, uncheck any files you do not want, and click **receive**. Chrome/Edge stream multi-file/folder/large transfers directly to disk via File System Access; Firefox, Safari, and Chrome without a folder stream via Service Worker ([`public/sw.js`](public/sw.js)) with SHA-256 verification.
3. **Speed test:** open `/speed` to measure RTT and WebRTC/TURN throughput.

### CLI (`drop`)

#### Send (`drop send`)

```bash
drop send movie.mkv
drop send file1.jpg file2.pdf photos/
drop send backup.tar --once --expire 10m     # close after first download or 10 minutes
drop send large.iso --limit 10M              # cap upload bandwidth (K, M, G bytes/s)
drop send --text "wifi password..."          # send text as message.txt
drop send --clipboard                        # send clipboard as clipboard.txt
tar czf - project/ | drop send - --name project.tgz   # stream from stdin
```

#### Receive (`drop recv`)

```bash
drop recv 4271-lemon-radar-tiger-orbit
drop recv "4271 LEMON Radar tiger orbit"       # case/spaces/4-letter prefixes accepted
drop recv https://drop.oloxx.dev/#4271-lemon-radar-tiger-orbit
drop recv 4271-lemon-radar-tiger-orbit -o ./downloads
drop recv 4271-lemon-radar-tiger-orbit --only "*.jpg,photos/**"
drop recv 4271-lemon-radar-tiger-orbit --stdout | tar xzf -
```

Interrupted transfers leave `.part` files and automatically resume after SHA-256 prefix verification (use `--no-resume` to start over or `--overwrite` to replace existing files).

#### Other commands

```bash
drop speed [code]                 # measure RTT and throughput between two CLI peers
drop verify-web [url]             # verify served public/ files match the repo commit in /version
drop update                       # self-update with minisign + SHA-256 verification
drop completion bash|zsh|fish|powershell
```

---

## ⚡ Interoperability & Expected Speeds

All four combinations (`Web ↔ Web`, `CLI ↔ CLI`, `CLI → Web`, `Web → CLI`) interoperate seamlessly under frozen protocol `5` ([docs/COMPATIBILITY.md](docs/COMPATIBILITY.md), [docs/PROTOCOL.md](docs/PROTOCOL.md)):

| Path | How it connects | Typical speed |
|---|---|---|
| **CLI ↔ CLI on LAN** | UDP broadcast + direct TCP over private IP | **100–115 MB/s** (saturates Gigabit / Wi-Fi 6) |
| **CLI ↔ CLI over WAN (direct)** | Global IPv6, UPnP, or forwarded `-p` port (public IP discovered via UPnP / STUN / server) | Limited by your upload/download ISP bandwidth |
| **CLI ↔ CLI over WAN (relay) or CLI ↔ Web** | End-to-end encrypted (`AES-256-GCM`) WebSocket relay via server | Depends on VPS bandwidth and `DROP_RELAY_LIMIT` |
| **Web ↔ Web** | WebRTC DataChannel direct (or TURN on strict NATs) | **~15 MB/s** direct (browser SCTP limit); TURN depends on server |

---

## 🔐 Security

- **44-bit secret + `scrypt` (`N=32768, r=8, p=1`):** 32 MiB RAM and ~62 ms per attempt; `roomId` acts only as salt (`drop-code-v2|<roomId>`), never as a secret.
- **Session fingerprint (SAS):** 3 BIP-39 words computed locally from DTLS fingerprints (WebRTC) or the scrypt-derived key (CLI) to detect active MITM attacks when compared out-of-band.
- **Full threat model & security policy:** see [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md) and [SECURITY.md](SECURITY.md).

---

## 💻 Local Development & Self-Hosting

Requires **Node.js >= 18** (CI and release binaries target Node 22):

```bash
npm install
npm run dev        # local signaling server on http://localhost:3000
npm test           # runs full test suite (starts ephemeral server automatically)
npm run build:all  # builds standalone SEA binaries for Windows, Linux, macOS
```

To self-host with automatic HTTPS (Caddy) and `coturn` TURN:

```bash
cp .env.example .env
docker compose up -d --build
```

Full deployment, backup, and secret rotation guide: [DEPLOY-VPS.md](DEPLOY-VPS.md).

---

## 📄 License

[Apache License 2.0](LICENSE)
