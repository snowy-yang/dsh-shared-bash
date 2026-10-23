/**
 * Session-keyed registry of PTY shells plus the background jobs commands produce.
 *
 * A shell belongs to one DSH session id, not to one agent: any agent that knows
 * the id can attach, read it or drive it, which is the explicit-sharing model the
 * plugin offers instead of a profile-wide pool.
 */

import { randomBytes } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BashSessionError, DEFAULT_COLS, DEFAULT_ROWS, MAX_RING_LINES, PtyShellSession, normalizeSessionId, toHostPath, toPosixPath } from './pty.js'

export const DEFAULT_MSYS2_BASH = 'C:\\msys64\\usr\\bin\\bash.exe'

const MAX_JOBS = 200

export class SharedBashManager {
  /**
   * @param {{ bashPath?: string, msystem?: string, cols?: number, rows?: number,
   *   maxLines?: number, maxSessions?: number, cwd?: string, login?: boolean,
   *   env?: object, rootDir?: string, spawnTerminal?: (spec: object) => Promise<object> }} [options]
   */
  constructor(options = {}) {
    this.bashPath = options.bashPath ?? process.env.DSH_SHARED_BASH ?? DEFAULT_MSYS2_BASH
    this.msystem = options.msystem ?? 'MSYS'
    this.cols = options.cols ?? DEFAULT_COLS
    this.rows = options.rows ?? DEFAULT_ROWS
    this.maxLines = options.maxLines ?? MAX_RING_LINES
    this.maxSessions = options.maxSessions ?? 16
    this.defaultCwd = options.cwd ?? process.cwd()
    this.login = options.login !== false
    this.env = options.env ?? {}
    this.rootDir = options.rootDir ?? join(tmpdir(), `dsh-shared-bash-pty-${process.pid}`)
    this.spawnTerminal = options.spawnTerminal
    this.sessions = new Map()
    this.jobs = new Map()
    mkdirSync(this.rootDir, { recursive: true })
  }

  /** The harness provider arrives after this plugin loads, so it is bound lazily. */
  bindSubprocess(getter) {
    this.providerOf = getter
    return this
  }

