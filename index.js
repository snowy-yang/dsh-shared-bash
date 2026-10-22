// dsh-shared-bash — tmux-like shared bash sessions for DeepSeek Harness.
//
// The Host half owns one manager of long-lived bash processes. Every tool it
// registers is global to the profile, so every agent in every session of this
// profile sees the same sessions and can keep using a shell someone else left
// in a useful directory.
//
// The web half (client.js) renders a settings page over the JSON routes
// registered here; the routes pend until a web server is composed, so the same
// Host half runs headless without a browser.

import { BashSessionError, DEFAULT_MSYS2_BASH, SharedBashManager } from './src/sessions.js'
import { buildTools } from './src/tools.js'
import { API_PREFIX, createWebHandler } from './src/web.js'

export const name = 'shared-bash'
export const inject = ['tools']

/**
 * Mount the shared session manager, its tools and (when a web server exists)
 * the browser-facing API.
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

  // The web server may be published after this plugin loads, so the route
  // registration waits for the service instead of reading it once at apply.
  // A bare Cordis context in tests has no fiber helpers; the tools still mount.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (scoped) => {
      const server = scoped.webServer
      const handler = createWebHandler(manager, {
        connection: () => (typeof scoped.get === 'function' ? scoped.get('connection') : undefined),
      })
      scoped.effect(() => server.register({ kind: 'prefix', path: API_PREFIX, handler }), 'shared-bash: api routes')
    })
  }
}

export { BashSessionError, DEFAULT_MSYS2_BASH, SharedBashManager }
