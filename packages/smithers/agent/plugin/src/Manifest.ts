/**
 * The plugin manifest: data a host reads without running plugin code.
 *
 * Every schema here is the closed shape decision 0017 prints. `decode` and
 * `parse` admit a manifest or refuse it with a {@link Refusal} naming the
 * failing field. `Load.load` applies the checks beyond the schema.
 *
 * @since 1.1.0
 */

import { BoundedJson } from "@smthrs/canonical"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as SchemaIssue from "effect/SchemaIssue"
import { Refusal } from "./Contribution.vibe"
import * as Path from "./internal/path.ts"
import * as Patterns from "./internal/patterns.ts"
import * as Subset from "./JsonSchema.ts"

/**
 * The plugin API this package's loader implements. `requires.api` is a range
 * over it.
 *
 * @category constants
 * @since 1.1.0
 */
export const PLUGIN_API = "1.0.0"

/**
 * First segments only the core may use, for plugin ids, contribution ids and
 * owned flow tags.
 *
 * @category constants
 * @since 1.1.0
 */
export const RESERVED: ReadonlyArray<string> = Object.freeze([
  "app",
  "chat",
  "repo",
  "run",
  "flow",
  "ui",
  "view",
  "system",
  "auth",
  "secret",
  "github",
  "issue",
  "plugin",
  "core"
])

/**
 * The largest manifest, in UTF-8 bytes of its JSON text.
 *
 * @category limits
 * @since 1.1.0
 */
export const maximumManifestBytes = 65_536

/**
 * The most entries one contribution point holds.
 *
 * @category limits
 * @since 1.1.0
 */
export const maximumEntriesPerPoint = 64

/**
 * The largest JSON Schema, in UTF-8 bytes serialized, before and after its
 * references are inlined.
 *
 * @category limits
 * @since 1.1.0
 */
export const maximumSchemaBytes: number = Subset.maximumBytes

/**
 * The deepest nesting of arrays and objects a manifest may have.
 *
 * @category limits
 * @since 1.1.0
 */
export const maximumDepth = 32

const bounded = <S extends Schema.Top>(item: S, max = maximumEntriesPerPoint) =>
  Schema.Array(item).check(Schema.isMaxLength(max))
const Name = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,39}$/))
// `$defs` keys follow JSON Schema convention (`Option`, `Note`), so they admit capitals.
const DefName = Schema.String.check(Schema.isPattern(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/))

/**
 * A plugin's id, and the namespace of its views, commands, hooks, settings,
 * queries and records.
 *
 * @category schemas
 * @since 1.1.0
 */
export const PluginId = Schema.String.check(Schema.isPattern(Patterns.pluginId))

/**
 * `<plugin>/<name>`: a view, slot entry, command, hook, setting, query or card
 * kind in a plugin's namespace.
 *
 * @category schemas
 * @since 1.1.0
 */
export const Qualified = Schema.String.check(Schema.isPattern(Patterns.qualified))

/**
 * A flow's tag, as `Flow.make`'s first argument: `app/navigate`, `run/answer`.
 *
 * @category schemas
 * @since 1.1.0
 */
export const FlowTag = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]*(\/[A-Za-z0-9][A-Za-z0-9.-]*){0,3}$/))

/**
 * A release version, never a prerelease.
 *
 * @category schemas
 * @since 1.1.0
 */
export const Version = Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+$/))

/**
 * A version range in `Pack.compatible`'s grammar: `*`, hyphen ranges, and
 * conjunctions of =, >=, >, <=, <, ^ and ~.
 *
 * @category schemas
 * @since 1.1.0
 */
export const Range = Schema.NonEmptyString.check(Schema.isMaxLength(64))

/**
 * The least role that may see or run a contribution.
 *
 * @category schemas
 * @since 1.1.0
 */
export const Minimum = Schema.Literals(["anyone", "guest", "member", "maintainer", "admin"])

/**
 * The least role that may see or run a contribution.
 *
 * @category models
 * @since 1.1.0
 */
export type Minimum = typeof Minimum.Type

/**
 * A capability, in `@smthrs/capability`'s grammar.
 *
 * @category schemas
 * @since 1.1.0
 */
