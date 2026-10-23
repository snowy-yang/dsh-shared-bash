import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { after, test } from 'node:test'

import { SharedBashManager } from '../src/manager.js'
import { buildTools } from '../src/tools.js'
import { createFakeTerminalProvider } from './terminal-double.mjs'

const root = mkdtempSync(join(tmpdir(), 'shared-bash-tools-'))
const provider = createFakeTerminalProvider()
const manager = new SharedBashManager({ rootDir: root, spawnTerminal: spec => provider.spawnTerminal(spec) })
const tools = new Map(buildTools(manager).map(tool => [tool.name, tool]))
const exec = { agent: { session: { id: 'sess-tools' } }, callId: 'call-1', signal: new AbortController().signal }

after(async () => {
  await manager.dispose()
  rmSync(root, { recursive: true, force: true })
})

test('registers the seven terminal tools with renderable outputs', () => {
  assert.deepEqual([...tools.keys()].sort(), [
    'bash_attach', 'bash_close', 'bash_exec', 'bash_interrupt', 'bash_list', 'bash_read', 'bash_wait',
  ])
  for (const [name, tool] of tools) {
    // Harness authoring style: a flat property map, not a root JSON Schema.
    assert.equal(typeof tool.parameters, 'object', name)
    assert.equal(Array.isArray(tool.parameters), false, name)
    assert.equal(tool.parameters.type, undefined, name)
    for (const property of Object.values(tool.parameters)) assert.equal(typeof property.type, 'string', name)
    assert.equal(typeof tool.execute, 'function', name)
    assert.equal(typeof tool.output.render, 'function', name)
    const rendered = tool.output.render({}, { session_id: 's', status: 'running', pid: 1, cwd: '/tmp', reused: false, startup: '', text: '', closed: [], sessions: [], interrupted: true, job_id: 'bash-0123456789abcdef', exit_code: 0, output: '', error: '', timed_out: false, start: 0, end: 0, total: 0, hasMore: false, busy: false })
    assert.ok(Array.isArray(rendered) && rendered[0].type === 'text', name)
  }
})

test('the default target is the calling agent\'s session', async () => {
  const attached = await tools.get('bash_attach').execute({}, exec)
  assert.equal(attached.session_id, 'sess-tools')
  assert.equal(attached.status, 'running')

  const listed = tools.get('bash_list').execute({}, exec)
  assert.deepEqual(listed.sessions.map(entry => entry.session_id), ['sess-tools'])
})

test('bash_exec returns a job id and bash_wait collects the result', async () => {
  const started = await tools.get('bash_exec').execute({ command: 'echo tool-hello' }, exec)
  assert.match(started.job_id, /^bash-[0-9a-f]{16}$/)
  assert.equal(started.session_id, 'sess-tools')

  const done = await tools.get('bash_wait').execute({ job_id: started.job_id, timeout_ms: 20_000 }, exec)
  assert.equal(done.status, 'completed')
  assert.equal(done.exit_code, 0)
  assert.match(done.output, /tool-hello/)
  assert.equal(done.timed_out, false)
})

test('bash_wait reports a timeout without losing the command', async () => {
  const started = await tools.get('bash_exec').execute({ command: 'sleep 2; echo late' }, exec)
  const early = await tools.get('bash_wait').execute({ job_id: started.job_id, timeout_ms: 50 }, exec)
  assert.equal(early.timed_out, true)
  assert.equal(early.status, 'running')

  const later = await tools.get('bash_wait').execute({ job_id: started.job_id, timeout_ms: 20_000 }, exec)
  assert.equal(later.status, 'completed')
  assert.match(later.output, /late/)
})

test('bash_read exposes scrollback and bash_interrupt targets the shell', async () => {
  const read = tools.get('bash_read').execute({ lines: 50 }, exec)
  assert.match(read.text, /tool-hello/)

  const interrupted = await tools.get('bash_interrupt').execute({}, exec)
  assert.equal(interrupted.session_id, 'sess-tools')
  assert.equal(typeof interrupted.interrupted, 'boolean')
})

test('another agent reaches a session by passing its id', async () => {
  const other = { agent: { session: { id: 'sess-other' } } }
  const attached = await tools.get('bash_attach').execute({ session_id: 'sess-tools' }, other)
  assert.equal(attached.session_id, 'sess-tools')
  assert.equal(attached.reused, true)

  const started = await tools.get('bash_exec').execute({ session_id: 'sess-tools', command: 'echo from-other' }, other)
  const done = await tools.get('bash_wait').execute({ job_id: started.job_id, timeout_ms: 20_000 }, other)
  assert.match(done.output, /from-other/)
})

test('tools without a calling session ask for an explicit id', async () => {
  await assert.rejects(
    () => tools.get('bash_exec').execute({ command: 'echo hi' }, {}),
    error => error.code === 'NO_SESSION_CONTEXT',
  )
})

test('an empty command is rejected before the shell sees it', async () => {
  await assert.rejects(
    () => tools.get('bash_exec').execute({ command: '   ' }, exec),
    error => error.code === 'INVALID_COMMAND',
  )
})

test('bash_close forgets the terminal', async () => {
  const closed = await tools.get('bash_close').execute({}, exec)
  assert.deepEqual(closed.closed, ['sess-tools'])
  assert.equal(tools.get('bash_list').execute({}, exec).sessions.length, 0)
})
