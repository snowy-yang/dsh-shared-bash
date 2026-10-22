import { existsSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'

import { BashSessionError, SharedBashManager } from '../src/sessions.js'

const bashPath = process.env.DSH_SHARED_BASH ?? (existsSync('C:\\msys64\\usr\\bin\\bash.exe') ? 'C:\\msys64\\usr\\bin\\bash.exe' : 'bash')
const skip = !existsSync(bashPath) && bashPath !== 'bash' ? 'bash executable not found' : false

let manager

before(async () => {
  manager = new SharedBashManager({
    rootDir: mkdtempSync(join(tmpdir(), 'dsb-test-')),
    bashPath,
    commandTimeoutMs: 20_000,
    maxSessions: 32,
  })
})

after(() => {
  manager?.dispose()
})

const waitIdle = async (session, timeoutMs = 10_000) => {
  const start = Date.now()
  while (session.busy && Date.now() - start < timeoutMs) await new Promise((resolve) => setTimeout(resolve, 50))
  return !session.busy
}

test('opens a session and proves the shell answers', { skip }, async () => {
  const { session, reused, probe } = await manager.open({ session: 'probe' })
  assert.equal(reused, false)
  assert.equal(session.status, 'running')
  assert.ok(session.pid > 0)
  assert.equal(probe.exitCode, 0)
  assert.match(session.bashPath, /bash/i)
})

test('reuses an existing session of the same name', { skip }, async () => {
  const first = await manager.open({ session: 'reuse' })
  const second = await manager.open({ session: 'reuse' })
  assert.equal(second.reused, true)
  assert.equal(second.session.pid, first.session.pid)
})

test('returns output and exit codes', { skip }, async () => {
  const { session } = await manager.open({ session: 'exitcodes' })
  const ok = await session.run('echo hello-$((1 + 1))')
  assert.equal(ok.exitCode, 0)
  assert.equal(ok.output, 'hello-2')
  const bad = await session.run('false')
  assert.equal(bad.exitCode, 1)
  const missing = await session.run('no-such-command-xyz 2>/dev/null')
  assert.equal(missing.exitCode, 127)
})

test('keeps shell state between commands', { skip }, async () => {
  const { session } = await manager.open({ session: 'state' })
  await session.run('cd /tmp && FOO=bar && greet() { echo "hi $1"; }')
  const pwd = await session.run('pwd')
  assert.equal(pwd.output, '/tmp')
  const variable = await session.run('echo "$FOO"')
  assert.equal(variable.output, 'bar')
  const fn = await session.run('greet world')
  assert.equal(fn.output, 'hi world')
})

test('runs heredocs and multi-line snippets', { skip }, async () => {
  const { session } = await manager.open({ session: 'heredoc' })
  const result = await session.run('cat <<EOF\nline one\nline two\nEOF')
  assert.equal(result.exitCode, 0)
  assert.equal(result.output, 'line one\nline two')
  const loop = await session.run('for i in 1 2 3; do\n  echo "n=$i"\ndone')
  assert.equal(loop.output, 'n=1\nn=2\nn=3')
})

test('commands cannot swallow the completion sentinel through stdin', { skip }, async () => {
  const { session } = await manager.open({ session: 'stdin' })
  const result = await session.run('read -r line; echo "read:[$line]"')
  assert.equal(result.exitCode, 0)
  assert.equal(result.output, 'read:[]')
  const after = await session.run('echo still-in-sync')
  assert.equal(after.output, 'still-in-sync')
})

test('a long command returns running and refuses a second command', { skip }, async () => {
  const { session } = await manager.open({ session: 'busy' })
  const pending = await session.run('sleep 2; echo late-output', { timeoutMs: 300 })
  assert.equal(pending.timedOut, true)
  assert.equal(pending.stillRunning, true)
  assert.equal(session.busy, true)
  await assert.rejects(() => session.run('echo nope'), (error) => error instanceof BashSessionError && error.code === 'SESSION_BUSY')
  assert.equal(await waitIdle(session), true)
  const rest = await session.run('echo done')
  assert.equal(rest.output, 'done')
})

test('interrupt stops the running command but keeps the shell', { skip }, async () => {
  const { session } = await manager.open({ session: 'interrupt' })
  await session.run('sleep 30', { timeoutMs: 300 })
  const outcome = await session.interrupt()
  assert.equal(outcome.interrupted, true)
  assert.equal(await waitIdle(session), true, 'session becomes idle after the interrupt')
  const result = await session.run('echo alive; echo "$((21 * 2))"')
  assert.equal(result.exitCode, 0)
  assert.equal(result.output, 'alive\n42')
})

test('reads paged scrollback', { skip }, async () => {
  const { session } = await manager.open({ session: 'scrollback' })
  await session.run('seq 1 50')
  const newest = session.read({ lines: 5 })
  assert.deepEqual(newest.text.split('\n'), ['46', '47', '48', '49', '50'])
  assert.equal(newest.hasMore, true)
  const older = session.read({ lines: 5, offset: 45 })
  assert.deepEqual(older.text.split('\n'), ['1', '2', '3', '4', '5'])
  const whole = session.read({ lines: 200 })
  assert.equal(whole.text.split('\n').length, 50)
})

test('close removes the session and its process', { skip }, async () => {
  const { session } = await manager.open({ session: 'closer' })
  const pid = session.pid
  assert.equal(manager.close('closer'), true)
  assert.equal(manager.get('closer'), undefined)
  assert.equal(manager.close('closer'), false)
  await assert.rejects(() => session.run('echo nope'), (error) => error instanceof BashSessionError && error.code === 'SESSION_CLOSED')
  const gone = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 5000)
    const check = () => {
      try {
        process.kill(pid, 0)
        setTimeout(check, 50)
      } catch {
        clearTimeout(timer)
        resolve(true)
      }
    }
    check()
  })
  assert.equal(gone, true)
})

test('names default sessions main, main-2 and so on', { skip }, async () => {
  const park = new SharedBashManager({ rootDir: mkdtempSync(join(tmpdir(), 'dsb-names-')), bashPath, maxSessions: 4 })
  try {
    const first = await park.open({})
    const second = await park.open({})
    assert.equal(first.session.name, 'main')
    assert.equal(second.session.name, 'main-2')
    assert.deepEqual(
      park.list().map((entry) => entry.session),
      ['main', 'main-2'],
    )
  } finally {
    park.dispose()
  }
})

test('enforces the session limit', { skip }, async () => {
  const small = new SharedBashManager({ rootDir: mkdtempSync(join(tmpdir(), 'dsb-limit-')), bashPath, maxSessions: 1 })
  try {
    await small.open({ session: 'one' })
    await assert.rejects(() => small.open({ session: 'two' }), (error) => error instanceof BashSessionError && error.code === 'TOO_MANY_SESSIONS')
  } finally {
    small.dispose()
  }
})