export const Capability = Schema.NonEmptyString.check(Schema.isMaxLength(128))

/**
 * A short title.
 *
 * @category schemas
 * @since 1.1.0
 */
export const Title = Schema.NonEmptyString.check(Schema.isMaxLength(80))

/**
 * A paragraph of prose.
 *
 * @category schemas
 * @since 1.1.0
 */
export const Prose = Schema.NonEmptyString.check(Schema.isMaxLength(1024))

/**
 * A condition in the closed `when` grammar (see the `When` module).
 *
 * @category schemas
 * @since 1.1.0
 */
export const When = Schema.String.check(Schema.isMaxLength(256))

/**
 * A path confined to the plugin root, portable across hosts: `/`-separated
 * segments of letters, digits and `._@+-`, with no leading `/`, no empty, `.`
 * or `..` segment, no scheme (`https:`) and no backslash.
 *
 * @category schemas
 * @since 1.1.0
 */
export const RelativePath = Schema.String.check(
  Schema.isMaxLength(256),
  Schema.isPattern(/^(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*$/)
)

/**
 * A JSON Schema in the closed subset the `JsonSchema` module admits: `$ref`
 * only to this manifest's `#/$defs/…`, never a URL; at most 16 KiB.
 *
 * @category schemas
 * @since 1.1.0
 */
export const JsonSchema = Schema.Json

/**
 * A query a contribution may read: a core projection (`core/waits`) or one of
 * this plugin's own.
 *
 * @category schemas
 * @since 1.1.0
 */
export const QueryRef = Schema.String.check(Schema.isPattern(/^(core|[a-z][a-z0-9-]{1,39})\/[a-z][a-z0-9-]{0,63}$/))

/**
 * A query a contribution may read.
 *
 * @category models
 * @since 1.1.0
 */
export type QueryRef = typeof QueryRef.Type

/**
 * Values the host fills, in the closed grammar of the `Bind` module: a JSON
 * literal, or a reference rooted at `$item`, `$event` or `$key`.
 *
 * @category schemas
 * @since 1.1.0
 */
export const Args = Schema.Record(Schema.String, Schema.Json)

/**
 * Values the host fills.
 *
 * @category models
 * @since 1.1.0
 */
export type Args = typeof Args.Type

/**
 * A view event: it runs a flow with host-bound args, or stays inside the view.
 *
 * @category schemas
 * @since 1.1.0
 */
export const Event = Schema.Union([
  Schema.Struct({ name: Name, payload: Schema.optional(JsonSchema), flow: FlowTag, args: Args }),
  Schema.Struct({ name: Name, local: Schema.Literal(true) })
])

/**
 * A view event.
 *
 * @category models
 * @since 1.1.0
 */
export type Event = typeof Event.Type

/**
 * How a UI contribution draws. `component` only for a plugin compiled into
 * the build.
 *
 * @category schemas
 * @since 1.1.0
 */
export const Render = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("blocks"), blocks: bounded(Schema.Json, 32) }),
  Schema.Struct({ kind: Schema.Literal("view"), module: RelativePath }),
  Schema.Struct({ kind: Schema.Literal("app"), module: RelativePath }),
  Schema.Struct({ kind: Schema.Literal("component"), export: Schema.NonEmptyString })
])

/**
 * How a UI contribution draws.
 *
 * @category models
 * @since 1.1.0
 */
export type Render = typeof Render.Type

/**
 * A view in the chat shell, inline and/or full.
 *
 * @category schemas
 * @since 1.1.0
 */
export const View = Schema.Struct({
  id: Qualified,
  title: Title,
  scope: Schema.Literals(["app", "repository"]),
  path: Schema.String.check(Schema.isMaxLength(128)),
  sizes: bounded(Schema.Literals(["inline", "full"]), 2),
  minimum: Minimum,
  render: Render,
  reads: Schema.optional(bounded(QueryRef, 16)),
  events: Schema.optional(bounded(Event, 32))
})

/**
 * A view in the chat shell.
 *
 * @category models
 * @since 1.1.0
 */
export type View = typeof View.Type

