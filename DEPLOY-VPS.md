# VPS Deployment (Oracle Cloud Guide)

Runs three containers: the **drop** app, **Caddy** (automatic Let's Encrypt HTTPS), and a self-hosted **coturn** TURN server. The entire stack is free on Oracle Cloud Always Free with zero external service dependencies.

Before starting, point a **domain** to your instance's public IP (e.g. a free subdomain from [DuckDNS](https://www.duckdns.org)). Without HTTPS, browsers disable clipboard access and Service Worker streaming downloads.

**Single instance, by design.** Rooms live in process memory (`Map` in `server/index.js`): sender and receiver must hit the same process or the code reads as expired. Do not place multiple `drop` replicas behind a load balancer. A single process easily handles signaling WebSockets, WebRTC bytes bypass the server, and CLI relay bandwidth can be bounded via `DROP_RELAY_LIMIT`.

## 1. Open Firewall Ports (Two Places on Oracle)

Opening ports in the OCI web console **is not enough**: Oracle's Ubuntu images also ship local `iptables` rules that drop incoming traffic.

**a) In the OCI Console** — *Networking → Virtual Cloud Networks → your VCN → Security Lists → Default Security List → Add Ingress Rules* (source `0.0.0.0/0`):

| Port | Protocol | Purpose |
|---|---|---|
| 80 | TCP | Let's Encrypt HTTP validation |
| 443 | TCP | App (HTTPS + WebSocket) |
| 3478 | TCP & UDP | TURN |
| 49160-49200 | UDP | TURN relay media ports |

**b) Inside the VM.** Oracle **Ubuntu** images end the `INPUT` chain with a `REJECT` rule, so new rules must be inserted **before** it:

```bash
sudo iptables -L INPUT --line-numbers        # check the REJECT line number
sudo iptables -I INPUT 6 -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 7 -p tcp --dport 443 -j ACCEPT
sudo iptables -I INPUT 8 -p tcp --dport 3478 -j ACCEPT
sudo iptables -I INPUT 9 -p udp --dport 3478 -j ACCEPT
sudo iptables -I INPUT 10 -p udp --dport 49160:49200 -j ACCEPT
sudo netfilter-persistent save               # persist across reboots
```

On **Oracle Linux** (`firewalld`):

```bash
sudo firewall-cmd --permanent --add-port=80/tcp --add-port=443/tcp \
  --add-port=3478/tcp --add-port=3478/udp --add-port=49160-49200/udp
sudo firewall-cmd --reload
```

