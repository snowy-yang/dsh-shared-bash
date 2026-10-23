// Validates the tool contract against the harness's own schema compiler.
//
// Tools use the harness authoring style (flat parameter map, inline
// `required: true`), so this test compiles both halves with the real
// `parameterSchemaSpecToJsonSchema` / `valueSchemaSpecToJsonSchema` instead of
// asserting against a private understanding of the format.
//
// The suite must stay runnable outside the app, so the test only runs when
// DSH_TOOLS_MODULE points at the harness `@deepseek-ai/dsh-tools` entry point
// (for example an extracted `app.asar/dsh/node_modules` copy).

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { SharedBashManager } from '../src/manager.js'
import { buildTools } from '../src/tools.js'

const modulePath = process.env.DSH_TOOLS_MODULE
const enabled = modulePath !== undefined && modulePath !== ''

/** A plausible value for one authoring property spec. */
function sample(spec) {
  if (spec.enum !== undefined) return spec.enum[0]
  if (spec.const !== undefined) return spec.const
  switch (spec.type) {
    case 'string': return 'x'
    case 'integer': return 1
    case 'number': return 1
    case 'boolean': return true
    case 'array': return []
    case 'object': return sampleObject(spec)
    default: return undefined
  }
}

function sampleObject(spec) {
  const value = {}
  for (const [key, property] of Object.entries(spec.properties ?? {})) value[key] = sample(property)
  return value
}

test('tool schemas compile and validate under the harness runtime', { skip: !enabled }, async () => {
  const tools = await import(new URL(`file://${modulePath.replace(/\\/gu, '/')}`).href)
  const { assertSupportedJsonSchema, validateArgs, validateJsonSchemaValue } = tools
  const root = mkdtempSync(join(tmpdir(), 'shared-bash-schema-'))
  const manager = new SharedBashManager({ rootDir: root, spawnTerminal: async () => { throw new Error('not started') } })
  try {
    const built = buildTools(manager)
    assert.equal(built.length, 7)
    for (const tool of built) {
      // `register()` asserts the output schema exactly as written; `parameters`
      // is an authoring spec compiled by validateArgs.
      assertSupportedJsonSchema(tool.output.schema)

      const args = {}
      for (const [key, property] of Object.entries(tool.parameters)) {
        if (property.required === true) args[key] = sample(property)
      }
      assert.doesNotThrow(() => validateArgs(tool.parameters, args), tool.name)

      const value = sampleObject(tool.output.schema)
      validateJsonSchemaValue(tool.output.schema, value)
      const rendered = tool.output.render(args, value)
      assert.ok(Array.isArray(rendered) && rendered.length > 0 && rendered.every(part => part.type === 'text' && typeof part.text === 'string'), tool.name)
    }
  } finally {
    await manager.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})