/**
 * An entry in a named place.
 *
 * @category schemas
 * @since 1.1.0
 */
export const Slot = Schema.Struct({
  slot: Schema.Literals(["shell.header", "shell.nav", "repo.tabs", "branch.pane", "item.pane"]),
  id: Qualified,
  order: Schema.optional(Schema.Int),
  when: Schema.optional(When),
  minimum: Minimum,
  render: Render,
  reads: Schema.optional(bounded(QueryRef, 16))
})

/**
 * An entry in a named place.
 *
 * @category models
 * @since 1.1.0
 */
export type Slot = typeof Slot.Type

/**
 * A flow with fixed `args`, as a slash command, a palette entry or both.
 *
 * @category schemas
 * @since 1.1.0
 */
export const Command = Schema.Struct({
  id: Qualified,
  flow: FlowTag,
  title: Title,
  minimum: Minimum,
  args: Schema.optional(Args),
  slash: Schema.optional(Schema.Struct({
    name: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9.-]{0,31}$/)),
    fields: Schema.optional(bounded(Schema.String, 16)),
    hidden: Schema.optional(bounded(Schema.String, 16))
  })),
  palette: Schema.optional(Schema.Boolean)
})

/**
 * A flow as a slash command or palette entry.
 *
 * @category models
 * @since 1.1.0
 */
export type Command = typeof Command.Type

/**
 * A key and a `when`, with exactly one action: a command, or an event the
 * `when` clause's view declares. `fields` fill the event's payload from the key
 * itself (`{ "index": "$key.index" }` for `digit`).
 *
 * @category schemas
 * @since 1.1.0
 */
export const Keybinding = Schema.Union([
  Schema.Struct({ key: Schema.String.check(Schema.isMaxLength(32)), when: Schema.optional(When), command: Qualified }),
  Schema.Struct({
    key: Schema.String.check(Schema.isMaxLength(32)),
    when: When,
    event: Name,
    fields: Schema.optional(Args)
  })
])

/**
 * A key and a `when`, with exactly one action.
 *
 * @category models
 * @since 1.1.0
 */
export type Keybinding = typeof Keybinding.Type

/**
 * A card kind in the conversation.
 *
 * @category schemas
 * @since 1.1.0
 */
export const Card = Schema.Struct({ kind: Qualified, payload: JsonSchema, sizes: View.fields.sizes, render: Render })

/**
 * A person or repository setting with a JSON Schema. A secret field refuses.
 *
 * @category schemas
 * @since 1.1.0
 */
export const Setting = Schema.Struct({
  key: Qualified,
  title: Title,
  scope: Schema.Literals(["person", "repository"]),
  schema: JsonSchema,
  default: Schema.Json,
  minimum: Minimum
})

/**
 * An event, cron, webhook or other runs' events that starts a flow.
 *
 * @category schemas
 * @since 1.1.0
 */
export const Trigger = Schema.Struct({
  on: Schema.String.check(Schema.isMaxLength(128)),
  flow: FlowTag,
  title: Title,
  over: Schema.optional(bounded(FlowTag, 32))
})

/**
 * A seam a plugin owns.
 *
 * @category schemas
 * @since 1.1.0
 */
export const Hook = Schema.Struct({
  id: Qualified,
  title: Title,
  kind: Schema.Literals(["collect", "select", "narrow", "guard", "observe"]),
  input: JsonSchema,
  output: JsonSchema,
  taps: Schema.Literals(["built-in", "repository", "any"]),
  deadline: Schema.optional(Schema.Int)
})

/**
 * A flow (any hook) or a value (`collect` hooks only) on a hook.
 *
 * @category schemas
 * @since 1.1.0
 */
export const Tap = Schema.Union([
  Schema.Struct({ hook: Qualified, flow: FlowTag }),
  Schema.Struct({ hook: Qualified, value: Schema.Json })
])

/**
 * A named model use.
 *
 * @category schemas
 * @since 1.1.0
 */
export const ModelRole = Schema.Struct({
  role: Qualified,
  title: Title,
  default: Schema.Literals(["agent", "judge", "renderer"])
})

/**
 * Small JSON records only the plugin's flows write.
 *
 * @category schemas
 * @since 1.1.0
 */
