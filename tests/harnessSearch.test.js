import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { searchHarness } from '../src/main/harnessSearch.js'

async function serverFor(handler, run) {
  const server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    await run(`http://127.0.0.1:${server.address().port}`)
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
}
const configuration = (restUrl) => ({
  vault: '/vault',
  selected: '/vault/HARNESS',
  restUrl,
  apiKey: 'test-only',
  cooldown: new Map()
})

test('REST search uses the contract, keeps selected scope, returns excerpts', async () => {
  await serverFor(
    (request, response) => {
      assert.equal(request.method, 'POST')
      assert.equal(request.headers.authorization, 'Bearer test-only')
      assert.equal(
        new URL(request.url, 'http://localhost').searchParams.get('query'),
        'daily equipe'
      )
      response.setHeader('Content-Type', 'application/json')
      response.end(
        JSON.stringify([
          { filename: 'private.md', matches: [{ context: 'Outside selected folder' }] },
          { filename: 'HARNESS/daily.md', matches: [{ context: 'Team context' }] }
        ])
      )
    },
    async (url) => {
      const results = await searchHarness('daily equipe', { config: configuration(url) })
      assert.equal(results.length, 1)
      assert.equal(results[0].path, '/vault/HARNESS/daily.md')
      assert.equal(results[0].content, 'Team context')
    }
  )
})

test('failed providers immediately fall back and are skipped on the next question', async () => {
  let calls = 0
  await serverFor(
    (request, response) => {
      calls++
      response.writeHead(503)
      response.end()
    },
    async (url) => {
      const config = configuration(url)
      assert.deepEqual(await searchHarness('daily', { config }), [])
      assert.deepEqual(await searchHarness('daily', { config }), [])
      assert.equal(calls, 1)
    }
  )
})

test('a hanging provider is bounded and cancellation returns promptly', async () => {
  await serverFor(
    () => {},
    async (url) => {
      const config = configuration(url)
      const started = Date.now()
      assert.deepEqual(await searchHarness('daily', { config }), [])
      assert.ok(Date.now() - started < 1300)
      assert.ok(config.cooldown.has('rest'))
      const controller = new AbortController()
      const pending = searchHarness('daily', {
        config: configuration(url),
        signal: controller.signal
      })
      controller.abort()
      assert.deepEqual(await pending, [])
    }
  )
})
