/**
 * The plugin manifest: data a host reads without running plugin code.
 *
 * Every schema here is the closed shape decision 0017 prints. `decode` and
 * `parse` admit a manifest or refuse it with a {@link Refusal} naming the
 * failing field. `Load.load` applies the checks beyond the schema.
 *
 * @since 1.1.0
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Refusal } from "./Contribution.vibe";
/**
 * The plugin API this package's loader implements. `requires.api` is a range
 * over it.
 *
 * @category constants
 * @since 1.1.0
 */
export declare const PLUGIN_API = "1.0.0";
/**
 * First segments only the core may use, for plugin ids, contribution ids and
 * owned flow tags.
 *
 * @category constants
 * @since 1.1.0
 */
export declare const RESERVED: ReadonlyArray<string>;
/**
 * The largest manifest, in UTF-8 bytes of its JSON text.
 *
 * @category limits
 * @since 1.1.0
 */
export declare const maximumManifestBytes = 65536;
/**
 * The most entries one contribution point holds.
 *
 * @category limits
 * @since 1.1.0
 */
export declare const maximumEntriesPerPoint = 64;
/**
 * The largest JSON Schema, in UTF-8 bytes serialized, before and after its
 * references are inlined.
 *
 * @category limits
 * @since 1.1.0
 */
export declare const maximumSchemaBytes: number;
/**
 * The deepest nesting of arrays and objects a manifest may have.
 *
 * @category limits
 * @since 1.1.0
 */
export declare const maximumDepth = 32;
/**
 * A plugin's id, and the namespace of its views, commands, hooks, settings,
 * queries and records.
 *
 * @category schemas
 * @since 1.1.0
 */
export declare const PluginId: Schema.String;
/**
 * `<plugin>/<name>`: a view, slot entry, command, hook, setting, query or card
 * kind in a plugin's namespace.
 *
 * @category schemas
 * @since 1.1.0
 */
export declare const Qualified: Schema.String;
/**
 * A flow's tag, as `Flow.make`'s first argument: `app/navigate`, `run/answer`.
 *
 * @category schemas
 * @since 1.1.0
 */
export declare const FlowTag: Schema.String;
/**
 * A release version, never a prerelease.
 *
 * @category schemas
 * @since 1.1.0
 */
export declare const Version: Schema.String;
/**
 * A version range in `Pack.compatible`'s grammar: `*`, hyphen ranges, and
 * conjunctions of =, >=, >, <=, <, ^ and ~.
 *
 * @category schemas
 * @since 1.1.0
 */
export declare const Range: Schema.NonEmptyString;
/**
 * The least role that may see or run a contribution.
 *
 * @category schemas
 * @since 1.1.0
 */
export declare const Minimum: Schema.Literals<readonly ["anyone", "guest", "member", "maintainer", "admin"]>;
/**
 * The least role that may see or run a contribution.
 *
 * @category models
 * @since 1.1.0
 */
export type Minimum = typeof Minimum.Type;
/**
 * A capability, in `@smthrs/capability`'s grammar.
 *
 * @category schemas
 * @since 1.1.0
 */
export declare const Capability: Schema.NonEmptyString;
/**
 * A short title.
 *
 * @category schemas
 * @since 1.1.0
 */
export declare const Title: Schema.NonEmptyString;
/**
 * A paragraph of prose.
 *
 * @category schemas
 * @since 1.1.0
 */
export declare const Prose: Schema.NonEmptyString;
/**
 * A condition in the closed `when` grammar (see the `When` module).
 *
 * @category schemas
 * @since 1.1.0
 */
export declare const When: Schema.String;
/**
 * A path confined to the plugin root, portable across hosts: `/`-separated
 * segments of letters, digits and `._@+-`, with no leading `/`, no empty, `.`
 * or `..` segment, no scheme (`https:`) and no backslash.
 *
 * @category schemas
 * @since 1.1.0
 */
export declare const RelativePath: Schema.String;
/**
 * A JSON Schema in the closed subset the `JsonSchema` module admits: `$ref`
 * only to this manifest's `#/$defs/…`, never a URL; at most 16 KiB.
 *
 * @category schemas
 * @since 1.1.0
 */
