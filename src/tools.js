// Model-facing tools over the shared session manager.
//
// Every definition here is a plain wire-level tool: `parameters` is the raw JSON
// Schema subset the registry validates, `output.render` turns the canonical value
// into model content. Keeping the definitions plain means the plugin needs no
// import from the harness packages at all.

const RESULT_BYTE_CAP = 128 * 1024

function clip(text) {
  if (typeof text !== 'string') return text
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes <= RESULT_BYTE_CAP) return text
  const buffer = Buffer.from(text, 'utf8')
  const head = buffer.subarray(0, RESULT_BYTE_CAP).toString('utf8')
  return `${head}\n… [truncated ${bytes - RESULT_BYTE_CAP} bytes]`
}

const SESSION_PROPERTY = {
  type: 'string',
  description: 'Session name (default "main"). Sessions are shared by every agent in this DSH profile.',
}

function text(value) {
  return [{ type: 'text', text: value }]
}

export function buildTools(manager) {
  return [
    {
      name: 'shared_bash_open',
      description:
        'Open or reuse a persistent bash session shared by every agent in this DSH profile. The session keeps its working directory, shell variables and functions between calls, like a tmux window. Use shared_bash_send to run commands in it. Windows default shell is MSYS2 bash (C:\\msys64\\usr\\bin\\bash.exe).',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          session: SESSION_PROPERTY,
          cwd: { type: 'string', description: 'Initial working directory. Relative paths resolve against the Host working directory. Defaults to the Host working directory.' },
          msystem: { type: 'string', enum: ['MSYS', 'UCRT64', 'MINGW64', 'CLANG64'], description: 'MSYS2 environment to source at startup. Defaults to the plugin config (MSYS).' },
          bash_path: { type: 'string', description: 'Override the bash executable. Defaults to the plugin config.' },
          recreate: { type: 'boolean', description: 'Replace an existing session of the same name instead of reusing it.' },
        },
        required: [],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            session: { type: 'string' },
            status: { type: 'string' },
            pid: { type: 'number' },
            cwd: { type: 'string' },
            bash: { type: 'string' },
            msystem: { type: 'string' },
            reused: { type: 'boolean' },
            startup: { type: 'string' },
          },
          required: ['session', 'status', 'cwd', 'bash', 'msystem', 'reused'],
        },
        render: (_args, value) =>
          text(
            `${value.reused ? 'Reused' : 'Opened'} session "${value.session}" (pid ${value.pid ?? '?'}, ${value.msystem} bash: ${value.bash})\n` +
              `cwd: ${value.cwd}\n` +
              `status: ${value.status}${value.startup ? `\n${value.startup}` : ''}`,
          ),
      },
      async execute(args) {
        const opened = await manager.open({
          session: args.session,
          cwd: args.cwd,
          msystem: args.msystem,
          bashPath: args.bash_path,
          recreate: args.recreate,
        })
        const summary = opened.session.summary()
        return {
          session: summary.session,
          status: summary.status,
          pid: summary.pid ?? 0,
          cwd: summary.cwd,
          bash: opened.session.bashPath,
          msystem: summary.msystem,
          reused: opened.reused,
          startup: opened.probe === undefined ? '' : clip(opened.probe.output),
        }
      },
    },
    {
      name: 'shared_bash_send',
      description:
        'Run a command in a shared persistent bash session and return its output and exit code. The session keeps `cd`, variables and functions from earlier calls. The command runs with stdin redirected from /dev/null, so interactive programs are unsupported; a command that outlives timeout_ms keeps running and shared_bash_read shows the rest. Any agent in this profile can attach to the same session, so prefer named sessions when more than one task is active.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          command: { type: 'string', description: 'Command text to run. Multiple lines and heredocs are supported; state changes persist in the session.' },
          session: SESSION_PROPERTY,
          timeout_ms: { type: 'integer', description: 'Foreground wait in milliseconds before the call returns with running=true. Defaults to the plugin config (120000).' },
        },
        required: ['command'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            session: { type: 'string' },
            exit_code: { type: 'number' },
            output: { type: 'string' },
            running: { type: 'boolean' },
            timed_out: { type: 'boolean' },
            cwd: { type: 'string' },
          },
          required: ['session', 'output', 'running', 'timed_out', 'cwd'],
        },
        render: (_args, value) => {
          const status = value.timed_out
            ? 'still running (not finished within the wait)'
            : value.exit_code === 0
              ? 'ok'
              : `exit code ${value.exit_code}`
          return text(`[${value.session}] ${status} · cwd ${value.cwd}\n${value.output === '' ? '(no output)' : value.output}`)
        },
      },
      async execute(args) {
        const name = args.session === undefined ? 'main' : args.session
        if (manager.get(name) === undefined) await manager.open({ session: name })
        const session = manager.require(name)
        const result = await session.run(args.command, { timeoutMs: args.timeout_ms })
        return {
          session: name,
          exit_code: result.exitCode ?? 0,
          output: clip(result.output),
          running: result.stillRunning,
          timed_out: result.timedOut,
          cwd: result.cwd ?? session.cwd,
        }
      },
    },
    {
      name: 'shared_bash_read',
      description:
        'Read retained output from a shared bash session without sending input. Use it to collect the rest of a command that returned running=true, or to look at recent history. `offset` counts lines back from the newest line.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          session: SESSION_PROPERTY,
          lines: { type: 'integer', description: 'Maximum lines to return, 1-2000. Defaults to 200.' },
          offset: { type: 'integer', description: 'Lines to skip back from the newest line. Defaults to 0.' },
        },
        required: [],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            session: { type: 'string' },
            text: { type: 'string' },
            start: { type: 'number' },
            end: { type: 'number' },
            total: { type: 'number' },
            has_more: { type: 'boolean' },
            partial: { type: 'boolean' },
            status: { type: 'string' },
            busy: { type: 'boolean' },
            cwd: { type: 'string' },
          },
          required: ['session', 'text', 'start', 'end', 'total', 'has_more', 'status', 'busy', 'cwd'],
        },
        render: (_args, value) =>
          text(
            `[${value.session}] lines ${value.start}-${value.end} of ${value.total} · ${value.status}${value.busy ? ' · busy' : ''} · cwd ${value.cwd}\n` +
              (value.text === '' ? '(no output retained)' : value.text),
          ),
      },
      async execute(args) {
        const name = args.session === undefined ? manager.resolveName() : args.session
        const session = manager.require(name)
        const page = session.read({ lines: args.lines, offset: args.offset })
        return {
          session: name,
          text: clip(page.text),
          start: page.start,
          end: page.end,
          total: page.total,
          has_more: page.hasMore,
          partial: page.partial,
          status: page.status,
          busy: page.busy,
          cwd: page.cwd,
        }
      },
    },
    {
      name: 'shared_bash_list',
      description: 'List the shared bash sessions in this DSH profile with their status, working directory and activity. Every agent sees the same list.',
      parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            sessions: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  session: { type: 'string' },
                  status: { type: 'string' },
                  pid: { type: 'number' },
                  cwd: { type: 'string' },
                  msystem: { type: 'string' },
                  busy: { type: 'boolean' },
                  lines: { type: 'number' },
                  commands: { type: 'number' },
                  createdAt: { type: 'string' },
                  lastActivityAt: { type: 'string' },
                },
                required: ['session', 'status', 'cwd', 'msystem', 'busy', 'lines', 'commands'],
              },
            },
          },
          required: ['sessions'],
        },
        render: (_args, value) =>
          text(
            value.sessions.length === 0
              ? 'No shared bash sessions are open.'
              : value.sessions
                  .map(
                    (entry) =>
                      `${entry.session} · ${entry.status}${entry.busy ? ' · busy' : ''} · pid ${entry.pid ?? '?'} · ${entry.msystem} · ${entry.commands} commands · cwd ${entry.cwd} · last activity ${entry.lastActivityAt}`,
                  )
                  .join('\n'),
          ),
      },
      async execute() {
        return { sessions: manager.list().map((entry) => ({ ...entry, pid: entry.pid ?? 0 })) }
      },
    },
    {
      name: 'shared_bash_interrupt',
      description:
        'Stop the command currently running in a shared bash session without closing the session. Child processes of the session shell are terminated, the shell keeps its state, and the session becomes idle again.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { session: SESSION_PROPERTY },
        required: [],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            session: { type: 'string' },
            interrupted: { type: 'boolean' },
            killed: { type: 'array', items: { type: 'number' } },
            status: { type: 'string' },
          },
          required: ['session', 'interrupted', 'killed', 'status'],
        },
        render: (_args, value) =>
          text(
            value.interrupted
              ? `Interrupted session "${value.session}": terminated ${value.killed.join(', ')}. Session status: ${value.status}.`
              : `Session "${value.session}" was not running a command (status ${value.status}).`,
          ),
      },
      async execute(args) {
        const name = args.session === undefined ? manager.resolveName() : args.session
        const session = manager.require(name)
        const outcome = await session.interrupt()
        return { session: name, interrupted: outcome.interrupted, killed: outcome.killed, status: session.status }
      },
    },
    {
      name: 'shared_bash_close',
      description: 'Close one shared bash session, or every session with all=true. Running commands in the closed sessions are terminated.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          session: SESSION_PROPERTY,
          all: { type: 'boolean', description: 'Close every session in this profile.' },
        },
        required: [],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            closed: { type: 'array', items: { type: 'string' } },
            remaining: { type: 'number' },
          },
          required: ['closed', 'remaining'],
        },
        render: (_args, value) =>
          text(value.closed.length === 0 ? 'No session was closed.' : `Closed: ${value.closed.join(', ')}. ${value.remaining} session(s) remain.`),
      },
      async execute(args) {
        const closed = []
        if (args.all === true) {
          for (const entry of manager.list()) {
            if (manager.close(entry.session)) closed.push(entry.session)
          }
        } else if (args.session !== undefined) {
          if (manager.close(args.session)) closed.push(args.session)
        } else {
          const name = manager.resolveName()
          if (manager.close(name)) closed.push(name)
        }
        return { closed, remaining: manager.list().length }
      },
    },
  ]
}
