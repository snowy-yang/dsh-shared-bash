// dsh-shared-bash — tmux-like shared bash sessions for DeepSeek Harness.
//
// The Host half owns one manager of long-lived bash processes. Every tool it
// registers is global to the profile, so every agent in every session of this
// profile sees the same sessions and can keep using a shell someone else left
// in a useful directory.

import { BashSessionError, DEFAULT_MSYS2_BASH, SharedBashManager } from './src/sessions.js'
import { buildTools } from './src/tools.js'

export const name = 'shared-bash'
export const inject = ['tools']

/**
 * Mount the shared session manager and its tools.
 * @param ctx - Cordis context of this plugin row.
 * @param config - Plugin config; see README.
 */
export function apply(ctx, config) {
  if (config !== undefined && config !== null && (typeof config !== 'object' || Array.isArray(config))) {
    throw new TypeError('shared-bash: config must be an object')
  }
  const manager = new SharedBashManager(config ?? {})
  ctx.effect(() => () => manager.dispose(), 'shared-bash: sessions')
  const disposers = buildTools(manager).map((tool) => ctx.tools.register(tool))
  ctx.effect(
    () => () => {
      for (const dispose of disposers) dispose?.()
    },
    'shared-bash: tools',
  )
}

export { BashSessionError, DEFAULT_MSYS2_BASH, SharedBashManager }
