# MTProto Checker

Telegram MTProto proxy checker powered by TDLib. It runs a real `testProxy`
handshake through each proxy, so a successful result is closer to "works in
Telegram" than a plain TCP/TLS port check.

## Features

- Parses `tg://proxy` and `https://t.me/proxy` links.
- Loads proxies from direct links, remote lists, local files, or `stdin`.
- De-duplicates by `server:port:secret`.
- Supports hex and base64url secrets, including Fake-TLS SNI extraction.
- Checks proxies concurrently and can re-check only successful proxies across
  multiple iterations.
- Works as a CLI, HTTP API server, or CommonJS library.

## Requirements

- Node.js 18+
- Telegram API credentials: `TG_API_ID` and `TG_API_HASH`

Get credentials from [my.telegram.org](https://my.telegram.org). No Telegram
login or phone number is required; credentials are only used to initialize TDLib.

## Install

```bash
npm install mtproto-checker
```

For local development:

```bash
git clone git@github.com:Tar4s/mtproto-checker.git
cd mtproto-checker
npm install
```

GitHub Packages users can install the scoped package:

```bash
npm config set @tar4s:registry https://npm.pkg.github.com
npm install @tar4s/mtproto-checker
```

Private GitHub Packages require a token with `read:packages`.

## CLI

```bash
TG_API_ID=12345 TG_API_HASH=abcdef npx mtproto-checker --sources urls.txt
```

Common inputs:

```bash
# One direct proxy link
TG_API_ID=12345 TG_API_HASH=abcdef node check.js \
  --proxy 'tg://proxy?server=1.2.3.4&port=443&secret=...'

# One or more remote proxy-list URLs
TG_API_ID=12345 TG_API_HASH=abcdef node check.js \
  --url https://example.com/proxies.txt \
  --url https://example.com/more.txt

# Source URL file, local proxy file, or stdin
TG_API_ID=12345 TG_API_HASH=abcdef node check.js --sources urls.txt
TG_API_ID=12345 TG_API_HASH=abcdef node check.js proxies.txt
cat proxies.txt | TG_API_ID=12345 TG_API_HASH=abcdef node check.js
```

Options:

| Option | Default | Description |
| --- | ---: | --- |
| `--proxy <link>` | none | Check one `tg://proxy` or `https://t.me/proxy` link directly. |
| `--url <url>` | none | Add a remote proxy-list URL. Repeatable. |
| `--sources <file>` | none | Read remote source URLs from a file. |
| `--dc <1-5>` | `2` | Telegram data center used for `testProxy`. |
| `--timeout <sec>` | `10` | Per-proxy TDLib timeout. |
| `--concurrency <n>` | `30` | Parallel proxy checks. |
| `--iterations <n>` | `1` | Re-check only successful proxies for `n` rounds. |
| `--out <prefix>` | `result` | Writes `<prefix>.json` and `<prefix>.txt`. |

Input files may contain blank lines and `#` comments. Only MTProto proxy links
are checked; `tg://socks` links are ignored.

## HTTP API

Running `node check.js` without arguments starts the server on `PORT` or `3080`.
Basic auth is required.

```bash
TG_API_ID=12345 \
TG_API_HASH=abcdef \
CHECK_AUTH_USER=admin \
CHECK_AUTH_PASSWORD=secret \
node check.js
```

Endpoint:

```http
POST /check
Content-Type: application/json
Authorization: Basic ...

{
  "url": "https://example.com/proxies.txt",
  "iterations": 3,
  "concurrency": 10
}
```

`url` accepts either a remote `http(s)` proxy list or one direct `tg://proxy` /
`https://t.me/proxy` link. `iterations` defaults to `1`; `concurrency` defaults
to `30`.

Example:

```bash
curl -u admin:secret \
  -H 'content-type: application/json' \
  -d '{"url":"tg://proxy?server=1.2.3.4&port=443&secret=...","iterations":3,"concurrency":10}' \
  http://127.0.0.1:3080/check
```

Response shape:

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

## Library Usage

```js
const { checkRequestUrl, checkProxiesFromUrls } = require('mtproto-checker')

const opts = {
  apiId: Number(process.env.TG_API_ID),
  apiHash: process.env.TG_API_HASH,
  concurrency: 30,
  iterations: 2
}

const direct = await checkRequestUrl('tg://proxy?server=1.2.3.4&port=443&secret=...', opts)
const fromLists = await checkProxiesFromUrls(['https://example.com/proxies.txt'], opts)

console.log(direct, fromLists)
```

Main exports:

- `checkRequestUrl(url, opts)`
- `checkProxiesFromUrls(urls, opts)`
- `loadProxiesFromUrls(urls)`
- `checkProxies(proxies, opts)`
- `mergeProxies(texts)`
- `parseLink(line)`
- `normalizeSecret(secret)`
- `faketlsSni(hexSecret)`

## Output

CLI runs write:

- `result.json` or `<out>.json`: full report for the final completed round.
- `result.txt` or `<out>.txt`: working proxy links, fastest first.

Use `--out fresh` to write `fresh.json` and `fresh.txt`.

## Troubleshooting

- `Set TG_API_ID and TG_API_HASH`: export both credentials or prefix the command.
- Noisy latency: reduce `--concurrency`.
- Need only stable proxies: increase `--iterations`.
- Temporary TDLib files are created in `.proxy-checker-td/` and removed after the run.

## License

No license file is currently included.
