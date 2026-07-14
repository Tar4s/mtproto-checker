# 🔍 mtproto-checker

Telegram MTProto proxy health checker powered by **TDLib**. Performs a real `testProxy` handshake through each proxy — the same protocol path tdesktop uses. If it says ✅, the proxy **actually works** in Telegram.

## ⚡ Features

- 🤝 Real MTProto handshake (not just a port scan)
- 📡 Check from remote URLs, local files, direct proxy links, or any mix
- 🔄 Multi-iteration filtering — only survivors advance
- 🌐 Built-in HTTP API server with Basic Auth
- 🧹 Auto de-duplication by `server:port:secret`
- 📊 Sorted output: working first, fastest on top
- 🔐 Fake-TLS SNI extraction from `ee`-prefixed secrets

## 📦 Install

```bash
# Global — gives you the `mtproto-checker` command
npm install -g mtproto-checker

# Local dependency
npm install mtproto-checker
```

Or clone:

```bash
git clone https://github.com/Tar4s/mtproto-checker.git
cd mtproto-checker
npm install
```

GitHub Packages (scoped):

```bash
npm config set @tar4s:registry https://npm.pkg.github.com
npm install @tar4s/mtproto-checker
```

> **Requirements:** Node.js ≥ 18 · `TG_API_ID` + `TG_API_HASH` from [my.telegram.org](https://my.telegram.org)
> No phone login needed — credentials only initialize TDLib.

## 🔑 Environment Variables

| Variable | Required | Description |
|----------|:--------:|-------------|
| `TG_API_ID` | ✅ | Telegram API ID |
| `TG_API_HASH` | ✅ | Telegram API Hash |
| `CHECK_AUTH_USER` | 🌐 | HTTP Basic Auth username (server mode) |
| `CHECK_AUTH_PASSWORD` | 🌐 | HTTP Basic Auth password (server mode) |
| `PORT` | ❌ | Server port (default `8080`) |

## 🚀 Quick Start (Global)

After `npm i -g mtproto-checker`:

```bash
# Start HTTP server (no arguments)
TG_API_ID=12345 TG_API_HASH=abcdef \
CHECK_AUTH_USER=admin CHECK_AUTH_PASSWORD=secret \
check-proxies

# CLI mode (with arguments)
TG_API_ID=12345 TG_API_HASH=abcdef check-proxies --sources urls.txt
```

## 🖥 CLI Usage

```bash
TG_API_ID=12345 TG_API_HASH=abcdef check-proxies [sources] [options]
```

### Input Methods

```bash
# Single proxy link
check-proxies --proxy "tg://proxy?server=1.2.3.4&port=443&secret=ee..."

# Remote URLs (positional or --url flag, repeatable)
check-proxies https://example.com/proxies.txt
check-proxies --url URL1 --url URL2

# File with source URLs (one per line, # comments ok)
check-proxies --sources urls.txt

# Local proxy file
check-proxies ./my-proxies.txt

# Stdin
cat proxies.txt | check-proxies
```

### ⚙️ Options

| Flag | Default | Description |
|------|:-------:|-------------|
| `--proxy <link>` | — | Check one proxy link directly |
| `--url <url>` | — | Add a source URL (repeatable) |
| `--sources <file>` | — | File of source URLs |
| `--dc <1-5>` | `2` | Data center for `testProxy` |
| `--timeout <sec>` | `10` | Per-proxy timeout |
| `--concurrency <n>` | `30` | Parallel checks (lower = more accurate ms) |
| `--iterations <n>` | `1` | Re-check rounds; only working proxies advance |
| `--out <prefix>` | `result` | Output prefix → `.json` + `.txt` |

### 📄 Output Files

| File | Content |
|------|---------|
| `result.json` | Full report: server, port, SNI, latency, error, link |
| `result.txt` | Working proxy links only, fastest first |

## 🌐 HTTP API Server

Start with **no arguments** — works both globally and locally:

```bash
# Global
TG_API_ID=12345 TG_API_HASH=abcdef \
CHECK_AUTH_USER=admin CHECK_AUTH_PASSWORD=secret \
check-proxies

# Local
TG_API_ID=12345 TG_API_HASH=abcdef \
CHECK_AUTH_USER=admin CHECK_AUTH_PASSWORD=secret \
node check.js
```

```
[mtproto-checker] ⚡ HTTP server listening on http://localhost:8080
[mtproto-checker]   POST /check (Basic auth: admin:***)
```

### `POST /check`

```bash
curl -u admin:secret http://localhost:8080/check \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/proxies.txt", "iterations": 2, "concurrency": 20}'
```

**Request body:**

| Field | Type | Default | Description |
|-------|------|:-------:|-------------|
| `url` / `urls` / `uri` / `uris` | string \| string[] | — | Proxy link(s), list URL(s), or any mix |
| `iterations` | int | `1` | Check rounds |
| `concurrency` | int | `30` | Parallel checks |

All input formats work:

```json
// Single proxy link
{ "url": "tg://proxy?server=1.2.3.4&port=443&secret=ee..." }

// Single list URL
{ "url": "https://example.com/proxies.txt" }

// Array — mix of direct links and list URLs
{ "urls": [
    "tg://proxy?server=1.2.3.4&port=443&secret=ee...",
    "https://t.me/proxy?server=5.6.7.8&port=443&secret=dd...",
    "https://example.com/list.txt"
  ]
}
```

**Response:**

```json
{
  "uris": ["https://example.com/proxies.txt"],
  "iterations": 2,
  "concurrency": 20,
  "count": 150,
  "working": 42,
  "results": [
    { "proxy": { "raw": "tg://proxy?...", "server": "1.2.3.4", "port": 443, "secret": "ee...", "sni": "example.com" }, "ok": true, "ms": 312, "error": null }
  ]
}
```

**Error codes:** `400` bad request · `401` unauthorized · `404` wrong endpoint · `405` wrong method · `502` upstream fetch failed

## 🛰 Unified Service (`serve` / `pool`)

One HTTP server, one port, two ways to check proxies — run it as an autonomous service:

- **On-demand** — `POST /check` checks any link(s)/list URL(s) you send and returns a full report. (Same contract as the [HTTP API Server](#-http-api-server) above; it's the same server.)
- **Always-ready pool** — a background loop keeps a **live pool** of working proxies from a sources file, served over non-blocking public `GET` endpoints (reads never block, even mid-check).

```bash
node check.js serve   # POST /check; pool auto-enabled if sources.txt exists
node check.js pool    # POST /check + background pool (forced on)
```

`POST /check` needs `CHECK_AUTH_USER`/`CHECK_AUTH_PASSWORD` (returns `503` if unset). The pool `GET` feed is public by default. Toggle the pool explicitly with `--pool` / `--no-pool`.

### The pool

It loads sources from a nearby file, checks them on a background loop, and serves the survivors over non-blocking `GET` endpoints — reads never block, even while a check round is running.

### Flow

1. **Load** every source from `sources.txt` (remote list URLs, direct proxy links, or local files; `#` comments allowed) into one de-duplicated set, and put the **whole set into the live container immediately** (each entry marked `ok: null` = unchecked). The API can serve it right away.
2. **`--iterations` re-check rounds** run in the background and prune the container **live**: the moment a check fails, that proxy is dropped; the moment one passes, it flips to `ok: true` (with its latency). So a working proxy shows up in the API instantly, mid-round — no waiting for the round to finish.
3. Each round only re-checks the current survivors, so the container narrows down to the most stable proxies.
4. **Sleep** for `--interval` hours, then repeat the whole cycle from the sources (the container is re-seeded with the fresh full set).

`GET /proxies.txt` (and `GET /proxies?working=1`) return only verified-working proxies; `GET /proxies` returns the whole container with each entry's `ok`/`ms`/`error` status so you can see what's still pending. Pass `--clear-on-cycle` to empty the container the moment a new cycle starts (instead of keeping the previous set served until the new one is loaded).

### Start

```bash
# Prepare sources
cp sources.example.txt sources.txt   # then edit it

TG_API_ID=12345 TG_API_HASH=abcdef \
node check.js pool --sources sources.txt --iterations 3 --interval 6
```

### ⚙️ Pool Options

| Flag | Default | Description |
|------|:-------:|-------------|
| `--sources <file>` | `sources.txt` | Source list file |
| `--iterations <n>` | `3` | Re-check rounds against the container |
| `--interval <hours>` | `6` | Pause between full cycles |
| `--dc <1-5>` | `2` | Data center for `testProxy` |
| `--timeout <sec>` | `10` | Per-proxy timeout |
| `--concurrency <n>` | `30` | Parallel checks |
| `--port <n>` | `8080` | HTTP port (or `PORT` env) |
| `--clear-on-cycle` | off | Empty the container at the start of each cycle |
| `--pool` / `--no-pool` | auto | Force the background pool on/off (`serve`/bare auto-enable it when `sources.txt` exists) |
| `--user` / `--password` | env | Basic auth for `POST /check` (fallback: `CHECK_AUTH_USER` / `CHECK_AUTH_PASSWORD`) |

### 🌐 Service Endpoints

| Endpoint | Auth | Response |
|----------|:----:|----------|
| `POST /check` | 🔐 Basic | On-demand check of link(s)/list URL(s); full report |
| `GET /proxies` | — | JSON: cycle metadata + whole container (each entry has `ok`/`ms`/`error`) |
| `GET /proxies?working=1` | — | JSON: metadata + only verified-working proxies |
| `GET /proxies.txt` | — | Verified-working proxy links, plain text (one per line) |
| `GET /status` | — | Cycle/phase metadata only (`containerCount`, `workingCount`, ...) |
| `GET /health` | — | Liveness probe |

Pool `GET` endpoints are served only when the pool is enabled.

```bash
curl "http://localhost:8080/proxies.txt"          # working links, ready to use
curl "http://localhost:8080/proxies?working=1"    # working entries with latency
curl "http://localhost:8080/status"               # cycle/phase + counts
curl -u admin:secret http://localhost:8080/check \
  -H 'Content-Type: application/json' -d '{"url":"https://example.com/list.txt"}'
```

### 🏃 Quick Local Run

```bash
cp .env.example .env          # fill in TG_API_ID / TG_API_HASH
cp sources.example.txt sources.txt   # or use the bundled example directly

npm run dev:pool              # node --env-file=.env, fast params, sources.example.txt
# or, with your own sources.txt and env already exported:
npm run pool
```

## 📚 Library API

```js
const { checkProxyLink, checkProxiesFromURIs, startServer } = require('mtproto-checker')
```

### `checkProxyLink(link, opts)` → `Promise<Array>`

Check a single `tg://proxy` or `https://t.me/proxy` link.

```js
const results = await checkProxyLink(
  'tg://proxy?server=1.2.3.4&port=443&secret=ee...',
  { apiId: 12345, apiHash: 'abcdef' }
)
```

```
[mtproto-checker] Checking 1.2.3.4:443 [example.com]...
[mtproto-checker] ✓ 312ms
```

### `checkProxiesFromURIs(uris, opts)` → `Promise<Array>`

Check proxies from remote URLs, local files, direct proxy links, or any mix. Auto-detects type per entry, de-duplicates automatically.

```js
// Single source
await checkProxiesFromURIs('https://example.com/proxies.txt', opts)

// Direct proxy link
await checkProxiesFromURIs('tg://proxy?server=1.2.3.4&port=443&secret=ee...', opts)

// Mix of everything
await checkProxiesFromURIs([
  'tg://proxy?server=1.2.3.4&port=443&secret=ee...',
  'https://t.me/proxy?server=5.6.7.8&port=443&secret=dd...',
  'https://example.com/list.txt',
  './local-list.txt'
], { apiId: 12345, apiHash: 'abcdef', iterations: 2, concurrency: 20 })
```

```
[mtproto-checker] Loading 4 source(s)...
  ⚡ 1.2.3.4:443
  ⚡ 5.6.7.8:443
  ↓ https://example.com/list.txt
  ◈ ./local-list.txt
[mtproto-checker] Checking 150 proxies (dc=2, timeout=10s, concurrency=20, iterations=2)...

  [  1/150] ✓   312ms  1.2.3.4:443 [example.com]
  [  2/150] ✗ Timeout  5.6.7.8:443
  ...

[mtproto-checker] Done: 42/150 working.
```

### `startServer(opts)` → `Promise<http.Server>`

Start the HTTP API server programmatically.

```js
const server = await startServer({
  apiId: 12345,
  apiHash: 'abcdef',
  user: 'admin',
  password: 'secret',
  port: 8080
})
```

All fields are optional — falls back to env vars if omitted.

### `opts` Reference

| Key | Type | Default | Description |
|-----|------|:-------:|-------------|
| `apiId` | number | — | Telegram API ID |
| `apiHash` | string | — | Telegram API Hash |
| `dc` | number | `2` | Data center (1–5) |
| `timeout` | number | `10` | Timeout in seconds |
| `concurrency` | number | `30` | Parallel checks |
| `iterations` | number | `1` | Check rounds |
| `onProgress` | function | — | `(proxy, res, index, total) => void` |

## 🧩 Proxy Link Formats

```
tg://proxy?server=1.2.3.4&port=443&secret=ee...
https://t.me/proxy?server=1.2.3.4&port=443&secret=ee...
```

Secrets: hex (`ee...`, `dd...`), plain hex, or base64url — auto-detected. `tg://socks` links are ignored.

## 🐳 Docker Deployment

The service ships as a Docker image (built in CI, pushed to the GitLab registry) and runs behind nginx (TLS termination) via Docker Compose. The container runs the [unified service](#-unified-service-serve--pool) — background pool **and** on-demand `POST /check`.

### Server layout — `/opt/mtproto-checker`

Everything runs from `/opt/mtproto-checker`. CI ships `docker-compose.yml` and `default.conf`; **you** prepare the rest once (CI never touches it):

```
/opt/mtproto-checker/
├── docker-compose.yml   ← shipped by CI
├── default.conf         ← shipped by CI (nginx)
├── .env                 ← you: secrets & config
└── ssl/                 ← you: TLS keys
    ├── privkey.key
    └── fullchain.pem
```

### `.env`

Docker Compose auto-loads this for `${VAR}` interpolation. Create it once:

```ini
TG_API_ID=12345
TG_API_HASH=your_api_hash
CHECK_AUTH_USER=admin
CHECK_AUTH_PASSWORD=your_password
PORT=8080
```

The image name is pinned in `docker-compose.yml` (`registry.gitlab.com/<group>/mtproto-checker:latest`) — adjust it to your registry path.

### SSL certificate

Issue a cert straight into `ssl/` with [acme.sh](https://github.com/acmesh-official/acme.sh):

```bash
apt install -y cron socat
curl https://get.acme.sh | sh -s email=your@email.com && source ~/.bashrc
acme.sh --set-default-ca --server letsencrypt

acme.sh --issue --standalone -d 'proxy.example.com' \
  --key-file    /opt/mtproto-checker/ssl/privkey.key \
  --fullchain-file /opt/mtproto-checker/ssl/fullchain.pem
```

Auto-renewal is registered in cron automatically — verify with `crontab -l | grep acme`.

### CI/CD (GitLab)

`.gitlab-ci.yml` has two stages, triggered from a **manual web pipeline** (`Pipelines → Run pipeline`):

1. **build** — `docker build` + `docker push` to `$CI_REGISTRY`.
2. **deploy** — over SSH: `mkdir -p /opt/mtproto-checker/ssl`, `scp` `docker-compose.yml` + `default.conf`, then `docker compose pull && docker compose up -d --force-recreate`.

Required CI/CD variables (**Settings → CI/CD → Variables**):

| Variable | Purpose |
|----------|---------|
| `SERVER_HOST` / `SERVER_USER` | Deploy target (SSH) |
| `SSH_PRIVATE_KEY` | Key authorized on the server |
| `CI_REGISTRY` / `CI_REGISTRY_USER` / `CI_REGISTRY_PASSWORD` | Registry auth (predefined on GitLab.com) |

A scheduled pipeline (**CI/CD → Schedules**) can re-run the deploy to pull the freshest image periodically.

### Manual run

On the server, without CI:

```bash
cd /opt/mtproto-checker
docker login registry.gitlab.com
docker compose pull
docker compose up -d
docker compose logs -f app
```

Behind nginx the endpoints are served over HTTPS:

```bash
curl "https://proxy.example.com/proxies.txt"
curl -u admin:secret https://proxy.example.com/check \
  -H 'Content-Type: application/json' -d '{"url":"https://example.com/list.txt"}'
```

> The image bakes `sources.txt` in, so the pool starts immediately. Change sources without rebuilding by mounting your own file — uncomment the `sources.txt` volume in `docker-compose.yml`.

## 📜 License

[Unlicense](LICENSE) — completely free to use, no restrictions.
