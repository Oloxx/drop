# Compatibility

What **drop** guarantees starting at `1.0`: which versions interoperate, what cannot change without a major version bump, and how new capabilities are added without breaking installed binaries.

This policy follows [SemVer](https://semver.org/): within `1.x`, nothing listed in Section 1 changes in a backwards-incompatible way. Anything outside Section 1 is not part of the stability promise.

## 1. Frozen for 1.0

- **CLI Protocol Version 5** (`PROTOCOL_VERSION` in [`public/shared/protocol.js`](../public/shared/protocol.js)). Fixed for the entire `1.x` series. Covers direct TCP (`[length][IV][tag][ciphertext]` frames, `manifest` → `ready` → `start`/chunks/`end` → `done`), the encrypted WebSocket relay (`cli-offer`, `cli-proof`, `cli-manifest`, `cli-accept`, `cli-start`, `cli-ack`, `cli-end`, `cli-done`, `cli-complete`, `cli-retry`, `cli-error`, `cli-denied`, `cli-wait`), `scrypt` key derivation, proof/SAS formulas, and `files` selective download. The canonical reference lives above `receive_from_relay` in [`cli-rs/src/transfer.rs`](../cli-rs/src/transfer.rs).
- **Web protocol** (signaling + DataChannel): everything marked frozen in Section 8 of [`docs/PROTOCOL.md`](PROTOCOL.md).
- **Server signaling:** `host` with `v: 2`, `join`, `signal`, and `bad-guest` client-to-server; `hosted`, `joined`, `guest`, `guest-gone`, `host-gone`, `signal`, and `error` server-to-client.
- **Share code format:** `4271-lemon-radar-tiger-orbit` — 4-digit room ID + 4 English BIP-39 words in the URL fragment (`/#<code>`), preserving case-insensitive, space-tolerant, and 4-letter prefix parsing. Any code valid in `1.0` remains valid in all `1.x`.
- **CLI interface:** subcommands (`send`, `recv`, `speed`, `serve`, `update`, `install`, `uninstall`, `completion`, `verify-web`) and flags documented in `drop --help`; exit code `0` on success and non-zero on failure; `--stdout` (or `-o -`) writes only file bytes to standard output.
- **Self-hosted server:** documented environment variable names (`DROP_*`, `TURN_SECRET`, `TURN_TTL_SECONDS`, `DROP_COMMIT`) and HTTP routes (`/config`, `/healthz`, `/version`). Responses may gain fields, never lose existing ones.

**Not part of the promise:** human-readable output text (prompts, progress bar layout, colors, language), web UI styling, default server quota values, tuning constants (chunk size, watermarks, ack intervals), and undocumented behavior.

## 2. Interoperability Matrix

| | CLI `1.x` | Deployed Web | CLI `0.x` |
|---|---|---|---|
| **CLI `1.x`** | Yes — any `1.x` with any `1.y`, both directions, TCP and relay | Yes — web speaks Protocol 5 across all `1.x` | No — rejected with an explicit message asking for `drop update` |
| **Web** | Yes | Yes — both tabs load the same `app.js` | No — same rejection message |

Before `1.0`, minor versions could break compatibility (`0.9.x` uses Protocol 4; `0.7.x`–`0.8.x` use Protocol 3). Breaking changes are documented per release in [`CHANGELOG.md`](../CHANGELOG.md).

## 3. Extending 1.x Without Breaking

Because `PROTOCOL_VERSION` stays fixed at `5`, a `1.0` peer and a `1.3` peer must interoperate cleanly. [`test/compat.test.mjs`](../test/compat.test.mjs) enforces these rules:

1. **Unknown items are ignored.** Extra fields on a JSON frame, unknown `k` control frames (DataChannel/TCP), unknown `cli-*` relay `type`s, or unknown signaling `t` messages are ignored without error and never written to disk.
2. **New fields are optional, and absence means `1.0` behavior.** `files` already works this way: omitting it transfers the entire batch.
3. **Behavior-changing capabilities are negotiated via `features`.** Requesting something an older peer silently ignores is worse than not requesting it:
   - `features` is an array of strings sent by the sender in the manifest (`manifest` over TCP/DataChannel, `cli-manifest` over relay) and echoed/intersected by the receiver (`ready`, `cli-accept`, `accept`).
   - Omitting `features` means `[]` (`1.0` baseline).
   - `1.0` announces no features; the field name is reserved for future `1.x` extensions.
4. **Handshake ordering never changes.** On TCP, the sender's first frame is `manifest` and the receiver's first frame is `ready`. Over relay, `cli-offer` is cleartext and subsequent frames are sealed. New steps go after, never before.
5. **New signaling `t` messages ship on the server first.** Clients and servers ignore unknown `t`, so a client cannot rely on a message the server does not forward yet. New `error` reasons fall back to generic text on older clients without breaking.
6. **Single-sided tuning constants may change freely** (chunk size, watermarks, chain batching window) as long as ack semantics remain monotonic total plaintext bytes and relay window sizes stay well above receiver ack frequency.

## 4. Breaking Changes: 2.0

Only a major release changes `PROTOCOL_VERSION`:

- Announced in `CHANGELOG.md` at least one minor release in advance.
- A `1.x` client and `2.x` client reject each other cleanly (`drop update`), never half-parsing frames.
- The public signaling server continues accepting `1.x` relay signaling for at least **6 months** after `2.0` ships; direct CLI TCP transfers need no server at all.

## 5. Supported Versions

Only the latest release receives fixes. Since `1.x` preserves protocol compatibility, updating via `drop update` never breaks communication with peers on earlier `1.x` releases. Security reporting is covered in [`SECURITY.md`](../SECURITY.md).
