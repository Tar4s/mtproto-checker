#!/usr/bin/env node
'use strict'

/**
 * Pool (daemon) mode for mtproto-checker.
 *
 * Instead of checking on request, this starts a long-running process that:
 *   1. Loads a full set of proxy links from every source in a nearby file
 *      (`sources.txt` by default — remote list URLs, direct proxy links, or
 *      local files, one per line; `#` comments allowed).
 *   2. Runs a first check in the background and populates the *live container*
 *      with the proxies that passed (working only).
 *   3. Runs N further re-check rounds against the live container, keeping only
 *      the survivors each round (extra stability filtering).
 *   4. Sleeps for a configured interval, then repeats the whole cycle from the
 *      sources again (the container is refreshed atomically — see below).
 *
 * All checking happens on a background loop. An HTTP server exposes the live
 * container over non-blocking GET endpoints: reads are synchronous snapshots of
 * whatever is currently in the container, even while a check round is running.
 *
 * Container refresh semantics: the requirement is to rebuild the container from
 * the sources on every cycle. To avoid serving an empty feed during the reload
 * + first-check window, the previous cycle's survivors stay served until the
 * new first check completes, then the container is swapped atomically. Set
 * `--clear-on-cycle` to instead empty the container the moment a new cycle
 * starts (strict "clear" behaviour, at the cost of an empty window).
 *
 * Usage:
 *   TG_API_ID=.. TG_API_HASH=.. node check.js pool [options]
 *
 * Options:
 *   --sources <file>     source list file (default "sources.txt")
 *   --iterations <n>     re-check rounds against the container (default 3)
 *   --interval <hours>   pause between full cycles (default 6)
 *   --dc <1-5>           data center for testProxy (default 2)
 *   --timeout <sec>      per-proxy timeout (default 10)
 *   --concurrency <n>    parallel checks (default 30)
 *   --port <n>           HTTP port (default PORT env or 8080)
 *   --clear-on-cycle     empty the container at the start of each cycle
 *
 * HTTP endpoints (all GET, no auth, non-blocking):
 *   GET /proxies       JSON snapshot of the live container + metadata
 *   GET /proxies.txt   working proxy links, fastest first, plain text
 *   GET /status        cycle/phase metadata only (no proxy list)
 *   GET /health        liveness probe
 */

const fs = require('fs')
const http = require('http')
const path = require('path')

// Static dashboard (web/index.html) served at `/`. Read once at startup; null
// if the file is absent (e.g. slimmed-down deploy).
const WEB_INDEX = (() => {
  try {
    return fs.readFileSync(path.join(__dirname, 'web', 'index.html'))
  } catch {
    return null
  }
})()

/**
 * Format the current local time as `YYYY-MM-DD HH:MM:SS` for log prefixes.
 * @param {Date} [d] - the moment to format (defaults to now)
 * @returns {string}
 */
function timestamp(d = new Date()) {
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/**
 * Log to stderr with a `[timestamp] [pool]` prefix.
 * @param {...unknown} args - message parts
 */
function log(...args) {
  console.error(`[${timestamp()}] [pool]`, ...args)
}

/**
 * Parse argv for the unified service into an options object. `pool` is null
 * unless `--pool`/`--no-pool` is given, letting the caller decide the default
 * (the `pool` subcommand forces it on; `serve`/bare auto-enable if a sources
 * file exists).
 * @param {string[]} argv - argv after the subcommand
 * @returns {{sources: string, iterations: number, interval: number, dc: number, timeout: number, concurrency: number, port: number, clearOnCycle: boolean, pool: boolean|null, user: string|undefined, password: string|undefined}}
 */
function parseServiceArgs(argv) {
  const opts = {
    sources: 'sources.txt',
    iterations: 3,
    interval: 6,
    dc: 2,
    timeout: 10,
    concurrency: 30,
    port: parseInt(process.env.PORT || '8080', 10),
    clearOnCycle: false,
    pool: null,
    user: undefined,
    password: undefined
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--sources') opts.sources = argv[++i]
    else if (a === '--iterations') opts.iterations = parseInt(argv[++i], 10)
    else if (a === '--interval') opts.interval = parseFloat(argv[++i])
    else if (a === '--dc') opts.dc = parseInt(argv[++i], 10)
    else if (a === '--timeout') opts.timeout = parseFloat(argv[++i])
    else if (a === '--concurrency') opts.concurrency = parseInt(argv[++i], 10)
    else if (a === '--port') opts.port = parseInt(argv[++i], 10)
    else if (a === '--clear-on-cycle') opts.clearOnCycle = true
    else if (a === '--pool') opts.pool = true
    else if (a === '--no-pool') opts.pool = false
    else if (a === '--user') opts.user = argv[++i]
    else if (a === '--password') opts.password = argv[++i]
  }
  return opts
}

/**
 * Split a sources file into individual source entries (URLs / proxy links /
 * file paths), dropping blank lines and `#` comments.
 * @param {string} text - raw sources file contents
 * @returns {string[]} source entries
 */
function parseSourcesFile(text) {
  const out = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split('#')[0].trim()
    if (line) out.push(line)
  }
  return out
}

