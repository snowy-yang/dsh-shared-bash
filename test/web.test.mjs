import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { after, test } from 'node:test'

import { SharedBashManager } from '../src/sessions.js'
import { API_PREFIX, createWebHandler, requestRejection } from '../src/web.js'

const root = mkdtempSync(join(tmpdir(), 'shared-bash-web-'))
const manager = new SharedBashManager({ rootDir: root, maxSessions: 4, commandTimeoutMs: 10_000 })
const handler = createWebHandler(manager)

after(() => {
  manager.dispose()
  rmSync(root, { recursive: true, force: true })
})

/** One fake browser request: a readable body plus the headers the fence reads. */
function request(method, path, options = {}) {
  const body = options.body === undefined ? [] : [Buffer.from(JSON.stringify(options.body))]
  return {
    method,
    url: `${API_PREFIX}${path}`,
    headers: { host: '127.0.0.1:7675', ...options.headers },
    async *[Symbol.asyncIterator]() {
      for (const chunk of body) yield chunk
    },
  }
}

/** A response recorder with the two methods the handler uses. */
function response() {
  const state = { status: 0, headers: {}, body: '' }
  return {
    state,
    writeHead(status, headers) {
      state.status = status
      state.headers = headers ?? {}
    },
    end(body) {
      state.body = String(body ?? '')
    },
    json() {
      return JSON.parse(state.body)
    },
  }
}

async function call(method, path, options) {
  const res = response()
  await handler(request(method, path, options), res)
  return res
}

test('GET /sessions starts empty', async () => {
  const res = await call('GET', '/sessions')
  assert.equal(res.state.status, 200)
  assert.deepEqual(res.json().sessions, [])
  assert.equal(res.json().maxSessions, 4)
})

test('POST /open returns the session summary', async () => {
  const res = await call('POST', '/open', { body: { session: 'ui', cwd: '/tmp' } })
  assert.equal(res.state.status, 200)
  const payload = res.json()
  assert.equal(payload.session.session, 'ui')
  assert.equal(payload.session.cwd, '/tmp')
  assert.equal(payload.reused, false)

  const list = await call('GET', '/sessions')
  assert.equal(list.json().sessions.length, 1)
})

test('POST /send runs a command and GET /output reads it back', async () => {
  const sent = await call('POST', '/send', { body: { session: 'ui', command: 'echo hello-web' } })
  assert.equal(sent.state.status, 200)
  const payload = sent.json()
  assert.equal(payload.exit_code, 0)
  assert.match(payload.output, /hello-web/)
  assert.equal(payload.timed_out, false)

  const output = await call('GET', '/output?session=ui&lines=50')
  assert.equal(output.state.status, 200)
  assert.match(output.json().text, /hello-web/)
  assert.equal(output.json().session, 'ui')
})

test('unknown sessions and invalid names map to 404 and 400', async () => {
  const missing = await call('POST', '/send', { body: { session: 'nope', command: 'true' } })
  assert.equal(missing.state.status, 404)
  assert.equal(missing.json().code, 'NO_SESSION')

  const invalid = await call('POST', '/open', { body: { session: 'bad name!' } })
  assert.equal(invalid.state.status, 400)
  assert.equal(invalid.json().code, 'INVALID_SESSION')
})

test('POST /interrupt and POST /close report what they touched', async () => {
  const interrupted = await call('POST', '/interrupt', { body: { session: 'ui' } })
  assert.equal(interrupted.state.status, 200)
  assert.equal(interrupted.json().interrupted, false)

  const closed = await call('POST', '/close', { body: { session: 'ui' } })
  assert.equal(closed.state.status, 200)
  assert.deepEqual(closed.json().closed, ['ui'])

  const again = await call('POST', '/close', { body: { session: 'ui' } })
  assert.equal(again.state.status, 404)

  await call('POST', '/open', { body: { session: 'a' } })
  await call('POST', '/open', { body: { session: 'b' } })
  const all = await call('POST', '/close', { body: { all: true } })
  assert.deepEqual(all.json().closed.sort(), ['a', 'b'])
})

