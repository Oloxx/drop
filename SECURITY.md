# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability, **do not open a public issue**: report it through a [GitHub Private Security Advisory](https://github.com/Oloxx/drop/security/advisories/new). You can expect an initial response within a few days, and fixes ship in a release before any advisory is published.

Anything that violates the threat model below qualifies as a security issue: the server being able to read plaintext file bytes, a peer downloading without knowing the four words, a manifest `path` escaping the destination directory, or `drop update` accepting a binary without a valid signature.

## Supported Versions

Only the **latest release** receives fixes. Installed CLI binaries update via `drop update`, which verifies the release signature before replacing itself. The web app deploys continuously from `main` and is always on the latest version. Within `1.x`, protocol `5` remains backwards-compatible ([`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md)).

## Threat Model Summary

See [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md) for the full threat model, along with the [README](README.md#code-security-model) and header comments in [`public/shared/codes.js`](public/shared/codes.js) and [`public/shared/sas.js`](public/shared/sas.js).

- **What the signaling server sees:** the 4-digit public room ID (`4271`), peer IPs, WebRTC SDP/ICE signaling, and encrypted AES-256-GCM relay noise when relay is used. **Never** the four words, any fast hash of them, or plaintext file bytes.
- **What TURN sees:** DTLS-encrypted packets between browsers. Credentials carry an expiry (`TURN_TTL_SECONDS`) and are HMAC-signed per request.
- **What the 4-word code protects:** 44 bits of secret entropy stretched with `scrypt` (`N=2^15, r=8, p=1`: ~62 ms native and 32 MiB per guess). Online brute force is throttled by per-IP rate limits and room burning (`BAD_GUEST_MAX = 5`). Guessing a room ID without the words yields neither file contents nor filenames.
- **What the session fingerprint (SAS) protects:** 3 BIP-39 words derived locally from negotiated material (DTLS fingerprints on WebRTC, scrypt key on TCP/relay). If a server tampers with SDP to MITM WebRTC, fingerprints diverge; compare them over an out-of-band channel.
- **What release signatures protect:** `SHA256SUMS.minisig` (Ed25519, Minisign format) proves release authenticity against the public key embedded in the binary. `drop update` rejects unsigned or mismatched releases.

### Out of Scope

- **Targeted malicious web server:** a compromised server could serve tampered `app.js` to a victim browser while serving clean files to `drop verify-web`.
- **PAKE:** Drop does not implement SPAKE2/CPace; protection relies on secret entropy, `scrypt` stretching, server rate limits, and manual SAS comparison.
- **Paid external audit:** cryptographic modules in [`public/shared/`](public/shared/) and [`cli-rs/src/`](cli-rs/src/) use standard primitives verified against official test vectors (FIPS 180-4, RFC 4231, RFC 6070, RFC 7914) in [`test/e2ee.test.mjs`](test/e2ee.test.mjs) and [`cli-rs/tests/shared_vectors_test.rs`](cli-rs/tests/shared_vectors_test.rs), without a paid third-party audit.
- **Traffic metadata:** the server, TURN, and network observers can see timing, peer IPs, and byte volumes.
- **Endpoint compromise:** anyone who receives the four words or compromises a sender/receiver device can access the transferred files.
