/**
 * One persistent PTY shell, addressed by the DSH session that owns it.
 *
 * The terminal itself comes from the harness subprocess provider
 * (`ctx.subprocess.spawnTerminal`), so this module owns only what a PTY consumer
 * owns: how a command is framed, when it is done, retained output, and teardown.
 *
 * Framing uses a private sentinel instead of prompt detection. Each command is
 * written to a script file and sourced with stdin from `/dev/null`, so heredocs,
 * loops and `read` all behave, and the shell then prints
 * `\x1e__DSH_SB__<session>:<exit>:<pwd>\x1e`. The session token travels in the
 * environment, never in the typed text, so terminal echo of the command line
 * cannot fake a completion.
 */

import { randomBytes } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_COLS = 120
export const DEFAULT_ROWS = 30
export const MAX_RING_LINES = 4000

const SENTINEL = '\u001e__DSH_SB__'
const SENTINEL_PATTERN = /\u001e__DSH_SB__([0-9a-f]{8,32}):(-?\d+):(.*?)\u001e/u
const ANSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)|\u001b[()][0-9A-Za-z]|\u001b[=>78NODM]/gu
const CONTROL_PATTERN = /[\u0000-\u0008\u000b-\u001f\u007f]/gu

const SESSION_ID = /^[A-Za-z0-9._:-]{1,128}$/u

export class BashSessionError extends Error {
  /**
   * @param {string} code - stable machine-routable code.
   * @param {string} message - human-readable text.
   * @param {object} [extra] - additional fields merged into the error.
   */
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'BashSessionError'
    this.code = code
    Object.assign(this, extra)
  }
}

/** Reject ids that are not addressable in a tool argument or a URL. */
export function normalizeSessionId(value) {
  if (typeof value !== 'string' || !SESSION_ID.test(value)) {
    throw new BashSessionError('INVALID_SESSION', `invalid session id ${JSON.stringify(value)}: use 1-128 characters from A-Z a-z 0-9 . _ : -`)
  }
  return value
}

/** Strip terminal escape sequences and control bytes from one PTY line. */
export function sanitizeLine(line) {
  return line.replace(ANSI_PATTERN, '').replace(CONTROL_PATTERN, '').replace(/\r/gu, '')
}

// Windows paths are what the subprocess provider spawns with; bash's `cd` and
// `source` need the POSIX form a Cygwin/MSYS2 shell reads.
export function toPosixPath(value) {
  const text = String(value).replace(/\\/gu, '/')
  const drive = text.match(/^([A-Za-z]):(\/|$)/u)
  if (drive === null) return text
  const rest = text.slice(3)
  return `/${drive[1].toLowerCase()}${rest === '' ? '' : `/${rest}`}`
}

// The inverse: POSIX paths an MSYS2 installation owns, as Windows paths a spawn
// can use. Non-Windows hosts and non-POSIX input pass through unchanged.
export function toHostPath(input, bashPath) {
  const text = String(input)
  if (process.platform !== 'win32' || !text.startsWith('/')) return text
  const marker = String(bashPath).toLowerCase().indexOf('\\usr\\')
  if (marker < 0) return text
  const root = String(bashPath).slice(0, marker)
  const drive = text.match(/^\/([A-Za-z])(\/|$)/u)
  if (drive !== null) return `${drive[1].toUpperCase()}:\\${text.slice(3).replace(/\//gu, '\\')}`
  if (text === '/') return root
  return `${root}\\${text.slice(1).replace(/\//gu, '\\')}`
}

function shellQuote(value) {
  return `'${String(value).replace(/'/gu, "'\\''")}'`
}

/**
 * One long-lived PTY shell for one DSH session.
 *
 * `run()` is the only way a command enters the shell: it writes a script file,
 * sources it, and settles when the sentinel for that write arrives.
 */
export class PtyShellSession {
  /**
   * @param {{ sessionId: string, spawnTerminal: (spec: object) => Promise<object>,
   *   argv?: string[], cwd?: string, env?: object, cols?: number, rows?: number,
   *   maxLines?: number, rootDir: string }} options
   */
  constructor(options) {
    this.sessionId = normalizeSessionId(options.sessionId)
    this.spawnTerminal = options.spawnTerminal
    this.argv = options.argv ?? []
    this.cwd = options.cwd ?? process.cwd()
    this.env = options.env ?? {}
    this.cols = options.cols ?? DEFAULT_COLS
    this.rows = options.rows ?? DEFAULT_ROWS
    this.maxLines = options.maxLines ?? MAX_RING_LINES
    this.rootDir = join(options.rootDir, this.sessionId)
    this.token = randomBytes(8).toString('hex')
    this.status = 'starting'
    this.pid = undefined
    this.startupError = undefined
    this.commands = 0
    this.createdAt = new Date().toISOString()
    this.lastActivityAt = this.createdAt
    this.firstSeq = 0
    this.lines = []
    this.partial = ''
    this.active = undefined
    this.closed = false
    this.decoder = new TextDecoder()
    this.pending = ''
    mkdirSync(this.rootDir, { recursive: true })
  }

