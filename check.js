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
 *   TG_API_ID=12345 TG_API_HASH=abcdef CHECK_AUTH_USER=admin CHECK_AUTH_PASSWORD=secret node check.js
 *   # starts the HTTP API server on PORT (default 8080)
 *   TG_API_ID=12345 TG_API_HASH=abcdef... node check.js [sources] [options]
 *   # sources: any positional http(s) URL, a local file path, or stdin
 *   node check.js https://raw.githubusercontent.com/u/r/main/list.txt
 *   node check.js --url URL1 --url URL2
 *   node check.js --proxy "tg://proxy?server=...&port=443&secret=..."
 *   node check.js --sources urls.txt           # file with one URL per line
 *   cat proxies.txt | node check.js
 *
 * Options:
 *   --url <url>         add a source URL (repeatable)
 *   --proxy <link>      check one proxy link directly
 *   --sources <file>    file containing source URLs (one per line, # comments ok)
 *   --dc <1-5>          data center id to test against (default 2)
 *   --timeout <sec>     per-proxy TDLib timeout in seconds (default 10)
 *   --concurrency <n>   parallel checks (default 30; lower = more accurate ms)
 *   --out <prefix>      output file prefix (default "result")
 *   --iterations <num>  repeat checks, keeping only proxies that passed the previous round (default 1)
 *
 * Module usage:
 *   const { checkProxiesFromUrls } = require('./check')
 *   const results = await checkProxiesFromUrls([url1, url2], { apiId, apiHash })
 *
 * Requirements: Node.js v18+ (for global fetch), `npm i tdl prebuilt-tdlib`,
 *   and api_id/api_hash from https://my.telegram.org (no login is performed).
 */

const fs = require('fs')
const http = require('http')
const path = require('path')
const crypto = require('crypto')
const tdl = require('tdl')
const { getTdjson } = require('prebuilt-tdlib')

const tdlibConfigState = { configured: false }

/**
 * Configure TDLib once per process. The `tdl` package rejects configure calls
 * after the first client has been initialized.
 * @param {{configured: boolean}} state - mutable configuration state
 * @param {(opts: object) => void} configure - tdl.configure-compatible function
 * @param {() => unknown} tdjsonFactory - returns tdjson binding
 */
function configureTdlibOnce(state = tdlibConfigState, configure = tdl.configure, tdjsonFactory = getTdjson) {
  if (state.configured) return
  configure({ tdjson: tdjsonFactory(), verbosityLevel: 0 })
  state.configured = true
}

/**
 * Parse argv into an options object, collecting source URLs and/or a file path.
 * @param {string[]} argv - process.argv.slice(2)
 * @returns {{file: string|null, urls: string[], proxy: string|null, sourcesFile: string|null, dc: number, timeout: number, concurrency: number, out: string, iterations: number}}
 */
function parseArgs(argv) {
  const opts = { file: null, urls: [], proxy: null, sourcesFile: null, dc: 2, timeout: 10, concurrency: 30, out: 'result', iterations: 1 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dc') opts.dc = parseInt(argv[++i], 10)
    else if (a === '--timeout') opts.timeout = parseFloat(argv[++i])
    else if (a === '--concurrency') opts.concurrency = parseInt(argv[++i], 10)
    else if (a === '--out') opts.out = argv[++i]
    else if (a === '--iterations') opts.iterations = parseInt(argv[++i], 10)
    else if (a === '--url') opts.urls.push(argv[++i])
    else if (a === '--proxy') opts.proxy = argv[++i]
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
  const tdlibBase = opts.tdlibDir ?? '.proxy-checker-td'
  const tdlibDir = `${tdlibBase}-${crypto.randomUUID()}`
  const databaseDirectory = path.join(tdlibDir, 'db')
  const filesDirectory = path.join(tdlibDir, 'files')

  configureTdlibOnce()
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
 * Re-check proxies for multiple rounds, carrying only working proxies forward.
 * @param {Array} proxies - parsed proxies to check in the first round
 * @param {number} iterations - number of rounds to run
 * @param {(proxies: Array, iteration: number) => Promise<Array>} checker
 *   function that checks one round and returns checkProxies-style results
 * @returns {Promise<Array>} survivors after the final completed round
 */
async function runIterativeChecks(proxies, iterations, checker) {
  const rounds = Math.max(1, iterations)
  let current = proxies
  let results = []

  for (let iteration = 1; iteration <= rounds && current.length > 0; iteration++) {
    results = await checker(current, iteration)
    current = results.filter(c => c.ok).map(c => c.proxy)
  }

  return results
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

async function checkSingleUrl(url, opts) {
  const directProxy = parseLink(url)
  if (directProxy) {
    const checker = opts.checker || checkProxies
    return checker([directProxy], opts)
  }

  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('url must be a proxy link or an http or https URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('url must be a proxy link or an http or https URL')
  }

  const fetcher = opts.fetcher || fetchText
  const checker = opts.checker || checkProxies
  const text = await fetcher(url)
  const proxies = mergeProxies([text])
  return checker(proxies, opts)
}

/**
 * Load proxies from a local file path.
 * @param {string} filePath - path to a text file with proxy links (one per line)
 * @returns {Array} de-duplicated parsed proxies
 */
function loadProxiesFromFile(filePath) {
  const text = fs.readFileSync(filePath, 'utf8')
  return mergeProxies([text])
}

/**
 * Check proxies from URIs — supports both remote URLs (http/https) and local
 * file paths. Detects type automatically per entry.
 * @param {string|string[]} uris - URL(s) or file path(s) with proxy links
 * @param {{apiId: number, apiHash: string, dc?: number, timeout?: number, concurrency?: number, iterations?: number, onProgress?: Function}} opts
 * @returns {Promise<Array<{proxy: object, ok: boolean, ms: number, error: string|null}>>}
 */
async function checkProxiesFromURIs(uris, opts) {
  const list = Array.isArray(uris) ? uris : [uris]
  console.error(`[mtproto-checker] Loading ${list.length} source(s)...`)
  const directProxies = []
  const texts = await Promise.all(list.map(uri => {
    const parsed = parseLink(uri)
    if (parsed) {
      console.error(`  ⚡ ${parsed.server}:${parsed.port}`)
      directProxies.push(parsed)
      return Promise.resolve('')
    }
    if (/^https?:\/\//i.test(uri)) {
      console.error(`  ↓ ${uri}`)
      return fetchText(uri).catch(err => { console.error(`  ✗ Skipping ${uri}: ${err.message}`); return '' })
    }
    console.error(`  ◈ ${uri}`)
    return Promise.resolve(fs.readFileSync(uri, 'utf8'))
  }))
  const fromTexts = mergeProxies(texts)
  const seen = new Set(fromTexts.map(p => `${p.server}:${p.port}:${p.secret}`))
  const proxies = [...fromTexts]
  for (const p of directProxies) {
    const key = `${p.server}:${p.port}:${p.secret}`
    if (seen.has(key)) continue
    seen.add(key)
    proxies.push(p)
  }
  if (proxies.length === 0) {
    console.error('[mtproto-checker] No valid proxy links found.')
    return []
  }
  const iterations = opts.iterations ?? 1
  console.error(`[mtproto-checker] Checking ${proxies.length} proxies (dc=${opts.dc ?? 2}, timeout=${opts.timeout ?? 10}s, concurrency=${opts.concurrency ?? 30}, iterations=${iterations})...\n`)
  const results = await runIterativeChecks(proxies, iterations, (batch, iteration) => {
    if (iterations > 1) console.error(`[mtproto-checker] Iteration ${iteration}/${iterations}: ${batch.length} proxies\n`)
    return checkProxies(batch, {
      ...opts,
      onProgress: (proxy, res, index, total) => {
        const tag = res.ok ? `✓ ${String(res.ms).padStart(5)}ms` : `✗ ${res.error}`
        const sni = proxy.sni ? ` [${proxy.sni}]` : ''
        console.error(`  [${String(index + 1).padStart(3)}/${total}] ${tag}  ${proxy.server}:${proxy.port}${sni}`)
        if (opts.onProgress) opts.onProgress(proxy, res, index, total)
      }
    })
  })
  const working = results.filter(c => c.ok).length
  console.error(`\n[mtproto-checker] Done: ${working}/${proxies.length} working.`)
  return results
}

/**
 * Check a single tg://proxy or t.me/proxy link via real MTProto handshake.
 * @param {string} link - proxy link (tg://proxy?... or https://t.me/proxy?...)
 * @param {{apiId: number, apiHash: string, dc?: number, timeout?: number, iterations?: number, onProgress?: Function}} opts
 * @returns {Promise<Array<{proxy: object, ok: boolean, ms: number, error: string|null}>>}
 * @throws if the link is not a valid MTProto proxy link
 */
async function checkProxyLink(link, opts) {
  const proxy = parseLink(link)
  if (!proxy) throw new Error('Invalid proxy link. Expected tg://proxy?... or https://t.me/proxy?...')
  const sni = proxy.sni ? ` [${proxy.sni}]` : ''
  console.error(`[mtproto-checker] Checking ${proxy.server}:${proxy.port}${sni}...`)
  const results = await runIterativeChecks([proxy], opts.iterations ?? 1, batch => checkProxies(batch, opts))
  const r = results[0]
  if (r)
    console.error(`[mtproto-checker] ${r.ok ? `✓ ${r.ms}ms` : `✗ ${r.error}`}`)
  return results
}

async function loadSingleUrlProxies(url, opts = {}) {
  const directProxy = parseLink(url)
  if (directProxy) return [directProxy]

  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('url must be a proxy link or an http or https URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('url must be a proxy link or an http or https URL')
  }

  const fetcher = opts.fetcher || fetchText
  const text = await fetcher(url)
  return mergeProxies([text])
}

async function checkRequestUrl(url, opts) {
  const proxies = await loadSingleUrlProxies(url, opts)
  const checker = opts.checker || checkProxies
  return runIterativeChecks(proxies, opts.iterations ?? 1, batch => checker(batch, opts))
}

async function resolveInputProxies(opts, deps = {}) {
  const readFile = deps.readFile || (file => fs.readFileSync(file, 'utf8'))
  const readInputFn = deps.readInput || readInput
  const loadFromUrls = deps.loadFromUrls || loadProxiesFromUrls

  if (opts.proxy) {
    const proxy = parseLink(opts.proxy)
    return proxy ? [proxy] : []
  }

  if (opts.sourcesFile) {
    const text = readFile(opts.sourcesFile)
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.split('#')[0].trim()
      if (line) opts.urls.push(line)
    }
  }

  if (opts.urls.length > 0) {
    console.error(`Fetching ${opts.urls.length} source URL(s)...`)
    return loadFromUrls(opts.urls)
  }

  const input = await readInputFn(opts.file)
  return mergeProxies([input])
}

function toReport(results) {
  return results.map(c => ({
    server: c.proxy ? c.proxy.server : c.server,
    port: c.proxy ? c.proxy.port : c.port,
    sni: c.proxy ? c.proxy.sni : c.sni,
    ok: c.ok,
    ms: c.ms,
    error: c.error,
    link: c.proxy ? c.proxy.raw : c.link
  }))
}

function jsonResponse(res, statusCode, body, headers = {}) {
  const payload = JSON.stringify(body, null, 2)
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    ...headers
  })
  res.end(payload)
}

function safeEqual(a, b) {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}

function isAuthorized(req, auth) {
  const header = req.headers.authorization
  if (!header || !header.startsWith('Basic ')) return false

  let decoded
  try {
    decoded = Buffer.from(header.slice(6), 'base64').toString('utf8')
  } catch {
    return false
  }

  const separator = decoded.indexOf(':')
  if (separator === -1) return false
  const user = decoded.slice(0, separator)
  const password = decoded.slice(separator + 1)
  return safeEqual(user, auth.user) && safeEqual(password, auth.password)
}

function readJsonBody(req, limitBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', chunk => {
      size += Buffer.byteLength(chunk)
      if (size > limitBytes) {
        reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }))
        req.destroy()
        return
      }
      raw += chunk
    })
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch {
        reject(Object.assign(new Error('Invalid JSON body'), { statusCode: 400 }))
      }
    })
    req.on('error', reject)
  })
}

