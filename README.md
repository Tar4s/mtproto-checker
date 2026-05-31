# 🔍 mtproto-checker

Telegram MTProto proxy health checker powered by **TDLib**. Performs a real `testProxy` handshake through each proxy — the same protocol path tdesktop uses. If it says ✅, the proxy **actually works** in Telegram.

## ⚡ Features

- 🤝 Real MTProto handshake (not just a port scan)
- 📡 Check from remote URLs, local files, or single proxy links
- 🔄 Multi-iteration filtering — only survivors advance
- 🌐 Built-in HTTP API server with Basic Auth
- 🧹 Auto de-duplication by `server:port:secret`
- 📊 Sorted output: working first, fastest on top
- 🔐 Fake-TLS SNI extraction from `ee`-prefixed secrets

## 📦 Install

```bash
npm install mtproto-checker
```

Or clone locally:

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
| `PORT` | ❌ | Server port (default `3080`) |

## 🚀 CLI Usage

```bash
TG_API_ID=12345 TG_API_HASH=abcdef node check.js [sources] [options]
```

### Input Methods

```bash
# Single proxy link
node check.js --proxy "tg://proxy?server=1.2.3.4&port=443&secret=ee..."

# Remote URLs (positional or --url flag, repeatable)
node check.js https://example.com/proxies.txt
node check.js --url URL1 --url URL2

# File with source URLs (one per line, # comments ok)
node check.js --sources urls.txt

# Local proxy file
node check.js ./my-proxies.txt

# Stdin
cat proxies.txt | node check.js
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

Start with **no arguments**:

```bash
TG_API_ID=12345 TG_API_HASH=abcdef \
CHECK_AUTH_USER=admin CHECK_AUTH_PASSWORD=secret \
node check.js
```

```
[mtproto-checker] ⚡ HTTP server listening on http://localhost:3080
[mtproto-checker]   POST /check (Basic auth: admin:***)
```

### `POST /check`

```bash
curl -u admin:secret http://localhost:3080/check \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/proxies.txt", "iterations": 2, "concurrency": 20}'
```

**Request body:**

| Field | Type | Default | Description |
|-------|------|:-------:|-------------|
| `url` | string | — | Proxy list URL or single `tg://proxy` link |
| `iterations` | int | `1` | Check rounds |
| `concurrency` | int | `30` | Parallel checks |

**Response:**

```json
{
  "url": "https://example.com/proxies.txt",
  "iterations": 2,
  "concurrency": 20,
  "count": 150,
  "working": 42,
  "results": [
    { "server": "1.2.3.4", "port": 443, "sni": "example.com", "ok": true, "ms": 312, "error": null, "link": "tg://proxy?..." }
  ]
}
```

**Error codes:** `400` bad request · `401` unauthorized · `404` wrong endpoint · `405` wrong method · `502` upstream fetch failed

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

Check proxies from remote URLs, local files, or both. Auto-detects type per entry.

```js
// Remote
const results = await checkProxiesFromURIs(
  'https://example.com/proxies.txt',
  { apiId: 12345, apiHash: 'abcdef' }
)

// Local
const results = await checkProxiesFromURIs('./proxies.txt', opts)

// Mix
const results = await checkProxiesFromURIs([
  'https://example.com/list1.txt',
  './local-list.txt',
  'https://example.com/list2.txt'
], { apiId: 12345, apiHash: 'abcdef', iterations: 2, concurrency: 20 })
```

```
[mtproto-checker] Loading 3 source(s)...
  ↓ https://example.com/list1.txt
  ◈ ./local-list.txt
  ↓ https://example.com/list2.txt
[mtproto-checker] Checking 150 proxies (dc=2, timeout=10s, concurrency=30, iterations=2)...

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

## 🛠 Troubleshooting

| Problem | Fix |
|---------|-----|
| `Set TG_API_ID and TG_API_HASH` | Export both env vars |
| Noisy latency | Reduce `--concurrency` |
| Need stable proxies only | Increase `--iterations` |
| TDLib leftover files | `.proxy-checker-td/` is auto-cleaned after each run |

## 📜 License

ISC
