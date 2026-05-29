# MTProto Checker ⚡

Fast Telegram MTProto proxy checker powered by TDLib. It does a real `testProxy`
handshake through every proxy, so a green result means the proxy is much more
likely to work in Telegram than with a plain TCP/TLS port check.

## What It Does

- ✅ Parses `tg://proxy` and `https://t.me/proxy` links
- 🌐 Loads proxy lists from remote URLs, local files, or `stdin`
- 🧹 Removes duplicates by `server:port:secret`
- 🔐 Supports hex and base64url MTProto secrets
- 🕵️ Extracts Fake-TLS SNI from `ee...` secrets and supports padded `dd...` secrets
- 🚀 Checks proxies concurrently via TDLib `testProxy`
- 💪 Re-checks survivors with `--iterations` to find the most stable proxies
- 📄 Writes both a full JSON report and a ready-to-use TXT list

## Requirements

- Node.js 18+ recommended
- npm
- Telegram API credentials:
  - `TG_API_ID`
  - `TG_API_HASH`

Get API credentials from [my.telegram.org](https://my.telegram.org).

> No Telegram login or phone number is required. The credentials are only used
> to initialize TDLib before running `testProxy`.

## Installation

```bash
git clone git@github.com:Tar4s/mtproto-checker.git
cd mtproto-checker
npm install
```

Optional, if you want the `check-proxies` command available locally:

```bash
npm link
```

### GitHub Packages

This project can also be published to GitHub Packages as
`@tar4s/mtproto-checker`. GitHub's npm registry requires scoped package names,
so the GitHub Packages workflow applies that scoped name during publishing.

To install from GitHub Packages:

```bash
npm config set @tar4s:registry https://npm.pkg.github.com
npm install @tar4s/mtproto-checker
```

Private packages require authentication with a GitHub personal access token that
has `read:packages`.

## Quick Start

Start the HTTP API server:

```bash
TG_API_ID=12345 \
TG_API_HASH=abcdef \
CHECK_AUTH_USER=admin \
CHECK_AUTH_PASSWORD=secret \
node check.js
```

By default it listens on port `3080`. Override it with `PORT`.

Check URLs listed in `urls.txt`:

```bash
TG_API_ID=12345 TG_API_HASH=abcdef npm start -- --sources urls.txt
```

Equivalent direct Node.js run:

```bash
TG_API_ID=12345 TG_API_HASH=abcdef node check.js --sources urls.txt
```

With `npm link`:

```bash
TG_API_ID=12345 TG_API_HASH=abcdef check-proxies --sources urls.txt
```

Check one proxy link directly:

```bash
TG_API_ID=12345 TG_API_HASH=abcdef node check.js \
  --proxy 'tg://proxy?server=quackton.life&port=443&secret=7mX8dVOh9cqLULccAVs4ciR5YW5kZXgucnU'
```

## Input Sources

You can provide proxies in several ways.

### 1. Direct Proxy Link

```bash
TG_API_ID=12345 TG_API_HASH=abcdef node check.js \
  --proxy 'https://t.me/proxy?server=1.2.3.4&port=443&secret=...'
```

### 2. Source URL File

`urls.txt` contains one remote text-list URL per line:

```txt
https://example.com/proxies.txt
https://example.com/more-proxies.txt
```

Run:

```bash
TG_API_ID=12345 TG_API_HASH=abcdef node check.js --sources urls.txt
```

### 3. One Or More Remote URLs

```bash
TG_API_ID=12345 TG_API_HASH=abcdef node check.js \
  --url https://example.com/proxies.txt \
  --url https://example.com/more-proxies.txt
```

Positional HTTP URLs also work:

```bash
TG_API_ID=12345 TG_API_HASH=abcdef node check.js https://example.com/proxies.txt
```

### 4. Local Proxy File

```bash
TG_API_ID=12345 TG_API_HASH=abcdef node check.js proxies.txt
```

### 5. stdin

```bash
cat proxies.txt | TG_API_ID=12345 TG_API_HASH=abcdef node check.js
```

Input files may contain blank lines and `#` comments.

## CLI Options

| Option | Default | Description |
| --- | ---: | --- |
| `--url <url>` | none | Add a remote proxy-list URL. Can be repeated. |
| `--proxy <link>` | none | Check one `tg://proxy` or `https://t.me/proxy` link directly. |
| `--sources <file>` | none | Read remote source URLs from a file, one URL per line. |
| `--dc <1-5>` | `2` | Telegram data center ID used for `testProxy`. |
| `--timeout <sec>` | `10` | Per-proxy TDLib timeout in seconds. Decimals are allowed. |
| `--concurrency <n>` | `30` | Number of proxies checked in parallel. Lower values can produce steadier latency numbers. |
| `--iterations <num>` | `1` | Number of check rounds. Each next round checks only proxies that passed the previous one. |
| `--out <prefix>` | `result` | Output file prefix. Writes `<prefix>.json` and `<prefix>.txt`. |

Environment variables:

| Variable | Required | Description |
| --- | --- | --- |
| `TG_API_ID` | yes | Telegram API ID from `my.telegram.org`. |
| `TG_API_HASH` | yes | Telegram API hash from `my.telegram.org`. |
| `CHECK_AUTH_USER` | HTTP server only | Basic auth username. |
| `CHECK_AUTH_PASSWORD` | HTTP server only | Basic auth password. |
| `PORT` | no | HTTP server port. Defaults to `3080`. |

## HTTP API

Running `node check.js` without CLI arguments starts the HTTP server. The server
requires Basic auth and exposes one endpoint:

```http
POST /check
Content-Type: application/json
Authorization: Basic ...

{ "url": "https://example.com/proxies.txt", "iterations": 3, "concurrency": 10 }
```

The `url` field accepts either a remote `http(s)` proxy list or one direct
`tg://proxy` / `https://t.me/proxy` link. The optional `iterations` field is a
positive integer; each next round checks only proxies that passed the previous
round. It defaults to `1`. The optional `concurrency` field controls how many
proxies are checked in parallel per round. It defaults to `30`.

Example:

```bash
curl -u admin:secret \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com/proxies.txt","iterations":3,"concurrency":10}' \
  http://127.0.0.1:3080/check
```

Direct proxy link example:

```bash
curl -u admin:secret \
  -H 'content-type: application/json' \
  -d '{"url":"tg://proxy?server=quackton.life&port=443&secret=7mX8dVOh9cqLULccAVs4ciR5YW5kZXgucnU"}' \
  http://127.0.0.1:3080/check
```

Response:

```json
{
  "url": "https://example.com/proxies.txt",
  "iterations": 3,
  "concurrency": 10,
  "count": 1,
  "working": 1,
  "results": [
    {
      "server": "1.2.3.4",
      "port": 443,
      "sni": "example.com",
      "ok": true,
      "ms": 841,
      "error": null,
      "link": "tg://proxy?server=1.2.3.4&port=443&secret=..."
    }
  ]
}
```

## Output

By default the checker writes:

- `result.json` — full report for the final completed round
- `result.txt` — working proxy links from the final completed round, fastest first

Example JSON item:

```json
{
  "server": "1.2.3.4",
  "port": 443,
  "sni": "example.com",
  "ok": true,
  "ms": 841,
  "error": null,
  "link": "tg://proxy?server=1.2.3.4&port=443&secret=..."
}
```

Use a custom prefix:

```bash
TG_API_ID=12345 TG_API_HASH=abcdef node check.js --sources urls.txt --out fresh
```

This creates `fresh.json` and `fresh.txt`.

## Practical Examples

Fast broad scan:

```bash
TG_API_ID=12345 TG_API_HASH=abcdef node check.js --sources urls.txt --concurrency 80 --timeout 7
```

More conservative latency check:

```bash
TG_API_ID=12345 TG_API_HASH=abcdef node check.js --sources urls.txt --concurrency 10 --timeout 15
```

Find the most stable proxies across several rounds:

```bash
TG_API_ID=12345 TG_API_HASH=abcdef node check.js --sources urls.txt --iterations 3 --out stable
```

Test against another Telegram DC:

```bash
TG_API_ID=12345 TG_API_HASH=abcdef node check.js --sources urls.txt --dc 4
```

Check a pasted list:

```bash
pbpaste | TG_API_ID=12345 TG_API_HASH=abcdef node check.js --out pasted
```

## Programmatic Usage

```js
const { checkProxiesFromUrls } = require('./check')

const results = await checkProxiesFromUrls(
  ['https://example.com/proxies.txt'],
  {
    apiId: Number(process.env.TG_API_ID),
    apiHash: process.env.TG_API_HASH,
    dc: 2,
    timeout: 10,
    concurrency: 30
  }
)

console.log(results)
```

Exported helpers:

- `checkProxiesFromUrls(urls, opts)`
- `loadProxiesFromUrls(urls)`
- `checkProxies(proxies, opts)`
- `mergeProxies(texts)`
- `parseLink(line)`
- `normalizeSecret(secret)`
- `faketlsSni(hexSecret)`

## Notes & Troubleshooting

- If you see `Set TG_API_ID and TG_API_HASH`, export both credentials or prefix
  the command with them.
- If remote URLs fail on old Node.js versions, upgrade to Node.js 18+.
- If checks are noisy, reduce `--concurrency`.
- If you want only resilient proxies, increase `--iterations`; `result.txt`
  will contain proxies that survived the final round.
- Only MTProto proxy links are checked. `tg://socks` links are ignored.
- Temporary TDLib files are created in `.proxy-checker-td/` and removed after the run.

## License

No license file is currently included.