function logRequest(logger, req, statusCode, started) {
  const ms = Date.now() - started
  const forwarded = req.headers['x-forwarded-for']
  const remote = Array.isArray(forwarded) ? forwarded[0] : forwarded || req.socket.remoteAddress || '-'
  logger(`${req.id} ${remote} ${req.method} ${req.url} ${statusCode} ${ms}ms`)
}

function createServer({ auth, checkUrl, logger = console.error }) {
  let nextRequestId = 0
  const realm = 'Basic realm="mtproto-checker"'

  return http.createServer(async (req, res) => {
    const started = Date.now()
    req.id = `req-${++nextRequestId}`
    let statusCode = 500

    try {
      if (req.url === '/health') {
        statusCode = 200
        jsonResponse(res, statusCode, { status: 'ok', uptime: process.uptime() })
        return
      }

      if (!isAuthorized(req, auth)) {
        statusCode = 401
        jsonResponse(res, statusCode, { error: 'Unauthorized' }, { 'www-authenticate': realm })
        return
      }

      if (req.url !== '/check') {
        statusCode = 404
        jsonResponse(res, statusCode, { error: 'Not found' })
        return
      }

      if (req.method !== 'POST') {
        statusCode = 405
        jsonResponse(res, statusCode, { error: 'Method not allowed' }, { allow: 'POST' })
        return
      }

      const body = await readJsonBody(req)
      const uris = body.url || body.urls || body.uri || body.uris
      if (!uris || (typeof uris === 'string' && uris.trim() === '') || (Array.isArray(uris) && uris.length === 0)) {
        statusCode = 400
        jsonResponse(res, statusCode, { error: 'Request body must include url (string or array)' })
        return
      }
      const iterations = body.iterations === undefined ? 1 : body.iterations
      if (!Number.isInteger(iterations) || iterations < 1) {
        statusCode = 400
        jsonResponse(res, statusCode, { error: 'iterations must be a positive integer' })
        return
      }
      const concurrency = body.concurrency === undefined ? 30 : body.concurrency
      if (!Number.isInteger(concurrency) || concurrency < 1) {
        statusCode = 400
        jsonResponse(res, statusCode, { error: 'concurrency must be a positive integer' })
        return
      }

      const input = Array.isArray(uris) ? uris.map(u => u.trim()) : [uris.trim()]
      let results
      try {
        results = await checkUrl(input, { iterations, concurrency })
      } catch (err) {
        statusCode = 502
        jsonResponse(res, statusCode, {
          error: 'Failed to check url',
          detail: err.message || String(err)
        })
        return
      }
      statusCode = 200
      jsonResponse(res, statusCode, {
        uris: input,
        iterations,
        concurrency,
        count: results.length,
        working: results.filter(item => item.ok).length,
        results
      })
    } catch (err) {
      statusCode = err.statusCode || 500
      const message = statusCode === 500 ? 'Internal server error' : err.message
      jsonResponse(res, statusCode, { error: message })
      if (statusCode === 500) logger(`${req.id} error ${err.stack || err.message || err}`)
    } finally {
      logRequest(logger, req, statusCode, started)
    }
  })
}

