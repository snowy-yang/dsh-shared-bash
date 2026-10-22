import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import * as plugin from '../index.js'
import { buildTools } from '../src/tools.js'

const bashPath = process.env.DSH_SHARED_BASH ?? (existsSync('C:\\msys64\\usr\\bin\\bash.exe') ? 'C:\\msys64\\usr\\bin\\bash.exe' : 'bash')
const skip = bashPath === 'bash' && !existsSync('C:\\msys64\\usr\\bin\\bash.exe') ? 'bash executable not found' : false

function mount() {
  const registered = []
  const disposers = []
  const ctx = {
    tools: {
      register(definition) {
        registered.push(definition)
        return () => {
          const index = registered.indexOf(definition)
          if (index >= 0) registered.splice(index, 1)
        }
      },
    },
    effect(setup) {
      const disposer = setup()
      if (typeof disposer === 'function') disposers.push(disposer)
      return disposer
    },
  }
  return { ctx, registered, dispose: () => disposers.reverse().forEach((disposer) => disposer()) }
}

test('registers the six shared-bash tools with renderable outputs', { skip }, () => {
  const mounted = mount()
  plugin.apply(mounted.ctx, { bashPath, rootDir: mkdtempSync(join(tmpdir(), 'dsb-plugin-')), commandTimeoutMs: 20_000 })
  const names = mounted.registered.map((tool) => tool.name).sort()
  assert.deepEqual(names, [
    'shared_bash_close',
    'shared_bash_interrupt',
    'shared_bash_list',
    'shared_bash_open',
    'shared_bash_read',
    'shared_bash_send',
  ])
  for (const tool of mounted.registered) {
    assert.equal(tool.parameters.type, 'object', `${tool.name} parameters are an object schema`)
    assert.ok(tool.description.length > 40, `${tool.name} has a useful description`)
    assert.equal(typeof tool.execute, 'function')
    assert.equal(typeof tool.output.render, 'function')
    const rendered = tool.output.render({}, sampleValue(tool.name), undefined)
    assert.equal(rendered[0].type, 'text')
    assert.equal(typeof rendered[0].text, 'string')
  }
  mounted.dispose()
})

function sampleValue(name) {
  switch (name) {
    case 'shared_bash_open':
      return { session: 'demo', status: 'running', pid: 1234, cwd: '/home/user', bash: bashPath, msystem: 'MSYS', reused: false, startup: '' }
    case 'shared_bash_send':
      return { session: 'demo', exit_code: 0, output: 'hi', running: false, timed_out: false, cwd: '/home/user' }
    case 'shared_bash_read':
      return { session: 'demo', text: 'hi', start: 0, end: 1, total: 1, has_more: false, partial: false, status: 'running', busy: false, cwd: '/home/user' }
    case 'shared_bash_list':
      return { sessions: [] }
    case 'shared_bash_interrupt':
      return { session: 'demo', interrupted: true, killed: [42], status: 'running' }
    default:
      return { closed: ['demo'], remaining: 0 }
  }
}

test('drives a real session through the tool surface', { skip }, async () => {
  const mounted = mount()
  plugin.apply(mounted.ctx, { bashPath, rootDir: mkdtempSync(join(tmpdir(), 'dsb-tools-')), commandTimeoutMs: 20_000 })
  const tool = (name) => mounted.registered.find((entry) => entry.name === name)

  const opened = await tool('shared_bash_open').execute({ session: 'e2e', cwd: '/tmp' })
  assert.equal(opened.session, 'e2e')
  assert.equal(opened.status, 'running')
  assert.equal(opened.reused, false)

  const sent = await tool('shared_bash_send').execute({ session: 'e2e', command: 'cd /tmp && COUNT=7; echo "count=$COUNT in $(pwd)"' })
  assert.equal(sent.exit_code, 0)
  assert.equal(sent.output, 'count=7 in /tmp')

  const listed = await tool('shared_bash_list').execute({})
  assert.equal(listed.sessions.length, 1)
  assert.equal(listed.sessions[0].session, 'e2e')
  assert.equal(listed.sessions[0].cwd, '/tmp')

  const page = await tool('shared_bash_read').execute({ session: 'e2e', lines: 10 })
  assert.match(page.text, /count=7/)

  const long = await tool('shared_bash_send').execute({ session: 'e2e', command: 'sleep 20', timeout_ms: 200 })
  assert.equal(long.running, true)
  const interrupted = await tool('shared_bash_interrupt').execute({ session: 'e2e' })
  assert.equal(interrupted.interrupted, true)

  const waitIdle = async () => {
    const start = Date.now()
    while (Date.now() - start < 10_000) {
      const [session] = (await tool('shared_bash_list').execute({})).sessions
      if (session !== undefined && session.busy === false) return true
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    return false
  }
  assert.equal(await waitIdle(), true, 'session returns to idle after the interrupt')
  const after = await tool('shared_bash_send').execute({ session: 'e2e', command: 'echo still-here' })
  assert.equal(after.output, 'still-here')

  mounted.dispose()
})

test('dispose closes every session', { skip }, async () => {
  const mounted = mount()
  plugin.apply(mounted.ctx, { bashPath, rootDir: mkdtempSync(join(tmpdir(), 'dsb-dispose-')), commandTimeoutMs: 20_000 })
  const open = mounted.registered.find((entry) => entry.name === 'shared_bash_open')
  const list = mounted.registered.find((entry) => entry.name === 'shared_bash_list')
  await open.execute({ session: 'gone' })
  assert.equal((await list.execute({})).sessions.length, 1)
  mounted.dispose()
  assert.equal(mounted.registered.length, 0)
})

test('tool schemas satisfy the harness JSON Schema subset', { skip: !process.env.DSH_TOOLS_MODULE }, async () => {
  const module = await import(pathToFileURL(process.env.DSH_TOOLS_MODULE).href)
  const definitions = buildTools({ resolveName: () => 'main', require: () => ({ run: async () => ({}), read: () => ({}), interrupt: async () => ({}), status: 'running' }), list: () => [] })
  for (const definition of definitions) {
    module.assertSupportedJsonSchema(definition.parameters)
    module.assertSupportedJsonSchema(definition.output.schema)
  }
  const send = definitions.find((definition) => definition.name === 'shared_bash_send')
  assert.ok(module.validateJsonSchemaValue(send.parameters, {}, 'arguments').length > 0, 'a call without command is rejected')
  assert.equal(module.validateJsonSchemaValue(send.parameters, { command: 'echo hi' }, 'arguments').length, 0)
})
