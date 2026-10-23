import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { after, test } from 'node:test'

import { SharedBashManager } from '../src/manager.js'
import { BashSessionError, normalizeSessionId, sanitizeLine, toPosixPath } from '../src/pty.js'
import { createFakeTerminalProvider } from './terminal-double.mjs'

const root = mkdtempSync(join(tmpdir(), 'shared-bash-pty-'))
const provider = createFakeTerminalProvider()
const manager = new SharedBashManager({ rootDir: root, maxSessions: 32, spawnTerminal: spec => provider.spawnTerminal(spec) })

after(async () => {
  await manager.dispose()
  rmSync(root, { recursive: true, force: true })
})

test('sanitizeLine drops escape sequences and control bytes', () => {
  assert.equal(sanitizeLine('\u001b[31mred\u001b[0m'), 'red')
  assert.equal(sanitizeLine('bell\u0007x'), 'bellx')
  assert.equal(sanitizeLine('carriage\r'), 'carriage')
  assert.equal(sanitizeLine('\u001b]0;title\u0007done'), 'done')
})

test('toPosixPath maps Windows paths into the form bash reads', () => {
  assert.equal(toPosixPath('C:\\msys64\\tmp'), '/c/msys64/tmp')
  assert.equal(toPosixPath('/tmp'), '/tmp')
  assert.equal(toPosixPath('D:\\proj\\x'), '/d/proj/x')
})

test('normalizeSessionId rejects unaddressable ids', () => {
  assert.equal(normalizeSessionId('0f6c1f5e-aaaa-bbbb'), '0f6c1f5e-aaaa-bbbb')
  assert.throws(() => normalizeSessionId('bad id!'), error => error.code === 'INVALID_SESSION')
  assert.throws(() => normalizeSessionId(''), error => error.code === 'INVALID_SESSION')
})

test('attach starts a terminal and reports it as running', async () => {
  const attached = await manager.attach('sess-one')
  assert.equal(attached.reused, false)
  const summary = attached.session.summary()
  assert.equal(summary.session_id, 'sess-one')
  assert.equal(summary.status, 'running')
  assert.ok(summary.pid > 0)

  const again = await manager.attach('sess-one')
  assert.equal(again.reused, true)
  assert.equal(manager.list().length, 1)
})

test('attach enters the requested cwd inside the shell', async () => {
  await manager.attach('sess-cwd', { cwd: '/tmp' })
  const summary = manager.get('sess-cwd').summary()
  assert.equal(summary.cwd, '/tmp')
})

test('exec returns a job id and wait collects exit code and output', async () => {
  await manager.attach('sess-run')
  const job = await manager.exec('sess-run', 'echo hello-pty; pwd')
  assert.match(job.id, /^bash-[0-9a-f]{16}$/)

  const done = await manager.wait(job.id, 20_000)
  assert.equal(done.status, 'completed')
  assert.equal(done.exit_code, 0)
  assert.match(done.output, /hello-pty/)
  assert.match(done.output, /\/tmp|\/home|\/c\//)
})

test('multi-line commands and exit codes survive the script-file framing', async () => {
  await manager.attach('sess-multi')
  const job = await manager.exec('sess-multi', 'for i in 1 2 3\ndo\n  echo "n=$i"\ndone\nfalse')
  const done = await manager.wait(job.id, 20_000)
  assert.equal(done.exit_code, 1)
  assert.match(done.output, /n=1[\s\S]*n=2[\s\S]*n=3/)
})

test('a missing command reports 127 instead of hanging', async () => {
  await manager.attach('sess-missing')
  const job = await manager.exec('sess-missing', 'definitely-not-a-command-xyz')
  const done = await manager.wait(job.id, 20_000)
  assert.equal(done.exit_code, 127)
  assert.match(done.output, /not found/i)
})

test('one command at a time: a second exec is refused while one runs', async () => {
  await manager.attach('sess-busy')
  const first = await manager.exec('sess-busy', 'printf started; sleep 5')
  await assert.rejects(
    () => manager.exec('sess-busy', 'echo second'),
    error => error.code === 'SESSION_BUSY',
  )
  assert.equal(manager.get('sess-busy').summary().busy, true)
  await manager.close('sess-busy')
  assert.equal((await manager.wait(first.id, 1000)).status, 'failed')
})

test('read pages retained output from the newest line back', async () => {
  await manager.attach('sess-read')
  const job = await manager.exec('sess-read', 'echo line-1; echo line-2; echo line-3')
  await manager.wait(job.id, 20_000)

  const latest = manager.read('sess-read', { lines: 2 })
  assert.match(latest.text, /line-2[\s\S]*line-3/)
  assert.equal(latest.hasMore, true)

  const all = manager.read('sess-read', { lines: 100 })
  assert.match(all.text, /line-1/)
})

test('terminals are addressed by session id, so another agent can attach', async () => {
  await manager.attach('sess-owner')
  const job = await manager.exec('sess-owner', 'echo owner-shell')
  await manager.wait(job.id, 20_000)

  // A different caller (any agent) reads and drives the same terminal by id.
  assert.match(manager.read('sess-owner', { lines: 20 }).text, /owner-shell/)
  const second = await manager.exec('sess-owner', 'echo second-agent')
  const done = await manager.wait(second.id, 20_000)
  assert.match(done.output, /second-agent/)
})

test('unknown sessions and jobs carry stable codes', async () => {
  assert.throws(() => manager.read('no-such-session'), error => error.code === 'NO_SESSION')
  await assert.rejects(() => manager.wait('bash-0000000000000000', 1000), error => error.code === 'NO_JOB')
})

test('close terminates the terminal and forgets it', async () => {
  await manager.attach('sess-close')
  assert.equal(await manager.close('sess-close'), true)
  assert.equal(manager.get('sess-close'), undefined)
  assert.equal(await manager.close('sess-close'), false)
})

test('without a subprocess provider the manager fails with a named code', async () => {
  const bare = new SharedBashManager({ rootDir: join(root, 'bare') })
  await assert.rejects(() => bare.attach('sess-bare'), error => error.code === 'NO_SUBPROCESS')
  await bare.dispose()
})

test('the session limit is enforced', async () => {
  const capped = new SharedBashManager({ rootDir: join(root, 'capped'), maxSessions: 1, spawnTerminal: spec => provider.spawnTerminal(spec) })
  await capped.attach('only-one')
  await assert.rejects(() => capped.attach('second-one'), error => error.code === 'TOO_MANY_SESSIONS')
  await capped.dispose()
})

test('a closed terminal rejects further commands', async () => {
  const session = (await manager.attach('sess-dead')).session
  await manager.close('sess-dead')
  await assert.rejects(() => session.run('echo never'), error => error instanceof BashSessionError)
})
