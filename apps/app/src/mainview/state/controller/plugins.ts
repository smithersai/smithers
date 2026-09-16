/*
 * The plugin shelf's controller half: what `/plugins`, `/plugins.install` and
 * `/plugins.remove` actually do to the workspace.
 *
 * Installing writes ONE row — the id on the session's shelf. Everything a
 * plugin then adds to the app is recomputed from the catalog by the plugin
 * loader (plugins/AppPlugin.ts), so the store never holds a stale copy of a
 * plugin's rail, and a catalog change reaches an installed workspace the next
 * time it renders.
 */
import { CATALOG, pluginById } from "../../plugins/catalog"
import type { ControllerContext } from "./context"

export interface PluginsController {
  readonly showPlugins: () => void
  readonly installPlugin: (id: string) => string | void
  readonly removePlugin: (id: string) => string | void
  readonly listPlugins: () => { readonly value: string }
}

export const createPluginsController = (ctx: ControllerContext): PluginsController => {
  const enabled = () => ctx.services?.features?.pluginLibrary === true
  const installed = (): ReadonlyArray<string> => ctx.store.session().plugins ?? []

  /* A lesson finished by a real flow: the guide moves on, everywhere else nothing happens. */

  /*
   * Toggles toggle (§2c): `/plugins` on the Library returns to the chat. The
   * Library is a browse, so the model's door is `plugins.list`, which answers
   * in the conversation instead of taking the pane.
   */
  const showPlugins = (): void => {
    if (!enabled()) return
    ctx.store.dispatch({
      type: "surface.changed",
      actor: ctx.commandActor,
      surface: ctx.store.session().surface === "plugins" ? "chat" : "plugins"
    })
  }

  const installPlugin = (id: string): string | void => {
    if (!enabled()) return
    const plugin = pluginById(id)
    if (plugin === undefined) return `No plugin named “${id}”. Open the Library with /plugins to see the shelf.`
    const shelf = installed()
    if (shelf.includes(id)) {
      return `${plugin.manifest.name} is already installed.`
    }
    /*
     * A dependency is part of the install, the way it is in every store that
     * has them: a plugin whose dependency is missing would refuse to load,
     * and a person clicking Install did not ask for that outcome.
     */
    for (const required of plugin.manifest.dependsOn ?? []) {
      if (!shelf.includes(required)) {
        ctx.store.dispatch({ type: "plugin.installed", actor: ctx.commandActor, plugin: required })
      }
    }
    ctx.store.dispatch({ type: "plugin.installed", actor: ctx.commandActor, plugin: id })
  }

  const removePlugin = (id: string): string | void => {
    if (!enabled()) return
    const plugin = pluginById(id)
    if (plugin === undefined) return `No plugin named “${id}”. Open the Library with /plugins to see the shelf.`
    if (!installed().includes(id)) return `${plugin.manifest.name} is not installed.`
    const dependent = CATALOG.find(
      (candidate) =>
        installed().includes(candidate.manifest.id) && (candidate.manifest.dependsOn ?? []).includes(id)
    )
    if (dependent !== undefined) {
      return `${dependent.manifest.name} needs ${plugin.manifest.name}. Remove ${dependent.manifest.name} first.`
    }
    ctx.store.dispatch({ type: "plugin.removed", actor: ctx.commandActor, plugin: id })
  }

  /* The model's door onto the Library: the shelf as an answer, not as a pane. */
  const listPlugins = (): { readonly value: string } => {
    if (!enabled()) return { value: "" }
    const shelf = installed()
    /* The same live shelf as the pane, embedded: browsing is not installing. */
    const existing = ctx.store.collections.cards.get("plugin-library")
    const ordinal = Math.max(0,
      ...Array.from(ctx.store.collections.cards.values(), card => card.ordinal),
      ...Array.from(ctx.store.collections.messages.values(), message => message.ordinal)) + 1
    ctx.store.dispatch({ type: "card.upsert", actor: ctx.commandActor, card: {
      id: "plugin-library", kind: "plugin-library", title: "Library", status: "active",
      createdAt: existing?.createdAt ?? Date.now(), ordinal,
      payload: { tutorial: false }
    } })
    return {
      value: CATALOG.map((plugin) => {
        const { id, name, summary, recommended } = plugin.manifest
        const state = shelf.includes(id) ? "installed" : recommended === undefined ? "available" : `recommended #${recommended}`
        return `${id} — ${name} (${state}): ${summary}`
      }).join("\n")
    }
  }

  return { showPlugins, installPlugin, removePlugin, listPlugins }
}
