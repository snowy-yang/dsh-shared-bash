import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { after, test } from 'node:test'

import { SharedBashManager } from '../src/manager.js'
import { API_PREFIX, createWebHandler, requestRejection } from '../src/web.js'
import { createFakeTerminalProvider } from './terminal-double.mjs'

const root = mkdtempSync(join(tmpdir(), 'shared-bash-api-'))
const provider = createFakeTerminalProvider()
const manager = new SharedBashManager({ rootDir: root, spawnTerminal: spec => provider.spawnTerminal(spec) })
const handler = createWebHandler(manager)

after(async () => {
  await manager.dispose()
  rmSync(root, { recursive: true, force: true })
})

function request(method, path, options = {}) {
  const body = options.body === undefined ? [] : [Buffer.from(JSON.stringify(options.body))]
  return {
    method,
    url: `${API_PREFIX}${path}`,
    headers: { host: '127.0.0.1:7632', ...options.headers },
    async *[Symbol.asyncIterator]() {
      for (const chunk of body) yield chunk
    },
  }
}

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
  assert.equal(res.json().maxSessions, 16)
})

test('POST /attach opens a terminal for a session id', async () => {
  const res = await call('POST', '/attach', { body: { session_id: 'web-a', cwd: '/tmp' } })
  assert.equal(res.state.status, 200)
  const payload = res.json()
  assert.equal(payload.session.session_id, 'web-a')
  assert.equal(payload.session.cwd, '/tmp')
  assert.equal(payload.reused, false)
})

test('POST /exec returns a job id and GET /wait collects it', async () => {
  const started = await call('POST', '/exec', { body: { session_id: 'web-a', command: 'echo via-http' } })
  assert.equal(started.state.status, 200)
  const { job_id: jobId } = started.json()
  assert.match(jobId, /^bash-[0-9a-f]{16}$/)

  const waited = await call('GET', `/wait?job_id=${jobId}&timeout_ms=20000`)
  assert.equal(waited.state.status, 200)
  const done = waited.json()
  assert.equal(done.status, 'completed')
  assert.match(done.output, /via-http/)

  const output = await call('GET', '/output?session_id=web-a&lines=50')
  assert.equal(output.state.status, 200)
  assert.match(output.json().text, /via-http/)
})

test('unknown sessions, jobs and empty commands map to stable statuses', async () => {
  const missing = await call('GET', '/output?session_id=nope')
  assert.equal(missing.state.status, 404)
  assert.equal(missing.json().code, 'NO_SESSION')

  const invalid = await call('POST', '/attach', { body: { session_id: 'bad id!' } })
  assert.equal(invalid.state.status, 400)
  assert.equal(invalid.json().code, 'INVALID_SESSION')

  const empty = await call('POST', '/exec', { body: { session_id: 'web-a', command: '  ' } })
  assert.equal(empty.state.status, 400)

  const noJob = await call('GET', '/wait?job_id=bash-0000000000000000')
  assert.equal(noJob.state.status, 404)
  assert.equal(noJob.json().code, 'NO_JOB')
})

test('exec opens a terminal on demand for a session that has none', async () => {
  const started = await call('POST', '/exec', { body: { session_id: 'web-on-demand', command: 'echo fresh' } })
  assert.equal(started.state.status, 200)
  const waited = await call('GET', `/wait?job_id=${started.json().job_id}&timeout_ms=20000`)
  assert.match(waited.json().output, /fresh/)
  await call('POST', '/close', { body: { session_id: 'web-on-demand' } })
})

test('POST /interrupt and POST /close report what they touched', async () => {
  const interrupted = await call('POST', '/interrupt', { body: { session_id: 'web-a' } })
  assert.equal(interrupted.state.status, 200)
  assert.equal(typeof interrupted.json().interrupted, 'boolean')

  const closed = await call('POST', '/close', { body: { session_id: 'web-a' } })
  assert.equal(closed.state.status, 200)
  assert.deepEqual(closed.json().closed, ['web-a'])

  const again = await call('POST', '/close', { body: { session_id: 'web-a' } })
  assert.equal(again.state.status, 404)

  await call('POST', '/attach', { body: { session_id: 'web-b' } })
  await call('POST', '/attach', { body: { session_id: 'web-c' } })
  const all = await call('POST', '/close', { body: { all: true } })
  assert.deepEqual(all.json().closed.sort(), ['web-b', 'web-c'])
})

test('unknown routes answer 404 with method and route', async () => {
  const res = await call('GET', '/nope')
  assert.equal(res.state.status, 404)
  assert.match(res.json().error, /GET \/nope/)
})

test('the request fence refuses cross-site, foreign-origin and rebound callers', async () => {
  assert.equal((await call('GET', '/sessions', { headers: { 'sec-fetch-site': 'cross-site' } })).state.status, 403)
  assert.equal((await call('GET', '/sessions', { headers: { origin: 'http://example.com' } })).state.status, 403)
  assert.equal((await call('GET', '/sessions', { headers: { host: 'evil.test:7632' } })).state.status, 403)
  assert.equal((await call('GET', '/sessions', { headers: { origin: 'http://127.0.0.1:7632' } })).state.status, 200)
})

test('a mounted connection service decides, and a broken one fails closed', async () => {
  const denied = createWebHandler(manager, { connection: () => ({ admit: () => ({ rejection: 401 }) }) })
  const deniedRes = response()
  await denied(request('GET', '/sessions'), deniedRes)
  assert.equal(deniedRes.state.status, 401)

  const legacy = createWebHandler(manager, { connection: () => ({ requestRejection: () => 403 }) })
  const legacyRes = response()
  await legacy(request('GET', '/sessions'), legacyRes)
  assert.equal(legacyRes.state.status, 403)

  const broken = createWebHandler(manager, { connection: () => ({ admit: () => { throw new Error('boom') } }) })
  const brokenRes = response()
  await broken(request('GET', '/sessions'), brokenRes)
  assert.equal(brokenRes.state.status, 503)
})

test('the desktop relay referer is allowed only on its own', () => {
  const relay = { headers: { host: '127.0.0.1:7632', referer: 'dsh-app://app/' } }
  assert.equal(requestRejection(relay, undefined), undefined)
  assert.equal(requestRejection({ headers: { ...relay.headers, origin: 'http://127.0.0.1:7632' } }, undefined), 403)
  assert.equal(requestRejection({ headers: { ...relay.headers, 'sec-fetch-site': 'same-origin' } }, undefined), 403)
})

test('apply registers the prefix on a composed web server and answers over HTTP', async () => {
  const { apply } = await import('../index.js')
  const registrations = []
  const disposers = []
  const effect = fn => {
    const dispose = fn()
    disposers.push(dispose)
    return dispose
  }
  const ctx = {
    get: name => (name === 'subprocess' ? provider : undefined),
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
  assert.equal(registrations[0].path, API_PREFIX)
  assert.equal(registrations[0].kind, 'prefix')

  const server = createServer(registrations[0].handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const { port } = server.address()
    const base = `http://127.0.0.1:${port}`
    const sessions = await fetch(`${base}${API_PREFIX}/sessions`)
    assert.equal(sessions.status, 200)
    assert.deepEqual((await sessions.json()).sessions, [])

    const attached = await fetch(`${base}${API_PREFIX}/attach`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ session_id: 'http-session', cwd: '/tmp' }),
    })
    assert.equal(attached.status, 200)
    assert.equal((await attached.json()).session.cwd, '/tmp')
  } finally {
    for (const dispose of disposers) dispose?.()
    await new Promise(resolve => server.close(resolve))
  }
})
