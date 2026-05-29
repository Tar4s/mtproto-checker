'use strict'

const assert = require('node:assert/strict')
const http = require('node:http')
const test = require('node:test')

const { checkSingleUrl, configureTdlibOnce, createServer, parseArgs, runIterativeChecks, shouldStartServer } = require('../check')

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

test('parseArgs reads --iterations', () => {
  const opts = parseArgs(['--sources', 'urls.txt', '--iterations', '4'])

  assert.equal(opts.sourcesFile, 'urls.txt')
  assert.equal(opts.iterations, 4)
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
    assert.equal(res.body.error, 'Request body must include url')
  } finally {
    server.close()
  }
})

test('createServer checks posted url and returns expanded json', async () => {
  const seen = []
  const server = createServer({
    auth: { user: 'admin', password: 'secret' },
    checkUrl: async url => {
      seen.push(url)
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
    assert.deepEqual(seen, ['https://example.com/list.txt'])
    assert.deepEqual(res.body, {
      url: 'https://example.com/list.txt',
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
