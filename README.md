# 🔍 mtproto-checker

Telegram MTProto proxy health checker powered by **TDLib**. Runs a real `testProxy` handshake through each proxy — the same path tdesktop uses — so a ✅ means the proxy **actually works** in Telegram, not just that a port is open.

## ⚡ Features

- 🤝 Real MTProto handshake — not a port scan
- 📡 Sources: remote URLs, local files, direct links, or any mix (auto-deduped)
- 🖥 Three modes: one-shot **CLI**, on-demand **HTTP API**, always-on **pool** + web dashboard
- 🎯 Accurate latency via a low-concurrency measurement pass
- 🔐 Fake-TLS SNI extraction · adaptive result sorting

## 📦 Install

```bash
npm install -g mtproto-checker      # global → `mtproto-checker` command
# or from source:
git clone https://github.com/Tar4s/mtproto-checker.git && cd mtproto-checker && npm install
```

**Requirements:** Node.js ≥ 18 · `TG_API_ID` + `TG_API_HASH` from [my.telegram.org](https://my.telegram.org) (no phone login — they only initialize TDLib).

## 🔑 Environment

| Variable | Required | Description |
|----------|:--------:|-------------|
| `TG_API_ID` / `TG_API_HASH` | ✅ | Telegram API credentials |
| `CHECK_AUTH_USER` / `CHECK_AUTH_PASSWORD` | server | Basic auth for `POST /check` (unset → `/check` returns `503`) |
| `PORT` | ❌ | HTTP port (default `8080`) |

Examples below use `node check.js`; with the global install swap in `mtproto-checker`.

## 🖥 CLI (one-shot)

```bash
TG_API_ID=… TG_API_HASH=… node check.js [sources] [options]

node check.js --proxy "tg://proxy?server=1.2.3.4&port=443&secret=ee…"   # one link
node check.js https://example.com/proxies.txt                            # remote list
node check.js --sources urls.txt                                         # file of source URLs
node check.js ./my-proxies.txt                                           # local file
cat proxies.txt | node check.js                                          # stdin
```

| Flag | Default | Description |
|------|:-------:|-------------|
| `--proxy <link>` | — | Check one proxy link directly |
| `--url <url>` | — | Add a source URL (repeatable) |
| `--sources <file>` | — | File of source URLs |
| `--dc <1-5>` | `2` | Data center for `testProxy` |
| `--timeout <sec>` | `10` | Per-proxy timeout |
| `--concurrency <n>` | `30` | Parallel checks (lower = more accurate `ms`) |
| `--iterations <n>` | `1` | Re-check rounds; only working proxies advance |
| `--out <prefix>` | `result` | Output prefix → `<prefix>.json` (full report) + `.txt` (working links) |

## 🛰 Service (`serve` / `pool`)

One HTTP server, one port. Always serves on-demand `POST /check`; optionally runs a background **pool** that keeps a live, always-ready set of working proxies plus a web dashboard at `/`.

```bash
node check.js serve   # POST /check; pool auto-on if sources.txt exists
node check.js pool    # POST /check + background pool (forced on)
```

### Endpoints

| Endpoint | Auth | Response |
|----------|:----:|----------|
| `POST /check` | 🔐 | On-demand check of link(s)/list URL(s) → full report |
| `GET /` | — | Web dashboard (served when pool is on) |
| `GET /proxies` | — | Whole container; each entry has `ok`/`ms`/`error` |
| `GET /proxies?working=1` | — | Verified-working entries only (JSON) |
| `GET /proxies.txt` | — | Verified-working links, plain text |
| `GET /status` | — | Cycle/phase metadata (`workingCount`, `containerCount`, …) |
| `GET /health` | — | Liveness probe |

```bash
curl "http://localhost:8080/proxies.txt"
curl -u admin:secret http://localhost:8080/check \
  -H 'Content-Type: application/json' -d '{"url":"https://example.com/list.txt"}'
```

### How the pool works

1. **Load** all sources into one deduped set and expose it immediately (`ok: null` = unchecked).
2. **Filter** — `--iterations` fast rounds prune the container live; dead links drop, survivors flip to `ok: true` the moment they pass.
3. **Measure** — survivors re-checked once at low concurrency (`--measure-concurrency`) for accurate latency (concurrent-round `ms` is inflated by TDLib queueing and discarded).
4. **Sleep** `--interval` hours, re-measuring every `--keepalive` minutes to drop proxies that died and refresh latency (console-only). Then repeat from sources.

Reads never block — a `GET` always returns a consistent snapshot, even mid-check.

### Pool options

| Flag | Default | Description |
|------|:-------:|-------------|
| `--sources <file>` | `sources.txt` | Source list (URLs / links / files; `#` comments ok) |
| `--iterations <n>` | `3` | Filtering rounds |
| `--interval <hours>` | `6` | Pause between full cycles |
| `--keepalive <min>` | `15` | Re-measure interval during the pause |
| `--concurrency <n>` | `30` | Parallel checks in filtering rounds |
| `--measure-concurrency <n>` | `1` | Parallel checks in the latency pass (keep low) |
| `--dc <1-5>` · `--timeout <sec>` · `--port <n>` | `2` · `10` · `8080` | Same as CLI |
| `--clear-on-cycle` | off | Empty the container at the start of each cycle |
| `--pool` / `--no-pool` | auto | Force the pool on/off |

### Quick local run

```bash
cp .env.example .env                 # fill TG_API_ID / TG_API_HASH (+ CHECK_AUTH_* for /check)
cp sources.example.txt sources.txt   # or edit the bundled example
npm run dev:pool                     # loads .env, fast params → http://localhost:8080/
```

### `POST /check` contract

Body accepts `url`/`urls`/`uri`/`uris` (string or array of proxy links and/or list URLs), plus optional `iterations` (`1`) and `concurrency` (`30`).

```json
// response
{ "uris": ["…"], "iterations": 2, "concurrency": 20, "count": 150, "working": 42,
  "results": [ { "proxy": { "raw": "tg://proxy?…", "server": "1.2.3.4", "port": 443, "secret": "ee…", "sni": "example.com" }, "ok": true, "ms": 312, "error": null } ] }
```

Errors: `400` bad request · `401` unauthorized · `405` wrong method · `502` upstream fetch failed · `503` `/check` disabled (no auth set).

## 📚 Library API

```js
const { checkProxyLink, checkProxiesFromURIs, startServer } = require('mtproto-checker')

await checkProxyLink('tg://proxy?server=1.2.3.4&port=443&secret=ee…', { apiId, apiHash })

await checkProxiesFromURIs([
  'tg://proxy?server=1.2.3.4&port=443&secret=ee…',
  'https://example.com/list.txt',
  './local-list.txt'
], { apiId, apiHash, iterations: 2, concurrency: 20 })

await startServer({ apiId, apiHash, user: 'admin', password: 'secret', port: 8080 })
```

`opts`: `apiId`, `apiHash`, `dc` (`2`), `timeout` (`10`), `concurrency` (`30`), `iterations` (`1`), `onProgress(proxy, res, index, total)`. Missing fields fall back to env vars.

## 🧩 Proxy link formats

```
tg://proxy?server=1.2.3.4&port=443&secret=ee…
https://t.me/proxy?server=1.2.3.4&port=443&secret=ee…
```

Secrets: hex, plain hex, or base64url (auto-detected). `tg://socks` links are ignored.

## 🐳 Deployment

The app runs in Docker as the unified service, published on `127.0.0.1:${HOST_PORT}` only; **host nginx** terminates TLS and is the single public entry point.

- **Container** — [`docker/docker-compose.yml`](docker/docker-compose.yml). Prepare `.env` (secrets) next to it; the image bakes `sources.txt` in, override it via the `sources.txt` volume.
- **nginx** — copy [`nginx/mtproto-checker.conf`](nginx/mtproto-checker.conf) into `sites-available`, point `server_name` + certs at your domain. TLS setup (acme.sh, standalone on port 80) in [`nginx/README.md`](nginx/README.md).
- **CI/CD** — GitHub Actions builds the image and deploys over SSH (`git pull` → `docker compose up -d`). `APP_ENV` / `APP_SOURCES` repo variables become the server's `.env` / `sources.txt`; `SERVER_HOST` / `SERVER_USER` / `SSH_PRIVATE_KEY` are secrets.

```bash
# on the server, manually:
cd /opt/mtproto-checker && docker compose up -d && docker compose logs -f app
```

## 📜 License

[Unlicense](LICENSE) — free to use, no restrictions.