/**
 * Load and de-duplicate every proxy from a list of source entries. Each entry
 * may be a direct proxy link, a remote http(s) list URL, or a local file path.
 * Failing remote sources are logged and skipped.
 * @param {string[]} sources - source entries
 * @param {{parseLink: Function, fetchText: Function, mergeProxies: Function}} deps
 * @returns {Promise<Array>} unique parsed proxies
 */
async function loadProxiesFromSources(sources, deps) {
  const { parseLink, fetchText, mergeProxies } = deps
  const directProxies = []
  const texts = await Promise.all(sources.map(async src => {
    const direct = parseLink(src)
    if (direct) { directProxies.push(direct); return '' }
    if (/^https?:\/\//i.test(src)) {
      try {
        return await fetchText(src)
      } catch (err) {
        log(`skip ${src}: ${err.message}`)
        return ''
      }
    }
    try {
      return fs.readFileSync(src, 'utf8')
    } catch (err) {
      log(`skip ${src}: ${err.message}`)
      return ''
    }
  }))
  const proxies = mergeProxies(texts)
  const seen = new Set(proxies.map(p => `${p.server}:${p.port}:${p.secret}`))
  for (const p of directProxies) {
    const key = `${p.server}:${p.port}:${p.secret}`
    if (seen.has(key)) continue
    seen.add(key)
    proxies.push(p)
  }
  return proxies
}

/**
 * Build the mutable shared state that both the background loop and the HTTP
 * handlers read/write. Single-threaded Node guarantees reads are consistent
 * snapshots between awaits.
 * @returns {object} pool state
 */
function createPoolState() {
  return {
    cycle: 0,
    phase: 'starting', // starting | loading | checking | idle
    iteration: 0,
    iterations: 0,
    sourceCount: 0,
    loadedCount: 0,
    startedAt: null,
    updatedAt: null,
    nextRunAt: null,
    // Live container of candidates: [{ proxy, ok, ms, error }].
    // Seeded with every loaded proxy (ok: null = unchecked), then pruned live as
    // checks complete — failures are removed, survivors flip to ok: true.
    container: []
  }
}

/**
 * Canonical de-duplication key for a proxy.
 * @param {{server: string, port: number, secret: string}} proxy
 * @returns {string}
 */
function proxyKey(proxy) {
  return `${proxy.server}:${proxy.port}:${proxy.secret}`
}

/**
 * Serialize a container entry into the public shape returned over HTTP.
 * @param {{proxy: object, ok: boolean|null, ms: number|null, error: string|null}} entry
 * @returns {{server: string, port: number, sni: string|null, ok: boolean|null, ms: number|null, error: string|null, link: string}}
 */
function toPublic(entry) {
  return {
    server: entry.proxy.server,
    port: entry.proxy.port,
    sni: entry.proxy.sni,
    ok: entry.ok,
    ms: entry.ms,
    error: entry.error,
    link: entry.proxy.raw
  }
}

/**
 * Run one full cycle: load every proxy from the sources into the container
 * up-front (so the API can serve them immediately), then run N re-check rounds
 * that prune the container live — dead proxies are dropped the moment a check
 * fails, survivors are marked working the moment one passes. Mutates `state`.
 * @param {object} state - pool state from createPoolState
 * @param {object} opts - parsed pool options
 * @param {{loadSources: Function, checkProxies: Function, checkOpts: object}} deps
 */