function shouldStartServer(argv) {
  return argv.length === 0
}

/**
 * Start the HTTP API server for proxy checking.
 * @param {{apiId?: number, apiHash?: string, user?: string, password?: string, port?: number}} opts
 *   All fields fall back to environment variables if omitted.
 * @returns {Promise<http.Server>} the listening server instance
 */
async function startServer(opts = {}) {
  const apiId = opts.apiId ?? parseInt(process.env.TG_API_ID, 10)
  const apiHash = opts.apiHash ?? process.env.TG_API_HASH
  const user = opts.user ?? process.env.CHECK_AUTH_USER
  const password = opts.password ?? process.env.CHECK_AUTH_PASSWORD
  const port = opts.port ?? parseInt(process.env.PORT || '8080', 10)

  if (!apiId || !apiHash) throw new Error('Set TG_API_ID and TG_API_HASH (get them at https://my.telegram.org).')
  if (!user || !password) throw new Error('Set CHECK_AUTH_USER and CHECK_AUTH_PASSWORD for HTTP Basic auth.')
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('port must be a valid TCP port (1-65535).')

  const server = createServer({
    auth: { user, password },
    checkUrl: async (url, requestOpts) => checkProxiesFromURIs(url, {
      apiId,
      apiHash,
      iterations: requestOpts.iterations,
      concurrency: requestOpts.concurrency
    })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, () => {
      server.off('error', reject)
      resolve()
    })
  })

  console.error(`[mtproto-checker] ⚡ HTTP server listening on http://localhost:${port}`)
  console.error(`[mtproto-checker]   GET  /health (no auth)`)
  console.error(`[mtproto-checker]   POST /check  (Basic auth: ${user}:***)`)

  const shutdown = signal => {
    console.error(`\n[mtproto-checker] ${signal} received, shutting down...`)
    server.close(() => {
      console.error('[mtproto-checker] Server closed.')
      process.exit(0)
    })
    setTimeout(() => { process.exit(1) }, 5000)
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))

  return server
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

  const proxies = await resolveInputProxies(opts)

  if (proxies.length === 0) {
    console.error('No valid tg://proxy or t.me/proxy links found.')
    process.exit(1)
  }

  if (!Number.isInteger(opts.iterations) || opts.iterations < 1) {
    console.error('--iterations must be a positive integer.')
    process.exit(1)
  }

  console.error(`Checking ${proxies.length} unique proxies (dc=${opts.dc}, timeout=${opts.timeout}s, concurrency=${opts.concurrency}, iterations=${opts.iterations})...\n`)

  const sorted = await runIterativeChecks(proxies, opts.iterations, (batch, iteration) => {
    if (opts.iterations > 1) console.error(`Iteration ${iteration}/${opts.iterations}: checking ${batch.length} proxy/proxies...\n`)
    return checkProxies(batch, {
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

module.exports = { checkProxyLink, checkProxiesFromURIs, startServer }
module.exports._internals = { checkRequestUrl, checkSingleUrl, configureTdlibOnce, createServer, parseArgs, resolveInputProxies, runIterativeChecks, shouldStartServer, parseLink, normalizeSecret, faketlsSni, mergeProxies, loadProxiesFromFile }

if (require.main === module) (shouldStartServer(process.argv.slice(2)) ? startServer() : main()).catch(err => {
  console.error(err)
  process.exit(1)
})
