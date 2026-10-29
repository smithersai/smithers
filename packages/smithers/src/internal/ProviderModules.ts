/**
 * Optional provider modules, loaded only by the Effect constructing that provider.
 * @since 1.0.0
 * @private
 */

import type * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk"
import { Context, Effect } from "effect"

/**
 * The provider SDKs this host can load, with their actual module types.
 * @since 1.0.0
 * @private
 */
export interface Modules {
  readonly "@anthropic-ai/claude-agent-sdk": typeof ClaudeSdk
}

const imports: { readonly [Name in keyof Modules]: () => Promise<Modules[Name]> } = {
  "@anthropic-ai/claude-agent-sdk": () => import("@anthropic-ai/claude-agent-sdk")
}

/**
 * The module-resolution boundary. Fault tests supply an Effect that fails;
 * importing the CLI or constructing this reference never loads an SDK.
 * @since 1.0.0
 * @private
 */
export const ModuleLoader = Context.Reference<{
  readonly load: <Name extends keyof Modules>(name: Name) => Effect.Effect<Modules[Name], unknown>
}>("/cli/ProviderModules/ModuleLoader", {
  defaultValue: () => ({
    load: (name) => Effect.tryPromise({ try: imports[name], catch: (cause) => cause })
  })
})