export declare const JsonSchema: Schema.Codec<Schema.Json, Schema.Json, never, never>;
/**
 * A query a contribution may read: a core projection (`core/waits`) or one of
 * this plugin's own.
 *
 * @category schemas
 * @since 1.1.0
 */
export declare const QueryRef: Schema.String;
/**
 * A query a contribution may read.
 *
 * @category models
 * @since 1.1.0
 */
export type QueryRef = typeof QueryRef.Type;
/**
 * Values the host fills, in the closed grammar of the `Bind` module: a JSON
 * literal, or a reference rooted at `$item`, `$event` or `$key`.
 *
 * @category schemas
 * @since 1.1.0
 */
export declare const Args: Schema.$Record<Schema.String, Schema.Codec<Schema.Json, Schema.Json, never, never>>;
/**
 * Values the host fills.
 *
 * @category models
 * @since 1.1.0
 */
export type Args = typeof Args.Type;
/**
 * A view event: it runs a flow with host-bound args, or stays inside the view.
 *
 * @category schemas
 * @since 1.1.0
 */
export declare const Event: Schema.Union<readonly [Schema.Struct<{
    readonly name: Schema.String;
    readonly payload: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
    readonly flow: Schema.String;
    readonly args: Schema.$Record<Schema.String, Schema.Codec<Schema.Json, Schema.Json, never, never>>;
}>, Schema.Struct<{
    readonly name: Schema.String;
    readonly local: Schema.Literal<true>;
}>]>;
/**
 * A view event.
 *
 * @category models
 * @since 1.1.0
 */
export type Event = typeof Event.Type;
/**
 * How a UI contribution draws. `component` only for a plugin compiled into
 * the build.
 *
 * @category schemas
 * @since 1.1.0
 */
export declare const Render: Schema.Union<readonly [Schema.Struct<{
    readonly kind: Schema.Literal<"blocks">;
    readonly blocks: Schema.$Array<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
}>, Schema.Struct<{
    readonly kind: Schema.Literal<"view">;
    readonly module: Schema.String;
}>, Schema.Struct<{
    readonly kind: Schema.Literal<"app">;
    readonly module: Schema.String;
}>, Schema.Struct<{
    readonly kind: Schema.Literal<"component">;
    readonly export: Schema.NonEmptyString;
}>]>;
/**
 * How a UI contribution draws.
 *
 * @category models
 * @since 1.1.0
 */
export type Render = typeof Render.Type;
/**
 * A view in the chat shell, inline and/or full.
 *
 * @category schemas
 * @since 1.1.0
 */
export declare const View: Schema.Struct<{
    readonly id: Schema.String;
    readonly title: Schema.NonEmptyString;
    readonly scope: Schema.Literals<readonly ["app", "repository"]>;
    readonly path: Schema.String;
    readonly sizes: Schema.$Array<Schema.Literals<readonly ["inline", "full"]>>;
    readonly minimum: Schema.Literals<readonly ["anyone", "guest", "member", "maintainer", "admin"]>;
    readonly render: Schema.Union<readonly [Schema.Struct<{
        readonly kind: Schema.Literal<"blocks">;
        readonly blocks: Schema.$Array<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
    }>, Schema.Struct<{
        readonly kind: Schema.Literal<"view">;
        readonly module: Schema.String;
    }>, Schema.Struct<{
        readonly kind: Schema.Literal<"app">;
        readonly module: Schema.String;
    }>, Schema.Struct<{
        readonly kind: Schema.Literal<"component">;
        readonly export: Schema.NonEmptyString;
    }>]>;
    readonly reads: Schema.optional<Schema.$Array<Schema.String>>;
    readonly events: Schema.optional<Schema.$Array<Schema.Union<readonly [Schema.Struct<{
        readonly name: Schema.String;
        readonly payload: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
        readonly flow: Schema.String;
        readonly args: Schema.$Record<Schema.String, Schema.Codec<Schema.Json, Schema.Json, never, never>>;
    }>, Schema.Struct<{
        readonly name: Schema.String;
        readonly local: Schema.Literal<true>;
    }>]>>>;
}>;
/**
 * A view in the chat shell.
 *
 * @category models
 * @since 1.1.0
 */
