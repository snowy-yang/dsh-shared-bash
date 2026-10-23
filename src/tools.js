/**
 * Model-facing tools over the session-keyed PTY registry.
 *
 * Every tool names a terminal by DSH session id. Omitting it means "my own
 * session", and passing one means "that session's terminal" — which is how one
 * agent reaches a shell another agent left running.
 *
 * Schemas follow the harness authoring style: `parameters` is a flat property map
 * with `required: true` inline, and `output.schema` marks required fields the same
 * way (see `assertSupportedJsonSchema` in @deepseek-ai/dsh-tools).
 */

import { BashSessionError } from './pty.js'

const RESULT_BYTE_CAP = 128 * 1024

const SESSION_PROPERTY = {
  type: 'string',
  description: 'DSH session id that owns the terminal (for example "0f6c1f5e-…"). Defaults to the calling agent\'s own session; pass another id to attach to that session\'s shell.',
}

function clip(value) {
  const text = typeof value === 'string' ? value : ''
  if (Buffer.byteLength(text) <= RESULT_BYTE_CAP) return text
  let clipped = text
  while (Buffer.byteLength(clipped) > RESULT_BYTE_CAP) clipped = clipped.slice(0, Math.floor(clipped.length * 0.9))
  return `${clipped}\n… (output truncated)`
}

function callerSessionId(exec) {
  const id = exec?.agent?.session?.id
  if (typeof id !== 'string' || id === '') {
    throw new BashSessionError('NO_SESSION_CONTEXT', 'this tool needs a calling agent session; pass session_id explicitly')
  }
  return id
}

function target(exec, args) {
  return args.session_id === undefined || args.session_id === '' ? callerSessionId(exec) : args.session_id
}

/** Shared output property shapes; required fields carry `required: true` inline. */
const out = {
  string: { type: 'string', required: true },
  integer: { type: 'integer', required: true },
  boolean: { type: 'boolean', required: true },
  optionalString: { type: 'string' },
  optionalInteger: { type: 'integer' },
}

/**
 * Build the tool definitions registered on `ctx.tools`.
 * @param {object} manager - SharedBashManager.
 * @returns {object[]} wire-level tool definitions.
 */
