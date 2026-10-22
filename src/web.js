/**
 * Browser-facing JSON API for the Shared Bash settings page.
 *
 * The web server itself carries no request policy ("route owners such as
 * dsh-client-connection enforce their own request policy"), and a prefix longer
 * than `/api` outranks the kernel's own admission check, so this module owns the
 * fence: the composition's `connection` service when it exists, otherwise the
 * same structural rules the kernel applies (loopback Host, no cross-site fetch,
 * an Origin/Referer that matches the Host authority).
 */

import { BashSessionError } from './sessions.js'

/** Prefix registered on the harness web server. */
export const API_PREFIX = '/api/shared-bash'

const MAX_BODY_BYTES = 64 * 1024
const MAX_RESULT_BYTES = 128 * 1024
const LOOPBACK_NAMES = new Set(['127.0.0.1', '[::1]', '::1', 'localhost'])

const STATUS_BY_CODE = {
  INVALID_SESSION: 400,
  CWD_NOT_FOUND: 400,
  NO_SESSION: 404,
  SESSION_BUSY: 409,
  SESSION_NOT_RUNNING: 409,
  SESSION_CLOSED: 410,
  SESSION_EXITED: 409,
  TOO_MANY_SESSIONS: 409,
  SPAWN_FAILED: 500,
}

/**
 * Build the `(req, res)` handler registered under {@link API_PREFIX}.
 * @param {object} manager - the SharedBashManager.
 * @param {{ connection?: () => object | undefined, maxSessions?: number }} [options]
 *   `connection` resolves the harness connection service per request, because
 *   plugins load before the browser half publishes it.
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createWebHandler(manager, options = {}) {
  const connectionOf = typeof options.connection === 'function' ? options.connection : () => options.connection

  return async function handler(req, res) {
    const rejection = requestRejection(req, safeCall(connectionOf))
    if (rejection !== undefined) {
      return send(res, rejection, { error: rejection === 401 ? 'unauthorized' : 'forbidden' })
    }
    let url
    try {
      url = new URL(req.url ?? '/', 'http://localhost')
    } catch {
      return send(res, 400, { error: 'malformed request URL' })
    }
    const route = url.pathname.slice(API_PREFIX.length).replace(/\/+$/u, '') || '/'
    const method = String(req.method ?? 'GET').toUpperCase()

    try {
      if (method === 'GET' && route === '/sessions') {
        return send(res, 200, {
          sessions: manager.list(),
          maxSessions: manager.maxSessions ?? options.maxSessions,
        })
      }

      if (method === 'GET' && route === '/output') {
        const name = url.searchParams.get('session') ?? ''
        const session = manager.require(name)
        return send(res, 200, { session: name, ...session.read({
          lines: numberParam(url, 'lines', 200),
          offset: numberParam(url, 'offset', 0),
        }) })
      }

      if (method === 'POST' && route === '/open') {
        const body = await readJson(req)
        const opened = await manager.open({
          session: text(body.session),
          cwd: text(body.cwd),
          msystem: text(body.msystem),
          recreate: body.recreate === true,
        })
        return send(res, 200, { session: opened.session.summary(), reused: opened.reused })
      }

      if (method === 'POST' && route === '/send') {
        const body = await readJson(req)
        const command = text(body.command)
        if (command === undefined || command.trim() === '') {
          return send(res, 400, { error: 'command must be a non-empty string' })
        }
        const session = manager.require(text(body.session) ?? 'main')
        const result = await session.run(command, { timeoutMs: numeric(body.timeout_ms) })
        return send(res, 200, {
          session: session.name,
          exit_code: result.exitCode,
          output: clip(result.output ?? ''),
          timed_out: result.timedOut === true,
          running: result.stillRunning === true,
          cwd: result.cwd,
        })
      }

      if (method === 'POST' && route === '/interrupt') {
        const body = await readJson(req)
        const session = manager.require(text(body.session) ?? 'main')
        return send(res, 200, { session: session.name, ...(await session.interrupt()) })
      }

      if (method === 'POST' && route === '/close') {
        const body = await readJson(req)
        if (body.all === true) {
          const closed = manager.list().map((entry) => entry.session)
          for (const name of closed) manager.close(name)
          return send(res, 200, { closed })
        }
        const name = text(body.session)
        if (name === undefined) return send(res, 400, { error: 'session is required unless all is true' })
        const closed = manager.close(name)
        return send(res, closed ? 200 : 404, { closed: closed ? [name] : [] })
      }

      return send(res, 404, { error: `no route for ${method} ${route}` })
    } catch (error) {
      const status = error instanceof BashSessionError
        ? STATUS_BY_CODE[error.code] ?? 500
        : 500
      return send(res, status, {
        error: error instanceof Error ? error.message : String(error),
        ...(error instanceof BashSessionError ? { code: error.code } : {}),
      })
    }
  }
}

/**
 * Decide one request: an HTTP status to reject with, or `undefined` to run it.
 * @param {import('node:http').IncomingMessage} req
 * @param {object | undefined} connection - the harness connection service, when composed.
 * @returns {number | undefined}
 */