export type View = typeof View.Type;
/**
 * An entry in a named place.
 *
 * @category schemas
 * @since 1.1.0
 */
export declare const Slot: Schema.Struct<{
    readonly slot: Schema.Literals<readonly ["shell.header", "shell.nav", "repo.tabs", "branch.pane", "item.pane"]>;
    readonly id: Schema.String;
    readonly order: Schema.optional<Schema.Int>;
    readonly when: Schema.optional<Schema.String>;
    readonly minimum: Schema.Literals<readonly ["anyone", "guest", "member", "maintainer", "admin"]>;
    readonly render: Schema.Union<readonly [Schema.Struct<{
        readonly kind: Schema.Literal<"blocks">;
        readonly blocks: Schema.$Array<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
    }>, Schema.Struct<{
        readonly kind: Schema.Literal<"view">;
        readonly module: Schema.String;
    }>, Schema.Struct<{
        readonly kind: Schema.Literal<"app">;
        readonly module: Schema.String;
    }>, Schema.Struct<{
        readonly kind: Schema.Literal<"component">;
        readonly export: Schema.NonEmptyString;
    }>]>;
    readonly reads: Schema.optional<Schema.$Array<Schema.String>>;
}>;
/**
 * An entry in a named place.
 *
 * @category models
 * @since 1.1.0
 */
export type Slot = typeof Slot.Type;
/**
 * A flow with fixed `args`, as a slash command, a palette entry or both.
 *
 * @category schemas
 * @since 1.1.0
 */
export declare const Command: Schema.Struct<{
    readonly id: Schema.String;
    readonly flow: Schema.String;
    readonly title: Schema.NonEmptyString;
    readonly minimum: Schema.Literals<readonly ["anyone", "guest", "member", "maintainer", "admin"]>;
    readonly args: Schema.optional<Schema.$Record<Schema.String, Schema.Codec<Schema.Json, Schema.Json, never, never>>>;
    readonly slash: Schema.optional<Schema.Struct<{
        readonly name: Schema.String;
        readonly fields: Schema.optional<Schema.$Array<Schema.String>>;
        readonly hidden: Schema.optional<Schema.$Array<Schema.String>>;
    }>>;
    readonly palette: Schema.optional<Schema.Boolean>;
}>;
/**
 * A flow as a slash command or palette entry.
 *
 * @category models
 * @since 1.1.0
 */
export type Command = typeof Command.Type;
/**
 * A key and a `when`, with exactly one action: a command, or an event the
 * `when` clause's view declares. `fields` fill the event's payload from the key
 * itself (`{ "index": "$key.index" }` for `digit`).
 *
 * @category schemas
 * @since 1.1.0
 */
export declare const Keybinding: Schema.Union<readonly [Schema.Struct<{
    readonly key: Schema.String;
    readonly when: Schema.optional<Schema.String>;
    readonly command: Schema.String;
}>, Schema.Struct<{
    readonly key: Schema.String;
    readonly when: Schema.String;
    readonly event: Schema.String;
    readonly fields: Schema.optional<Schema.$Record<Schema.String, Schema.Codec<Schema.Json, Schema.Json, never, never>>>;
}>]>;
/**
 * A key and a `when`, with exactly one action.
 *
 * @category models
 * @since 1.1.0
 */
export type Keybinding = typeof Keybinding.Type;
/**
 * A card kind in the conversation.
 *
 * @category schemas
 * @since 1.1.0
 */
export declare const Card: Schema.Struct<{
    readonly kind: Schema.String;
    readonly payload: Schema.Codec<Schema.Json, Schema.Json, never, never>;
    readonly sizes: Schema.$Array<Schema.Literals<readonly ["inline", "full"]>>;
    readonly render: Schema.Union<readonly [Schema.Struct<{
        readonly kind: Schema.Literal<"blocks">;
        readonly blocks: Schema.$Array<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
    }>, Schema.Struct<{
        readonly kind: Schema.Literal<"view">;
        readonly module: Schema.String;
    }>, Schema.Struct<{
        readonly kind: Schema.Literal<"app">;
        readonly module: Schema.String;
    }>, Schema.Struct<{
        readonly kind: Schema.Literal<"component">;
        readonly export: Schema.NonEmptyString;
    }>]>;
}>;
/**
 * A person or repository setting with a JSON Schema. A secret field refuses.
 *
 * @category schemas
 * @since 1.1.0
 */
