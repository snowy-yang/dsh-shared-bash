// Shared persistent bash sessions for DSH.
//
// One Host-side manager owns every session as a long-lived `bash` process whose
// stdio are pipes. Each command is written to a temporary file inside the
// session directory and executed with `. file </dev/null`, so `cd`, variables,
// functions and exported environment survive between commands while a command
// can never swallow the completion sentinel from stdin.

import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'

const DEFAULT_MSYS2_BASH = 'C:\\msys64\\usr\\bin\\bash.exe'
const MAX_RING_LINES = 4000
const SENTINEL_HOLDBACK = 128

export class BashSessionError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'BashSessionError'
    this.code = code
    Object.assign(this, details)
  }
}

function defaultBashPath() {
  if (existsSync(DEFAULT_MSYS2_BASH)) return DEFAULT_MSYS2_BASH
  return 'bash'
}

function normalizeName(name) {
  const value = String(name ?? '').trim()
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(value)) {
    throw new BashSessionError('INVALID_SESSION', `invalid session name ${JSON.stringify(name)}: use 1-64 characters from A-Z a-z 0-9 . _ -`)
  }
  return value
}

function stripTrailingNewlines(text) {
  return text.replace(/\n+$/, '')
}

function decodeUtf8(chunk) {
  return chunk.toString('utf8')
}

export class BashSession {
  constructor(options) {
    this.name = options.name
    this.bashPath = options.bashPath
    this.msystem = options.msystem
    this.login = options.login
    this.cwd = options.cwd
    this.env = options.env
    this.maxLines = options.maxLines
    this.commandTimeoutMs = options.commandTimeoutMs

    this.status = 'starting'
    this.pid = undefined
    this.cygwinPid = undefined
    this.psPath = companionTool(options.bashPath, 'ps')
    this.killPath = companionTool(options.bashPath, 'kill')
    this.startupError = undefined
    this.createdAt = new Date().toISOString()
    this.lastActivityAt = this.createdAt
    this.commands = 0
    this.busy = false
    this.child = undefined
    this.exitCode = undefined

    this.dir = join(options.rootDir, this.name)
    mkdirSync(this.dir, { recursive: true })

    this.lines = []
    this.partial = ''
    this.firstSeq = 0
    this.scan = ''
    this.active = undefined
    this.closed = false
  }

  start() {
    const args = this.login ? ['-l', '-s'] : ['--noprofile', '--norc', '-s']
    const child = spawn(this.bashPath, args, {
      cwd: this.cwd,
      env: { ...process.env, ...this.env, MSYSTEM: this.msystem, TERM: 'dumb', PS1: '', PS2: '' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child = child
    this.pid = child.pid
    this.status = 'running'

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => this.#receive(chunk))
    child.stderr.on('data', (chunk) => this.#receive(chunk))
    child.stdin.on('error', (error) => this.#failActive(new BashSessionError('SESSION_CLOSED', `session ${this.name}: stdin error: ${error.message}`)))
    child.on('error', (error) => {
      this.status = 'failed'
      this.startupError = `failed to start ${this.bashPath}: ${error.message}`
      this.#failActive(new BashSessionError('SPAWN_FAILED', `session ${this.name}: ${this.startupError}`))
    })
    child.on('exit', (code) => {
      this.exitCode = code
      this.status = 'exited'
      this.busy = false
      this.#failActive(new BashSessionError('SESSION_EXITED', `session ${this.name} exited with code ${code}`, { exitCode: code }))
    })
    return this
  }

  #receive(text) {
    this.lastActivityAt = new Date().toISOString()
    this.scan += text
    const active = this.active
    if (active === undefined) {
      // Output that arrived with no in-flight command is retained so nothing is lost.
      this.#append(text)
      this.scan = ''
      return
    }
    const marker = this.#findSentinel(active.token)
    if (marker === undefined) {
      // Hold back a possible partial sentinel prefix so it never reaches the model.
      if (this.scan.length > SENTINEL_HOLDBACK) {
        const safe = this.scan.slice(0, this.scan.length - SENTINEL_HOLDBACK)
        this.scan = this.scan.slice(this.scan.length - SENTINEL_HOLDBACK)
        if (!active.silent) this.#append(safe)
        active.output += safe
      }
      return
    }
    const output = this.scan.slice(0, marker.index)
    this.scan = ''
    if (!active.silent) this.#append(output)
    active.output += output
    this.active = undefined
    this.busy = false
    if (marker.cwd !== undefined) this.cwd = marker.cwd
    active.settle({ exitCode: marker.exitCode, cwd: marker.cwd, output: active.output })
  }

  #sentinelPrefix(token) {
    return `<<DSH:${token}:`
  }

  #findSentinel(token) {
    const prefix = this.#sentinelPrefix(token)
    const index = this.scan.indexOf(prefix)
    if (index < 0) return undefined
    const end = this.scan.indexOf('>>', index + prefix.length)
    if (end < 0) return undefined
    const payload = this.scan.slice(index + prefix.length, end)
    const firstColon = payload.indexOf(':')
    const exitCode = Number(firstColon < 0 ? payload : payload.slice(0, firstColon))
    const cwd = firstColon < 0 ? undefined : payload.slice(firstColon + 1)
    return {
      index,
      exitCode: Number.isFinite(exitCode) ? exitCode : undefined,
      cwd: cwd === undefined || cwd === '' ? undefined : cwd,
    }
  }

  #append(text) {
    if (text === '') return
    let start = 0
    for (let index = text.indexOf('\n'); index >= 0; index = text.indexOf('\n', start)) {
      this.partial += text.slice(start, index)
      this.lines.push(this.partial)
      this.partial = ''
      start = index + 1
    }
    this.partial += text.slice(start)
    if (this.lines.length > this.maxLines) {
      const drop = this.lines.length - this.maxLines
      this.lines.splice(0, drop)
      this.firstSeq += drop
    }
  }

  #failActive(error) {
    const active = this.active
    if (active === undefined) return
    this.active = undefined
    this.busy = false
    active.settle(undefined, error)
  }

