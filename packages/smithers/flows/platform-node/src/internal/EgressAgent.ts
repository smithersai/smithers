/**
 * Scope-local construction of the native egress pool.
 * @since 0.1.0
 */

import type * as Undici from "@effect/platform-node/Undici"
import * as Context from "effect/Context"

/**
 * The real Undici agent by default; fault tests provide a constructor whose
 * failure belongs only to their Effect context.
 * @private
 * @since 0.1.0
 */
export const AgentFactory = Context.Reference<
  (undici: typeof Undici, options: ConstructorParameters<typeof Undici.EnvHttpProxyAgent>[0]) => Undici.Dispatcher
>("@smthrs/platform-node/EgressAgent/AgentFactory", {
  defaultValue: () => (undici, options) => new undici.EnvHttpProxyAgent(options)
})