test('unknown routes answer 404 with the method and route', async () => {
  const res = await call('GET', '/nope')
  assert.equal(res.state.status, 404)
  assert.match(res.json().error, /GET \/nope/)
})

test('the request fence refuses cross-site and foreign-origin callers', async () => {
  const crossSite = await call('GET', '/sessions', { headers: { 'sec-fetch-site': 'cross-site' } })
  assert.equal(crossSite.state.status, 403)

  const foreign = await call('GET', '/sessions', { headers: { origin: 'http://example.com' } })
  assert.equal(foreign.state.status, 403)

  const sameOrigin = await call('GET', '/sessions', { headers: { origin: 'http://127.0.0.1:7675' } })
  assert.equal(sameOrigin.state.status, 200)

  const rebound = await call('GET', '/sessions', { headers: { host: 'evil.test:7675' } })
  assert.equal(rebound.state.status, 403)
})

test('the fence prefers a mounted connection service and fails closed', async () => {
  const withConnection = createWebHandler(manager, { connection: () => ({ admit: () => ({ rejection: 401 }) }) })
  const res = response()
  await withConnection(request('GET', '/sessions'), res)
  assert.equal(res.state.status, 401)
  assert.equal(res.json().error, 'unauthorized')

  const legacy = createWebHandler(manager, { connection: () => ({ requestRejection: () => 403 }) })
  const legacyRes = response()
  await legacy(request('GET', '/sessions'), legacyRes)
  assert.equal(legacyRes.state.status, 403)

  const broken = createWebHandler(manager, { connection: () => ({ admit: () => { throw new Error('boom') } }) })
  const brokenRes = response()
  await broken(request('GET', '/sessions'), brokenRes)
  assert.equal(brokenRes.state.status, 503)
})

test('requestRejection allows the desktop relay referer only on its own', () => {
  const relay = { headers: { host: '127.0.0.1:7675', referer: 'dsh-app://app/' } }
  assert.equal(requestRejection(relay, undefined), undefined)
  assert.equal(requestRejection({ headers: { ...relay.headers, origin: 'http://127.0.0.1:7675' } }, undefined), 403)
  assert.equal(requestRejection({ headers: { ...relay.headers, 'sec-fetch-site': 'same-origin' } }, undefined), 403)
})

test('apply registers the API prefix on a composed web server and answers over HTTP', async () => {
  const { createServer } = await import('node:http')
  const { apply } = await import('../index.js')
  const registrations = []
  const disposers = []
  const effect = fn => {
    const dispose = fn()
    disposers.push(dispose)
    return dispose
  }
  const ctx = {
    tools: { register: () => () => {} },
    effect,
    inject(deps, callback) {
      assert.deepEqual(deps, ['webServer'])
      callback({
        webServer: {
          register(route) {
            registrations.push(route)
            return () => registrations.pop()
          },
        },
        effect,
        get: () => undefined,
      })
    },
  }

  apply(ctx, { rootDir: join(root, 'apply-http') })
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].kind, 'prefix')
  assert.equal(registrations[0].path, API_PREFIX)

  const server = createServer(registrations[0].handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const { port } = server.address()
    const response = await fetch(`http://127.0.0.1:${port}${API_PREFIX}/sessions`)
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.ok(Array.isArray(payload.sessions))
    assert.equal(payload.sessions.length, 0)

    const opened = await fetch(`http://127.0.0.1:${port}${API_PREFIX}/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` },
      body: JSON.stringify({ session: 'http', cwd: '/tmp' }),
    })
    assert.equal(opened.status, 200)
    assert.equal((await opened.json()).session.cwd, '/tmp')
  } finally {
    for (const dispose of disposers) dispose?.()
    await new Promise(resolve => server.close(resolve))
  }
})

