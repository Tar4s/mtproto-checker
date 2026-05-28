#!/usr/bin/env node
'use strict'

/**
 * MTProto proxy health checker built on TDLib (via the `tdl` Node binding).
 *
 * Unlike a TCP/TLS ping, this performs a real MTProto handshake to a Telegram
 * data center *through* each proxy using TDLib's `testProxy` method — the same
 * protocol path the official clients (tdesktop) use. A "ok" here therefore
 * means the proxy will actually work in the app, not just that the port is open
 * or that some web server is answering the Fake-TLS camouflage.
 *
 * Sources of proxies (any combination):
 *   - one or more remote URLs (e.g. raw GitHub files), fetched and merged;
 *   - a local file (one link per line);
 *   - stdin.
 * In all cases links are parsed, blank/`#`-comment lines dropped, and the
 * result de-duplicated (by server+port+secret) via a Set.
 *
 * CLI usage:
 *   TG_API_ID=12345 TG_API_HASH=abcdef... node check-proxies.js [sources] [options]
 *   # sources: any positional http(s) URL, a local file path, or stdin
 *   node check-proxies.js https://raw.githubusercontent.com/u/r/main/list.txt
 *   node check-proxies.js --url URL1 --url URL2
 *   node check-proxies.js --sources urls.txt           # file with one URL per line
 *   cat proxies.txt | node check-proxies.js
 *
 * Options:
 *   --url <url>         add a source URL (repeatable)
 *   --sources <file>    file containing source URLs (one per line, # comments ok)
 *   --dc <1-5>          data center id to test against (default 2)
 *   --timeout <sec>     per-proxy TDLib timeout in seconds (default 10)
 *   --concurrency <n>   parallel checks (default 30; lower = more accurate ms)
 *   --out <prefix>      output file prefix (default "result")
 *
 * Module usage:
 *   const { checkProxiesFromUrls } = require('./check-proxies')
 *   const results = await checkProxiesFromUrls([url1, url2], { apiId, apiHash })
 *
 * Requirements: Node.js v18+ (for global fetch), `npm i tdl prebuilt-tdlib`,
 *   and api_id/api_hash from https://my.telegram.org (no login is performed).
 */

const fs = require('fs')
const path = require('path')
const tdl = require('tdl')
const { getTdjson } = require('prebuilt-tdlib')

/**
 * Parse argv into an options object, collecting source URLs and/or a file path.
 * @param {string[]} argv - process.argv.slice(2)
 * @returns {{file: string|null, urls: string[], sourcesFile: string|null, dc: number, timeout: number, concurrency: number, out: string}}
 */
function parseArgs(argv) {
  const opts = { file: null, urls: [], sourcesFile: null, dc: 2, timeout: 10, concurrency: 30, out: 'result' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dc') opts.dc = parseInt(argv[++i], 10)
    else if (a === '--timeout') opts.timeout = parseFloat(argv[++i])
    else if (a === '--concurrency') opts.concurrency = parseInt(argv[++i], 10)
    else if (a === '--out') opts.out = argv[++i]
    else if (a === '--url') opts.urls.push(argv[++i])
    else if (a === '--sources') opts.sourcesFile = argv[++i]
    else if (/^https?:\/\//i.test(a)) opts.urls.push(a)
    else if (!a.startsWith('--')) opts.file = a
  }
  return opts
}

/**
 * Read raw input from a file path, or from stdin when no path is given.
 * @param {string|null} file - path to the proxy list, or null for stdin
 * @returns {Promise<string>} the raw file contents
 */
function readInput(file) {
  if (file) return Promise.resolve(fs.readFileSync(file, 'utf8'))
  return new Promise((resolve, reject) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', chunk => { data += chunk })
    process.stdin.on('end', () => resolve(data))
    process.stdin.on('error', reject)
  })
}

/**
 * Normalize a proxy secret to lowercase hex. Accepts hex (`ee...`, `dd...`,
 * plain) or base64url-encoded secrets and returns the hex form expected by
 * TDLib's proxyTypeMtproto.
 * @param {string} secret - the raw `secret` query parameter
 * @returns {string} lowercase hex secret
 */
