import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

// Validates the published plugin market index with the harness' own format-1
// validator. Enable by pointing DSH_MARKET_INDEX_MODULE at
// @deepseek-ai/dsh-plugin-market-index/lib/index.js, e.g. inside a DSH checkout.
test('index.json is a valid market index format 1 document', { skip: !process.env.DSH_MARKET_INDEX_MODULE }, async () => {
  const validator = await import(pathToFileURL(process.env.DSH_MARKET_INDEX_MODULE).href)
  const document = JSON.parse(readFileSync(new URL('../index.json', import.meta.url), 'utf8'))
  const indexUrl = 'https://raw.githubusercontent.com/snowy-yang/dsh-shared-bash/main/index.json'
  const parsed = validator.parseMarketIndex(document, indexUrl)
  assert.equal(parsed.format, 1)
  assert.ok(parsed.plugins.length > 0)
  const [plugin] = parsed.plugins
  assert.equal(plugin.name, 'dsh-shared-bash')
  const target = validator.marketInstallTarget(plugin.name, plugin.versions[0])
  assert.match(target.spec, /^git\+https:\/\/github\.com\/snowy-yang\/dsh-shared-bash\.git#[0-9a-f]{40}$/)
})
