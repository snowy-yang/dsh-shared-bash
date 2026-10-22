import assert from 'node:assert/strict'
import { test } from 'node:test'

// Loads the hand-written browser bundle with the shell's loader contract stubbed:
// `window.__ModuleLoader__.load({ id, factory })` and a `require` that resolves
// the platform's React seed. Nothing here renders React; the test pins the module
// shape and the slot registration a settings page depends on.

const stubs = []
globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      stubs.push(entry)
    },
  },
}

const react = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: value => [typeof value === 'function' ? value() : value, () => {}],
  useEffect: () => {},
  useMemo: factory => factory(),
  useRef: () => ({ current: null }),
  useCallback: fn => fn,
}
const requireStub = name => {
  if (name === 'react') return react
  throw new Error(`unexpected module request: ${name}`)
}

await import('../client.js')

const [entry] = stubs

test('the bundle registers one factory under the package name', () => {
  assert.equal(stubs.length, 1)
  assert.equal(entry.id, 'dsh-shared-bash')
  assert.equal(typeof entry.factory, 'function')
})

test('the factory is lazy and exports a Cordis client plugin', () => {
  const exports = entry.factory(requireStub)
  assert.equal(exports.name, 'shared-bash')
  assert.deepEqual(exports.inject, ['slots'])
  assert.equal(typeof exports.apply, 'function')
})

test('apply registers a settings section with a usable label', () => {
  const exports = entry.factory(requireStub)
  const registrations = []
  const registered = []
  const ctx = {
    slots: {
      inject(slotName, callback) {
        registrations.push({ slotName, callback })
        return () => {}
      },
      register(definition, component) {
        registered.push({ definition, component })
        return () => {}
      },
    },
  }

  exports.apply(ctx)
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].slotName, 'settings.section')

  registrations[0].callback()
  assert.equal(registered.length, 1)
  const { definition, component } = registered[0]
  assert.equal(definition.name, 'settings.section')
  assert.equal(definition.id, 'shared-bash')
  assert.equal(typeof definition.order, 'number')
  assert.equal(typeof definition.label(), 'string')
  assert.equal(component.length, 0, 'the page reads no slot props')
})