function normalizeSecret(secret) {
  const s = secret.trim()
  if (/^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0) return s.toLowerCase()
  return Buffer.from(s, 'base64url').toString('hex')
}

/**
 * Extract the Fake-TLS camouflage domain (SNI) embedded in an `ee`-prefixed
 * secret: one tag byte + 16-byte key (34 hex chars), then the domain in hex.
 * @param {string} hexSecret - lowercase hex secret
 * @returns {string|null} the SNI domain, or null if not a Fake-TLS secret
 */
function faketlsSni(hexSecret) {
  if (!hexSecret.startsWith('ee')) return null
  const domainHex = hexSecret.slice(34)
  if (!domainHex) return null
  try {
    return Buffer.from(domainHex, 'hex').toString('utf8')
  } catch {
    return null
  }
}

/**
 * Parse a single tg://proxy or https://t.me/proxy link into proxy fields.
 * @param {string} line - a single, comment-stripped, trimmed line
 * @returns {{raw: string, server: string, port: number, secret: string, sni: string|null}|null}
 *   parsed proxy, or null if the line is not a supported MTProto proxy link
 */
function parseLink(line) {
  const raw = line.trim()
  const qIndex = raw.indexOf('?')
  if (qIndex === -1) return null
  // Only MTProto proxies (tg://proxy / t.me/proxy); tg://socks is skipped.
  if (!/\bproxy\b/i.test(raw.slice(0, qIndex))) return null
  const params = new URLSearchParams(raw.slice(qIndex + 1))
  const server = params.get('server')
  const port = parseInt(params.get('port'), 10)
  const secretRaw = params.get('secret')
  if (!server || !port || !secretRaw) return null
  const secret = normalizeSecret(secretRaw)
  return { raw, server, port, secret, sni: faketlsSni(secret) }
}

/**
 * Parse one proxy-list text blob, appending unique proxies (by
 * server:port:secret) to `out` using the shared `seen` set. `#` starts a
 * comment (whole-line or trailing); blank lines are ignored.
 * @param {string} text - a proxy list
 * @param {Set<string>} seen - shared de-duplication set (canonical keys)
 * @param {Array} out - accumulator for unique proxies
 */