export function buildTools(manager) {
  const tools = [
    {
      name: 'bash_attach',
      description:
        'Attach to the persistent PTY bash terminal of a DSH session, opening one if that session has none yet. The terminal keeps its working directory, variables, functions and foreground job between calls. Omitting session_id attaches to your own session; passing an id attaches to that session\'s terminal, so one agent can pick up a shell another agent started. Requires a composed subprocess provider (the desktop composition has one). Windows default shell is MSYS2 bash (C:\\msys64\\usr\\bin\\bash.exe).',
      parameters: {
        session_id: SESSION_PROPERTY,
        cwd: { type: 'string', description: 'Initial working directory for a new terminal. POSIX paths such as /tmp are translated for the MSYS2 installation. Ignored when the terminal already exists.' },
        recreate: { type: 'boolean', description: 'Replace an existing terminal for that session instead of reusing it.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            session_id: out.string,
            status: out.string,
            pid: out.integer,
            cwd: out.string,
            reused: out.boolean,
            startup: out.string,
          },
        },
      },
      async execute(args, exec) {
        const id = target(exec, args)
        const attached = await manager.attach(id, { cwd: args.cwd, recreate: args.recreate === true })
        const summary = attached.session.summary()
        return {
          session_id: summary.session_id,
          status: summary.status,
          pid: summary.pid ?? 0,
          cwd: summary.cwd ?? '',
          reused: attached.reused,
          startup: summary.startupError === undefined ? '' : clip(summary.startupError),
        }
      },
    },
    {
      name: 'bash_exec',
      description:
        'Run one command in a session\'s PTY terminal and return a background job id immediately. The command may be multi-line (heredocs and loops work) and its stdin is /dev/null. Collect the result with bash_wait, watch it with bash_read, stop it with bash_interrupt. Only one command runs per terminal at a time. Omit session_id to use your own session\'s terminal, opened on demand.',
      parameters: {
        command: { type: 'string', required: true, description: 'Shell text to run in the terminal.' },
        session_id: SESSION_PROPERTY,
        wait_ms: { type: 'integer', description: 'Return the finished result when the command completes within this many milliseconds; otherwise return the running job id. Defaults to 0, which is always asynchronous.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            job_id: out.string,
            session_id: out.string,
            status: out.string,
            output: out.string,
            exit_code: out.optionalInteger,
            cwd: out.optionalString,
          },
        },
      },
      async execute(args, exec) {
        const id = target(exec, args)
        if (typeof args.command !== 'string' || args.command.trim() === '') {
          throw new BashSessionError('INVALID_COMMAND', 'command must be a non-empty string')
        }
        const job = await manager.exec(id, args.command, { waitMs: args.wait_ms })
        return {
          job_id: job.id,
          session_id: id,
          status: job.status,
          exit_code: job.exitCode ?? 0,
          output: clip(job.output ?? ''),
          cwd: job.cwd ?? '',
        }
      },
    },
    {
      name: 'bash_wait',
      description:
        'Wait for a command started by bash_exec to finish, then return its exit code and output. `timed_out` is true when the wait limit passed first — the command keeps running in the terminal, so call bash_wait again or read the terminal with bash_read.',
      parameters: {
        job_id: { type: 'string', required: true, description: 'Job id returned by bash_exec.' },
        timeout_ms: { type: 'integer', description: 'Maximum time to wait, in milliseconds. Defaults to 600000 (10 minutes).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            job_id: out.string,
            session_id: out.string,
            status: out.string,
            output: out.string,
            exit_code: out.optionalInteger,
            cwd: out.optionalString,
            error: out.optionalString,
            timed_out: out.boolean,
          },
        },
      },
      async execute(args) {
        const result = await manager.wait(args.job_id, args.timeout_ms ?? 600_000)
        return {
          job_id: result.id,
          session_id: result.session_id,
          status: result.status,
          exit_code: result.exit_code ?? 0,
          output: clip(result.output ?? ''),
          cwd: result.cwd ?? '',
          error: result.error ?? '',
          timed_out: result.timed_out === true,
        }
      },
    },
    {
      name: 'bash_read',
      description:
        'Read retained output from a session\'s PTY terminal without sending input. Use it to watch a running command, collect what happened before a wait timed out, or look at recent scrollback. `offset` counts lines back from the newest line.',
      parameters: {
        session_id: SESSION_PROPERTY,
        lines: { type: 'integer', description: 'Maximum lines to return, 1-2000. Defaults to 200.' },
        offset: { type: 'integer', description: 'Lines to skip back from the newest line. Defaults to 0.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            session_id: out.string,
            text: out.string,
            start: out.integer,
            end: out.integer,
            total: out.integer,
            hasMore: out.boolean,
            busy: out.boolean,
            cwd: out.string,
          },
        },
      },
      execute(args, exec) {
        const id = target(exec, args)
        const page = manager.read(id, { lines: args.lines, offset: args.offset })
        return {
          session_id: id,
          text: clip(page.text),
          start: page.start,
          end: page.end,
          total: page.total,
          hasMore: page.hasMore,
          busy: page.busy,
          cwd: page.cwd ?? '',
        }
      },
    },
    {
      name: 'bash_interrupt',
      description:
        'Send a real SIGINT to the foreground process group of a terminal, the way Ctrl-C would. The terminal survives and keeps its state; the running command settles as interrupted.',
      parameters: { session_id: SESSION_PROPERTY },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            session_id: out.string,
            interrupted: out.boolean,
          },
        },
      },
      async execute(args, exec) {
        const id = target(exec, args)
        const result = await manager.interrupt(id)
        return { session_id: id, interrupted: result.interrupted === true }
      },
    },
    {
      name: 'bash_close',
      description:
        'Close one session\'s terminal, or every terminal in the profile. Closing terminates the shell and its process tree; scrollback and shell state are lost.',
      parameters: {
        session_id: SESSION_PROPERTY,
        all: { type: 'boolean', description: 'Close every terminal instead of one.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            closed: { type: 'array', required: true, items: { type: 'string' } },
          },
        },
      },
      async execute(args, exec) {
        if (args.all === true) {
          const closed = manager.list().map(entry => entry.session_id)
          for (const id of closed) await manager.close(id)
          return { closed }
        }
        const id = target(exec, args)
        const closed = await manager.close(id)
        return { closed: closed ? [id] : [] }
      },
    },
    {
      name: 'bash_list',
      description:
        'List every PTY terminal in this profile with its DSH session id, status, working directory and whether a command is running. Terminals outlive tool calls and are reachable by id, so this is how you discover one to attach to.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            sessions: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  session_id: out.string,
                  status: out.string,
                  pid: out.integer,
                  cwd: out.string,
                  busy: out.boolean,
                  commands: out.integer,
                  lastActivityAt: out.string,
                },
              },
            },
          },
        },
      },
      execute() {
        return {
          sessions: manager.list().map(entry => ({
            session_id: entry.session_id,
            status: entry.status,
            pid: entry.pid ?? 0,
            cwd: entry.cwd ?? '',
            busy: entry.busy,
            commands: entry.commands,
            lastActivityAt: entry.lastActivityAt,
          })),
        }
      },
    },
  ]

  for (const tool of tools) tool.output.render = (args, value) => [{ type: 'text', text: renderValue(tool.name, value) }]
  return tools
}

/** One readable line (or block) per tool result; the model sees this, not JSON. */
function renderValue(name, value) {
  switch (name) {
    case 'bash_attach':
      return `${value.session_id} · ${value.status} · pid ${value.pid} · ${value.cwd}${value.reused ? ' (reused)' : ''}${value.startup === '' ? '' : `\n${value.startup}`}`
    case 'bash_exec':
      return `job ${value.job_id} · ${value.status}${value.exit_code === 0 || value.exit_code === undefined ? '' : ` · exit ${value.exit_code}`}${value.output === '' ? '' : `\n${value.output}`}`
    case 'bash_wait': {
      const head = `job ${value.job_id} · ${value.status}${value.timed_out ? ' (still running)' : ''}${value.error === '' || value.error === undefined ? '' : ` · ${value.error}`}`
      return value.output === '' ? head : `${head}\n${value.output}`
    }
    case 'bash_read':
      return value.text === '' ? `(no output) · ${value.end}/${value.total} lines · ${value.cwd}` : value.text
    case 'bash_interrupt':
      return value.interrupted ? `${value.session_id}: SIGINT sent` : `${value.session_id}: nothing is running`
    case 'bash_close':
      return value.closed.length === 0 ? 'nothing to close' : `closed ${value.closed.join(', ')}`
    case 'bash_list':
      return value.sessions.length === 0
        ? 'no terminals'
        : value.sessions.map(entry => `${entry.session_id} · ${entry.status}${entry.busy ? ' · busy' : ''} · ${entry.cwd}`).join('\n')
    default:
      return JSON.stringify(value, null, 2)
  }
}