export declare const Setting: Schema.Struct<{
    readonly key: Schema.String;
    readonly title: Schema.NonEmptyString;
    readonly scope: Schema.Literals<readonly ["person", "repository"]>;
    readonly schema: Schema.Codec<Schema.Json, Schema.Json, never, never>;
    readonly default: Schema.Codec<Schema.Json, Schema.Json, never, never>;
    readonly minimum: Schema.Literals<readonly ["anyone", "guest", "member", "maintainer", "admin"]>;
}>;
/**
 * An event, cron, webhook or other runs' events that starts a flow.
 *
 * @category schemas
 * @since 1.1.0
 */
export declare const Trigger: Schema.Struct<{
    readonly on: Schema.String;
    readonly flow: Schema.String;
    readonly title: Schema.NonEmptyString;
    readonly over: Schema.optional<Schema.$Array<Schema.String>>;
}>;
/**
 * A seam a plugin owns.
 *
 * @category schemas
 * @since 1.1.0
 */
export declare const Hook: Schema.Struct<{
    readonly id: Schema.String;
    readonly title: Schema.NonEmptyString;
    readonly kind: Schema.Literals<readonly ["collect", "select", "narrow", "guard", "observe"]>;
    readonly input: Schema.Codec<Schema.Json, Schema.Json, never, never>;
    readonly output: Schema.Codec<Schema.Json, Schema.Json, never, never>;
    readonly taps: Schema.Literals<readonly ["built-in", "repository", "any"]>;
    readonly deadline: Schema.optional<Schema.Int>;
}>;
/**
 * A flow (any hook) or a value (`collect` hooks only) on a hook.
 *
 * @category schemas
 * @since 1.1.0
 */
export declare const Tap: Schema.Union<readonly [Schema.Struct<{
    readonly hook: Schema.String;
    readonly flow: Schema.String;
}>, Schema.Struct<{
    readonly hook: Schema.String;
    readonly value: Schema.Codec<Schema.Json, Schema.Json, never, never>;
}>]>;
/**
 * A named model use.
 *
 * @category schemas
 * @since 1.1.0
 */
export declare const ModelRole: Schema.Struct<{
    readonly role: Schema.String;
    readonly title: Schema.NonEmptyString;
    readonly default: Schema.Literals<readonly ["agent", "judge", "renderer"]>;
}>;
/**
 * Small JSON records only the plugin's flows write.
 *
 * @category schemas
 * @since 1.1.0
 */
export declare const Records: Schema.Struct<{
    readonly collection: Schema.String;
    readonly scope: Schema.Literals<readonly ["person", "repository"]>;
    readonly schema: Schema.Codec<Schema.Json, Schema.Json, never, never>;
}>;
/**
 * A plugin manifest, `plugin.json`.
 *
 * @category schemas
 * @since 1.1.0
 */