  #nextScript(command) {
    this.commands += 1
    const path = join(this.dir, `command-${this.commands}.sh`)
    writeFileSync(path, command.replace(/\r\n/g, '\n'), 'utf8')
    return path
  }

  async run(command, options = {}) {
    if (this.closed) throw new BashSessionError('SESSION_CLOSED', `session ${this.name} is closed`)
    if (this.status !== 'running') {
      throw new BashSessionError('SESSION_NOT_RUNNING', this.startupError ?? `session ${this.name} is ${this.status}`)
    }
    if (this.busy) {
      throw new BashSessionError('SESSION_BUSY', `session ${this.name} is still running a command; use shared_bash_read, shared_bash_interrupt or wait`, { session: this.name })
    }

    const token = randomBytes(6).toString('hex')
    const script = this.#nextScript(String(command))
    const timeoutMs = options.timeoutMs ?? this.commandTimeoutMs
    const quoted = script.replace(/'/g, `'\\''`)

    return await new Promise((resolvePromise, rejectPromise) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        // The command keeps running: `active` stays installed so its sentinel
        // still clears `busy`, and a later shared_bash_read shows the rest.
        resolvePromise({
          output: stripTrailingNewlines(this.active?.output ?? ''),
          exitCode: null,
          timedOut: true,
          stillRunning: true,
          cwd: this.cwd,
        })
      }, Math.max(1, timeoutMs))

      this.active = {
        token,
        silent: options.silent === true,
        output: '',
        settle: (result, error) => {
          this.busy = false
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (error !== undefined) {
            rejectPromise(error)
            return
          }
          resolvePromise({
            output: stripTrailingNewlines(result?.output ?? ''),
            exitCode: result?.exitCode ?? null,
            timedOut: false,
            stillRunning: false,
            cwd: this.cwd,
          })
        },
      }
      this.busy = true
      this.lastActivityAt = new Date().toISOString()
      this.child.stdin.write(`. '${quoted}' </dev/null; __dsh_ec=$?; printf '<<DSH:${token}:%s:%s>>\n' "$__dsh_ec" "$PWD"\n`)
    })
  }

  read(options = {}) {
    const total = this.firstSeq + this.lines.length
    const limit = Math.max(1, Math.min(2000, Number(options.lines ?? 200)))
    const offset = Math.max(0, Number(options.offset ?? 0))
    const end = Math.max(0, total - offset)
    const start = Math.max(this.firstSeq, end - limit)
    const body = this.lines.slice(start - this.firstSeq, end - this.firstSeq)
    const text = body.join('\n') + (end === total && this.partial !== '' ? (body.length > 0 ? '\n' : '') + this.partial : '')
    return {
      text,
      start,
      end,
      total,
      hasMore: start > this.firstSeq,
      partial: end === total && this.partial !== '',
      status: this.status,
      busy: this.busy,
      cwd: this.cwd,
    }
  }

  async interrupt() {
    if (this.active === undefined) return { killed: [], interrupted: false }
    const killed = []
    for (const pid of this.#descendantPids()) {
      if (signalProcess(this.killPath, pid, '-TERM') || signalProcess(this.killPath, pid, '-KILL')) killed.push(pid)
    }
    return { killed, interrupted: killed.length > 0 }
  }

  // Cygwin/MSYS2 reports the session shell with PPID 1, so the Windows process
  // tree does not describe the job. The Cygwin process table does, and its own
  // kill reaches every child the shell started.
  #descendantPids() {
    if (this.cygwinPid === undefined) return []
    const result = spawnSync(this.psPath, ['-ef'], { encoding: 'utf8', windowsHide: true })
    if (result.status !== 0 || typeof result.stdout !== 'string') return []
    const table = result.stdout
      .split(/\r?\n/)
      .slice(1)
      .map((line) => line.trim().split(/\s+/))
      .filter((fields) => fields.length >= 4 && /^\d+$/.test(fields[1] ?? '') && /^\d+$/.test(fields[2] ?? ''))
      .map((fields) => ({ pid: Number(fields[1]), ppid: Number(fields[2]) }))
    const pids = []
    let frontier = [this.cygwinPid]
    for (let depth = 0; depth < 8 && frontier.length > 0; depth += 1) {
      const next = table.filter((row) => frontier.includes(row.ppid))
      pids.push(...next.map((row) => row.pid))
      frontier = next.map((row) => row.pid)
    }
    return [...new Set(pids)]
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.status = 'closed'
    if (this.pid !== undefined) {
      spawnSync('taskkill', ['/PID', String(this.pid), '/T', '/F'], { windowsHide: true })
    }
    this.#failActive(new BashSessionError('SESSION_CLOSED', `session ${this.name} closed`))
    try {
      rmSync(this.dir, { recursive: true, force: true, maxRetries: 3 })
    } catch {
      // A leftover temp directory is harmless; the process is already gone.
    }
  }

  summary() {
    return {
      session: this.name,
      status: this.status,
      pid: this.pid,
      cwd: this.cwd,
      msystem: this.msystem,
      busy: this.busy,
      lines: this.firstSeq + this.lines.length,
      commands: this.commands,
      createdAt: this.createdAt,
      lastActivityAt: this.lastActivityAt,
      exitCode: this.exitCode,
    }
  }
}

// MSYS2 ships `ps` and `kill` next to bash; a `bash` resolved through PATH
// falls back to the same names on PATH (Linux, macOS, WSL).
function companionTool(bashPath, tool) {
  if (bashPath === undefined || bashPath === 'bash') return tool
  const dir = dirname(bashPath)
  const candidate = join(dir, process.platform === 'win32' ? `${tool}.exe` : tool)
  return existsSync(candidate) ? candidate : tool
}

// Models often pass POSIX-style paths. Translate the forms an MSYS2 (or Cygwin)
// installation owns into Windows paths a spawn can use, and leave the rest alone.
function hostPath(input, bashPath) {
  if (process.platform !== 'win32' || !input.startsWith('/')) return input
  const prefix = String(bashPath).toLowerCase()
  const marker = prefix.indexOf('\\usr\\')
  if (marker < 0) return input
  const root = String(bashPath).slice(0, marker)
  const drive = input.match(/^\/([A-Za-z])(\/|$)/)
  if (drive !== null) return `${drive[1].toUpperCase()}:\\${input.slice(3).replace(/\//g, '\\')}`
  if (input === '/') return root
  for (const top of ['tmp', 'home', 'etc', 'opt']) {
    if (input === `/${top}` || input.startsWith(`/${top}/`)) return join(root, input.slice(1).replace(/\//g, '\\'))
  }
  return join(root, input.slice(1).replace(/\//g, '\\'))
}

// The inverse direction: a Windows path in the form a Cygwin/MSYS2 shell's `cd`
// accepts, for the one place that has to speak to the shell rather than to spawn.
function toPosixPath(value) {
  if (process.platform !== 'win32') return String(value)
  const text = String(value).replace(/\\/g, '/')
  const drive = text.match(/^([A-Za-z]):(\/|$)/)
  if (drive === null) return text
  const rest = text.slice(3)
  return `/${drive[1].toLowerCase()}${rest === '' ? '' : `/${rest}`}`
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function signalProcess(killPath, pid, signal) {  try {
    return spawnSync(killPath, [signal, String(pid)], { encoding: 'utf8', windowsHide: true }).status === 0
  } catch {
    return false
  }
}

export class SharedBashManager {
  constructor(options = {}) {
    this.rootDir = options.rootDir ?? join(tmpdir(), `dsh-shared-bash-${process.pid}`)
    this.bashPath = options.bashPath ?? defaultBashPath()
    this.msystem = options.msystem ?? 'MSYS'
    this.login = options.login !== false
    this.commandTimeoutMs = options.commandTimeoutMs ?? 120_000
    this.maxLines = options.maxLines ?? MAX_RING_LINES
    this.maxSessions = options.maxSessions ?? 16
    this.defaultCwd = options.cwd ?? process.cwd()
    this.env = options.env ?? {}
    this.sessions = new Map()
    mkdirSync(this.rootDir, { recursive: true })
    try {
      chmodSync(this.rootDir, 0o700)
    } catch {
      // Permissions are advisory on Windows filesystems.
    }
  }

  list() {
    return [...this.sessions.values()].map((session) => session.summary())
  }

  get(name) {
    return this.sessions.get(name)
  }

  resolveName(requested) {
    if (requested !== undefined) return normalizeName(requested)
    if (!this.sessions.has('main')) return 'main'
    for (let index = 2; index < 1000; index += 1) {
      if (!this.sessions.has(`main-${index}`)) return `main-${index}`
    }
    throw new BashSessionError('TOO_MANY_SESSIONS', 'no free default session name')
  }

  async open(options = {}) {
    const name = this.resolveName(options.session)
    const bashPath = options.bashPath ?? this.bashPath
    const existing = this.sessions.get(name)
    if (existing !== undefined && existing.status === 'running' && !options.recreate) {
      const cwd = options.cwd === undefined ? undefined : this.#posixCwd(options.cwd, bashPath)
      if (cwd !== undefined) await this.#enter(existing, cwd)
      return { session: existing, reused: true, probe: undefined }
    }
    if (existing !== undefined) {
      existing.close()
      this.sessions.delete(name)
    }
    if (this.sessions.size >= this.maxSessions) {
      throw new BashSessionError('TOO_MANY_SESSIONS', `session limit ${this.maxSessions} reached; close one with shared_bash_close`)
    }
    const cwd = options.cwd === undefined ? this.defaultCwd : resolve(this.defaultCwd, hostPath(options.cwd, bashPath))
    if (!existsSync(cwd)) {
      throw new BashSessionError('CWD_NOT_FOUND', `working directory ${JSON.stringify(cwd)} does not exist on this machine`, { cwd })
    }
    const session = new BashSession({
      name,
      bashPath,
      msystem: options.msystem ?? this.msystem,
      login: options.login ?? this.login,
      cwd,
      env: { ...this.env, ...(options.env ?? {}) },
      rootDir: this.rootDir,
      maxLines: this.maxLines,
      commandTimeoutMs: this.commandTimeoutMs,
    })
    this.sessions.set(name, session)
    session.start()
    try {
      // A real round trip proves bash started, the working directory exists and
      // the sentinel protocol works, instead of failing on the first user command.
      const probe = await session.run(':', { timeoutMs: 15_000, silent: true })
      const identity = await session.run("printf '__DSH_PID__:%s\\n' \"$$\"", { timeoutMs: 15_000, silent: true })
      const pid = Number(identity.output.match(/__DSH_PID__:(\d+)/)?.[1])
      session.cygwinPid = Number.isInteger(pid) && pid > 0 ? pid : undefined
      // A login shell runs its profile scripts, and MSYS2's end in $HOME: the
      // spawn cwd alone does not survive, so an explicit cwd is entered here.
      if (options.cwd !== undefined) await this.#enter(session, this.#posixCwd(options.cwd, bashPath))
      return { session, reused: false, probe }
    } catch (error) {
      this.close(name)
      throw error
    }
  }

  /** Translate one requested working directory into the POSIX form bash's `cd` reads. */
  #posixCwd(input, bashPath) {
    const host = resolve(this.defaultCwd, hostPath(input, bashPath))
    return String(input).startsWith('/') ? String(input) : toPosixPath(host)
  }

  /** Enter a directory inside an existing session; a failure is a caller error, not a silent no-op. */
  async #enter(session, cwd) {
    const result = await session.run(`cd ${shellQuote(cwd)}`, { timeoutMs: 15_000, silent: true })
    if (result.exitCode !== 0) {
      throw new BashSessionError('CWD_NOT_FOUND', `cannot enter working directory ${JSON.stringify(cwd)}: ${result.output.trim()}`, { cwd })
    }
  }

  require(name) {
    const session = this.sessions.get(name)
    if (session === undefined) {
      throw new BashSessionError('NO_SESSION', `no session named ${JSON.stringify(name)}; open one with shared_bash_open`, { session: name })
    }
    return session
  }

  close(name) {
    const session = this.sessions.get(name)
    if (session === undefined) return false
    session.close()
    this.sessions.delete(name)
    return true
  }

  dispose() {
    for (const session of this.sessions.values()) session.close()
    this.sessions.clear()
    try {
      rmSync(this.rootDir, { recursive: true, force: true, maxRetries: 3 })
    } catch {
      // Best effort: the sessions' own directories were already removed.
    }
  }
}

export { DEFAULT_MSYS2_BASH }
