# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**drop** — a browser-to-browser file transfer app. Files travel over a WebRTC DataChannel;
the server only introduces the two peers and never sees a byte of payload.

Live at https://drop.oloxx.dev (see Deployment).

## Commands

```bash
npm run dev        # node --watch, http://localhost:3000
npm start          # production entrypoint
npm test           # REQUIRES a server already running on PORT (or ZAAP_URL)
npm run bench      # real two-peer transfer through Chrome; also needs a running server
npm run bench:cli   # native TCP transfer test (drop CLI, reaches 100+ MB/s)
npm run build:exe   # compiles dist/drop.exe (Windows x64)
npm run build:linux # compiles dist/drop-linux-x64 (Linux x64)
npm run build:arm   # compiles dist/drop-linux-arm64 (Linux ARM64 / valhalla)
npm run build:macos # compiles dist/drop-macos-arm64 (macOS Apple Silicon)
npm run build:all   # cross-compiles for all platforms
npm run cli         # run CLI via node (e.g. npm run cli -- send file.bin)
```

`npm test` drives the real signaling server over WebSocket; it does not spin one up. Start
`npm run dev` in another terminal first. To run a single case:

```bash
node --test --test-name-pattern "NOT_FOUND" test/signaling.test.mjs
```

`/speed` (`public/speed.html` + `speed.js`) is the in-app version of the same measurement, for
two real people on two real machines: one opens a channel, shares the link, and both see round
trip, throughput in each direction, and whether the path is direct or relayed through TURN.
Directions are labelled per side (`outbound`/`inbound`) — one peer's outbound is the other's
inbound, so never hardcode "download". `speed.js` deliberately duplicates app.js's signaling
plumbing rather than sharing it; app.js is deployed and working.

`npm run bench:fanout` is the multi-receiver counterpart. It drives N tabs, verifies every
receiver's file by SHA-256, and reports **how many copies of the payload left the sender's
uplink** — counted with `getStats()` on the sender's own connections. That count, not the wall
clock, is the metric: it is the mechanism of the relay chain and it does not depend on the
machine. Knobs: `PEERS` (3), `FILES` (1), `SIZE_MB`, `MAX_COPIES` (exit 1 above it),
`STAGGER_MS` (spread the accepts out so no chain forms — this is the pre-chain baseline), and
`KILL_HEAD=1` (close the tab feeding off the sender mid-transfer, to exercise `resume`).

Measured on the dev machine, 3 receivers × 32 MB: **1.05 copies** chained versus **3.14**
with `STAGGER_MS=2500`. Wall-clock time is *not* the thing to read here — all the tabs share one
CPU, so the aggregate is limited by that and says nothing about anyone's bandwidth.

`npm run bench` drives two Chrome tabs against the real app with `playwright-core` (no browser
download — it uses the installed Chrome, override with `CHROME_PATH`). Knobs: `SIZE_MB`,
`DROP_URL`, `MIN_MBPS` (exit 1 below that), `HEADED=1`. Both tabs live on one machine, so the
number is the app's own ceiling — chunking, DTLS, SCTP, flow control — not a network
measurement. Baseline on the dev machine: ~11.5 MB/s for a 256 MB payload. It is the regression
guard for `CHUNK`, `HIGH_WATER`/`LOW_WATER` and the ack loop.

Read that number against the machine ceiling, not against zero: two bare `RTCPeerConnection`s in
one tab, no app and no files, reach **13.9 MB/s** at 64 KiB chunks and **14.9 MB/s** at 256 KiB.
The app therefore runs at ~80-90% of what Chrome's SCTP/DTLS stack can do here, and `getStats()`
during a transfer reports 20-39 ms RTT *on loopback* — the two tabs are fighting for CPU. Most of
the remaining gap is transport, not JavaScript. Measured, so you do not have to re-derive it:
removing the per-chunk disk reads entirely buys **0%**, and lowering the watermarks makes it
*worse* (`HIGH_WATER` 1 MB → 10.7 MB/s, 2 MB → 11.1). Run-to-run spread is ~1 MB/s, so compare
medians of three runs, never single runs.

The relay chain costs nothing on this path: A/B at 256 MB with the forwarding hook stripped out
of `onInbound`/`onChunk` gave the same median as with it. That is expected — at a 256 KiB chunk
a 256 MB payload is only ~1000 messages, so a few extra property reads per chunk cannot show up.
Don't go looking for chain overhead in single-receiver numbers; it isn't there.

Both `dev` and `start` pass `--env-file-if-exists=.env`, so a local `.env` is picked up
automatically. Nothing else reads it.

## Architecture

Three moving parts, and the boundary between them is the thing to hold in your head:

| File | Role |
|---|---|
| `server/index.js` | Express + `ws`. Rooms in memory, blind relay of SDP/ICE. Never touches file data. |
| `public/app.js` | The entire client: signaling, WebRTC, chunking, flow control, disk writes, relay chain. |
| `public/index.html` + `style.css` | Two views (`send`, `recv`) toggled by `body[data-view]`. |

### Rooms are in-process memory — the deployment constraint