async function runCycle(state, opts, deps) {
  const { loadSources, checkProxies, checkOpts } = deps
  state.cycle += 1
  state.phase = 'loading'
  state.startedAt = new Date().toISOString()
  if (opts.clearOnCycle) { state.container = []; state.updatedAt = state.startedAt }

  const sources = parseSourcesFile(fs.readFileSync(opts.sources, 'utf8'))
  state.sourceCount = sources.length
  const proxies = await loadSources(sources)
  state.loadedCount = proxies.length
  log(`cycle ${state.cycle}: ${proxies.length} proxies from ${sources.length} source(s)`)

  // Seed the container with the full loaded set (unchecked) and expose it now.
  const entries = new Map()
  for (const proxy of proxies) entries.set(proxyKey(proxy), { proxy, ok: null, ms: null, error: null })
  state.container = [...entries.values()]
  state.updatedAt = new Date().toISOString()

  if (proxies.length === 0) return

  state.phase = 'checking'
  const rounds = Math.max(1, opts.iterations)
  state.iterations = rounds
  let current = proxies

  for (let iteration = 1; iteration <= rounds && current.length > 0; iteration++) {
    state.iteration = iteration
    log(`cycle ${state.cycle} round ${iteration}/${rounds}: checking ${current.length} proxies...`)
    const width = String(current.length).length
    const survivors = []
    const onProgress = (proxy, res, index, total) => {
      const entry = entries.get(proxyKey(proxy))
      if (res.ok) {
        if (entry) { entry.ok = true; entry.ms = res.ms; entry.error = null }
        survivors.push(proxy)
      } else if (entry) {
        entries.delete(proxyKey(proxy))
      }
      // Publish a fresh snapshot after every check so readers see live pruning.
      state.container = [...entries.values()]
      state.updatedAt = new Date().toISOString()
      const tag = res.ok ? `✓ ${String(res.ms).padStart(5)}ms` : `✗ ${res.error}`
      const sni = proxy.sni ? ` [${proxy.sni}]` : ''
      log(`  r${iteration} [${String(index + 1).padStart(width)}/${total}] ${tag}  ${proxy.server}:${proxy.port}${sni}`)
    }
    await checkProxies(current, { ...checkOpts, onProgress })
    current = survivors
    log(`cycle ${state.cycle} round ${iteration}/${rounds}: ${survivors.length} working`)
  }
}

/**
 * Handle a `POST /check` request: ad-hoc, on-demand check of the proxy link(s)
 * or list URL(s) in the JSON body. Requires Basic auth. Mirrors the request
 * contract of the classic `check.js` server.
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {{auth: {user: string, password: string}|null, checkUrl: Function, internals: object}} ctx
 */
async function handleCheck(req, res, { auth, checkUrl, internals }) {
  const { isAuthorized, readJsonBody, jsonResponse } = internals
  if (req.method !== 'POST') return jsonResponse(res, 405, { error: 'Method not allowed' }, { allow: 'POST' })
  if (!auth) return jsonResponse(res, 503, { error: 'POST /check is disabled: set CHECK_AUTH_USER and CHECK_AUTH_PASSWORD' })
  if (!isAuthorized(req, auth)) return jsonResponse(res, 401, { error: 'Unauthorized' }, { 'www-authenticate': 'Basic realm="mtproto-checker"' })

  let body
  try {
    body = await readJsonBody(req)
  } catch (err) {
    return jsonResponse(res, err.statusCode || 400, { error: err.message })
  }

  const uris = body.url || body.urls || body.uri || body.uris
  if (!uris || (typeof uris === 'string' && uris.trim() === '') || (Array.isArray(uris) && uris.length === 0))
    return jsonResponse(res, 400, { error: 'Request body must include url (string or array)' })

  const iterations = body.iterations === undefined ? 1 : body.iterations
  if (!Number.isInteger(iterations) || iterations < 1)
    return jsonResponse(res, 400, { error: 'iterations must be a positive integer' })
  const concurrency = body.concurrency === undefined ? 30 : body.concurrency
  if (!Number.isInteger(concurrency) || concurrency < 1)
    return jsonResponse(res, 400, { error: 'concurrency must be a positive integer' })

  const input = Array.isArray(uris) ? uris.map(u => u.trim()) : [uris.trim()]
  let results
  try {
    results = await checkUrl(input, { iterations, concurrency })
  } catch (err) {
    return jsonResponse(res, 502, { error: 'Failed to check url', detail: err.message || String(err) })
  }
  return jsonResponse(res, 200, {
    uris: input,
    iterations,
    concurrency,
    count: results.length,
    working: results.filter(item => item.ok).length,
    results
  })
}

/**
 * Create the unified HTTP server. Always serves `POST /check` (ad-hoc checks,
 * Basic auth) and `GET /health`. When `poolEnabled`, also serves the live pool
 * over non-blocking public `GET` endpoints.
 * @param {{state: object, poolEnabled: boolean, auth: object|null, checkUrl: Function, internals: object}} ctx
 * @returns {http.Server}
 */
