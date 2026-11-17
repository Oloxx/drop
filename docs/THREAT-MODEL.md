# Drop Threat Model

Detailed security guarantees across every transfer and distribution path, what each intermediary observes, and explicit boundaries. For a concise summary and vulnerability reporting instructions, see [`SECURITY.md`](../SECURITY.md).

---

## 1. Actors and Visibility

| Actor | Sees | Does NOT see |
|---|---|---|
| **Signaling server** (`server/index.js`) | Public 4-digit room ID (`4271`), sender/receiver IPs, WebRTC SDP/ICE, `cli-offer`/`cli-proof`, and encrypted relay payloads (`cli-sealed` + AES-GCM chunks) when relay is used | The four code words, the derived AES key, CLI filenames/sizes, or any plaintext file byte |
| **TURN server** (`coturn`) | Peer IPs and end-to-end DTLS-encrypted WebRTC packets | DataChannel contents or permanent credentials (uses ephemeral HMAC tokens valid for `TURN_TTL_SECONDS`) |
| **LAN neighbor** (UDP `42424` / mDNS `5353`) | `roomHash = sha256(roomId).slice(0, 16)` and sender's local TCP port | The four words, manifest, or file data (without the `scrypt` key, AES-GCM rejects the first TCP packet) |
| **Passive network observer / ISP** | IPs, timing, traffic volume, and SNI/DNS; payloads are wrapped in DTLS (WebRTC) or AES-256-GCM (TCP and relay) | Filenames or plaintext file contents |
| **Peer holding the code** | Offered files (or selected `--only` / checkbox subset) once approved by sender | Any other files outside the transfer |

---

## 2. Four-Word Code & Key Derivation

`4271-lemon-radar-tiger-orbit` separates routing from secret entropy ([`public/shared/codes.js`](../public/shared/codes.js)):

- **Public room ID (`4271`, 4 digits, 10,000 rooms):** routes signaling and computes LAN `roomHash`. **Contributes zero secrecy.**
- **Shared secret (`lemon-radar-tiger-orbit`, 4 words from 2048-word BIP-39 list):** $4 \times 11 = 44\text{ bits}$ of entropy generated client-side (`OsRng` in Rust, `crypto.getRandomValues` in browsers). Never sent to the server.

### Derivation (`scrypt`)

Both the CLI ([`cli-rs/src/crypto.rs`](../cli-rs/src/crypto.rs)) and browser ([`public/shared/e2ee.js`](../public/shared/e2ee.js), [`public/shared/scrypt.js`](../public/shared/scrypt.js)) derive the 256-bit key via:

```text
salt = SHA-256("drop-code-v2|" + roomId)
key  = scrypt(secret, salt, N=32768, r=8, p=1, dkLen=32)
```

- **Cost per guess:** 32 MiB RAM and ~62 ms native (~0.3 s in browser JS).
- **Offline brute-force resistance:** against captured TCP/relay ciphertext or a `cli-proof`, testing the $2^{44}$ space against `scrypt` requires $\sim 2^{44} \times 0.062\text{ s} \approx 3.5 \times 10^{10}$ CPU-years, memory-bandwidth bound.
- **Domain separation:** `roomId` enters the salt (`drop-code-v2|<roomId>`), so identical words in different rooms yield distinct keys.

### Online Brute-Force Defenses

[`server/index.js`](../server/index.js) enforces:

1. **`JOIN_FAIL_MAX = 20` per IP every 60 s (`RATE_LIMITED`):** scanning all 10,000 room IDs from one IP takes ~8 hours, while idle rooms expire in minutes (`DROP_ROOM_TTL_MS`, 30 min default).
2. **`BAD_GUEST_MAX = 5` (`BURNED`):** five failed secret proofs reported by the sender (`bad-guest`) permanently burn and close the room.
3. **Constant-time verification:** the CLI validates `cli-proof` (`HMAC-SHA256(key, "drop-proof-v3|" + nonce)`) in constant time via `subtle::ConstantTimeEq` (`verify_proof` in [`cli-rs/src/crypto.rs`](../cli-rs/src/crypto.rs)), and the browser uses [`timingSafeEqualStr`](../public/shared/e2ee.js).
4. **Explicit sender approval:** even with the four words, a peer sees neither the manifest nor file bytes until passing the proof check and (unless `--yes`) being accepted by the sender.

