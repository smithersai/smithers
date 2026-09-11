/*
 * Running the plugin loader for the app.
 *
 * The loader is an Effect; the app is React. This is the one place the two
 * meet: a pure, synchronous fold over the installed plugins, recomputed
 * during render from the session's shelf and from what the registry actually
 * registered here. Nothing is cached in the store, so a catalog change or a
 * flow that only exists on one host reaches the workspace the next time it
 * renders.
 *
 * A refused load is reported rather than thrown: a plugin naming a dependency
 * it does not have must not blank the app, and the Library says what happened.
 */
import { Effect } from "effect"
import { emptySurface, load, PluginHost } from "./AppPlugin"
import { installedPlugins } from "./catalog"
import type { AppSurface, PluginError } from "./AppPlugin"

export interface LoadedApp {
  readonly surface: AppSurface
  /** What the loader refused, in the words a person can act on. */
  readonly problem?: string
}

const describe = (error: PluginError): string => {
  switch (error._tag) {
    case "MissingDependency":
      return `${error.plugin} needs ${error.requires}. Install ${error.requires} first.`
    case "DuplicatePlugin":
      return `${error.plugin} is on the shelf twice.`
    case "UnknownFlow":
      return `${error.plugin} names a flow this app does not have (${error.flow}).`
  }
}

/** The app the installed plugins produce, for a runtime that registered `hasFlow`. */
export const loadedApp = (
  installed: ReadonlyArray<string>,
  hasFlow: (name: string) => boolean
): LoadedApp => {
  const result = Effect.runSync(
    Effect.result(Effect.provideService(load(installedPlugins(installed)), PluginHost, { hasFlow }))
  )
  return result._tag === "Success" ? { surface: result.success } : { surface: emptySurface, problem: describe(result.failure) }
}
