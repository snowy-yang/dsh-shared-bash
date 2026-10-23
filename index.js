// dsh-shared-bash — persistent PTY bash terminals, one per DSH session.
//
// The Host half owns a registry keyed by DSH session id: a terminal outlives
// tool calls and is reachable by any agent that knows the id, so "connect to the
// shell from that session" is an explicit act rather than an invisible pool.
// Commands run through it return a job id and settle asynchronously.

import { BashSessionError, DEFAULT_MSYS2_BASH, SharedBashManager } from './src/manager.js'
import { buildTools } from './src/tools.js'
import { API_PREFIX, createWebHandler } from './src/web.js'

export const name = 'shared-bash'
export const inject = ['tools']

/**
 * Mount the session-keyed PTY registry, its tools and (when a web server exists)
 * the browser-facing API.
 * @param ctx - Cordis context of this plugin row.
 * @param config - Plugin config; see README.
 */
export function apply(ctx, config) {
  if (config !== undefined && config !== null && (typeof config !== 'object' || Array.isArray(config))) {
    throw new TypeError('shared-bash: config must be an object')
  }
  const manager = new SharedBashManager(config ?? {})
  manager.bindSubprocess(() => (typeof ctx.get === 'function' ? ctx.get('subprocess') : undefined))
  ctx.effect(() => () => {
    void manager.dispose()
  }, 'shared-bash: terminals')

  const disposers = buildTools(manager).map(tool => ctx.tools.register(tool))
  ctx.effect(
    () => () => {
      for (const dispose of disposers) dispose?.()
    },
    'shared-bash: tools',
  )

  // The web server may be published after this plugin loads, so the route
  // registration waits for the service instead of reading it once at apply.
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
