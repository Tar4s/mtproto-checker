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

## Quick Start

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

## Input Sources

You can provide proxies in several ways.

### 1. Source URL File

`urls.txt` contains one remote text-list URL per line:

```txt
https://example.com/proxies.txt
https://example.com/more-proxies.txt
```

Run:

```bash
TG_API_ID=12345 TG_API_HASH=abcdef node check.js --sources urls.txt
```

### 2. One Or More Remote URLs

```bash
TG_API_ID=12345 TG_API_HASH=abcdef node check.js \
  --url https://example.com/proxies.txt \
  --url https://example.com/more-proxies.txt
```

Positional HTTP URLs also work:

```bash
TG_API_ID=12345 TG_API_HASH=abcdef node check.js https://example.com/proxies.txt
```

### 3. Local Proxy File

```bash
TG_API_ID=12345 TG_API_HASH=abcdef node check.js proxies.txt
```

### 4. stdin

```bash
cat proxies.txt | TG_API_ID=12345 TG_API_HASH=abcdef node check.js
```

Input files may contain blank lines and `#` comments.

## CLI Options

| Option | Default | Description |
| --- | ---: | --- |
| `--url <url>` | none | Add a remote proxy-list URL. Can be repeated. |
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
