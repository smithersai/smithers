/**
 * What a loaded plugin set contributes, folded into one value, and the typed
 * refusal a plugin that cannot load is recorded with.
 *
 * `Load.load` produces a {@link Contributions} value; hosts read it to draw
 * views and slots, list commands, and bind keys. Nothing in it runs plugin
 * code.
 *
 * @since 1.1.0
 */

import * as Schema from "effect/Schema"
import type * as JsonSchema from "./JsonSchema.ts"
import type * as Keys from "./Keys.ts"
import type * as Manifest from "./Manifest.ts"
import type * as When from "./When.ts"

/**
 * Why a plugin was not loaded. A closed set: a host lists it on the plugin
 * settings page and never guesses past it.
 *
 * @category models
 * @since 1.1.0
 */
export const Reason = Schema.Literals([
  "invalid",
  "incompatible",
  "range_unreadable",
  "schema_unresolved",
  "missing_dependency",
  "cycle",
  "undeclared_use",
  "capability_exceeded",
  "conflict",
  "unsupported_point",
  "stale_head",
  "reserved",
  "minimum_below_flow",
  "credential_input",
  "secret_field"
])

/**
 * Why a plugin was not loaded.
 *
 * @category models
 * @since 1.1.0
 */
export type Reason = typeof Reason.Type

/**
 * A plugin the loader refused, with the field that refused it.
 *
 * `plugin` is the manifest's id when it could be read, `path` the failing
 * field (`contributes.keybindings[2].event`), and `detail` a short sentence.
 * A refusal never carries a manifest value other than an id, and a path keeps
 * the first 64 characters of a key, so it is bounded and safe to log and show.
 *
 * @category errors
 * @since 1.1.0
 */
export class Refusal extends Schema.TaggedError<Refusal>()("plugin/Refusal", {
  plugin: Schema.optional(Schema.String),
  reason: Reason,
  path: Schema.optional(Schema.String),
  detail: Schema.String
}) {}

/**
 * Where a plugin comes from: compiled into the build, a repository's
 * `.smithers/plugins/`, or a person's own.
 *
 * @category models
 * @since 1.1.0
 */
export const Tier = Schema.Literals(["built-in", "repository", "personal"])

/**
 * Where a plugin comes from.
 *
 * @category models
 * @since 1.1.0
 */
export type Tier = typeof Tier.Type

/**
 * A contribution point a host may advertise. View events are part of `views`.
 *
 * @category models
 * @since 1.1.0
 */
export const Point = Schema.Literals([
  "views",
  "slots",
  "commands",
  "keybindings",
  "flows",
  "cards",
  "settings",
  "triggers",
  "hooks",
  "taps",
  "modelRoles",
  "records"
])

/**
 * A contribution point a host may advertise.
 *
 * @category models
 * @since 1.1.0
 */
export type Point = typeof Point.Type

/**
 * Which plugin contributed an entry, and from which tier.
 *
 * @category models
 * @since 1.1.0
 */
export interface Owner {
  readonly plugin: string
  readonly tier: Tier
}

/**
 * A plugin that loaded.
 *
 * @category models
 * @since 1.1.0
 */
export interface Active {
  readonly id: string
  readonly version: string
  readonly title: string
  readonly tier: Tier
  readonly capabilities: ReadonlyArray<string>
  readonly uses: ReadonlyArray<string>
  /** The flow tags this plugin owns, as the host resolved them. */
  readonly owns: ReadonlyArray<string>
}

/**
 * A view event that runs a flow. `payload` has every `$ref` inlined;
 * `personOnly` is the flow's registry fact, so the host's action strip draws
 * the event and plugin code never dispatches it.
 *
 * @category models
 * @since 1.1.0
 */
export interface FlowEvent {
  readonly name: string
  readonly payload?: JsonSchema.Resolved
  readonly flow: string
  readonly args: Manifest.Args
  readonly personOnly: boolean
}

/**
 * A view event that stays inside the view.
 *
 * @category models
 * @since 1.1.0
 */
export interface LocalEvent {
  readonly name: string
  readonly local: true
}

/**
 * A view event, as loaded.
 *
 * @category models
 * @since 1.1.0
 */
export type Event = FlowEvent | LocalEvent

/**
 * A view, as loaded: the manifest entry with its events resolved.
 *
 * @category models
 * @since 1.1.0
 */
export type View = Omit<Manifest.View, "events"> & Owner & { readonly events: ReadonlyArray<Event> }

/**
 * A slot entry, as loaded.
 *
 * @category models
 * @since 1.1.0
 */
export type Slot = Manifest.Slot & Owner

/**
 * A command, as loaded.
 *
 * @category models
 * @since 1.1.0
 */
export type Command = Manifest.Command & Owner

/**
 * A keybinding that runs a command.
 *
 * @category models
 * @since 1.1.0
 */
export interface CommandKeybinding extends Owner {
  readonly key: string
  readonly keys: Keys.Keys
  readonly when: When.When
  readonly command: string
}

/**
 * A keybinding that sends an event the view named in its `when` declares.
 * `personOnly` keys belong to the host's action strip.
 *
 * @category models
 * @since 1.1.0
 */
export interface EventKeybinding extends Owner {
  readonly key: string
  readonly keys: Keys.Keys
  readonly when: When.When
  readonly view: string
  readonly event: string
  readonly fields: Manifest.Args
  readonly personOnly: boolean
}

/**
 * A keybinding, as loaded: its key and `when` already parsed.
 *
 * @category models
 * @since 1.1.0
 */
export type Keybinding = CommandKeybinding | EventKeybinding

/**
 * Every active plugin's contributions, folded. Views, commands and
 * keybindings keep load order, then declaration order; slots are sorted by
 * slot, then `order` (absent is 0), then id.
 *
 * @category models
 * @since 1.1.0
 */
export interface Contributions {
  readonly plugins: ReadonlyArray<Active>
  readonly views: ReadonlyArray<View>
  readonly slots: ReadonlyArray<Slot>
  readonly commands: ReadonlyArray<Command>
  readonly keybindings: ReadonlyArray<Keybinding>
}

/**
 * No plugins, no contributions.
 *
 * @category constructors
 * @since 1.1.0
 */
export const empty: Contributions = { plugins: [], views: [], slots: [], commands: [], keybindings: [] }
