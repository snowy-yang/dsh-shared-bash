---
description: "Per-session persistent PTY bash terminals for DeepSeek Harness, with asynchronous command jobs."
kind: "plugin-bundle"
---

# dsh-shared-bash

Session-keyed, persistent **PTY** bash terminals for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), with an **asynchronous job model** for commands.

Every DSH session gets one long-lived shell. The shell is addressed by that session's id, so you can attach to the terminal an earlier session left behind — with its working directory, variables, functions and running process intact — instead of starting from scratch. A command handed to it returns a **job handle** immediately; the result is collected later with a wait, or read while it is still running.

## Requirements

- DeepSeek Harness `^0.2.1-rc.2`
- A composed subprocess provider with PTY support. The desktop composition mounts `@deepseek-ai/dsh-subprocess-local` + `dsh-experimental-terminal-bundle`; on Windows the default shell is MSYS2 bash at `C:\msys64\usr\bin\bash.exe`.

## Install

```bash
dsh plugin --profile desktop add git+https://github.com/snowy-yang/dsh-shared-bash.git
```

Quit the app before running that: pnpm rewrites the profile's `node_modules` and fails with `ERR_PNPM_EPERM` while the Host holds the files.

## Tools

| Tool | What it does |
| --- | --- |
| `bash_attach` | Attach to a session's terminal, opening one if that session has none. Optional `cwd`; `recreate` replaces an existing shell. |
| `bash_exec` | Run one command, return a job id immediately. Optional `wait_ms` returns the finished result when it is faster. |
| `bash_wait` | Wait for a job, returning exit code, output and `timed_out`. |
| `bash_read` | Read retained output of a terminal without sending input. |
| `bash_interrupt` | Send SIGINT to the foreground process group — a real Ctrl-C; the shell survives. |
| `bash_close` | Close one terminal or all of them. |
| `bash_list` | List terminals with session id, status, cwd and whether a command is running. |

Every tool takes an optional `session_id`. Omitted, it means "the calling agent's own session"; passed, it means "that session's terminal", which is the explicit cross-agent sharing this plugin offers:

```text
bash_list              → 3f2a… · busy · C:\proj\widgets
bash_read   {session_id: "3f2a…"}
bash_exec   {session_id: "3f2a…", command: "git status --short"}
bash_wait   {job_id: "bash-9c1e…"}
```

## Terminal model

- One PTY per DSH session id; the registry is profile-wide, the shell is not shared behind your back.
- `bash -l -i`: an interactive login shell, so MSYS2's `PATH` and the user's profile apply. A requested `cwd` is `cd`-ed inside the shell, and POSIX paths such as `/tmp` are translated to the MSYS2 installation (`C:\msys64\tmp`).
- The shell keeps working directory, exported and shell variables, functions, aliases and any process you background between calls.
- Commands are written to a script file and sourced with stdin from `/dev/null`, so heredocs, loops, pipes and quoting behave exactly as in a script, and a command that tries to read stdin gets EOF instead of stealing the terminal's input.
- Completion is detected with a sentinel printed by the shell after the command, carrying a token that lives only in the environment — terminal echo of the command line cannot fake it.
- Output is retained in a 4000-line ring per terminal, with ANSI escape sequences stripped.

## Asynchronous commands

`bash_exec` never blocks on the command: it returns `{job_id, session_id, status}`. Three ways to continue:

```text
bash_exec  {command: "npm run build"}        → job bash-9c1e…, status running
bash_wait  {job_id: "bash-9c1e…"}            → blocks until done, returns exit_code + output
bash_read  {}                                → what the terminal has printed so far
bash_interrupt {}                            → SIGINT, job settles as interrupted
```

Only one command runs per terminal at a time; a second `bash_exec` on a busy terminal is refused with `SESSION_BUSY`. `bash_wait` with a short `timeout_ms` returns `timed_out: true` and leaves the command running, so it can be polled.

## Settings page

**Settings → Bash terminals** lists every terminal by session id, shows retained output, sends commands (as jobs), interrupts them, attaches a new session id and closes terminals.

It is served by the plugin's own JSON API under `/api/shared-bash`: `GET /sessions`, `GET /output?session_id=…`, `GET /wait?job_id=…`, `POST /attach|/exec|/interrupt|/close`. The harness web server has no request policy of its own, so this route fences itself: the composition's `connection` service when present, otherwise loopback-only `Host` plus matching `Origin`/`Referer` (with the `dsh-app://app` relay allowed only on its own).

## Configuration

`cordis.patch.yml` defaults, all optional:

| Key | Default | Meaning |
| --- | --- | --- |
| `bashPath` | `C:\msys64\usr\bin\bash.exe` | Shell executable |
| `msystem` | `MSYS` | `MSYSTEM` value for the shell |
| `login` | `true` | `bash -l -i` instead of `--noprofile --norc -i` |
| `cwd` | Host process cwd | Startup directory when a terminal gets none |
| `maxLines` | `4000` | Retained output lines per terminal |
| `maxSessions` | `16` | Concurrent terminals per profile |
| `cols` / `rows` | `120` / `30` | Reported PTY geometry |

## Limits

- One command per terminal at a time; parallel work needs parallel sessions.
- The web page is a settings surface, not a full emulator: it shows stripped text output, not a live screen.
- Terminals are process-local: they end with the Host, and they are not a sandbox — a shell runs with the Host's own permissions.

## Development

```bash
node --test test/
```

Tests substitute a piped `bash -s` for the PTY through the same `spawnTerminal` contract the harness provides, so framing, jobs, the registry and the HTTP API are exercised without the app. `DSH_TOOLS_MODULE` additionally validates the tool schemas against the harness's own `assertSupportedJsonSchema`.

MIT licensed.