function createServiceServer({ state, poolEnabled, auth, checkUrl, internals }) {
  const { jsonResponse } = internals
  const json = (res, code, body) => jsonResponse(res, code, body)
  const meta = () => ({
    poolEnabled,
    cycle: state.cycle,
    phase: state.phase,
    iteration: state.iteration,
    iterations: state.iterations,
    sourceCount: state.sourceCount,
    loadedCount: state.loadedCount,
    containerCount: state.container.length,
    workingCount: state.container.reduce((n, e) => n + (e.ok === true ? 1 : 0), 0),
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    nextRunAt: state.nextRunAt
  })
  const isWorking = e => e.ok === true

  return http.createServer(async (req, res) => {
    const [url, query = ''] = req.url.split('?')

    if (url === '/health') return json(res, 200, { status: 'ok', uptime: process.uptime() })
    if (url === '/check') return handleCheck(req, res, { auth, checkUrl, internals })

    if (poolEnabled && req.method === 'GET' && (url === '/' || url === '/index.html') && WEB_INDEX) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': WEB_INDEX.length })
      res.end(WEB_INDEX)
      return
    }

    if (poolEnabled && req.method === 'GET') {
      // ?working=1 → only verified-working entries; default → whole container.
      const workingOnly = new URLSearchParams(query).get('working') === '1'
      if (url === '/status') return json(res, 200, meta())
      if (url === '/proxies') {
        const select = workingOnly ? state.container.filter(isWorking) : state.container
        return json(res, 200, { ...meta(), proxies: select.map(toPublic) })
      }
      if (url === '/proxies.txt') {
        // Plain-text feed is meant to be consumed directly: working links only.
        const body = state.container.filter(isWorking).map(e => e.proxy.raw).join('\n')
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'content-length': Buffer.byteLength(body ? body + '\n' : '') })
        res.end(body ? body + '\n' : '')
        return
      }
    }
    return json(res, 404, { error: 'Not found' })
  })
}

/**
 * Start the unified service: one HTTP server exposing on-demand `POST /check`
 * plus, when `opts.pool` is set, the background load → check → filter → sleep
 * loop and its live read endpoints.
 * @param {object} opts - parsed service options (see parseServiceArgs)
 * @param {object} internals - check.js `_internals`
 * @returns {Promise<{server: http.Server, state: object}>}
 */
async function startService(opts, internals) {
  const apiId = parseInt(process.env.TG_API_ID, 10)
  const apiHash = process.env.TG_API_HASH
  if (!apiId || !apiHash) throw new Error('Set TG_API_ID and TG_API_HASH (get them at https://my.telegram.org).')
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) throw new Error('port must be 1-65535.')

  const user = opts.user ?? process.env.CHECK_AUTH_USER
  const password = opts.password ?? process.env.CHECK_AUTH_PASSWORD
  const auth = user && password ? { user, password } : null

  const poolEnabled = !!opts.pool
  if (poolEnabled) {
    if (!fs.existsSync(opts.sources)) throw new Error(`Sources file not found: ${opts.sources}`)
    if (!Number.isInteger(opts.iterations) || opts.iterations < 1) throw new Error('--iterations must be a positive integer.')
    if (!(opts.interval > 0)) throw new Error('--interval must be a positive number of hours.')
  }

  const state = createPoolState()
  const checkOpts = { apiId, apiHash, dc: opts.dc, timeout: opts.timeout, concurrency: opts.concurrency }
  const deps = {
    loadSources: sources => loadProxiesFromSources(sources, internals),
    checkProxies: internals.checkProxies,
    checkOpts
  }
  const checkUrl = (input, requestOpts) => internals.checkProxiesFromURIs(input, {
    apiId,
    apiHash,
    dc: opts.dc,
    timeout: opts.timeout,
    iterations: requestOpts.iterations,
    concurrency: requestOpts.concurrency
  })

  const server = createServiceServer({ state, poolEnabled, auth, checkUrl, internals })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port, () => { server.off('error', reject); resolve() })
  })

  log(`⚡ HTTP server on http://localhost:${opts.port}`)
  log(`  POST /check ${auth ? `(Basic auth: ${user}:***)` : '(disabled — set CHECK_AUTH_USER/PASSWORD)'}`)
  log('  GET  /health')
  if (poolEnabled) {
    log('  GET  /proxies · /proxies?working=1 · /proxies.txt · /status')
    log(`pool: sources=${opts.sources} iterations=${opts.iterations} interval=${opts.interval}h dc=${opts.dc} timeout=${opts.timeout}s concurrency=${opts.concurrency}`)
  } else {
    log('  pool: disabled (on-demand /check only)')
  }

  let running = true
  const shutdown = signal => {
    log(`${signal} received, shutting down...`)
    running = false
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(1), 5000).unref()
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))

  if (poolEnabled) {
    const loop = async () => {
      while (running) {
        try {
          await runCycle(state, opts, deps)
        } catch (err) {
          log(`cycle ${state.cycle} failed: ${err.stack || err.message || err}`)
        }
        if (!running) break
        state.phase = 'idle'
        state.iteration = 0
        const waitMs = opts.interval * 3600 * 1000
        state.nextRunAt = new Date(Date.now() + waitMs).toISOString()
        log(`cycle ${state.cycle} done, sleeping ${opts.interval}h (next ~${state.nextRunAt})`)
        await new Promise(r => setTimeout(r, waitMs).unref())
      }
    }
    loop()
  }

  return { server, state }
}

module.exports = { startService, parseServiceArgs }
module.exports._internals = { parseSourcesFile, loadProxiesFromSources, createPoolState, runCycle, createServiceServer, handleCheck, toPublic, proxyKey, timestamp, log }
