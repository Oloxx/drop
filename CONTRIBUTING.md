# Contributing to Drop

Thank you for contributing. This document covers how to set up your environment, run tests and benchmarks, follow project conventions, and publish a release.

## Environment Setup

You need **Node.js >= 22.9** (signaling server, web client, and integration test suite) and **Rust (`cargo` stable)** if you build or modify the native CLI (`cli/`).

```bash
git clone https://github.com/Oloxx/drop.git
cd drop
npm install

npm run dev        # http://localhost:3000 (auto-reloads on save)
```

There is no database, external state, or required API key: rooms live in process memory (`Map` in `server/index.js`) and file bytes never transit the signaling server in plaintext. Both `dev` and `start` pass `--env-file-if-exists=.env`.

To build or run the Rust CLI:

```bash
npm run build:cli  # builds release binary at cli/target/release/drop(.exe)
npm run cli -- send file.zip
npm run cli -- recv 4271-lemon-radar-tiger-orbit
```

## Tests

```bash
npm test
cargo test --manifest-path cli/Cargo.toml
```

`npm test` is self-contained: `test/helpers.mjs` spawns `server/index.js` on an ephemeral port per test file and terminates it afterwards (isolated because per-IP quotas are process-wide). A single test can be run with:

```bash
node --test --test-name-pattern "NOT_FOUND" test/signaling.test.mjs
```

`test/web.test.mjs` drives two real Chrome tabs via `playwright-core` using the locally installed browser (no browser download; override with `CHROME_PATH`). It skips if Chrome is absent unless `DROP_REQUIRE_CHROME=1` is set (which CI enables on Linux).

Every behavior change needs a test. Existing tests explain in a comment **what broke or would break** if the assertion failed, rather than restating the code.

## Benchmarks

When changing chunking, backpressure, watermarks, or the ack loop, always compare **medians of three runs** (run-to-run variance is ~1 MB/s):

```bash
npm run bench           # real WebRTC transfer between two Chrome tabs (256 MB baseline ~11.5 MB/s)
npm run bench:fanout    # multi-receiver relay chain; measures uplink copies sent by sender
npm run bench:cli       # native CLI TCP transfer
npm run bench:speed     # CLI-to-CLI throughput benchmark (direct TCP & relay)
npm run bench:webrelay  # browser <-> CLI WebSocket relay in both directions
```

Benchmarks require a running server (`npm run dev`), and browser benchmarks require Chrome installed.

## Conventions

**Languages.** Code comments, commits, issues, and PRs may be written in **Spanish** or **English** (documentation is primarily English). Each user-facing surface keeps one consistent language:

- **Web UI (`public/`):** **English**, lowercase and terse (`open channel`, `transmitting…`, `delivered`).
- **CLI (`cli/`):** **Spanish**, including errors and `--help` output.
- **Shared formatting/parsing (`public/shared/codes.js`):** takes `lang` explicitly (`parseCode(input, { lang })`) instead of hardcoding one (`'en'` on the web, `'es'` default in the CLI).

**Comments.** Explain *why*, not *what*. A comment that explains why two frames must share or avoid a channel, or why an invariant exists, prevents regressions months later.

**Commits.** [Conventional Commits](https://www.conventionalcommits.org/) in imperative mood. Active types: `feat`, `fix`, `sec`, `refactor`, `test`, `docs`, `build`, `ci`, `chore`.

**Pull requests.** Keep PRs focused and targeted against `main`. Describe what problem it solves, what was tested, and how. CI runs the suite on Linux, macOS, and Windows and must pass before merging — every push to `main` deploys to production.

**Dependencies.** The web app makes **zero third-party requests** (`public/fonts/` is self-hosted; no CDN, no analytics). The server has two runtime dependencies (`express` and `ws`), and the Rust CLI compiles to a static binary with zero runtime dependencies. New server dependencies require strong justification.

**Before changing the protocol or relay chain**, read [`docs/PROTOCOL.md`](docs/PROTOCOL.md) and the header comments in [`public/app.js`](public/app.js) and [`cli/src/transfer.rs`](cli/src/transfer.rs). They document non-obvious invariants around channel ordering, chunk re-splitting, atomic `.part` commits, and `conn.epoch`.

## Publishing a Release

A release is two commits and a tag; `.github/workflows/release.yml` builds all four platform binaries, signs `SHA256SUMS` with Minisign, verifies the signature with the real `minisign` binary, and creates the GitHub release. Manual checklist in order:

1. **`npm test` green across Linux, macOS, and Windows.** Do not tag with a red CI matrix.
2. **If protocol changes:** inside `1.x`, `PROTOCOL_VERSION` stays `5`. New capabilities use optional fields, ignored control frames, or `features` negotiation per [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md). Anything incompatible requires `2.0`, a prior minor-version deprecation notice in `CHANGELOG.md`, and updating `test/compat.test.mjs`.
3. **`CHANGELOG.md`:** move *Sin publicar* / *Unreleased* into `[X.Y.Z] — YYYY-MM-DD` and leave the unreleased section empty.
4. **`README.md` and `README.es.md`:** point all release download links to `vX.Y.Z` (`test/version.test.mjs` enforces this). Leave historical version mentions in prose untouched.
5. **`ROADMAP.md`:** check off completed items and prune obsolete notes.
6. Commit docs (`docs: download links and changelog for vX.Y.Z`), then bump version and push tag:

   ```bash
   npm version X.Y.Z -m "chore(release): v%s"
   git push --follow-tags
   ```

7. Once the workflow finishes, test **`drop update` from the previous release** on at least one real machine (or verify with `minisign -Vm SHA256SUMS -P <key from README>`).
8. Open the production web app and complete a transfer between two browser tabs.
9. **Homebrew and Scoop** update automatically within 6 hours via [`Oloxx/homebrew-tap`](https://github.com/Oloxx/homebrew-tap) and [`Oloxx/scoop-bucket`](https://github.com/Oloxx/scoop-bucket) after verifying `SHA256SUMS.minisig`. To trigger immediately: `gh workflow run update.yml -R Oloxx/homebrew-tap` (and likewise for `scoop-bucket`).
10. **WinGet (`Oloxx.drop` in `microsoft/winget-pkgs`):** the `winget` job in `release.yml` verifies `SHA256SUMS.minisig`, generates the manifest, runs `winget validate` on Windows, and opens the PR if `WINGET_TOKEN` (PAT with `public_repo`) is configured. Manual fallback: `node scripts/winget.mjs vX.Y.Z --submit`.

## Security

If you find a security vulnerability, **do not open a public issue**: report it via [GitHub Private Security Advisory](https://github.com/Oloxx/drop/security/advisories/new). See [`SECURITY.md`](SECURITY.md) and [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md).