export declare const Manifest: Schema.Struct<{
    readonly apiVersion: Schema.Literal<1>;
    readonly id: Schema.String;
    readonly version: Schema.String;
    readonly title: Schema.NonEmptyString;
    readonly description: Schema.NonEmptyString;
    readonly requires: Schema.Struct<{
        readonly api: Schema.NonEmptyString;
        readonly plugins: Schema.optional<Schema.$Record<Schema.String, Schema.NonEmptyString>>;
    }>;
    readonly capabilities: Schema.$Array<Schema.NonEmptyString>;
    readonly uses: Schema.optional<Schema.$Array<Schema.String>>;
    readonly flows: Schema.optional<Schema.$Array<Schema.String>>;
    readonly skills: Schema.optional<Schema.$Array<Schema.String>>;
    readonly owns: Schema.optional<Schema.$Array<Schema.String>>;
    readonly userOnly: Schema.optional<Schema.$Record<Schema.String, Schema.NonEmptyString>>;
    readonly $defs: Schema.optional<Schema.$Record<Schema.String, Schema.Codec<Schema.Json, Schema.Json, never, never>>>;
    readonly contributes: Schema.optional<Schema.Struct<{
        readonly views: Schema.optional<Schema.$Array<Schema.Struct<{
            readonly id: Schema.String;
            readonly title: Schema.NonEmptyString;
            readonly scope: Schema.Literals<readonly ["app", "repository"]>;
            readonly path: Schema.String;
            readonly sizes: Schema.$Array<Schema.Literals<readonly ["inline", "full"]>>;
            readonly minimum: Schema.Literals<readonly ["anyone", "guest", "member", "maintainer", "admin"]>;
            readonly render: Schema.Union<readonly [Schema.Struct<{
                readonly kind: Schema.Literal<"blocks">;
                readonly blocks: Schema.$Array<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
            }>, Schema.Struct<{
                readonly kind: Schema.Literal<"view">;
                readonly module: Schema.String;
            }>, Schema.Struct<{
                readonly kind: Schema.Literal<"app">;
                readonly module: Schema.String;
            }>, Schema.Struct<{
                readonly kind: Schema.Literal<"component">;
                readonly export: Schema.NonEmptyString;
            }>]>;
            readonly reads: Schema.optional<Schema.$Array<Schema.String>>;
            readonly events: Schema.optional<Schema.$Array<Schema.Union<readonly [Schema.Struct<{
                readonly name: Schema.String;
                readonly payload: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
                readonly flow: Schema.String;
                readonly args: Schema.$Record<Schema.String, Schema.Codec<Schema.Json, Schema.Json, never, never>>;
            }>, Schema.Struct<{
                readonly name: Schema.String;
                readonly local: Schema.Literal<true>;
            }>]>>>;
        }>>>;
        readonly slots: Schema.optional<Schema.$Array<Schema.Struct<{
            readonly slot: Schema.Literals<readonly ["shell.header", "shell.nav", "repo.tabs", "branch.pane", "item.pane"]>;
            readonly id: Schema.String;
            readonly order: Schema.optional<Schema.Int>;
            readonly when: Schema.optional<Schema.String>;
            readonly minimum: Schema.Literals<readonly ["anyone", "guest", "member", "maintainer", "admin"]>;
            readonly render: Schema.Union<readonly [Schema.Struct<{
                readonly kind: Schema.Literal<"blocks">;
                readonly blocks: Schema.$Array<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
            }>, Schema.Struct<{
                readonly kind: Schema.Literal<"view">;
                readonly module: Schema.String;
            }>, Schema.Struct<{
                readonly kind: Schema.Literal<"app">;
                readonly module: Schema.String;
            }>, Schema.Struct<{
                readonly kind: Schema.Literal<"component">;
                readonly export: Schema.NonEmptyString;
            }>]>;
            readonly reads: Schema.optional<Schema.$Array<Schema.String>>;
        }>>>;
        readonly commands: Schema.optional<Schema.$Array<Schema.Struct<{
            readonly id: Schema.String;
            readonly flow: Schema.String;
            readonly title: Schema.NonEmptyString;
            readonly minimum: Schema.Literals<readonly ["anyone", "guest", "member", "maintainer", "admin"]>;
            readonly args: Schema.optional<Schema.$Record<Schema.String, Schema.Codec<Schema.Json, Schema.Json, never, never>>>;
            readonly slash: Schema.optional<Schema.Struct<{
                readonly name: Schema.String;
                readonly fields: Schema.optional<Schema.$Array<Schema.String>>;
                readonly hidden: Schema.optional<Schema.$Array<Schema.String>>;
            }>>;
            readonly palette: Schema.optional<Schema.Boolean>;
        }>>>;
        readonly keybindings: Schema.optional<Schema.$Array<Schema.Union<readonly [Schema.Struct<{
            readonly key: Schema.String;
            readonly when: Schema.optional<Schema.String>;
            readonly command: Schema.String;
        }>, Schema.Struct<{
            readonly key: Schema.String;
            readonly when: Schema.String;
            readonly event: Schema.String;
            readonly fields: Schema.optional<Schema.$Record<Schema.String, Schema.Codec<Schema.Json, Schema.Json, never, never>>>;
        }>]>>>;
        readonly cards: Schema.optional<Schema.$Array<Schema.Struct<{
            readonly kind: Schema.String;
            readonly payload: Schema.Codec<Schema.Json, Schema.Json, never, never>;
            readonly sizes: Schema.$Array<Schema.Literals<readonly ["inline", "full"]>>;
            readonly render: Schema.Union<readonly [Schema.Struct<{
                readonly kind: Schema.Literal<"blocks">;
                readonly blocks: Schema.$Array<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
            }>, Schema.Struct<{
                readonly kind: Schema.Literal<"view">;
                readonly module: Schema.String;
            }>, Schema.Struct<{
                readonly kind: Schema.Literal<"app">;
                readonly module: Schema.String;
            }>, Schema.Struct<{
                readonly kind: Schema.Literal<"component">;
                readonly export: Schema.NonEmptyString;
            }>]>;
        }>>>;
        readonly settings: Schema.optional<Schema.$Array<Schema.Struct<{
            readonly key: Schema.String;
            readonly title: Schema.NonEmptyString;
            readonly scope: Schema.Literals<readonly ["person", "repository"]>;
            readonly schema: Schema.Codec<Schema.Json, Schema.Json, never, never>;
            readonly default: Schema.Codec<Schema.Json, Schema.Json, never, never>;
            readonly minimum: Schema.Literals<readonly ["anyone", "guest", "member", "maintainer", "admin"]>;
        }>>>;
        readonly triggers: Schema.optional<Schema.$Array<Schema.Struct<{
            readonly on: Schema.String;
            readonly flow: Schema.String;
            readonly title: Schema.NonEmptyString;
            readonly over: Schema.optional<Schema.$Array<Schema.String>>;
        }>>>;
        readonly hooks: Schema.optional<Schema.$Array<Schema.Struct<{
            readonly id: Schema.String;
            readonly title: Schema.NonEmptyString;
            readonly kind: Schema.Literals<readonly ["collect", "select", "narrow", "guard", "observe"]>;
            readonly input: Schema.Codec<Schema.Json, Schema.Json, never, never>;
            readonly output: Schema.Codec<Schema.Json, Schema.Json, never, never>;
            readonly taps: Schema.Literals<readonly ["built-in", "repository", "any"]>;
            readonly deadline: Schema.optional<Schema.Int>;
        }>>>;
        readonly taps: Schema.optional<Schema.$Array<Schema.Union<readonly [Schema.Struct<{
            readonly hook: Schema.String;
            readonly flow: Schema.String;
        }>, Schema.Struct<{
            readonly hook: Schema.String;
            readonly value: Schema.Codec<Schema.Json, Schema.Json, never, never>;
        }>]>>>;
        readonly modelRoles: Schema.optional<Schema.$Array<Schema.Struct<{
            readonly role: Schema.String;
            readonly title: Schema.NonEmptyString;
            readonly default: Schema.Literals<readonly ["agent", "judge", "renderer"]>;
        }>>>;
        readonly records: Schema.optional<Schema.$Array<Schema.Struct<{
            readonly collection: Schema.String;
            readonly scope: Schema.Literals<readonly ["person", "repository"]>;
            readonly schema: Schema.Codec<Schema.Json, Schema.Json, never, never>;
        }>>>;
    }>>;
}>;
/**
 * A decoded plugin manifest.
 *
 * @category models
 * @since 1.1.0
 */
export type Manifest = typeof Manifest.Type;
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
export declare const decode: (input: unknown) => Effect.Effect<Manifest, Refusal>;
/**
 * Parses and decodes a manifest's JSON text: the byte limit first, then
 * `JSON.parse`, then {@link decode}.
 *
 * @category decoding
 * @since 1.1.0
 */
export declare const parse: (text: string) => Effect.Effect<Manifest, Refusal>;
