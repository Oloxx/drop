# Road to 1.0

What remains for **drop** to move from `0.x` to `1.0`. Under SemVer, once `1.0` ships, the protocol, code format, and CLI interface cannot break without bumping the major version. This list tracks what must be **decided or closed** before locking that contract.

## Protocol & Compatibility

Frozen at `1.0`; breaking changes afterwards require a major version.

- [x] **Freeze `PROTOCOL_VERSION`** and document the compatibility policy: version `5` for all `1.x`, specified in [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md), reserving `features` for future capabilities and enforcing via `test/compat.test.mjs`.
- [x] **Specify the DataChannel protocol:** [`docs/PROTOCOL.md`](docs/PROTOCOL.md) covers signaling, JSON/binary frames, the relay chain, in-band vs control routing, and `1.x` compatibility rules.
- [x] **Remove v0.3.5 legacy path:** removed in `v0.8.0` (`server/index.js` returns `VERSION` without `v: 2`, and `parseCode` rejects legacy tokens).
- [x] **Interoperability matrix in the README:** Web↔Web, CLI↔CLI, CLI→Web, Web→CLI with transports and resume behavior.
- [x] **Cross-session resume everywhere possible** (#58): Web→CLI resumes `.part` files after SHA-256 prefix verification; README documents why browser downloads cannot append across sessions.
- [x] **IPv6 direct paths and LAN discovery** (#37): global IPv6 in `ips`, dual-stack listener, and UDP IPv6 multicast (`ff02::1:42424`) in [`cli/src/discovery.rs`](cli/src/discovery.rs).
- [x] **mDNS / DNS-SD LAN discovery** (#38): [`cli/src/mdns.rs`](cli/src/mdns.rs) advertises and queries `_drop._tcp.local` (`224.0.0.251:5353` and `[ff02::fb]:5353`) without external dependencies or leaking the 4-word secret, degrading cleanly if port `5353` cannot bind.

## Robustness

- [x] **Streaming downloads without File System Access** (#55): Service Worker in [`public/sw.js`](public/sw.js) streams downloads via HTTP response (verified in Chrome; Safari/iOS verification tracked below).
- [x] **CLI-to-CLI over WAN** (#11): [`cli/src/stun.rs`](cli/src/stun.rs) queries STUN (RFC 5389) in parallel, [`cli/src/natpmp.rs`](cli/src/natpmp.rs) adds automatic NAT-PMP (RFC 6886) fallback alongside UPnP, and the README documents realistic speeds per path.
- [x] **Unix pipes** (#29): `drop send -` streams unknown-size `stdin` (`size: null`, `--stdout` already supported).
- [ ] **Real desktop Safari & iOS end-to-end testing** for web transfers (SCTP, `maxMessageSize`, Service Worker / Blob sinks). Currently measured on Chrome only.
- [x] **Browser E2E tests in CI:** `test/web.test.mjs` runs inside `npm test` using Chrome and CI enforces `DROP_REQUIRE_CHROME=1` on Linux.
- [x] **Clear error reporting on all disconnect paths:** web routes failures through `recvDead()`; CLI explains rejections and preserves `.part` files.

## Server & Deployment

- [x] **WebSocket relay bandwidth quotas** (#56): `DROP_RELAY_LIMIT` (per room) and `DROP_RELAY_LIMIT_TOTAL` (process-wide) pause socket reads via backpressure without dropping transfers.
- [x] **Operational metrics on `/healthz`:** active rooms, guests, relayed bytes/frames, throttle pauses, and rejection counters by reason.
- [x] **Single-instance architecture:** rooms live in process memory (`DEPLOY-VPS.md`).
- [x] **Secret backup and rotation guide:** documented in [`DEPLOY-VPS.md`](DEPLOY-VPS.md) for `TURN_SECRET` and `DROP_SIGNING_KEY`.
- [x] **`npm audit` and dependency checks in CI:** `audit` job in `.github/workflows/ci.yml` gates production dependencies and guards `dependencies` count.

## CLI Distribution

- [x] **macOS signing** (#24): native Rust binary signed ad hoc with `codesign --sign - --force` for Apple Silicon (`aarch64-apple-darwin`), without paid notarization (documented in README).
- [x] **Windows without paid Authenticode** (#57): static CRT build (`+crt-static`) with SmartScreen/Minisign verification documented in README.
- [x] **Package managers** (#40): **Homebrew** (`Oloxx/homebrew-tap`), **Scoop** (`Oloxx/scoop-bucket`), and **WinGet** (`Oloxx.drop` via [`scripts/winget.mjs`](scripts/winget.mjs) and `release.yml`), all verifying `SHA256SUMS.minisig` and detected by [`cli/src/pkgmgr.rs`](cli/src/pkgmgr.rs). npm distribution was dropped after migrating to native Rust (`cli/`).
- [ ] **`drop update` tested end-to-end against a real release** across all three platforms before each release (currently covered by unit tests in `cli/src/minisign.rs`, not E2E).
- [x] **Shell completions & `--help` coverage:** `drop completion bash|zsh|fish|powershell` ([`cli/src/completion.rs`](cli/src/completion.rs)) enforced against parser flags in [`test/version.test.mjs`](test/version.test.mjs).

## Security

- [x] **Threat model document:** [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md), linked from [`SECURITY.md`](SECURITY.md).
- [x] **Formal internal cryptography pass:** verified constant-time `verifyProof`, scrypt/AEAD parameter checks, and official test vectors (FIPS 180-4, RFC 4231, RFC 6070, RFC 7914) in [`test/e2ee.test.mjs`](test/e2ee.test.mjs) and [`cli/tests/shared_vectors_test.rs`](cli/tests/shared_vectors_test.rs). No paid external audit (documented in `SECURITY.md` and `docs/THREAT-MODEL.md`).
- [x] **`SECURITY.md`:** vulnerability reporting, supported versions, and threat model summary.
- [x] **Web integrity verification (`drop verify-web`):** compares served `public/` assets against the GitHub commit reported by `/version`.

## Web

- [x] **Per-file selection on receiver** (#10): checkboxes in web offer and `drop recv --only <patterns>` using `files` manifest indices (Protocol 5).
- [x] **Basic accessibility:** visible focus outlines, `aria-live` announcements, `progressbar` semantics, WCAG AA contrast checked by `test/a11y.test.mjs`, and keyboard-accessible file picker.
- [x] **Unsupported WebRTC fallback view:** explicit `unsupported` view showing the share code instead of failing silently.

## Documentation & Tooling

- [x] **Bilingual README (`README.md` in English + `README.es.md` in Spanish):** synced download links checked by [`test/version.test.mjs`](test/version.test.mjs).
- [x] **Embedded web & signaling server (`drop serve`, #39):** [`cli/src/commands/serve.rs`](cli/src/commands/serve.rs) and [`cli/build.rs`](cli/build.rs) embed `public/` into the single native binary with `/config`, `/healthz`, `/version`, CSP headers, and WebSocket signaling/relay.
- [x] **Release checklist:** documented in [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Non-Goals for 1.0

- Redis / multi-instance clustering.
- User accounts, transfer history, or persistent links (Drop is ephemeral by design).
- In-browser file previews on the receiver (second half of #10 — nice to have, not required for 1.0).
- Any third-party network requests from the web client.
