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

Structure on the server:

```
/etc/mtproto-checker/          ← source code (auto-pulled)
├── check.js
├── Dockerfile
├── package.json
└── ...

/opt/mtproto-checker/          ← configs & certs (manual)
├── docker-compose.yml
├── default.conf
├── fullchain.pem
└── privkey.key
```

### `docker-compose.yml`

```yaml
services:
  app:
    container_name: mtproto-checker
    build: /etc/mtproto-checker
    restart: unless-stopped
    environment:
      - TG_API_ID=your_api_id
      - TG_API_HASH=your_api_hash
      - CHECK_AUTH_USER=admin
      - CHECK_AUTH_PASSWORD=your_password
      - PORT=8080
    expose:
      - "8080"

  nginx:
    container_name: mtproto-checker-nginx
    image: nginx:alpine
    restart: unless-stopped
    ports:
      - "443:443"
      - "80:80"
    volumes:
      - ./default.conf:/etc/nginx/conf.d/default.conf:ro
      - ./privkey.key:/etc/nginx/ssl/privkey.key:ro
      - ./fullchain.pem:/etc/nginx/ssl/fullchain.pem:ro
    depends_on:
      - app
```

### `default.conf`

```nginx
server {
    listen 443 ssl;
    server_name _;

    ssl_certificate     /etc/nginx/ssl/fullchain.pem;
    ssl_certificate_key /etc/nginx/ssl/privkey.key;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;

    location / {
        proxy_pass http://app:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # Объявляем переменную с таймаутом (600s = 10 минут)
        set $custom_timeout 600s;

        # Используем переменную для всех таймаутов
        proxy_read_timeout          $custom_timeout;
        proxy_connect_timeout       $custom_timeout;
        proxy_send_timeout          $custom_timeout;
        send_timeout                $custom_timeout;
    }
}

server {
    listen 80;
    server_name _;
    return 301 https://$host$request_uri;
}
```

### SSL Certificate

Install acme.sh:

```bash
sudo apt-get install cron socat
curl https://get.acme.sh | sh -s email=your@email.com && source ~/.bashrc
acme.sh --set-default-ca --server letsencrypt
```

Issue certificate:

```bash
acme.sh --issue --standalone -d 'your-domain.example.com' \
  --key-file /opt/mtproto-checker/privkey.key \
  --fullchain-file /opt/mtproto-checker/fullchain.pem
```

Auto-renewal is set up via cron automatically. Verify with `crontab -l | grep acme`.

### Deploy

```bash
docker compose build --no-cache
docker compose up -d
```

## 🛠 Troubleshooting

| Problem | Fix |
|---------|-----|
| `Set TG_API_ID and TG_API_HASH` | Export both env vars |
| Noisy latency | Reduce `--concurrency` |
| Need stable proxies only | Increase `--iterations` |
| TDLib leftover files | `.proxy-checker-td/` is auto-cleaned after each run |

## 📜 License

[Unlicense](LICENSE) — completely free to use, no restrictions.