  #provider() {
    if (typeof this.spawnTerminal === 'function') return { spawnTerminal: this.spawnTerminal }
    const provider = typeof this.providerOf === 'function' ? this.providerOf() : undefined
    if (provider === undefined || typeof provider !== 'object' || typeof provider.spawnTerminal !== 'function') {
      throw new BashSessionError('NO_SUBPROCESS', 'no subprocess provider is composed; mount @deepseek-ai/dsh-subprocess-local to get PTY terminals')
    }
    return provider
  }

  #argv() {
    const shell = this.bashPath
    return this.login ? [shell, '-l', '-i'] : [shell, '--noprofile', '--norc', '-i']
  }

  list() {
    return [...this.sessions.values()].map(session => session.summary())
  }

  get(sessionId) {
    return this.sessions.get(sessionId)
  }

  /** Resolve an existing shell or allocate one for that session id. */
  async attach(sessionId, options = {}) {
    const id = normalizeSessionId(sessionId)
    const existing = this.sessions.get(id)
    if (existing !== undefined && existing.status === 'running' && options.recreate !== true) {
      return { session: existing, reused: true }
    }
    if (existing !== undefined) {
      await this.close(id)
    }
    if (this.sessions.size >= this.maxSessions) {
      throw new BashSessionError('TOO_MANY_SESSIONS', `terminal limit ${this.maxSessions} reached; close one with bash_close`)
    }
    const cwd = options.cwd ?? this.defaultCwd
    const session = new PtyShellSession({
      sessionId: id,
      spawnTerminal: spec => this.#provider().spawnTerminal(spec),
      argv: this.#argv(),
      cwd: toHostPath(cwd, this.bashPath),
      env: { ...this.env, MSYSTEM: options.msystem ?? this.msystem },
      cols: options.cols ?? this.cols,
      rows: options.rows ?? this.rows,
      maxLines: this.maxLines,
      rootDir: this.rootDir,
    })
    this.sessions.set(id, session)
    try {
      await session.start()
      if (options.cwd !== undefined) await session.enter(toPosixPath(cwd))
      return { session, reused: false }
    } catch (error) {
      await this.close(id)
      throw error
    }
  }

  /** Start one command as a background job and return its id immediately. */
  async exec(sessionId, command, options = {}) {
    const id = normalizeSessionId(sessionId)
    const attached = await this.attach(id, { cwd: options.cwd })
    const session = attached.session
    if (session.active !== undefined) {
      throw new BashSessionError('SESSION_BUSY', `session ${id} is still running a command; wait for it, read its output, or interrupt it`, { session: id })
    }
    const job = {
      id: `bash-${randomBytes(8).toString('hex')}`,
      sessionId: id,
      command,
      status: 'running',
      startedAt: new Date().toISOString(),
      endedAt: undefined,
      exitCode: undefined,
      cwd: session.cwd,
      output: '',
      error: undefined,
      done: undefined,
      waiters: [],
    }
    this.jobs.set(job.id, job)
    this.#pruneJobs()

    job.done = session.run(command).then(
      result => {
        job.status = result.timedOut === true ? 'running' : 'completed'
        job.exitCode = result.exitCode
        job.cwd = result.cwd ?? job.cwd
        job.output = result.output ?? ''
        if (result.timedOut !== true) job.endedAt = new Date().toISOString()
        this.#settle(job)
        return job
      },
      error => {
        job.status = 'failed'
        job.error = error instanceof Error ? error.message : String(error)
        job.endedAt = new Date().toISOString()
        this.#settle(job)
        return job
      },
    )
    const first = await Promise.race([
      job.done,
      new Promise(resolve => setTimeout(() => resolve(undefined), Math.max(0, Number(options.waitMs ?? 0)))),
    ])
    return first ?? { id: job.id, session_id: id, status: 'running', startedAt: job.startedAt }
  }

  #settle(job) {
    for (const resolve of job.waiters.splice(0)) resolve(job)
  }

  #pruneJobs() {
    if (this.jobs.size <= MAX_JOBS) return
    for (const [id, job] of this.jobs) {
      if (job.status === 'running') continue
      this.jobs.delete(id)
      if (this.jobs.size <= MAX_JOBS) return
    }
  }

  getJob(jobId) {
    const job = this.jobs.get(jobId)
    if (job === undefined) throw new BashSessionError('NO_JOB', `no job named ${JSON.stringify(jobId)}; bash_exec returns job ids`, { job: jobId })
    return job
  }

  /** Wait for a job to settle, or return its current projection after `timeoutMs`. */
  async wait(jobId, timeoutMs = 600_000) {
    const job = this.getJob(jobId)
    if (job.status !== 'running') return project(job)
    let timer
    const timeout = new Promise(resolve => {
      timer = setTimeout(() => resolve('timeout'), Math.max(1, Number(timeoutMs)))
    })
    const settled = new Promise(resolve => job.waiters.push(resolve))
    if (job.status !== 'running') {
      const current = project(job)
      for (const resolve of job.waiters.splice(0)) resolve(job)
      return current
    }
    const outcome = await Promise.race([settled, timeout])
    clearTimeout(timer)
    return outcome === 'timeout' ? { ...project(job), timed_out: true } : project(job)
  }

  read(sessionId, options = {}) {
    const session = this.sessions.get(normalizeSessionId(sessionId))
    if (session === undefined) throw noSession(sessionId)
    return session.read(options)
  }

  async interrupt(sessionId) {
    const session = this.sessions.get(normalizeSessionId(sessionId))
    if (session === undefined) throw noSession(sessionId)
    return session.interrupt()
  }

  async close(sessionId) {
    const id = normalizeSessionId(sessionId)
    const session = this.sessions.get(id)
    if (session === undefined) return false
    this.sessions.delete(id)
    await session.close()
    return true
  }

  async dispose() {
    for (const session of [...this.sessions.values()]) await session.close().catch(() => {})
    this.sessions.clear()
    this.jobs.clear()
    try {
      rmSync(this.rootDir, { recursive: true, force: true, maxRetries: 3 })
    } catch {
      // Best effort: each session removed its own directory already.
    }
  }
}

function project(job) {
  return {
    id: job.id,
    session_id: job.sessionId,
    status: job.status,
    exit_code: job.exitCode,
    cwd: job.cwd,
    output: job.output,
    error: job.error,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
  }
}

function noSession(sessionId) {
  return new BashSessionError('NO_SESSION', `no terminal for session ${JSON.stringify(sessionId)}; call bash_attach first`, { session: sessionId })
}

export { BashSessionError, DEFAULT_COLS, DEFAULT_ROWS }