---

## 3. Transport Encryption, Integrity & Disk Safety

- **Direct TCP & WebSocket Relay (CLI ↔ CLI and CLI ↔ Web):** every control frame and binary chunk is encrypted with **AES-256-GCM** using a random 96-bit IV (`12-byte IV | 16-byte tag | ciphertext`). Per NIST SP 800-38D, random 96-bit IVs remain safe up to $2^{32}$ packets per key (~256 TiB at 64 KiB chunks), far exceeding ephemeral transfers.
- **Web ↔ Web (WebRTC):** encrypted by standard WebRTC **DTLS** over SCTP.
- **End-to-end file integrity:** beyond per-frame AEAD authentication, every file carries a full **SHA-256** digest verified inside the authenticated channel (`end` / `cli-end`), detecting any chunk drop, duplication, or reordering by a hostile relay.
- **Safe destination writes:** receivers validate manifest `path` segments to block path traversal (`../`) and refuse resuming `.part` files whose prefix SHA-256 does not match the sender's file.

---

## 4. Session Fingerprint (SAS)

The SAS consists of **3 BIP-39 words** (33 bits) computed locally on both peers ([`public/shared/sas.js`](../public/shared/sas.js)):

- **WebRTC (`webrtc`):** `SHA-256("drop-sas-v1|webrtc|" + sorted(dtlsFingerprints))`. Detects an **active MITM on the signaling server** swapping DTLS fingerprints in SDP: each peer negotiates DTLS with the attacker and sees different words.
- **CLI (`tcp`):** `HMAC-SHA256(key, "drop-sas-v1|tcp|" + roomId)`. Confirms both peers share the same `scrypt` key in the same room without exposing a cheap offline verifier of the words.

Users compare the 3 words over an independent channel (voice, chat, in person); the software displays them but cannot verify out-of-band identity on its own.

---

## 5. Distribution & Web Client Integrity

- **CLI binaries (`drop update`):** releases ship `SHA256SUMS` and Ed25519 signature `SHA256SUMS.minisig` ([`cli-rs/src/minisign.rs`](../cli-rs/src/minisign.rs)), verified against the public key embedded in the binary. Compromising DNS or serving a fake release mirror cannot forge the signature without `DROP_SIGNING_KEY`.
- **Web client (`drop verify-web`):** [`cli-rs/src/verifyweb.rs`](../cli-rs/src/verifyweb.rs) queries `/version` for `DROP_COMMIT` and compares served `public/` files byte-for-byte against that commit's tree on GitHub.

---

## 6. Explicit Non-Goals & Out of Scope

1. **Targeted malicious web server:** an attacker controlling the web server can serve tampered JS to a target browser while serving clean files to `drop verify-web` (SRI does not solve this when the same server serves the HTML).
2. **No PAKE (SPAKE2/CPace):** the 4-word code relies on `scrypt` work factor and rate limits rather than an elliptic-curve PAKE (deliberate trade-off to avoid un-audited curve primitives and external crypto dependencies). An active signaling MITM must still be caught via SAS comparison.
3. **Distributed botnets:** per-IP limits (`JOIN_FAIL_MAX`, `ROOM_RATE_MAX`) slow single-IP scanning, not thousands of distributed IPs (though `BAD_GUEST_MAX = 5` still burns any targeted room).
4. **Traffic metadata:** server, TURN, and network observers see peer IPs, timestamps, and byte counts.
5. **Compromised endpoint or leaked code:** anyone given the four words—or malware on a sender/receiver machine—can read the transferred files.
6. **Paid external audit:** cryptography combines standard Rust, Node.js, and WebCrypto primitives verified against official vectors (FIPS 180-4, RFC 4231, RFC 6070, RFC 7914) in [`test/e2ee.test.mjs`](../test/e2ee.test.mjs) and [`cli-rs/tests/shared_vectors_test.rs`](../cli-rs/tests/shared_vectors_test.rs), without a paid third-party audit.