  /** Allocate the PTY, then prove the sentinel protocol works. */
  async start() {
    try {
      const terminal = await this.spawnTerminal({
        argv: this.argv,
        cwd: this.cwd,
        env: {
          ...this.env,
          PS1: '',
          PS2: '',
          PROMPT_COMMAND: '',
          TERM: 'xterm-256color',
          __DSH_SB_ID: this.token,
        },
        rows: this.rows,
        cols: this.cols,
        terminalType: 'xterm-256color',
        graceMs: 3000,
      })
      this.terminal = terminal
      this.pid = terminal.pid
      terminal.output.on('data', chunk => this.#receive(chunk))
      terminal.output.on('end', () => this.#exit('shell exited'))
      terminal.output.on('error', error => this.#exit(`output error: ${error.message}`))
      void terminal.done.then(
        outcome => this.#exit(`shell exited (code ${outcome?.exitCode ?? 'unknown'})`),
        error => this.#exit(`shell failed: ${error?.message ?? 'unknown'}`),
      )
      this.status = 'running'
      await this.#probe()
    } catch (error) {
      this.status = 'exited'
      this.startupError = error instanceof Error ? error.message : String(error)
      throw error instanceof BashSessionError
        ? error
        : new BashSessionError('SPAWN_FAILED', `session ${this.sessionId}: ${this.startupError}`)
    }
    return this
  }

  /** `cd` into the requested directory once the shell is alive. */
  async enter(cwd) {
    const target = String(cwd).startsWith('/') ? String(cwd) : toPosixPath(cwd)
    const result = await this.run(`cd ${shellQuote(target)}`, { silent: true, timeoutMs: 15_000 })
    if (result.exitCode !== 0) {
      throw new BashSessionError('CWD_NOT_FOUND', `cannot enter working directory ${JSON.stringify(target)}: ${result.output.trim()}`, { cwd: target })
    }
  }

  /**
   * Run one command and settle when the shell prints its sentinel.
   * @param {string} command - shell text; heredocs and multi-line bodies are fine.
   * @param {{ silent?: boolean, timeoutMs?: number }} [options]
   * @returns {Promise<{exitCode: number, output: string, cwd?: string, timedOut?: boolean}>}
   */
  async run(command, options = {}) {
    if (this.closed) throw new BashSessionError('SESSION_CLOSED', `session ${this.sessionId} is closed`)
    if (this.status !== 'running') {
      throw new BashSessionError('SESSION_NOT_RUNNING', this.startupError ?? `session ${this.sessionId} is ${this.status}`)
    }
    if (this.active !== undefined) {
      throw new BashSessionError('SESSION_BUSY', `session ${this.sessionId} is still running a command; wait for it, read its output, or interrupt it`, { session: this.sessionId })
    }
    const index = this.commands
    this.commands += 1
    const file = join(this.rootDir, `command-${index}.sh`)
    writeFileSync(file, `${command}\n`, 'utf8')
    const startSeq = this.firstSeq + this.lines.length
    const payload = `. ${shellQuote(toPosixPath(file))} </dev/null; __dsh_sb_ec=$?; printf '\\036__DSH_SB__%s:%s:%s\\036\\n' "$__DSH_SB_ID" "$__dsh_sb_ec" "$PWD"`
    this.lastActivityAt = new Date().toISOString()

    const settled = new Promise((resolve, reject) => {
      this.active = { resolve, reject, startedAt: Date.now(), startSeq, file, payload, silent: options.silent === true }
    })
    try {
      await this.terminal.write(`${payload}\n`)
    } catch (error) {
      this.active = undefined
      throw new BashSessionError('SESSION_CLOSED', `session ${this.sessionId}: write failed: ${error.message}`)
    }

    if (options.timeoutMs === undefined) return await settled

    const timeoutMs = Math.max(1, Number(options.timeoutMs))
    let timer
    const timeout = new Promise(resolve => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs)
    })
    const outcome = await Promise.race([settled.then(value => ({ kind: 'settled', value })), timeout])
    clearTimeout(timer)
    if (outcome === 'timeout') {
      // The command keeps running; the late sentinel still settles the session.
      return { exitCode: undefined, output: this.textFrom(startSeq), cwd: this.cwd, timedOut: true, stillRunning: true }
    }
    return outcome.value
  }

  /** Text retained from one absolute line sequence onwards. */
  textFrom(seq) {
    const start = Math.max(seq, this.firstSeq)
    return this.lines.slice(start - this.firstSeq).join('\n')
  }

  /**
   * Read retained output, newest page first.
   * @param {{ lines?: number, offset?: number }} [options]
   */
  read(options = {}) {
    const total = this.firstSeq + this.lines.length
    const limit = Math.max(1, Math.min(2000, Number(options.lines ?? 200)))
    const offset = Math.max(0, Number(options.offset ?? 0))
    const end = Math.max(0, total - offset)
    const start = Math.max(this.firstSeq, end - limit)
    const body = this.lines.slice(start - this.firstSeq, end - this.firstSeq)
    const tail = end === total ? sanitizeLine(this.pending) : ''
    const text = body.join('\n') + (end === total && tail !== '' ? (body.length > 0 ? '\n' : '') + tail : '')
    return {
      text,
      start,
      end,
      total,
      hasMore: start > this.firstSeq,
      partial: end === total && tail !== '',
      status: this.status,
      busy: this.active !== undefined,
      cwd: this.cwd,
    }
  }

  /** Deliver a real SIGINT to the foreground process group. */
  async interrupt() {
    if (this.active === undefined || this.terminal === undefined) return { interrupted: false }
    try {
      await this.terminal.signalForeground('SIGINT')
    } catch (error) {
      throw new BashSessionError('INTERRUPT_FAILED', `session ${this.sessionId}: ${error.message}`)
    }
    // A signal aborts the whole input line, sentinel included; print a fresh one
    // so the session is usable again and the job settles as interrupted.
    setTimeout(() => {
      if (this.closed || this.active === undefined) return
      void this.terminal?.write(`printf '\\036__DSH_SB__%s:130:%s\\036\\n' "$__DSH_SB_ID" "$PWD"\n`).catch(() => {})
    }, 150)
    return { interrupted: true }
  }

  async close() {
    if (this.closed) return
    this.closed = true
    this.status = 'closing'
    const active = this.active
    this.active = undefined
    active?.reject(new BashSessionError('SESSION_CLOSED', `session ${this.sessionId} closed`))
    try {
      await this.terminal?.terminate()
    } catch {
      // The provider may already have destroyed the range.
    }
    this.status = 'exited'
    try {
      rmSync(this.rootDir, { recursive: true, force: true })
    } catch {
      // Best effort.
    }
  }

  summary() {
    return {
      session_id: this.sessionId,
      status: this.status,
      pid: this.pid,
      cwd: this.cwd,
      cols: this.cols,
      rows: this.rows,
      busy: this.active !== undefined,
      commands: this.commands,
      lines: this.firstSeq + this.lines.length,
      createdAt: this.createdAt,
      lastActivityAt: this.lastActivityAt,
      startupError: this.startupError,
    }
  }

  async #probe() {
    const result = await this.run(':', { silent: true, timeoutMs: 20_000 })
    if (result.timedOut) {
      throw new BashSessionError('STARTUP_TIMEOUT', `session ${this.sessionId}: shell did not answer the startup probe`)
    }
    try {
      const identity = await this.run("printf '__DSH_SB_PID__:%s\\n' \"$$\"", { silent: true, timeoutMs: 10_000 })
      const pid = Number(identity.output.match(/__DSH_SB_PID__:(\d+)/u)?.[1])
      if (Number.isInteger(pid) && pid > 0) this.pid = pid
    } catch {
      // The provider's pid remains authoritative when the shell cannot report one.
    }
  }