`rooms` is a `Map` in `server/index.js`. A sender and a receiver **must** hit the same process
or the link reads as expired. This rules out multi-instance deploys (`fly deploy --ha=false`,
`min_machines_running = 1`, one Render instance) and rules out platforms that cannot pin
connections to an instance. Scaling out would mean moving rooms to Redis and relaying signaling
messages over pub/sub.

### Tokens

The room token is 96 bits from `crypto.randomBytes`, base64url. It rides in the URL **fragment**
(`/#<token>`), which browsers never send to the server — it stays out of access logs and
`Referer`. The server logs only a 4-char prefix (`tag()`); treat the full token as a secret.

### Host / guest asymmetry

The sender is the host: it creates one `RTCPeerConnection` **per guest**, owns the DataChannel,
and makes the offer. Guests answer. `routeSignal()` picks the right connection by looking at
`body.dataset.view`, so the view state is load-bearing, not just cosmetic. On the guest side it
also creates a connection on demand for an unknown `from`: that is how a receiver accepts the
relay offer of the peer above it in the chain.

The server relays guest→guest signalling when `msg.to` names another guest **in the same room**;
that room check is the only thing it inspects, and it is what keeps a token from reaching peers
elsewhere.

ICE candidates arriving before the remote description are queued in `conn.pendingIce` and
flushed after `setRemoteDescription` — dropping that queue silently breaks connections on fast
networks.

### The relay chain — how multiple receivers are served

With N receivers the sender used to push N full copies through one uplink. Instead the sender
chains them (`sender → A → B → C`) and each receiver forwards chunks as they arrive, cut-through,
storing nothing. The sender uploads **one** copy and the ceiling becomes the worst uplink in the
chain rather than the sender's divided by N.

Four constraints fall out of "a relay stores nothing", and they explain most of the code:

1. **Only receivers that start together can be chained.** A relay can serve a peer that is at the
   same offset as itself and no other. So `queueForStart()` batches: the sender waits up to
   `RELAY_WINDOW` (1.5s) after the first `accept`, and starts immediately once every connected
   guest has accepted — so a lone receiver adds no delay at all. Anyone who accepts later is
   served directly, exactly as before. **A late joiner can never be chained**; supporting that
   needs peers that store and re-serve arbitrary pieces, which is a different protocol.
2. **Two flows, split by ordering.** Chunks and `start`/`end`/`done` travel *in band*, down the
   chain — send them on the direct channel and they overtake the last chunks, closing a file
   mid-write. Everything else (`manifest`, `accept`, `ack`, `complete`, `bye`, `relay`, `resume`,
   `linked`) goes straight to the sender on a control channel every receiver keeps open, whatever
   is feeding it. That is why progress and cancellation still work unchanged.
3. **Backpressure is a one-hop message.** A relay cannot slow its own inbound, so when its
   outbound buffer passes `HIGH_WATER` it sends `hold` upstream (`go` on `bufferedamountlow`), and
   each hop passes it up until the sender's send loop parks on `waitForResume`.
4. **The sender starts only after every link confirms `linked`.** Send earlier and the head
   forwards into a half-open channel; those bytes are gone, because nobody stored them. If a link
   never opens (`RELAY_LINK_TIMEOUT`, 8s) the whole chain is torn down and everyone is served
   directly — slow, but it is the old behaviour and it always works.

**Repair is driven by the sender, not by WebRTC.** When a tab is killed, the peers' DataChannel
stays `readyState === 'open'` for tens of seconds — measured: still open 48s later, nothing fires.
The server's `guest-gone` arrives at once, so `repairChain()` tells the dead peer's downstream
`orphaned`; that receiver drops its own relay link (cascading to whatever was below it) and sends
`resume` with the exact byte offset it has on disk. The chain collapses into direct streams —
never worse than the old behaviour. `pc.onconnectionstatechange` on the inbound relay is only a
backup, for when the sender is gone too.

Things that will silently break this if changed:

- **`resume` offsets come from `rx.fileGot`, read after `rx.writes` settles.** The counter is
  incremented synchronously in `onChunk` while the write is only queued; asking before the queue
  drains leaves a hole in the middle of the file.
- **`start` carrying `from > 0` must not recreate the sink** — `makeSink` truncates.
- **A relay must re-split chunks it forwards.** The size was chosen for the *upstream* link; if
  the downstream announces a smaller `maxMessageSize`, SCTP drops the message without a word.
  Splitting is free: the receiver only counts bytes, so chunk boundaries carry no meaning.
- **`sendAllFiles` is guarded by `conn.epoch`.** A `resume` while a previous loop is mid-`await`
  would otherwise interleave two byte streams on one channel.

### Knowing why a transfer is slow

The progress row's `.who` carries the path the bytes actually take, refreshed every
`PATH_EVERY` (3s) by `probePaths()`: `peer 2 · direct 20ms`, `inbound · turn 84ms`,
`inbound · via peer · direct 12ms`. `describePath()` reads it off the succeeded
`candidate-pair` — a `relay` candidate type on either end means the path is going through
coturn, and that dominates throughput more than anything tunable inside the app.

Two things worth knowing before trusting the number:

- **The sender deliberately shows no RTT for a chained receiver**, only `via peer 1`. Its own
  link to that peer carries control frames, not payload, so its latency says nothing about how
  the bytes are arriving. Only that receiver can see its real path.
- **RTT climbs during a transfer and that is not a bug.** It is the queue filling — on loopback
  it reads 1ms idle and 100ms+ under load, because the tabs fight for CPU (already noted above).
  On a real path it is the same signal: the pipe is full.

The polling loop stops itself once every row is closed and restarts from `watchPaths()`, so it
does not run between transfers. Measured: no effect on throughput (10.2 MB/s median at 256 MB,
against 10.0 before it existed).

### DataChannel protocol

- **string** messages are JSON control frames: `manifest`, `accept`, `start`, `end`, `done`,
  `ack`, `complete`, `bye`, plus the chain's `relay`, `unrelay`, `linked`, `orphaned`, `resume`,
  `hold`, `go`
- **binary** messages are chunks of the file named by the last `start`, sized by `chunkFor()`:
  `pc.sctp.maxMessageSize` clamped to `[64 KiB, MAX_CHUNK]` (256 KiB, what Chrome announces).
  The receiver only counts bytes, so the size is a sender-side decision and needs no negotiation
  of its own — but never send above what SCTP announced, or the message is dropped.

Four details that are easy to "simplify" and thereby break:

1. **Flow control.** The sender pauses above `HIGH_WATER` (8 MB) and resumes on
   `bufferedamountlow` at `LOW_WATER` (1 MB). Without it a large file is read entirely into RAM.
2. **Progress comes from receiver `ack`s**, not `bufferedAmount` — the latter only says what was
   handed to SCTP, so it reports 100% while data is still in flight.
3. **Receiver writes are serialized through `rx.writes`**, a promise chain. `onmessage` is
   synchronous but sinks are async; without the chain, chunks land out of order.
4. **Progress rows repaint once per `requestAnimationFrame`**, not once per chunk, and
   `makeProgressRow` caches its nodes instead of re-querying them. Both are on the receiver's
   synchronous `onmessage` path, and doing it per chunk costs ~7% of throughput. `finish()` and
   `fail()` must cancel the pending frame, or a late paint overwrites the final text.

### Where received files go

`supportsDirectPicker()` decides: multiple files or >128 MB asks for a directory
(File System Access API, Chrome/Edge) and streams to disk; anything else buffers in memory and
triggers a normal download, which is also the Firefox/Safari path. The picker must be requested
inside the accept click handler — user activation is lost after an await.

## UI conventions

- Copy is **English**, terse, lowercase, terminal-flavored (`open channel`, `transmitting…`,
  `delivered`). Code comments are **Spanish**. Keep both as they are.
- Palette is Tokyo Night, font is JetBrains Mono, both from Omarchy. The font is self-hosted in
  `public/fonts/` — the app makes **zero third-party requests** and should stay that way.
- `app.js` builds DOM at runtime (`makeProgressRow`, `renderFileList`) with classes the CSS must
  match: `.peer`, `.peer-head .who/.state`, `.bar > i`, `.peer-file .grow/.rate`, `.name`,
  `.size`, `.drop-one`. Renaming a CSS class silently kills the styling.
- `.who` is not static: `row.path()` rewrites it as `<title> · <path>`. The path goes there and
  not in `.state` because `progress()` repaints `.state` every frame and would eat it.
- `[hidden] { display: none !important; }` is required: the elements JS toggles also carry
  `display: flex`.
- `#recv-title` is an inner `<span>` on purpose. JS rewrites its `textContent`; the `❯` prompt
  lives outside it so it survives.

## Deployment

Production runs on the Oracle Cloud VPS reachable as `ssh valhalla` (Ubuntu 24.04, aarch64),
in `~/drop`, as three containers: the app, **Caddy** (automatic Let's Encrypt) and **coturn**
(TURN). Config lives in `.env` there — never commit it.

**CI/CD automático:** Cada `git push origin main` activa el workflow de GitHub Actions (`.github/workflows/deploy.yml`), que se conecta por SSH a `valhalla`, actualiza el repositorio en `~/drop` (`git reset --hard origin/main`) y reconstruye el contenedor Docker automáticamente.

Despliegue manual (si hiciera falta):
```bash
ssh valhalla "cd ~/drop && git pull && docker compose up -d --build drop"
```

Oracle's firewall is in **two** places: the VCN Security List in the OCI console *and* the
machine's own iptables, where rules must be inserted **before** the REJECT line and saved with
`netfilter-persistent save`. Both halves are already configured; see `DEPLOY-VPS.md`.

coturn runs `network_mode: host` and needs `--external-ip=PUBLIC/PRIVATE` because Oracle does
1:1 NAT. Its flag set is version-sensitive — `--no-cli` and the TLS 1.0/1.1 flags no longer
exist and make it crash-loop.

`fly.toml` and the Fly instructions in `README.md` are an untested alternative path.

## Known limitation

`/config` hands static TURN credentials to every visitor, so anyone can relay their own traffic
through the server indefinitely. The fix is coturn's `--use-auth-secret` plus server-generated
time-limited HMAC credentials.
