/*
 * The `plugins` flows: the Library, and what a person does in it.
 *
 * `plugins` is a surface switch — the Library is a pane a person browses, so
 * it is the human's gesture and the model's door onto the same shelf is
 * `plugins.list`, which answers in the conversation instead of taking the
 * pane. Installing and removing ARE the model's to ask for: both flows carry
 * a confirm, so an agent invocation posts the act for the human to run.
 */
import { Schema } from "effect"
import { flow, NoPayload } from "./Declare"
import type { CommandActions } from "./Declare"
import type { FlowEntry, Namespace, Recommendation } from "../registry"

/** The `plugins` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = {
  id: "plugins",
  label: "Plugins",
  summary: "The abilities on this workspace"
}

/** Nothing installed yet is exactly when the Library leads. */
export const recommendations: ReadonlyArray<Recommendation> = [
  { name: "plugins", when: (state) => (state.plugins ?? []).length === 0, rank: () => 2 }
]

/** Why the Library pane is the human's: browsing is a viewport gesture. */
export const PLUGINS_USER_ONLY_REASON =
  "surface switch: the model reads the same shelf with plugins.list, which answers in the conversation"

/** The bare `plugins` surface switch, registered with the other top-level surfaces. */
export const pluginsSurfaceFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    name: "plugins",
    summary: "Open the Library and browse plugins",
    userOnly: true,
    userOnlyReason: PLUGINS_USER_ONLY_REASON,
    input: NoPayload,
    handler: () => actions.showPlugins()
  })
]

/** The `plugins.*` flows: the shelf, and the two acts that change it. */
export const pluginsFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    name: "plugins.list",
    summary: "List the plugins on the shelf and which are installed",
    input: NoPayload,
    handler: () => actions.listPlugins()
  }),
  flow({
    name: "plugins.install",
    summary: "Install a plugin from the Library",
    args: "<plugin>",
    confirm: "install a plugin",
    input: Schema.Struct({ plugin: Schema.String }),
    form: { fields: { plugin: { label: "Plugin", optionsFrom: "plugins" } } },
    handler: ({ plugin }) => actions.installPlugin(plugin)
  }),
  flow({
    name: "plugins.remove",
    summary: "Remove a plugin from this workspace",
    args: "<plugin>",
    confirm: "remove a plugin",
    input: Schema.Struct({ plugin: Schema.String }),
    form: { fields: { plugin: { label: "Plugin", optionsFrom: "plugins" } } },
    handler: ({ plugin }) => actions.removePlugin(plugin)
  })
]