export const Records = Schema.Struct({
  collection: Qualified,
  scope: Schema.Literals(["person", "repository"]),
  schema: JsonSchema
})

/**
 * A plugin manifest, `plugin.json`.
 *
 * @category schemas
 * @since 1.1.0
 */
export const Manifest = Schema.Struct({
  apiVersion: Schema.Literal(1),
  id: PluginId,
  version: Version,
  title: Title,
  description: Prose,
  requires: Schema.Struct({ api: Range, plugins: Schema.optional(Schema.Record(PluginId, Range)) }),
  capabilities: bounded(Capability),
  uses: Schema.optional(bounded(FlowTag)),
  flows: Schema.optional(bounded(RelativePath, 16)),
  skills: Schema.optional(bounded(RelativePath, 16)),
  owns: Schema.optional(bounded(Name, 64)),
  userOnly: Schema.optional(Schema.Record(FlowTag, Prose)),
  $defs: Schema.optional(Schema.Record(DefName, JsonSchema)),
  contributes: Schema.optional(Schema.Struct({
    views: Schema.optional(bounded(View)),
    slots: Schema.optional(bounded(Slot)),
    commands: Schema.optional(bounded(Command)),
    keybindings: Schema.optional(bounded(Keybinding)),
    cards: Schema.optional(bounded(Card)),
    settings: Schema.optional(bounded(Setting)),
    triggers: Schema.optional(bounded(Trigger)),
    hooks: Schema.optional(bounded(Hook)),
    taps: Schema.optional(bounded(Tap)),
    modelRoles: Schema.optional(bounded(ModelRole, 8)),
    records: Schema.optional(bounded(Records, 16))
  }))
})

/**
 * A decoded plugin manifest.
 *
 * @category models
 * @since 1.1.0
 */
export type Manifest = typeof Manifest.Type

const decodeManifest = Schema.decodeUnknownEffect(Manifest, { onExcessProperty: "error" })
const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1()

const limits: BoundedJson.Limits = {
  maxBytes: maximumManifestBytes,
  maxDepth: maximumDepth,
  maxMembers: 4_096,
  maxNodes: 16_384,
  maxStringBytes: maximumManifestBytes,
  maxKeyBytes: 256
}

const refuse = (path: string, detail: string): Refusal =>
  new Refusal({
    reason: "invalid",
    ...(path === "" ? {} : { path }),
    // Issues are formatted without their input, so a detail is bounded by the schema's own text.
    detail
  })

/**
 * Decodes an already-parsed manifest, refusing an unknown field, a union
 * entry carrying both alternatives, or anything past the limits.
 *
 * The input is first copied as bounded, inert JSON (no accessors, no cycles,
 * at most {@link maximumDepth} deep), so a hostile object cannot run code or
 * change after admission.
 *
 * @category decoding
 * @since 1.1.0
 */
export const decode = (input: unknown): Effect.Effect<Manifest, Refusal> =>
  Effect.suspend(() => {
    const admitted = BoundedJson.admit(input, limits)
    if (!admitted.ok) {
      return Effect.fail(
        refuse(
          Path.join(admitted.path.map((segment) => /^\d+$/.test(segment) ? Number(segment) : segment)),
          admitted.complaint
        )
      )
    }
    return decodeManifest(admitted.value).pipe(
      Effect.mapError((error) => {
        const [first] = formatIssue(error.issue).issues
        return refuse(Path.join(first!.path as ReadonlyArray<PropertyKey>), first!.message)
      })
    )
  })

/**
 * Parses and decodes a manifest's JSON text: the byte limit first, then
 * `JSON.parse`, then {@link decode}.
 *
 * @category decoding
 * @since 1.1.0
 */
export const parse = (text: string): Effect.Effect<Manifest, Refusal> =>
  Effect.suspend(() => {
    if (new TextEncoder().encode(text).byteLength > maximumManifestBytes) {
      return Effect.fail(refuse("", `the manifest exceeds ${maximumManifestBytes} bytes`))
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return Effect.fail(refuse("", "the manifest is not JSON"))
    }
    return decode(parsed)
  })