  #receive(chunk) {
    this.pending += this.decoder.decode(chunk, { stream: true })
    let index = this.pending.indexOf('\n')
    while (index >= 0) {
      const line = this.pending.slice(0, index)
      this.pending = this.pending.slice(index + 1)
      this.#line(line)
      index = this.pending.indexOf('\n')
    }
  }

  #line(raw) {
    // The sentinel is bracketed with the ASCII record separator, which the output
    // sanitizer strips — so match it on the raw line before sanitizing.
    const sentinel = SENTINEL_PATTERN.exec(raw)
    if (sentinel !== null) {
      if (sentinel[1] !== this.token) return
      const active = this.active
      if (active === undefined) return
      this.active = undefined
      this.cwd = sentinel[3] === '' ? this.cwd : sentinel[3]
      this.lastActivityAt = new Date().toISOString()
      active.resolve({
        exitCode: Number(sentinel[2]),
        output: this.textFrom(active.startSeq).trimEnd(),
        cwd: this.cwd,
      })
      return
    }
    const line = sanitizeLine(raw)
    if (this.active !== undefined && line === this.active.payload) return
    if (line.trim() === '' && this.active === undefined && this.lines.length === 0) return
    this.#append(line)
  }

  #append(line) {
    if (this.active !== undefined && this.active.silent) return
    this.lines.push(line)
    if (this.lines.length > this.maxLines) {
      const drop = this.lines.length - this.maxLines
      this.lines.splice(0, drop)
      this.firstSeq += drop
    }
  }

  #exit(reason) {
    if (this.closed) return
    this.closed = true
    this.status = 'exited'
    this.startupError = this.startupError ?? reason
    const active = this.active
    this.active = undefined
    active?.reject(new BashSessionError('SESSION_EXITED', `session ${this.sessionId}: ${reason}`))
    if (this.pending !== '') this.#append(sanitizeLine(this.pending))
    this.pending = ''
  }
}

export { SENTINEL }
