/**
 * Browser-facing JSON API for the Bash terminals settings page.
 *
 * The web server carries no request policy of its own, and a prefix longer than
 * `/api` outranks the kernel's admission check, so this module owns the fence:
 * the composition's `connection` service when it exists, otherwise the same
 * structural rules the kernel applies (loopback Host, no cross-site fetch, an
 * Origin/Referer matching the Host authority).
 */

import { BashSessionError } from './pty.js'

/** Prefix registered on the harness web server. */
export const API_PREFIX = '/api/shared-bash'

const MAX_BODY_BYTES = 64 * 1024
const LOOPBACK_NAMES = new Set(['127.0.0.1', '[::1]', '::1', 'localhost'])

const STATUS_BY_CODE = {
  INVALID_SESSION: 400,
  INVALID_COMMAND: 400,
  CWD_NOT_FOUND: 400,
  NO_SESSION: 404,
  NO_JOB: 404,
  SESSION_BUSY: 409,
  SESSION_NOT_RUNNING: 409,
  SESSION_EXITED: 409,
  SESSION_CLOSED: 410,
  TOO_MANY_SESSIONS: 409,
  SPAWN_FAILED: 500,
  STARTUP_TIMEOUT: 504,
  NO_SUBPROCESS: 503,
  INTERRUPT_FAILED: 500,
  NO_SESSION_CONTEXT: 400,
}

/**
 * Build the `(req, res)` handler registered under {@link API_PREFIX}.
 * @param {object} manager - the SharedBashManager.
 * @param {{ connection?: () => object | undefined }} [options]
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
        return send(res, 200, { sessions: manager.list(), maxSessions: manager.maxSessions })
      }

      if (method === 'GET' && route === '/output') {
        const id = requireParam(url, 'session_id')
        return send(res, 200, manager.read(id, { lines: numberParam(url, 'lines', 200), offset: numberParam(url, 'offset', 0) }))
      }

      if (method === 'GET' && route === '/wait') {
        const job = await manager.wait(requireParam(url, 'job_id'), numberParam(url, 'timeout_ms', 30_000))
        return send(res, 200, job)
      }

      if (method === 'POST' && route === '/attach') {
        const body = await readJson(req)
        const attached = await manager.attach(requireText(body.session_id), { cwd: text(body.cwd), recreate: body.recreate === true })
        return send(res, 200, { session: attached.session.summary(), reused: attached.reused })
      }

      if (method === 'POST' && route === '/exec') {
        const body = await readJson(req)
        const command = text(body.command)
        if (command === undefined || command.trim() === '') return send(res, 400, { error: 'command must be a non-empty string' })
        const job = await manager.exec(requireText(body.session_id), command, { waitMs: numeric(body.wait_ms) ?? 0 })
        return send(res, 200, {
          job_id: job.id,
          session_id: job.sessionId ?? job.session_id,
          status: job.status,
          exit_code: job.exitCode ?? 0,
          output: job.output ?? '',
          cwd: job.cwd ?? '',
        })
      }

      if (method === 'POST' && route === '/interrupt') {
        const body = await readJson(req)
        const id = requireText(body.session_id)
        return send(res, 200, { session_id: id, ...(await manager.interrupt(id)) })
      }

      if (method === 'POST' && route === '/close') {
        const body = await readJson(req)
        if (body.all === true) {
          const closed = manager.list().map(entry => entry.session_id)
          for (const id of closed) await manager.close(id)
          return send(res, 200, { closed })
        }
        const id = requireText(body.session_id)
        const closed = await manager.close(id)
        return send(res, closed ? 200 : 404, { closed: closed ? [id] : [] })
      }

      return send(res, 404, { error: `no route for ${method} ${route}` })
    } catch (error) {
      const status = error instanceof BashSessionError ? STATUS_BY_CODE[error.code] ?? 500 : 500
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
      return status
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
    if (size > MAX_BODY_BYTES) throw new BashSessionError('INVALID_COMMAND', 'request body too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return value !== null && typeof value === 'object' ? value : {}
  } catch {
    throw new BashSessionError('INVALID_COMMAND', 'request body must be JSON')
  }
}

function text(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function requireText(value) {
  const result = text(value)
  if (result === undefined) throw new BashSessionError('INVALID_SESSION', 'session_id is required')
  return result
}

function numeric(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function numberParam(url, key, fallback) {
  const value = Number(url.searchParams.get(key))
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function requireParam(url, key) {
  const value = url.searchParams.get(key)
  if (value === null || value === '') throw new BashSessionError('INVALID_SESSION', `${key} is required`)
  return value
}

function safeCall(read) {
  try {
    return read()
  } catch {
    return undefined
  }
}
