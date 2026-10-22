---
description: "tmux-like persistent bash sessions shared by every agent in a DeepSeek Harness profile."
kind: "plugin-bundle"
---

# dsh-shared-bash

English | [中文](README.zh.md)

## Summary

`dsh-shared-bash` gives a DeepSeek Harness profile a pool of long-lived bash sessions that **every agent in the profile shares**. One agent can `cd` into a build tree, export a variable, start a server, and another agent — a teammate, a subagent, or a later session — can read its output and keep going in the same shell. That is the gap the built-in `terminal_*` tools leave open: those sessions are owner-isolated, so one agent cannot hand a live shell to another.

It mounts one Host row and registers six tools. The default shell on Windows is MSYS2 bash (`C:\msys64\usr\bin\bash.exe`) with the login environment loaded, so `pacman`, `gcc`, `sed`, `find` and autotools behave as they do in a normal MSYS2 terminal.

## Install

```bash
# from a registry
dsh plugin --profile desktop add dsh-shared-bash

# from this repository
dsh plugin --profile desktop add git+https://github.com/snowy-yang/dsh-shared-bash.git
```

Or add the bundle by hand to `~/.dsh/profiles/<profile>/package.json`:

```json
{
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "dsh-shared-bash"] } },
  "dependencies": { "dsh-shared-bash": "^0.1.0" }
}
```

Then run `pnpm install` in the profile directory and restart the app (a profile without HMR loads bundles at startup).

## Tools

| Tool | Purpose |
|---|---|
| `shared_bash_open` | Open or reuse a named session (`main` by default); optional `cwd`, `msystem`, `bash_path`, `recreate` |
| `shared_bash_send` | Run a command, return output and exit code; `timeout_ms` bounds the wait, and a command that outlives it keeps running |
| `shared_bash_read` | Page through retained output without sending input (`lines`, `offset`) |
| `shared_bash_list` | List every session in the profile with status, cwd, busy flag and activity |
| `shared_bash_interrupt` | Stop the running command, keep the shell and its state |
| `shared_bash_close` | Close one session, or all of them |

Typical flow:

```text
shared_bash_open  { "session": "build", "cwd": "C:\\proj" }
shared_bash_send  { "session": "build", "command": "cmake -S . -B build && cmake --build build -j8" }
shared_bash_send  { "session": "build", "command": "./build/tests/unit" }
shared_bash_read  { "session": "build", "lines": 200 }
shared_bash_interrupt { "session": "build" }
```

## How it works

Each session is one `bash -l -s` process with pipes. A command is written to a temporary file inside the session directory and executed as `. file </dev/null`, then the shell prints a random completion sentinel carrying the exit status and the current `$PWD`. That gives three properties:

- **State persists** — `cd`, variables, exported environment and shell functions survive between calls.
- **Multi-line input works** — heredocs, loops and `&&` chains are ordinary file content, not paste into a terminal.
- **The sentinel cannot be eaten** — commands read `/dev/null` as stdin, so `read`, `cat` without arguments or a stray `select` cannot consume the completion marker.

`shared_bash_interrupt` uses the Cygwin/MSYS2 process table (`ps -ef`) and its own `kill`, because MSYS2 reports the session shell with `PPID 1` and Windows' process tree does not describe the job. The shell survives, the job does not.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `bashPath` | MSYS2 bash when installed, else `bash` from `PATH` | bash executable |
| `msystem` | `MSYS` | `MSYS`, `UCRT64`, `MINGW64` or `CLANG64` |
| `login` | `true` | Source the login environment (`-l`); off means `--noprofile --norc` and a bare `PATH` |
| `cwd` | Host working directory | Default directory for new sessions |
| `commandTimeoutMs` | `120000` | Default foreground wait for one command |
| `maxLines` | `4000` | Retained output lines per session |
| `maxSessions` | `16` | Concurrent sessions per profile |
| `env` | `{}` | Extra environment variables for the shell |

Per-session `cwd` accepts POSIX-style paths that the MSYS2 installation owns (`/tmp`, `/home/...`, `/c/Users/...`) and translates them for the Host.

## Limits

- **No TTY.** Pipes mean no colors, no cursor addressing, no `vim`, `top` or `less`, and no Ctrl-C byte. Interactive programs are unsupported by design; use `shared_bash_interrupt` to stop a job.
- **One command at a time per session.** A second `shared_bash_send` while a command runs is refused instead of queued, so output attribution stays unambiguous.
- **Commands are trusted.** They run in the Harness Host process with the user's permissions, outside the agent sandbox, exactly like the built-in terminal tools.
- **Not a sandbox boundary.** Any agent that can call these tools can read and drive every session, so treat a shared session as shared state, not as isolation.

## Development

```bash
node --test test/
```

The session tests start real bash processes; set `DSH_SHARED_BASH` to test another executable. `DSH_TOOLS_MODULE` adds the harness JSON Schema check.

## License

MIT