export function requestRejection(req, connection) {
  try {
    const admit = connection?.admit
    if (typeof admit === 'function') {
      const admission = admit.call(connection, req)
      const status = admission && typeof admission === 'object' ? admission.rejection : undefined
      if (status !== undefined) return status
      return undefined
    }
    const legacy = connection?.requestRejection
    if (typeof legacy === 'function') return legacy.call(connection, req)
  } catch {
    // A failing admission service must never read as "allowed".
    return 503
  }
  const reason = structuralReason(req)
  return reason === undefined ? undefined : 403
}

/** DNS-rebinding, cross-site and same-authority checks, mirroring the kernel. */
function structuralReason(req) {
  const host = authorityOf(req.headers.host)
  if (host === null || !LOOPBACK_NAMES.has(host.hostname)) return 'host-not-loopback'
  if (String(req.headers['sec-fetch-site'] ?? '').toLowerCase() === 'cross-site') return 'cross-site'
  for (const header of ['origin', 'referer']) {
    const raw = req.headers[header]
    if (typeof raw !== 'string' || raw.trim() === '') continue
    if (header === 'referer' && isDesktopRelayReferer(raw)) {
      if (req.headers.origin !== undefined || req.headers['sec-fetch-site'] !== undefined) return 'desktop-relay-markers'
      continue
    }
    const authority = authorityOf(raw)
    if (authority === null) return `${header}-invalid`
    if (authority.scheme !== host.scheme || authority.hostname !== host.hostname || authority.port !== host.port) {
      return `${header}-mismatch`
    }
  }
  return undefined
}

/** Only the owned application page, never an arbitrary custom-protocol page. */
function isDesktopRelayReferer(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'dsh-app:' && url.hostname === 'app' && url.port === ''
      && url.username === '' && url.password === ''
  } catch {
    return false
  }
}

function authorityOf(value) {
  if (typeof value !== 'string' || value.trim() === '') return null
  let url
  try {
    url = new URL(value.includes('://') ? value.trim() : `http://${value.trim()}`)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const port = url.port === '' ? (url.protocol === 'https:' ? '443' : '80') : url.port
  return { scheme: url.protocol.replace(':', ''), hostname: url.hostname.toLowerCase(), port }
}

function send(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new BashSessionError('INVALID_SESSION', 'request body too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return value !== null && typeof value === 'object' ? value : {}
  } catch {
    throw new BashSessionError('INVALID_SESSION', 'request body must be JSON')
  }
}

function text(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function numeric(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function numberParam(url, key, fallback) {
  const value = Number(url.searchParams.get(key))
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function clip(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) <= MAX_RESULT_BYTES) return text
  let clipped = text
  while (Buffer.byteLength(clipped) > MAX_RESULT_BYTES) clipped = clipped.slice(0, Math.floor(clipped.length * 0.9))
  return `${clipped}\n… (output truncated)`
}

function safeCall(read) {
  try {
    return read()
  } catch {
    return undefined
  }
}
