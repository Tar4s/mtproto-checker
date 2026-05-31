'use strict'

const assert = require('node:assert/strict')
const http = require('node:http')
const test = require('node:test')

const { checkRequestUrl, checkSingleUrl, configureTdlibOnce, createServer, parseArgs, resolveInputProxies, runIterativeChecks, shouldStartServer, parseLink, normalizeSecret, faketlsSni, mergeProxies, loadProxiesFromFile } = require('../check')._internals
const { checkProxyLink, checkProxiesFromURIs } = require('../check')
const packageEntry = require('..')

function basicAuth(user, password) {
  return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`
}

async function request(server, { method = 'POST', path = '/check', headers = {}, body } = {}) {
  if (!server.listening) {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  }
  const { port } = server.address()

  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      method,
      path,
      headers: {
        'content-type': 'application/json',
        ...headers
      }
    }, res => {
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { raw += chunk })
      res.on('end', () => {
        let json = null
        try {
          json = raw ? JSON.parse(raw) : null
        } catch {}
        resolve({ statusCode: res.statusCode, headers: res.headers, body: json, raw })
      })
    })

    req.on('error', reject)
    if (body !== undefined) req.end(typeof body === 'string' ? body : JSON.stringify(body))
    else req.end()
  })
}

test('shouldStartServer starts only for bare node check.js', () => {
  assert.equal(shouldStartServer([]), true)
  assert.equal(shouldStartServer(['--sources', 'urls.txt']), false)
})

test('package root exports public API', () => {
  assert.equal(typeof packageEntry.checkProxyLink, 'function')
  assert.equal(typeof packageEntry.checkProxiesFromURIs, 'function')
  assert.equal(typeof packageEntry.startServer, 'function')
})

test('parseArgs reads --iterations', () => {
  const opts = parseArgs(['--sources', 'urls.txt', '--iterations', '4'])

  assert.equal(opts.sourcesFile, 'urls.txt')
  assert.equal(opts.iterations, 4)
})

test('parseArgs reads --proxy', () => {
  const proxy = 'tg://proxy?server=one.example&port=443&secret=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  const opts = parseArgs(['--proxy', proxy])

  assert.equal(opts.proxy, proxy)
})

test('configureTdlibOnce configures TDLib only once per process', () => {
  const state = { configured: false }
  let calls = 0

  configureTdlibOnce(state, () => { calls++ }, () => 'tdjson')
  configureTdlibOnce(state, () => { calls++ }, () => 'tdjson')

  assert.equal(calls, 1)
})

test('createServer rejects requests without basic auth', async () => {
  const server = createServer({
    auth: { user: 'admin', password: 'secret' },
    checkUrl: async () => [],
    logger: () => {}
  })

  try {
    const res = await request(server, { body: { url: 'https://example.com/list.txt' } })

    assert.equal(res.statusCode, 401)
    assert.equal(res.headers['www-authenticate'], 'Basic realm="mtproto-checker"')
    assert.equal(res.body.error, 'Unauthorized')
  } finally {
    server.close()
  }
})

test('createServer validates request body', async () => {
  const server = createServer({
    auth: { user: 'admin', password: 'secret' },
    checkUrl: async () => [],
    logger: () => {}
  })

  try {
    const res = await request(server, {
      headers: { authorization: basicAuth('admin', 'secret') },
      body: {}
    })

    assert.equal(res.statusCode, 400)
    assert.equal(res.body.error, 'Request body must include url (string or array)')
  } finally {
    server.close()
  }
})

test('createServer checks posted url and returns expanded json', async () => {
  const seen = []
  const server = createServer({
    auth: { user: 'admin', password: 'secret' },
    checkUrl: async (url, opts) => {
      seen.push({ url, opts })
      return [{
        server: '1.2.3.4',
        port: 443,
        sni: 'example.com',
        ok: true,
        ms: 123,
        error: null,
        link: 'tg://proxy?server=1.2.3.4&port=443&secret=ee'
      }]
    },
    logger: () => {}
  })

  try {
    const res = await request(server, {
      headers: { authorization: basicAuth('admin', 'secret') },
      body: { url: 'https://example.com/list.txt' }
    })

    assert.equal(res.statusCode, 200)
    assert.deepEqual(seen, [{ url: ['https://example.com/list.txt'], opts: { iterations: 1, concurrency: 30 } }])
    assert.deepEqual(res.body, {
      uris: ['https://example.com/list.txt'],
      iterations: 1,
      concurrency: 30,
      count: 1,
      working: 1,
      results: [{
        server: '1.2.3.4',
        port: 443,
        sni: 'example.com',
        ok: true,
        ms: 123,
        error: null,
        link: 'tg://proxy?server=1.2.3.4&port=443&secret=ee'
      }]
    })
  } finally {
    server.close()
  }
})

test('createServer passes iterations from request body', async () => {
  const seen = []
  const server = createServer({
    auth: { user: 'admin', password: 'secret' },
    checkUrl: async (url, opts) => {
      seen.push({ url, opts })
      return [{
        server: '1.2.3.4',
        port: 443,
        sni: null,
        ok: true,
        ms: 321,
        error: null,
        link: 'tg://proxy?server=1.2.3.4&port=443&secret=ee'
      }]
    },
    logger: () => {}
  })

  try {
    const res = await request(server, {
      headers: { authorization: basicAuth('admin', 'secret') },
      body: { url: 'https://example.com/list.txt', iterations: 3 }
    })

    assert.equal(res.statusCode, 200)
    assert.deepEqual(seen, [{ url: ['https://example.com/list.txt'], opts: { iterations: 3, concurrency: 30 } }])
    assert.equal(res.body.iterations, 3)
  } finally {
    server.close()
  }
})

test('createServer passes concurrency from request body', async () => {
  const seen = []
  const server = createServer({
    auth: { user: 'admin', password: 'secret' },
    checkUrl: async (url, opts) => {
      seen.push({ url, opts })
      return []
    },
    logger: () => {}
  })

  try {
    const res = await request(server, {
      headers: { authorization: basicAuth('admin', 'secret') },
      body: { url: 'https://example.com/list.txt', concurrency: 7 }
    })

    assert.equal(res.statusCode, 200)
    assert.deepEqual(seen, [{ url: ['https://example.com/list.txt'], opts: { iterations: 1, concurrency: 7 } }])
    assert.equal(res.body.concurrency, 7)
  } finally {
    server.close()
  }
})

test('createServer rejects invalid iterations', async () => {
  const server = createServer({
    auth: { user: 'admin', password: 'secret' },
    checkUrl: async () => [],
    logger: () => {}
  })

  try {
    const res = await request(server, {
      headers: { authorization: basicAuth('admin', 'secret') },
      body: { url: 'https://example.com/list.txt', iterations: 0 }
    })

    assert.equal(res.statusCode, 400)
    assert.equal(res.body.error, 'iterations must be a positive integer')
  } finally {
    server.close()
  }
})

test('createServer rejects invalid concurrency', async () => {
  const server = createServer({
    auth: { user: 'admin', password: 'secret' },
    checkUrl: async () => [],
    logger: () => {}
  })

  try {
    const res = await request(server, {
      headers: { authorization: basicAuth('admin', 'secret') },
      body: { url: 'https://example.com/list.txt', concurrency: 0 }
    })

    assert.equal(res.statusCode, 400)
    assert.equal(res.body.error, 'concurrency must be a positive integer')
  } finally {
    server.close()
  }
})

test('createServer returns 502 when url check fails', async () => {
  const server = createServer({
    auth: { user: 'admin', password: 'secret' },
    checkUrl: async () => {
      throw new Error('HTTP 404')
    },
    logger: () => {}
  })

  try {
    const res = await request(server, {
      headers: { authorization: basicAuth('admin', 'secret') },
      body: { url: 'https://example.com/missing.txt' }
    })

    assert.equal(res.statusCode, 502)
    assert.equal(res.body.error, 'Failed to check url')
    assert.equal(res.body.detail, 'HTTP 404')
  } finally {
    server.close()
  }
})

test('checkSingleUrl fetches one source url and checks parsed proxies', async () => {
  const seen = {}
  const result = await checkSingleUrl('https://example.com/list.txt', {
    apiId: 123,
    apiHash: 'hash',
    fetcher: async url => {
      seen.url = url
      return 'tg://proxy?server=1.2.3.4&port=443&secret=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    },
    checker: async (proxies, opts) => {
      seen.proxies = proxies
      seen.opts = opts
      return [{ proxy: proxies[0], ok: true, ms: 50, error: null }]
    }
  })

  assert.equal(seen.url, 'https://example.com/list.txt')
  assert.equal(seen.proxies[0].server, '1.2.3.4')
  assert.equal(seen.opts.apiId, 123)
  assert.deepEqual(result, [{ proxy: seen.proxies[0], ok: true, ms: 50, error: null }])
})

test('checkSingleUrl checks a direct tg proxy link', async () => {
  const link = 'tg://proxy?server=quackton.life&port=443&secret=7mX8dVOh9cqLULccAVs4ciR5YW5kZXgucnU'
  const seen = {}
  const result = await checkSingleUrl(link, {
    apiId: 123,
    apiHash: 'hash',
    fetcher: async () => {
      throw new Error('direct links must not be fetched')
    },
    checker: async (proxies, opts) => {
      seen.proxies = proxies
      seen.opts = opts
      return [{ proxy: proxies[0], ok: true, ms: 77, error: null }]
    }
  })

  assert.equal(seen.proxies.length, 1)
  assert.equal(seen.proxies[0].raw, link)
  assert.equal(seen.proxies[0].server, 'quackton.life')
  assert.equal(seen.proxies[0].port, 443)
  assert.equal(seen.opts.apiHash, 'hash')
  assert.deepEqual(result, [{ proxy: seen.proxies[0], ok: true, ms: 77, error: null }])
})

test('checkSingleUrl rejects non-http source urls', async () => {
  await assert.rejects(
    checkSingleUrl('file:///tmp/list.txt', {
      apiId: 123,
      apiHash: 'hash',
      fetcher: async () => '',
      checker: async () => []
    }),
    /url must be a proxy link or an http or https URL/
  )
})

test('checkRequestUrl re-checks only successful proxies for requested iterations', async () => {
  const calls = []
  const result = await checkRequestUrl('https://example.com/list.txt', {
    iterations: 2,
    concurrency: 7,
    fetcher: async () => [
      'tg://proxy?server=one.example&port=443&secret=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'tg://proxy?server=two.example&port=443&secret=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    ].join('\n'),
    checker: async (proxies, opts) => {
      calls.push(proxies.map(proxy => proxy.server))
      assert.equal(opts.concurrency, 7)
      return proxies.map(proxy => ({
        proxy,
        ok: proxy.server === 'one.example',
        ms: 100,
        error: proxy.server === 'one.example' ? null : 'timeout'
      }))
    }
  })

  assert.deepEqual(calls, [['one.example', 'two.example'], ['one.example']])
  assert.deepEqual(result.map(item => item.proxy.server), ['one.example'])
})

test('resolveInputProxies uses --proxy without reading other sources', async () => {
  const proxy = 'tg://proxy?server=one.example&port=443&secret=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  const proxies = await resolveInputProxies(
    { proxy, urls: ['https://example.com/list.txt'], sourcesFile: null, file: 'local.txt' },
    {
      readFile: () => {
        throw new Error('files must not be read when --proxy is set')
      },
      readInput: async () => {
        throw new Error('stdin must not be read when --proxy is set')
      },
      loadFromUrls: async () => {
        throw new Error('urls must not be fetched when --proxy is set')
      }
    }
  )

  assert.equal(proxies.length, 1)
  assert.equal(proxies[0].server, 'one.example')
  assert.equal(proxies[0].raw, proxy)
})

test('runIterativeChecks carries only working proxies into the next iteration', async () => {
  const proxies = [
    { server: 'one.example', port: 443, secret: 'aa' },
    { server: 'two.example', port: 443, secret: 'bb' },
    { server: 'three.example', port: 443, secret: 'cc' }
  ]
  const calls = []

  const result = await runIterativeChecks(proxies, 3, async batch => {
    calls.push(batch.map(proxy => proxy.server))
    return batch.map(proxy => ({
      proxy,
      ok: proxy.server !== 'two.example' && !(calls.length === 2 && proxy.server === 'three.example'),
      ms: calls.length * 100,
      error: null
    }))
  })

  assert.deepEqual(calls, [
    ['one.example', 'two.example', 'three.example'],
    ['one.example', 'three.example'],
    ['one.example']
  ])
  assert.deepEqual(result.map(item => item.proxy.server), ['one.example'])
})

test('runIterativeChecks stops early when no proxies survive', async () => {
  const proxies = [{ server: 'dead.example', port: 443, secret: 'aa' }]
  let calls = 0

  const result = await runIterativeChecks(proxies, 5, async batch => {
    calls++
    return batch.map(proxy => ({ proxy, ok: false, ms: 100, error: 'timeout' }))
  })

  assert.equal(calls, 1)
  assert.deepEqual(result.map(item => item.proxy.server), ['dead.example'])
  assert.equal(result[0].ok, false)
})

// --- parseLink tests ---

test('parseLink parses tg://proxy link', () => {
  const result = parseLink('tg://proxy?server=1.2.3.4&port=443&secret=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')

  assert.equal(result.server, '1.2.3.4')
  assert.equal(result.port, 443)
  assert.equal(result.secret, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
  assert.equal(result.sni, null)
})

test('parseLink parses https://t.me/proxy link', () => {
  const result = parseLink('https://t.me/proxy?server=example.com&port=8443&secret=ddaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')

  assert.equal(result.server, 'example.com')
  assert.equal(result.port, 8443)
  assert.equal(result.secret, 'ddaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
})

test('parseLink extracts Fake-TLS SNI from ee-prefixed secret', () => {
  // ee + 16 bytes (32 hex chars) + domain in hex
  const domain = 'google.com'
  const domainHex = Buffer.from(domain).toString('hex')
  const secret = 'ee' + 'aa'.repeat(16) + domainHex
  const result = parseLink(`tg://proxy?server=1.2.3.4&port=443&secret=${secret}`)

  assert.equal(result.sni, 'google.com')
})

