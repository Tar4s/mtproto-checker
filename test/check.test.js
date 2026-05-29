'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const { configureTdlibOnce, parseArgs, runIterativeChecks } = require('../check')

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