## 2. Docker

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER    # log out and back in
```

## 3. Upload the Project

Clone from GitHub, or copy from a local machine without `node_modules`:

```powershell
tar --exclude=node_modules -czf drop.tgz .
scp -i C:\path\to\your-key.key drop.tgz ubuntu@YOUR_IP:~
```

```bash
mkdir -p ~/drop && tar -xzf ~/drop.tgz -C ~/drop && cd ~/drop
```

## 4. Configure and Start

```bash
cp .env.example .env
ip -4 addr show                 # private IP for .env (usually 10.0.0.x)
openssl rand -hex 32            # TURN_SECRET for .env
nano .env                       # set domain, IPs, and TURN_SECRET
docker compose up -d --build
```

Note that `coturn` runs with `network_mode: host` and `--external-ip=PUBLIC/PRIVATE` because Oracle uses 1:1 NAT.

Caddy takes a few seconds to obtain the TLS certificate. Verify:

```bash
curl https://YOUR_DOMAIN/healthz           # {"ok":true,"rooms":0}
docker compose logs -f drop                # room & startup logs
docker compose logs caddy | grep -i certificate
```

At startup, `drop` logs allowed browser WebSocket origins:

```text
origenes permitidos: https://drop.oloxx.dev, https://YOUR_DOMAIN, http://localhost:3000
```

Browsers connecting from unlisted origins receive **403** so third-party websites cannot open rooms on your server. Add extra origins via comma-separated `DROP_ALLOWED_ORIGINS`. The CLI sends no `Origin` header and is unaffected.

Startup logs also list trusted proxies (`DROP_TRUST_PROXY`) allowed to pass `X-Forwarded-For`. [`docker-compose.yml`](docker-compose.yml) sets `loopback,private` because `drop` only exposes port `3000` on the internal network behind Caddy, and [`Caddyfile`](Caddyfile) overwrites `X-Forwarded-For` with `{remote_host}` to prevent IP spoofing. Running `node server/index.js` directly without `DROP_TRUST_PROXY` ignores `X-Forwarded-For` by default.

TURN uses no static user/password: `drop` signs per-request HMAC-SHA1 credentials with `TURN_SECRET` carrying an expiry (`TURN_TTL_SECONDS`, default 12h), and `coturn` validates them statelessly via `--use-auth-secret`. [`docker-compose.yml`](docker-compose.yml) also sets `--denied-peer-ip` rules in `coturn` blocking loopback (`127.0.0.0/8`, `::1`), RFC 1918 / CGNAT private ranges, IPv6 link-local (`fe80::/10`), ULA (`fc00::/7`), and cloud metadata (`169.254.0.0/16`) to prevent SSRF (#60).

Verify TURN credentials and relay reachability:

```bash
curl -s https://YOUR_DOMAIN/config
# {"iceServers":[{"urls":[...]},{"urls":"turn:YOUR_DOMAIN:3478","username":"1757...:drop","credential":"..."}],"ttl":43200}
```

Paste `turn:YOUR_DOMAIN:3478`, `username`, and `credential` into the [WebRTC Trickle ICE sample](https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/) and confirm a `relay` candidate appears.

### Relay Bandwidth Quotas

TURN uses ephemeral credentials, while the WebSocket relay (`--relay` and CLI ↔ browser transfers) flows through your VPS. By default it is uncapped; set `DROP_RELAY_LIMIT` (per room) and `DROP_RELAY_LIMIT_TOTAL` (process-wide) in `.env` (`10M`, `500K`, `1.5G` bytes/s):

```bash
DROP_RELAY_LIMIT=10M
DROP_RELAY_LIMIT_TOTAL=50M
```

Exceeding the limit pauses socket reads (`ws.pause()`) rather than dropping connections, letting TCP backpressure slow the sender cleanly. Check `/healthz` for live counters:

```bash
curl -s https://YOUR_DOMAIN/healthz
# {"ok":true,"rooms":2,"guests":3,"uptime":86400,"roomsOpened":41,
#  "relay":{"bytes":734003200,"frames":11200,"throttled":57,"limit":10485760,"limitTotal":52428800},
#  "rejected":{"NOT_FOUND":3,"RATE_LIMITED":1}}
```

Update manually after pulling changes:

```bash
git pull && docker compose up -d --build
```

*(With `.github/workflows/deploy.yml`, pushes to `main` automatically run CI and redeploy via SSH.)*

## 5. Preventing Oracle Idle Reclamation

Oracle **Always Free** instances may be reclaimed after 7 days if 95th-percentile CPU, network, and (on Ampere A1) memory utilization all stay below 20%. Exceeding any single metric (usually memory on A1) or upgrading the account to *Pay As You Go* (Always Free resources remain free) avoids reclamation. Since `drop` is stateless, rebuilding on a fresh VM only takes a few minutes.

## 6. Backup and Secret Rotation

Although **drop** stores no files or database, back up and know how to rotate **`TURN_SECRET`** (in the VPS `.env`) and **`DROP_SIGNING_KEY`** (the Ed25519 key used by GitHub Actions to sign releases).

### Backup

- **VPS `.env`:** contains `DROP_DOMAIN`, `PUBLIC_IP`, `PRIVATE_IP`, and `TURN_SECRET`. Keep `chmod 600 .env`, never commit it to Git, and keep an encrypted offline copy (password manager or `gpg -c .env`).
- **`DROP_SIGNING_KEY`:** lives outside the VPS (GitHub repo secret and local file generated by [`scripts/keygen.mjs`](scripts/keygen.mjs), default `~/.drop-signing-key` with `0600`). Back it up encrypted offline — losing it prevents publishing verifiable updates for existing binaries.

### Rotating `TURN_SECRET`

1. Generate a new secret and update `TURN_SECRET=` in `.env`:

   ```bash
   openssl rand -hex 32
   ```

2. Recreate `drop` and `coturn`:

   ```bash
   docker compose up -d
   ```

3. Confirm `/config` returns fresh credentials (`curl -s https://YOUR_DOMAIN/config`).

Previously issued TURN credentials stop working immediately on `coturn` reload; rotate during low traffic.

### Rotating `DROP_SIGNING_KEY` (CLI Releases)

The public key (`PUBLIC_KEY`) is **embedded in every CLI binary** in [`cli/src/cli.rs`](cli/src/cli.rs):

1. Back up `~/.drop-signing-key` and generate a new pair:

   ```bash
   mv ~/.drop-signing-key ~/.drop-signing-key.old
   node scripts/keygen.mjs
   ```

2. Upload the new private key to GitHub Actions secrets without printing it:

   ```bash
   gh secret set DROP_SIGNING_KEY < ~/.drop-signing-key
   ```

3. Update `PUBLIC_KEY` in [`cli/src/cli.rs`](cli/src/cli.rs) and the verification public key in [`README.md`](README.md) and [`README.es.md`](README.es.md).
4. Run `npm test` (includes `test/minisign.test.mjs`) and publish a new release.

**Important:** older binaries carry the old embedded public key, so `drop update` will reject the first release signed with the new key. Note this in the release notes so users upgrade via their package manager (`brew upgrade drop`, `winget upgrade Oloxx.drop`, `scoop update drop`) or re-download verifying the new key.