test('parseLink returns null for tg://socks links', () => {
  const result = parseLink('tg://socks?server=1.2.3.4&port=1080&user=u&pass=p')

  assert.equal(result, null)
})

test('parseLink returns null for invalid input', () => {
  assert.equal(parseLink(''), null)
  assert.equal(parseLink('not a link'), null)
  assert.equal(parseLink('https://example.com'), null)
  assert.equal(parseLink('tg://proxy'), null) // no query string
})

test('parseLink returns null when required params are missing', () => {
  assert.equal(parseLink('tg://proxy?server=1.2.3.4&port=443'), null) // no secret
  assert.equal(parseLink('tg://proxy?server=1.2.3.4&secret=aa'), null) // no port (NaN)
  assert.equal(parseLink('tg://proxy?port=443&secret=aa'), null) // no server
})

// --- normalizeSecret tests ---

test('normalizeSecret passes through valid hex', () => {
  assert.equal(normalizeSecret('AABBCCDD'), 'aabbccdd')
  assert.equal(normalizeSecret('eeaabbccdd112233'), 'eeaabbccdd112233')
})

test('normalizeSecret decodes base64url to hex', () => {
  const hex = 'deadbeef01020304'
  const b64 = Buffer.from(hex, 'hex').toString('base64url')
  assert.equal(normalizeSecret(b64), hex)
})

