/**
 * Test double for `ctx.subprocess.spawnTerminal`.
 *
 * A real PTY is only available inside the harness, so the tests substitute a
 * long-lived `bash -s` process behind pipes. The plugin never depends on PTY
 * specifics for framing: it writes a script-file payload and waits for a sentinel
 * line, and that protocol behaves identically on a pipe. Echo filtering is the
 * one PTY-only behavior, and it is covered by the sanitizer unit tests.
 */

import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'

export function createFakeTerminalProvider(options = {}) {
  const terminals = []
  return {
    terminals,
    async spawnTerminal(spec) {
      const child = spawn(spec.argv[0], ['-l', '-s'], {
        cwd: spec.cwd,
        env: { ...process.env, ...spec.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
      const output = new EventEmitter()
      child.stdout.on('data', chunk => output.emit('data', chunk))
      child.stderr.on('data', chunk => output.emit('data', chunk))
      const done = new Promise(resolve => {
        child.on('exit', code => {
          output.emit('end')
          resolve({ exitCode: code ?? 0 })
        })
      })
      const terminal = {
        pid: child.pid,
        output,
        done,
        writes: [],
        async write(data) {
          terminal.writes.push(data)
          child.stdin.write(data)
        },
        async signalForeground(signal) {
          terminal.signals.push(signal)
          if (options.onSignal !== undefined) options.onSignal(child, signal)
        },
        signals: [],
        async terminate() {
          child.stdin.end()
          child.kill()
          await done
        },
      }
      terminals.push(terminal)
      return terminal
    },
  }
}
