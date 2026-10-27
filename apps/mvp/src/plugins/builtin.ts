import { bugs, queue } from "./manifests"

// The built-in plugins (decision 0017, "What stays hardcoded"): the one place the core names a plugin, as webpack's
// `WebpackOptionsApply` lists its own. Each is a manifest, read without running plugin code, and two chunks loaded only
// when a contribution needs them: its tab (Effect, `{ queries, actions }` over `PluginHost`) and its React components.
// Removing a line here and the plugin's folder removes the feature; nothing else in the core names it.

/** One built-in plugin: its manifest, and its tab's and components' chunks. */
export interface BuiltIn {
  readonly manifest: unknown
  /** The tab entry: a module whose `tab` builds `{ queries, actions }` from `PluginHost`. */
  readonly tab: () => Promise<{ readonly tab: unknown }>
  /** The components: a module whose exports are the names a `component` render names. */
  readonly components: () => Promise<Readonly<Record<string, unknown>>>
}

/** Every built-in plugin, in no order: the loader orders them by their dependencies, then id. */
export const BUILTIN: ReadonlyArray<BuiltIn> = [
  {
    manifest: queue,
    tab: () => import("../../plugins/queue/src/tab"),
    components: () => import("../../plugins/queue/src/components/index"),
  },
  {
    manifest: bugs,
    tab: () => import("../../plugins/bugs/src/tab"),
    components: () => import("../../plugins/bugs/src/components/index"),
  },
]