function collectProxies(text, seen, out) {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split('#')[0].trim()
    if (!line) continue
    const proxy = parseLink(line)
    if (!proxy) continue
    const key = `${proxy.server}:${proxy.port}:${proxy.secret}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(proxy)
  }
}

/**
 * Merge multiple proxy-list text blobs into one de-duplicated array.
 * @param {string[]} texts - raw proxy lists
 * @returns {Array} unique proxies in first-seen order
 */
function mergeProxies(texts) {
  const seen = new Set()
  const out = []
  for (const text of texts) collectProxies(text, seen, out)
  return out
}

/**
 * Download a URL and return its body text.
 * @param {string} url - the raw file URL
 * @returns {Promise<string>} the response body
 * @throws on a non-2xx response
 */
async function fetchText(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.text()
}

/**
 * Download every source URL concurrently, then merge + de-duplicate all proxy
 * links into one array. Sources that fail to download are logged and skipped.
 * @param {string[]} urls - raw URLs of text files, one proxy link per line
 * @returns {Promise<Array>} unique proxies
 */
async function loadProxiesFromUrls(urls) {
  const texts = await Promise.all(urls.map(async url => {
    try {
      return await fetchText(url)
    } catch (err) {
      console.error(`Skipping ${url}: ${err.message}`)
      return ''
    }
  }))
  return mergeProxies(texts)
}

/**
 * Drive the pre-authorization TDLib flow manually (without `client.login`):
 * answer `authorizationStateWaitTdlibParameters` with `setTdlibParameters` and
 * resolve once the client is ready to serve `testProxy` requests. We never log
 * in, so it parks at `authorizationStateWaitPhoneNumber`, which is enough.
 * @param {import('tdl').Client} client - the tdl client
 * @param {{apiId: number, apiHash: string, databaseDirectory: string, filesDirectory: string}} cfg
 * @returns {Promise<void>} resolves when parameters are set
 */
function prepare(client, cfg) {
  return new Promise((resolve, reject) => {
    /**
     * React to authorization-state transitions until the client is ready.
     * @param {{_: string, authorization_state?: {_: string}}} update
     */
    const onUpdate = update => {
      if (update._ !== 'updateAuthorizationState') return
      const state = update.authorization_state._
      if (state === 'authorizationStateWaitTdlibParameters')
        client.invoke({
          _: 'setTdlibParameters',
          api_id: cfg.apiId,
          api_hash: cfg.apiHash,
          database_directory: cfg.databaseDirectory,
          files_directory: cfg.filesDirectory,
          database_encryption_key: '',
          use_file_database: false,
          use_chat_info_database: false,
          use_message_database: false,
          use_secret_chats: false,
          system_language_code: 'en',
          device_model: 'mtproto-proxy-checker',
          system_version: '1.0',
          application_version: '1.0',
          use_test_dc: false
        }).catch(reject)
      else if (state === 'authorizationStateWaitPhoneNumber' || state === 'authorizationStateReady')
        resolve()
    }
    client.on('update', onUpdate)
  })
}

/**
 * Test a single proxy by performing a real MTProto handshake through it.
 * @param {import('tdl').Client} client - the tdl client
 * @param {{server: string, port: number, secret: string}} proxy - parsed proxy
 * @param {number} dcId - data center id (1-5) to test against
 * @param {number} timeoutSec - TDLib-side timeout in seconds
 * @returns {Promise<{ok: boolean, ms: number, error: string|null}>} test result
 */
async function checkOne(client, proxy, dcId, timeoutSec) {
  const started = Date.now()
  try {
    // TDLib >= 1.8.64 takes a single `proxy` object (proxy$Input); the older
    // flat server/port/type form is silently ignored and yields an empty proxy.
    await client.invoke({
      _: 'testProxy',
      proxy: {
        _: 'proxy',
        server: proxy.server,
        port: proxy.port,
        type: { _: 'proxyTypeMtproto', secret: proxy.secret }
      },
      dc_id: dcId,
      timeout: timeoutSec
    })
    return { ok: true, ms: Date.now() - started, error: null }
  } catch (err) {
    const message = err && err.message ? err.message : String(err)
    return { ok: false, ms: Date.now() - started, error: message }
  }
}

/**
 * Run an async worker over items with bounded concurrency, preserving input
 * order in the returned results array.
 * @template T, R
 * @param {T[]} items - input items
 * @param {number} concurrency - maximum parallel workers
 * @param {(item: T, index: number) => Promise<R>} worker - per-item handler
 * @returns {Promise<R[]>} results in the same order as `items`
 */
async function runPool(items, concurrency, worker) {
  const results = new Array(items.length)
  let next = 0
  /** Pull and process items until the shared queue is drained. */
  async function run() {
    while (next < items.length) {
      const index = next++
      results[index] = await worker(items[index], index)
    }
  }
  const runners = []
  for (let i = 0; i < Math.min(concurrency, items.length); i++) runners.push(run())
  await Promise.all(runners)
  return results
}

/**
 * Test an array of parsed proxies through TDLib and return sorted results
 * (working first, then by latency ascending). Spins up and tears down a
 * throwaway TDLib client; no Telegram login is performed.
 * @param {Array} proxies - parsed proxies (from mergeProxies/loadProxiesFromUrls)
 * @param {{apiId: number, apiHash: string, dc?: number, timeout?: number, concurrency?: number, tdlibDir?: string, onProgress?: (proxy: object, res: object, index: number, total: number) => void}} opts
 * @returns {Promise<Array<{proxy: object, ok: boolean, ms: number, error: string|null}>>}
 */
async function checkProxies(proxies, opts) {
  if (proxies.length === 0) return []
  const dc = opts.dc ?? 2
  const timeout = opts.timeout ?? 10
  const concurrency = opts.concurrency ?? 30
  const tdlibDir = opts.tdlibDir ?? '.proxy-checker-td'
  const databaseDirectory = path.join(tdlibDir, 'db')
  const filesDirectory = path.join(tdlibDir, 'files')

  tdl.configure({ tdjson: getTdjson(), verbosityLevel: 0 })
  const client = tdl.createClient({ apiId: opts.apiId, apiHash: opts.apiHash, databaseDirectory, filesDirectory })
  client.on('error', err => console.error('TDLib error:', err))

  try {
    await prepare(client, { apiId: opts.apiId, apiHash: opts.apiHash, databaseDirectory, filesDirectory })
    const checks = await runPool(proxies, concurrency, async (proxy, index) => {
      const res = await checkOne(client, proxy, dc, timeout)
      if (opts.onProgress) opts.onProgress(proxy, res, index, proxies.length)
      return { proxy, ...res }
    })
    return checks.slice().sort((a, b) => {
      if (a.ok !== b.ok) return a.ok ? -1 : 1
      return a.ms - b.ms
    })
  } finally {
    await client.close()
    fs.rmSync(tdlibDir, { recursive: true, force: true })
  }
}

/**
 * Download proxy lists from the given URLs, merge + de-duplicate them, and test
 * every unique proxy through TDLib. This is the end-to-end entry point.
 * @param {string[]} urls - raw URLs of text files, one proxy link per line
 * @param {{apiId: number, apiHash: string, dc?: number, timeout?: number, concurrency?: number, tdlibDir?: string, onProgress?: Function}} opts
 * @returns {Promise<Array>} per-proxy results, working first, then by latency
 */
async function checkProxiesFromUrls(urls, opts) {
  const proxies = await loadProxiesFromUrls(urls)
  return checkProxies(proxies, opts)
}

/**
 * CLI entry point: resolve sources (URLs / file / stdin), check, and write
 * `<out>.json` (full report) and `<out>.txt` (working links, fastest first).
 * @returns {Promise<void>}
 */
async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const apiId = parseInt(process.env.TG_API_ID, 10)
  const apiHash = process.env.TG_API_HASH
  if (!apiId || !apiHash) {
    console.error('Set TG_API_ID and TG_API_HASH (get them at https://my.telegram.org).')
    process.exit(1)
  }

  // A --sources file contributes one URL per line (with # comments).
  if (opts.sourcesFile) {
    const text = fs.readFileSync(opts.sourcesFile, 'utf8')
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.split('#')[0].trim()
      if (line) opts.urls.push(line)
    }
  }

  let proxies
  if (opts.urls.length > 0) {
    console.error(`Fetching ${opts.urls.length} source URL(s)...`)
    proxies = await loadProxiesFromUrls(opts.urls)
  } else {
    const input = await readInput(opts.file)
    proxies = mergeProxies([input])
  }

  if (proxies.length === 0) {
    console.error('No valid tg://proxy or t.me/proxy links found.')
    process.exit(1)
  }

  console.error(`Checking ${proxies.length} unique proxies (dc=${opts.dc}, timeout=${opts.timeout}s, concurrency=${opts.concurrency})...\n`)

  const sorted = await checkProxies(proxies, {
    apiId,
    apiHash,
    dc: opts.dc,
    timeout: opts.timeout,
    concurrency: opts.concurrency,
    onProgress: (proxy, res, index, total) => {
      const tag = res.ok ? `ok ${String(res.ms).padStart(5)}ms` : `-- ${res.error}`
      const sni = proxy.sni ? ` [sni: ${proxy.sni}]` : ''
      console.error(`[${String(index + 1).padStart(3)}/${total}] ${tag}  ${proxy.server}:${proxy.port}${sni}`)
    }
  })

  const working = sorted.filter(c => c.ok)
  const report = sorted.map(c => ({
    server: c.proxy.server,
    port: c.proxy.port,
    sni: c.proxy.sni,
    ok: c.ok,
    ms: c.ms,
    error: c.error,
    link: c.proxy.raw
  }))

  fs.writeFileSync(`${opts.out}.json`, JSON.stringify(report, null, 2))
  fs.writeFileSync(`${opts.out}.txt`, working.map(c => c.proxy.raw).join('\n') + (working.length ? '\n' : ''))

  console.error(`\nDone: ${working.length}/${proxies.length} working.`)
  console.error(`Wrote ${opts.out}.json and ${opts.out}.txt`)
  process.exit(0)
}

module.exports = { checkProxiesFromUrls, loadProxiesFromUrls, checkProxies, mergeProxies, parseLink, normalizeSecret, faketlsSni }

if (require.main === module) main().catch(err => {
  console.error(err)
  process.exit(1)
})