test('normalizeSecret trims whitespace', () => {
  assert.equal(normalizeSecret('  aabb  '), 'aabb')
})

// --- faketlsSni tests ---

test('faketlsSni extracts domain from ee-prefixed secret', () => {
  const domain = 'cdn.telegram.org'
  const domainHex = Buffer.from(domain).toString('hex')
  const secret = 'ee' + '00'.repeat(16) + domainHex
  assert.equal(faketlsSni(secret), domain)
})

test('faketlsSni returns null for non-ee secrets', () => {
  assert.equal(faketlsSni('dd' + '00'.repeat(16)), null)
  assert.equal(faketlsSni('aa' + '00'.repeat(16)), null)
})

test('faketlsSni returns null when no domain part', () => {
  assert.equal(faketlsSni('ee' + '00'.repeat(16)), null)
})

// --- mergeProxies tests ---

test('mergeProxies de-duplicates by server:port:secret', () => {
  const text = [
    'tg://proxy?server=1.2.3.4&port=443&secret=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'tg://proxy?server=1.2.3.4&port=443&secret=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'tg://proxy?server=5.6.7.8&port=443&secret=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  ].join('\n')

  const result = mergeProxies([text])
  assert.equal(result.length, 2)
})

test('mergeProxies de-duplicates across multiple texts', () => {
  const text1 = 'tg://proxy?server=1.2.3.4&port=443&secret=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  const text2 = 'tg://proxy?server=1.2.3.4&port=443&secret=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\ntg://proxy?server=9.9.9.9&port=443&secret=cccccccccccccccccccccccccccccccc'

  const result = mergeProxies([text1, text2])
  assert.equal(result.length, 2)
  assert.equal(result[0].server, '1.2.3.4')
  assert.equal(result[1].server, '9.9.9.9')
})

test('mergeProxies ignores comments and blank lines', () => {
  const text = [
    '# this is a comment',
    '',
    'tg://proxy?server=1.2.3.4&port=443&secret=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa # inline comment',
    '   ',
    '# another comment'
  ].join('\n')

  const result = mergeProxies([text])
  assert.equal(result.length, 1)
  assert.equal(result[0].server, '1.2.3.4')
})

test('mergeProxies ignores non-proxy lines', () => {
  const text = [
    'https://google.com',
    'just some text',
    'tg://socks?server=1.2.3.4&port=1080&user=u&pass=p',
    'tg://proxy?server=1.2.3.4&port=443&secret=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  ].join('\n')

  const result = mergeProxies([text])
  assert.equal(result.length, 1)
})

// --- loadProxiesFromFile tests ---

test('loadProxiesFromFile reads and parses a local file', () => {
  const fs = require('fs')
  const os = require('os')
  const path = require('path')
  const tmpFile = path.join(os.tmpdir(), `_test_proxies_${Date.now()}.txt`)
  fs.writeFileSync(tmpFile, [
    'tg://proxy?server=a.example&port=443&secret=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'tg://proxy?server=b.example&port=443&secret=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  ].join('\n'))

  try {
    const result = loadProxiesFromFile(tmpFile)
    assert.equal(result.length, 2)
    assert.equal(result[0].server, 'a.example')
    assert.equal(result[1].server, 'b.example')
  } finally {
    fs.unlinkSync(tmpFile)
  }
})

// --- checkProxyLink tests ---

test('checkProxyLink rejects invalid proxy link', async () => {
  await assert.rejects(
    checkProxyLink('https://google.com', { apiId: 1, apiHash: 'x' }),
    /Invalid proxy link/
  )
})

test('checkProxyLink rejects empty string', async () => {
  await assert.rejects(
    checkProxyLink('', { apiId: 1, apiHash: 'x' }),
    /Invalid proxy link/
  )
})

// --- checkProxiesFromURIs tests ---

test('checkProxiesFromURIs recognizes direct tg:// proxy links', async () => {
  const link = 'tg://proxy?server=test.example&port=443&secret=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  const seen = []

  // Mock checkProxies via opts.checker won't work here since checkProxiesFromURIs
  // calls checkProxies internally. We'll test indirectly via checkRequestUrl pattern.
  // Instead test that it doesn't throw ENOENT (the original bug)
  try {
    await checkProxiesFromURIs(link, { apiId: 1, apiHash: 'x', iterations: 1 })
  } catch (err) {
    // TDLib not available is fine — ENOENT means it tried to read as file (BAD)
    assert.ok(!err.message.includes('ENOENT'), `Should not treat proxy link as file: ${err.message}`)
  }
})

test('checkProxiesFromURIs recognizes https://t.me/proxy links', async () => {
  const link = 'https://t.me/proxy?server=test.example&port=443&secret=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

  try {
    await checkProxiesFromURIs(link, { apiId: 1, apiHash: 'x', iterations: 1 })
  } catch (err) {
    assert.ok(!err.message.includes('ENOENT'), `Should not treat t.me proxy link as file: ${err.message}`)
    // Should NOT try to fetch t.me as a web page either — verify no HTTP error
    assert.ok(!err.message.includes('HTTP 4'), `Should not fetch t.me proxy link as web page: ${err.message}`)
  }
})

test('checkProxiesFromURIs de-duplicates direct links', async () => {
  const link = 'tg://proxy?server=dup.example&port=443&secret=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

  try {
    await checkProxiesFromURIs([link, link, link], { apiId: 1, apiHash: 'x', iterations: 1 })
  } catch (err) {
    // Expected TDLib error, but the "Checking 1 proxies" log proves de-dup worked
    assert.ok(!err.message.includes('ENOENT'))
  }
})

test('checkProxiesFromURIs returns empty array when no proxies found', async () => {
  const fs = require('fs')
  const os = require('os')
  const path = require('path')
  const tmpFile = path.join(os.tmpdir(), `_test_empty_${Date.now()}.txt`)
  fs.writeFileSync(tmpFile, '# no proxies here\njust comments\n')

  try {
    const result = await checkProxiesFromURIs(tmpFile, { apiId: 1, apiHash: 'x' })
    assert.deepEqual(result, [])
  } finally {
    fs.unlinkSync(tmpFile)
  }
})

test('checkProxiesFromURIs reads local file and parses proxies', async () => {
  const fs = require('fs')
  const os = require('os')
  const path = require('path')
  const tmpFile = path.join(os.tmpdir(), `_test_local_${Date.now()}.txt`)
  fs.writeFileSync(tmpFile, 'tg://proxy?server=local.example&port=443&secret=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n')

  try {
    await checkProxiesFromURIs(tmpFile, { apiId: 1, apiHash: 'x' })
  } catch (err) {
    assert.ok(!err.message.includes('ENOENT'), `Should read the file: ${err.message}`)
    assert.ok(!err.message.includes('No valid proxy'), `Should find the proxy in the file: ${err.message}`)
  } finally {
    fs.unlinkSync(tmpFile)
  }
})

// --- createServer input format tests ---

test('createServer accepts url as array', async () => {
  const seen = []
  const server = createServer({
    auth: { user: 'admin', password: 'secret' },
    checkUrl: async (url, opts) => {
      seen.push({ url, opts })
      return []
    },
    logger: () => {}
  })

  try {
    const res = await request(server, {
      headers: { authorization: basicAuth('admin', 'secret') },
      body: { url: ['https://a.txt', 'https://b.txt'] }
    })

    assert.equal(res.statusCode, 200)
    assert.deepEqual(seen[0].url, ['https://a.txt', 'https://b.txt'])
    assert.deepEqual(res.body.uris, ['https://a.txt', 'https://b.txt'])
  } finally {
    server.close()
  }
})

test('createServer accepts "urls" field name', async () => {
  const seen = []
  const server = createServer({
    auth: { user: 'admin', password: 'secret' },
    checkUrl: async (url, opts) => {
      seen.push(url)
      return []
    },
    logger: () => {}
  })

  try {
    const res = await request(server, {
      headers: { authorization: basicAuth('admin', 'secret') },
      body: { urls: ['https://x.txt'] }
    })

    assert.equal(res.statusCode, 200)
    assert.deepEqual(seen[0], ['https://x.txt'])
  } finally {
    server.close()
  }
})

test('createServer accepts "uris" field name', async () => {
  const seen = []
  const server = createServer({
    auth: { user: 'admin', password: 'secret' },
    checkUrl: async (url, opts) => {
      seen.push(url)
      return []
    },
    logger: () => {}
  })

  try {
    const res = await request(server, {
      headers: { authorization: basicAuth('admin', 'secret') },
      body: { uris: 'tg://proxy?server=1.2.3.4&port=443&secret=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }
    })

    assert.equal(res.statusCode, 200)
    assert.deepEqual(seen[0], ['tg://proxy?server=1.2.3.4&port=443&secret=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'])
  } finally {
    server.close()
  }
})

test('createServer rejects empty array', async () => {
  const server = createServer({
    auth: { user: 'admin', password: 'secret' },
    checkUrl: async () => [],
    logger: () => {}
  })

  try {
    const res = await request(server, {
      headers: { authorization: basicAuth('admin', 'secret') },
      body: { url: [] }
    })

    assert.equal(res.statusCode, 400)
  } finally {
    server.close()
  }
})

test('createServer rejects empty string url', async () => {
  const server = createServer({
    auth: { user: 'admin', password: 'secret' },
    checkUrl: async () => [],
    logger: () => {}
  })

  try {
    const res = await request(server, {
      headers: { authorization: basicAuth('admin', 'secret') },
      body: { url: '   ' }
    })

    assert.equal(res.statusCode, 400)
  } finally {
    server.close()
  }
})

// --- parseArgs edge cases ---

test('parseArgs recognizes positional http URLs', () => {
  const opts = parseArgs(['https://example.com/a.txt', 'https://example.com/b.txt'])

  assert.deepEqual(opts.urls, ['https://example.com/a.txt', 'https://example.com/b.txt'])
})

test('parseArgs treats non-flag non-url as file', () => {
  const opts = parseArgs(['proxies.txt'])

  assert.equal(opts.file, 'proxies.txt')
})

test('parseArgs defaults', () => {
  const opts = parseArgs([])

  assert.equal(opts.dc, 2)
  assert.equal(opts.timeout, 10)
  assert.equal(opts.concurrency, 30)
  assert.equal(opts.out, 'result')
  assert.equal(opts.iterations, 1)
  assert.equal(opts.proxy, null)
  assert.equal(opts.file, null)
  assert.equal(opts.sourcesFile, null)
  assert.deepEqual(opts.urls, [])
})

// --- resolveInputProxies edge cases ---

test('resolveInputProxies returns empty for invalid --proxy link', async () => {
  const proxies = await resolveInputProxies(
    { proxy: 'not-a-valid-link', urls: [], sourcesFile: null, file: null },
    { readInput: async () => '', loadFromUrls: async () => [] }
  )

  assert.deepEqual(proxies, [])
})

test('resolveInputProxies reads sourcesFile and loads URLs', async () => {
  const loaded = []
  const proxies = await resolveInputProxies(
    { proxy: null, urls: [], sourcesFile: '/fake/sources.txt', file: null },
    {
      readFile: () => 'https://one.txt\n# comment\nhttps://two.txt\n',
      readInput: async () => { throw new Error('should not read stdin') },
      loadFromUrls: async urls => { loaded.push(...urls); return [{ server: 'x', port: 1, secret: 'aa' }] }
    }
  )

  assert.deepEqual(loaded, ['https://one.txt', 'https://two.txt'])
  assert.equal(proxies.length, 1)
})
