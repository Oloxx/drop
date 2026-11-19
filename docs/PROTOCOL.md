# Drop Web Protocol (Signaling + DataChannel)

Specification of what two `drop` browser tabs send to each other and to the signaling server during a transfer. It is the canonical reference for [`public/app.js`](../public/app.js) and [`server/index.js`](../server/index.js): if code and spec disagree, the bug is whichever drifted, and this document decides.

**Not covered here:** the CLI wire protocol (direct TCP and `cli-*` WebSocket relay), which is documented in one place above `receive_from_relay` in [`cli/src/transfer.rs`](../cli/src/transfer.rs). The two meet at a single boundary: a browser tab receiving from `drop send`, or sending to `drop recv`, switches to `cli-*` over the WebSocket (§7).

Everything here is frozen at `1.0` (see [`ROADMAP.md`](../ROADMAP.md)). Changing a frame shape, removing a field, or changing ordering requires a major version bump; adding optional fields or new `k` frames does not (see §8).

## 1. Three Layers

```text
  Sender tab                      Server                      Receiver tab
  ──────────                      ──────                      ────────────
    WebSocket  ──── signaling (blind JSON) ─────────────────── WebSocket
        │                                                          │
    RTCPeerConnection ══ DTLS/SCTP, direct or TURN ══════ RTCPeerConnection
        │                                                          │
    DataChannel "drop" ─ control (JSON) + chunks (binary) ─ DataChannel "drop"
```

1. **Signaling:** one WebSocket per tab to `server/index.js`. The server pairs peers by 4-digit room ID and forwards SDP/ICE blindly; it never sees file bytes.
2. **WebRTC:** one `RTCPeerConnection` per link, DTLS-encrypted end to end (via `coturn` TURN if no direct path exists).
3. **DataChannel:** one ordered channel named `"drop"` (`ordered: true`) per connection carrying the transfer protocol in §4.

## 2. Code & Room

The share code is `4271-lemon-radar-tiger-orbit`:

- `4271` is the **room identifier**, assigned by the server and the only part it receives.
- The four words are the **shared secret**, drawn locally (`randomSecretWords`), carried only in the URL fragment (`/#<code>`, never sent by browsers over HTTP), and used to prove knowledge of the code (§4.2) and derive the AES key when talking to a CLI. Between two browser tabs, encryption is already provided by DTLS.

Design rationale is documented in [`public/shared/codes.js`](../public/shared/codes.js).

## 3. Signaling (WebSocket)

All JSON messages carry a `t` field. Unknown or malformed shapes are closed with `error`.

### 3.1 Client → Server

| `t` | Fields | Sender | Behavior |
|---|---|---|---|
| `host` | `v: 2` | sender | Opens a room. Without `v: 2`, server replies `error VERSION`. `/speed` sends `link: true` and receives a 96-bit base64url token. |
| `join` | `token`, `name?` | receiver | Joins room `token` (4 digits). `name` is informational; `'cli'` signals a `drop recv` peer so a web sender uses `cli-*` relay (§7). |
| `signal` | `to?`, `data` | either | Blindly forwards `data` (SDP or ICE). Sender sets `to` to target `guestId`; a receiver without `to` targets the sender, and with `to` targets **another receiver in the same room** (chain links, §6). |
| `bad-guest` | `guestId` | sender | Reports a receiver that failed secret verification. Server sends `error BAD_SECRET` and kicks it; on the 5th failure (`BAD_GUEST_MAX`), burns the room (`BURNED`). |

`data` in `signal` is `{ sdp: RTCSessionDescription }` or `{ ice: RTCIceCandidate }`. When a CLI participates, `cli-*` JSON messages also travel inside `signal`, and WebSocket **binary frames** carry encrypted CLI relay chunks prefixed with a 4-byte `guestId` header that the server routes without inspecting.

### 3.2 Server → Client

