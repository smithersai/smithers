import { type Contribution, Host } from "@smthrs/plugin"
import { Context, Effect, Layer, Scope } from "effect"
import { runners } from "../boundary"
import { codeOf } from "../errorCode"
import { FlowDispatch } from "../flows/dispatch"
import { rankOf, type Viewer } from "../features/commands/catalog"
import type { Minimum } from "../flows/registry"
import { hostFor, pathOf, Plugins, press, readable, setDraft, show, viewAt } from "./plugins"
import { type Button, type Strip, stripOf } from "./strip"

// The plugin host as a frontend sees it (decision 0017): the folded contributions, the host's own state, and plain
// functions. A plugin's tab and components load on first use, never at boot; the tab is built once, in the host's
// scope, from `PluginHost` alone.

type View = Contribution.View

/** What a frontend reads and does. */
export interface PluginsView {
  readonly contributions: Contribution.Contributions
  readonly queries: {
    /** Every view's strip state. */
    readonly views: Plugins["Service"]["strips"]["tanstack"]
    /** Every note the strips hold, by `draftKey(view, item)`. */
    readonly notes: Plugins["Service"]["notes"]["tanstack"]
  }
  readonly actions: {
    /** The view `plugin` declares at `path` in `scope` (`app` unless given), if any. */
    readonly viewAt: (plugin: string, path: string, scope?: View["scope"]) => View | undefined
    /** Where a view shows; a `repository` view needs its repository. */
    readonly pathOf: (view: View, repository?: Host.Repository) => string | undefined
    /** Shows view `id` (`null` for none). */
    readonly show: (id: string | null) => void
    /** The strip for `item` under `view`. */
    readonly strip: (view: View, item: Readonly<Record<string, unknown>> | undefined) => Strip
    /** Presses `button` on view `id`'s strip, drawn for the item `drawn`: nothing runs if that item moved on. */
    readonly press: (id: string, button: Button, drawn?: Readonly<Record<string, unknown>>) => void
    readonly setDraft: (id: string, text: string) => void
    /**
     * Core query `name`, asked with `params` when it takes them, as the host reads it for its strip: its rows, and the
     * field a row is keyed by.
     */
    readonly core: (
      name: string,
      params?: Readonly<Record<string, string>> | null,
    ) => Plugins["Service"]["core"] extends ReadonlyMap<string, infer Q> ? Q | undefined : never
    /** Plugin `plugin`'s tab, built once on first use. */
    readonly tab: (plugin: string) => Promise<unknown>
    /** Plugin `plugin`'s components, loaded on first use. */
    readonly components: (plugin: string) => Promise<Readonly<Record<string, unknown>>>
    /** Whether `viewer` may see a contribution that asks `minimum`. */
    readonly allows: (minimum: Minimum, viewer: Viewer) => boolean
    /**
     * Records that plugin `plugin`'s contribution failed: a component that threw, or a tab or chunk that didn't load
     * (`Boundary`). Logged once at Error by the error's name, never its message.
     */
    readonly failed: (plugin: string, error: unknown) => void
  }
}

const RANKS = { anyone: 0, guest: 1, member: 2, maintainer: 3, admin: 4 } as const satisfies Record<Minimum, number>

/** Builds plugin `plugin`'s tab from its built-in entry, with `PluginHost` for that plugin, in the host's scope. */
export const buildTab = (plugin: string) =>
  Effect.gen(function* () {
    const plugins = yield* Plugins
    const entry = plugins.built.get(plugin)
    if (entry === undefined) return yield* Effect.die(new Error(`no active plugin ${plugin}`))
    const module = yield* Effect.promise(entry.tab)
    const host = yield* hostFor(plugin)
    const tab = module.tab as Effect.Effect<unknown, unknown, Host.PluginHost | Scope.Scope>
    return yield* tab.pipe(Effect.provideService(Host.PluginHost, host), Scope.provide(plugins.scope))
  })

export class PluginsUi extends Context.Service<PluginsUi, PluginsView>()("@smthrs/mvp/plugins/PluginsUi") {
  /** Binds the host for frontends, run with the services this layer was built with. */
  static readonly layer = Layer.effect(
    PluginsUi,
    Effect.gen(function* () {
      const plugins = yield* Plugins
      const context = yield* Effect.context<Plugins | FlowDispatch>()
      const { runSync: run, runPromise } = runners(context, "plugins")
      const tabs = new Map<string, Promise<unknown>>()
      const chunks = new Map<string, Promise<Readonly<Record<string, unknown>>>>()
      return PluginsUi.of({
        contributions: plugins.contributions,
        queries: { views: plugins.strips.tanstack, notes: plugins.notes.tanstack },
        actions: {
          viewAt: (plugin, path, scope) => viewAt(plugins.contributions, plugin, path, scope),
          pathOf,
          show: (id) => run(show(id)),
          strip: (view, item) => stripOf(view, plugins.contributions.keybindings, item),
          press: (id, button, drawn) => run(press(id, button, "button", drawn)),
          setDraft: (id, text) => run(setDraft(id, text)),
          core: (name, params) => readable(plugins, name, params ?? null),
          tab: (plugin) => {
            // expected: a tab that can't be built rejects to its Boundary, which records it once (`failed`)
            const built = tabs.get(plugin) ?? runPromise(Effect.catchDefect(buildTab(plugin), Effect.fail))
            tabs.set(plugin, built)
            return built
          },
          // Cached, as the tab is: React's `use` reads one promise per chunk, never a new one per render.
          components: (plugin) => {
            const loaded = chunks.get(plugin) ??
              plugins.built.get(plugin)?.components() ??
              Promise.reject(new Error(`no active plugin ${plugin}`))
            chunks.set(plugin, loaded)
            return loaded
          },
          allows: (minimum, viewer) => rankOf(viewer) >= RANKS[minimum],
          failed: (plugin, error) =>
            run(Effect.logError("plugin.failed").pipe(
              Effect.annotateLogs({ feature: "plugins", plugin, outcome: "failed", errorCode: codeOf(error) }),
            )),
        },
      })
    }),
  )
}