| `t` | Fields | Recipient | Meaning |
|---|---|---|---|
| `hosted` | `token`, `room`, `v: 2`, `publicIp` | sender | Room open; `token` is the 4-digit room ID. |
| `joined` | `guestId`, `publicIp` | receiver | Joined room; `guestId` is the receiver's numeric ID (sender is always `0`). |
| `guest` | `guestId`, `name`, `ip` | sender | New receiver joined; sender opens a connection (§4.1). |
| `guest-gone` | `guestId` | sender | Receiver disconnected. Arrives **immediately**, long before WebRTC notices, triggering chain repair (§6.4). |
| `host-gone` | — | receivers | Sender closed. Room closes; in-flight chain transfers may still finish. |
| `signal` | `from`, `data` | either | Forwarded signal (`from = 0` for sender, or another receiver's `guestId`). |
| `error` | `reason` | either | Rejection, usually followed by close. `reason` ∈ `NOT_FOUND`, `RATE_LIMITED`, `BAD_SECRET`, `BURNED`, `ROOM_FULL`, `TOO_MANY_ROOMS`, `NO_ROOMS`, `EXPIRED`, `FLOOD`, `VERSION`. Mapped in `JOIN_ERRORS`/`HOST_ERRORS` (`public/app.js`) and `translate_error` (`cli/src/signaling.rs`). |

### 3.3 Server Limits & Quotas

All configurable via environment variables in `server/index.js`:

- Rooms created per IP per minute: `DROP_ROOM_RATE_MAX` (default `30`), join failures per IP per 60s: `JOIN_FAIL_MAX` (`20`).
- Guests per room: `DROP_MAX_GUESTS` (`25`), max concurrent rooms: `DROP_MAX_ROOMS` (`5000`).
- Idle room TTL: `DROP_ROOM_TTL_MS` (default `30 min`), swept every `DROP_ROOM_SWEEP_MS`.
- Per-socket control-frame token bucket: `DROP_MSG_BURST` (`300`), `DROP_MSG_RATE` (`100/s`).
- `maxPayload`: `256 KiB` (largest legitimate CLI relay frame is 65,568 B: 4B `guestId` + 28B IV/tag + 64 KiB chunk).
- **Critical invariants:** binary WebSocket frames must refresh `room.lastActivity` (otherwise long CLI relay transfers time out mid-stream), and the control-frame token bucket must **not** apply to binary relay frames (~160 frames/s at 10 MB/s).
- Optional relay rate limits: `DROP_RELAY_LIMIT` (per room) and `DROP_RELAY_LIMIT_TOTAL` (process-wide), enforced by `ws.pause()` + timer rather than dropping frames.

### 3.4 Connections & Offerer Role

- **Sender is always the WebRTC offerer:** creates one `RTCPeerConnection` per receiver, creates the `"drop"` DataChannel, and sends the SDP offer. `routeSignal()` selects the connection based on `body.dataset.view`.
- Receivers create connections on demand when receiving a `signal` with `sdp` from an unknown `from` (another receiver acting as upstream chain link, §6). Orphan `ice` from unknown `from` is ignored.
- **Early ICE candidates are queued** in `conn.pendingIce` and flushed after `setRemoteDescription`; otherwise fast networks drop candidates silently.
- ICE config (`STUN` + ephemeral HMAC `TURN` if `TURN_SECRET` is configured) comes from `GET /config` and refreshes hourly.

### 3.5 Session Fingerprint (SAS)

Each peer computes locally `sasWords(sha256(sasInput('webrtc', fingerprints)))` from both sorted DTLS fingerprints (3 BIP-39 words). If a malicious signaling server swaps SDP fingerprints to MITM DTLS, both sides see different certificates and mismatched words. See [`public/shared/sas.js`](../public/shared/sas.js).

## 4. The DataChannel

### 4.1 Frames

Two message types on DataChannel `"drop"`:

- **string:** JSON control frame with a `k` field.
- **binary (`ArrayBuffer`):** sequential chunk of the file opened by the most recent `start`.

The sender picks chunk size with `chunkFor(pc)`: `pc.sctp.maxMessageSize` clamped to `[64 KiB, 256 KiB]`. Because receivers count bytes rather than message boundaries, intermediate relay peers can re-split chunks freely (§6.2). Never exceed the peer's announced `maxMessageSize` or SCTP drops the message silently.

### 4.2 Transfer Sequence

```text
  sender                                         receiver
    │  ── challenge {nonce} ───────────────────▶  │   channel open
    │  ◀── proof {proof} ───────────────────────  │   sha256("drop-proof-v2|nonce|secret")
    │  ── manifest {files} ─────────────────────▶  │   (only if proof matches)
    │  ◀── accept {files?} ─────────────────────  │   user clicked receive
    │  ── start {index:0, …} ───────────────────▶  │
    │  ── chunks ───────────────────────────────▶  │
    │  ◀── ack {bytes} ─────────────────────────  │   every 2 MB (ACK_EVERY)
    │  ── end {index:0, sha256} ────────────────▶  │   receiver compares SHA-256
    │  ── start {index:1, …} … end …               │
    │  ── done ─────────────────────────────────▶  │
    │  ◀── complete ────────────────────────────  │   all files verified & written
```

- **Nothing before `proof`:** the manifest (filenames/sizes) is withheld until the receiver proves knowledge of the four words. Invalid `proof` closes the channel and sends `bad-guest`. Any other frame before valid `proof` is ignored.
- **Selective accept:** when `accept.files` is present, unselected files are skipped and all totals (`ack`, progress, `delivered`) track only the requested subset.
- **Batching delay:** after `accept`, the sender may wait up to `RELAY_WINDOW` (1.5 s) if other guests are still connecting so they can be chained (§6.1); a single guest starts immediately.
- **Sender progress uses `ack`**, not `bufferedAmount` (which only reflects SCTP queuing, not delivery).
- **`complete` is sent only after disk/stream commit**, confirming to the sender it is safe to show `delivered` and close the tab.

### 4.3 Control Frames

`S→R` is sender to receiver. **Path** indicates routing when chained (§6): *in-band* flows hop-by-hop with chunks; *control* always goes direct between that receiver and the sender.

| `k` | Dir. | Fields | Path | Notes |
|---|---|---|---|---|
| `challenge` | S→R | `nonce` (32 hex) | control | Unique per receiver. |
| `proof` | R→S | `proof` (64 hex) | control | `sha256Hex("drop-proof-v2\|" + nonce + "\|" + secret)` (`secret` is hyphenated words). Same formula in `cli/src/crypto.rs`. |
| `manifest` | S→R | `files: [{ name, size, type, path? }]` | control | `path` is `/`-separated relative path for folders. `size` is `null` for streams (`drop send -`, §7). |
| `accept` | R→S | `files?`, `resume?` | control | `resume: [{ index, offset, sha256 }]` requests skipping already-present files matching prefix hash (`start {from: offset}`). `files` lists requested manifest indices; omitted means all (`pickedFiles` in `public/shared/protocol.js`). Only first `accept` is honored. |
| `start` | S→R | `index`, `name`, `size`, `type`, `from`, `path?` | **in-band** | Opens file `index`. `from > 0` only on resume (§5): receiver appends instead of truncating. |
| `end` | S→R | `index`, `sha256` | **in-band** | SHA-256 of the **entire** file (including resumed prefix). Mismatch aborts sink and offers `retry`. |
| `done` | S→R | — | **in-band** | End of batch. |
| `ack` | R→S | `bytes` | control | Monotonic **cumulative** bytes across the batch, every `ACK_EVERY` (2 MB) and at final byte. |
| `complete` | R→S | — | control | All files verified and closed. |
| `bye` | R→S | — | control | Receiver aborted; wakes sender if paused on `hold`. |
| `resume` | R→S | `index`, `offset` | control | Requests direct continuation from `offset` (§5, §6.4). |
| `relay` | S→R | `to` (`guestId`) | control | Instructs peer to open a DataChannel to `to` and forward inbound chunks/markers (§6). |
| `linked` | R→S | — | control | Downstream relay DataChannel to `to` is open. |
| `unrelay` | S→R | — | control | Stop forwarding; close downstream link. |
| `orphaned` | S→R | — | control | Upstream link died: drop downstream link and issue `resume`. |
| `hold` | R→S, R→R | — | **one hop** | Outbound buffer exceeded `HIGH_WATER`: pause sending. |
| `go` | R→S, R→R | — | **one hop** | Outbound buffer drained below `LOW_WATER`: resume sending. |

Unknown `k` frames are ignored on both sides without affecting state or output files.

### 4.4 Flow Control

- Sender pauses disk reads when `dc.bufferedAmount > HIGH_WATER` (8 MB) and resumes on `bufferedamountlow` at `LOW_WATER` (1 MB).
- Reads in `READ_BLOCK` (2 MB) slices and chunks to `chunkFor(pc)`. Measured loopback baselines (`npm run bench` in Chrome): ~11.5 MB/s for 256 MB against ~13.9–14.9 MB/s raw `RTCPeerConnection` ceiling; lowering `HIGH_WATER` degrades throughput (10.7 MB/s at 1 MB, 11.1 MB/s at 2 MB).
- Receiver serializes async writes through a promise chain (`rx.writes`) so chunks never land out of order.
- `hold`/`go` only travel on relay chains (§6.3), never on direct sender→receiver connections.

### 4.5 Receiver Sinks

Downloads >= 32 MB or of unknown size (including `.zip` batches built via [`public/shared/zip.js`](../public/shared/zip.js)) stream through the Service Worker ([`public/sw.js`](../public/sw.js)) with credit-based backpressure directly to the browser's Downloads folder; a SHA-256 mismatch aborts the HTTP response so the browser marks the download failed. Smaller downloads or insecure contexts buffer into an in-memory `Blob`. Both use the same wire protocol.

## 5. In-Session & Cross-Session Resume

`resume {index, offset}` tells the sender to switch to **direct** delivery from `offset` of file `index`. Triggered when:

1. **Upstream chain link dies** (§6.4): `offset` is `rx.fileGot` read **after `rx.writes` settles** (reading it before the write queue drains creates a gap).
2. **`retry` after hash mismatch:** `resume {index, offset: 0}`.

`sendAllFiles` is guarded by `conn.epoch` so a `resume` cleanly cancels any prior async send loop without interleaving streams.

Cross-session `accept.resume` (#58) remains supported by the protocol: web senders honor `.part` prefix resume requests from `drop recv` CLI peers (hashing in pure JS at ~80 MB/s while sending `cli-wait` every 5 s to keep the CLI's 60 s idle timer alive). Peers offering `resume` are never chained.

## 6. Fanout Relay Chain

With `N` concurrent receivers, instead of pushing `N` copies from the sender's uplink, the sender chains them (`sender → A → B → C`). Each intermediate peer forwards chunks cut-through without buffering files on disk, reducing sender uplink to **1 copy** (measured via `npm run bench:fanout`: ~1.05 uplink copies for 3 receivers × 32 MB vs ~3.14 staggered).

### 6.1 Batching Rules

- Only receivers starting together at offset 0 can chain (`RELAY_WINDOW = 1.5 s` after first `accept`, or immediate start once all connected guests accept). Late joiners always stream directly.
- Receivers must request the exact same `files` subset; `startBatch` groups by selection and chains each group.

### 6.2 Chain Setup & Forwarding

```text
  sender                A                    B                    C
    │ ── relay{to:B} ─▶ │                    │                    │
    │ ── relay{to:C} ───┼──────────────────▶ │                    │
    │                   │ ── signal(sdp) ──▶ │  (via server, to:B)
    │                   │                    │ ── signal(sdp) ──▶ │
    │ ◀── linked ────── │ (A→B channel open) │                    │
    │ ◀── linked ───────┼─────────────────── │ (B→C channel open) │
    │ ── start, chunks ▶│ ── forward ──────▶ │ ── forward ──────▶ │
```

- Sender does not send file bytes until every link replies `linked`. If any link misses `RELAY_LINK_TIMEOUT` (8 s), the chain tears down (`unrelay`) and falls back to direct streams.
- Intermediate peers forward binary chunks and `start`/`end`/`done` **in arrival order** before writing locally, and **re-split** chunks if their downstream peer has a smaller `maxMessageSize`.
- Control frames (`manifest`, `ack`, `complete`, `resume`) always stay on the direct control channel to the sender. Sender deliberately omits RTT for chained peers (`via peer N`).

### 6.3 Hop-by-Hop Backpressure (`hold` / `go`)

When a relay node's outbound `bufferedAmount` exceeds `HIGH_WATER`, it sends `hold` one hop upstream (and `go` on `bufferedamountlow`), propagating back to the sender's `waitForResume` loop.

### 6.4 Sender-Driven Repair

When a browser tab closes, WebRTC DataChannels can stay `readyState === 'open'` for 40+ seconds (measured: still open at 48 s), whereas the signaling server delivers `guest-gone` immediately:

```text
  A dies.  sender ── unrelay ──▶ (A's upstream, if any)
           sender ── orphaned ─▶ B
           B drops downstream link to C (cascading)
           B drains rx.writes, sends resume {index, offset: rx.fileGot}
           sender ── start{from} + chunks ──▶ B (direct)
```

`pc.onconnectionstatechange` acts only as a backup if the sender itself disconnects.

## 7. Interoperating with the CLI

A `drop recv` peer joins with `join { name: 'cli' }`. The web sender switches that peer to `onCliGuest`: derives the room key with `scrypt`, issues `cli-offer`, verifies `cli-proof`, and streams sealed JSON frames + AES-256-GCM binary chunks over the WebSocket relay with an 8 MB `cli-ack` window and 4 MB `bufferedAmount` cap.

Conversely, a web tab receiving from `drop send` translates `cli-manifest`/`cli-start`/`cli-end`/`cli-done` into §4.3 handlers via `cliEnqueue` (a single promise queue serializing async WebCrypto decryption) and replies with `cli-ack` and `cli-accept` (including `files`).

Both directions are documented frame-by-frame in [`cli/src/transfer.rs`](../cli/src/transfer.rs) above `receive_from_relay`.

## 8. Compatibility Rules

- **Frozen at `1.0`:** message shapes in §3 and §4.3, sequence in §4.2, `proof` formula, cumulative monotonic `ack` semantics (over requested `files`), `accept.files` behavior, in-band vs control routing, `start.from`, and chunk re-splitting.
- **Extensible without major bump:** unknown `k` control frames, optional fields (capabilities requiring peer action negotiated via `features`, see [`COMPATIBILITY.md`](COMPATIBILITY.md)), and single-sided constants (`CHUNK`, `HIGH_WATER`, `LOW_WATER`, `ACK_EVERY`, `RELAY_WINDOW`, `RELAY_LINK_TIMEOUT`).
- **Non-protocol:** `join.name`, UI status strings, `/config` advisory fields.

Breaking changes are announced in [`CHANGELOG.md`](../CHANGELOG.md).
