/**
 * The flow catalog: discovered flows joined with their declarations.
 *
 * A repository's flows are discovered from `flows/` by the registry, and how
 * the repository presents them is declared in `.smithers/FACTORY.ts` with
 * {@link Flow.Flow} under the factory's `flows` key. Neither side alone is a
 * listing a reader can trust without running discovery: the Worker that
 * serves smithers.sh reads the public mirror and imports nothing, and a
 * workspace without `node_modules` cannot evaluate `FACTORY.ts`. The
 * `FactoryProjection` target (`Factory.ts`) projects both into the `flows`
 * rows of the checked-in `.smithers/factory.json`.
 *
 * This module is the pure half: the shape of a catalog row and the rules
 * that order the rows, testable without a filesystem. The discovery runs in
 * the executor, which hands {@link rows} the discovered flows.
 *
 * @since 1.0.0
 */
import * as Schema from "effect/Schema";
import type * as Flow from "./Flow.vibe";
/**
 * The entry file a flow was discovered from: a `flow.ts` module, a
 * `flow.mdx` prompt, or a foreign `SKILL.md`.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const Kind: Schema.Literals<readonly ["ts", "mdx", "skill"]>;
/**
 * The entry file a flow was discovered from.
 *
 * @category models
 * @since 1.0.0
 */
export type Kind = typeof Kind.Type;
/**
 * One flow as discovery reports it, reduced to what the catalog carries.
 *
 * `path` is workspace-relative and POSIX, so the same file renders the same
 * row on every host.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const DiscoveredFlow: Schema.Struct<{
    readonly id: Schema.NonEmptyString;
    readonly description: Schema.String;
    readonly kind: Schema.Literals<readonly ["ts", "mdx", "skill"]>;
    readonly path: Schema.NonEmptyString;
    readonly capabilities: Schema.$Array<Schema.String>;
    readonly model: Schema.NullOr<Schema.Union<readonly [Schema.String, Schema.NonEmptyArray<Schema.String>]>>;
    readonly modelInvocable: Schema.Boolean;
    readonly inputSchema: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
    readonly flows: Schema.optional<Schema.$Array<Schema.String>>;
    readonly budget: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
    readonly view: Schema.optional<Schema.NonEmptyArray<Schema.Union<readonly [Schema.Struct<{
        readonly type: Schema.Literal<"text">;
        readonly title: Schema.optional<Schema.NonEmptyString>;
        readonly text: Schema.NonEmptyString;
    }>, Schema.Struct<{
        readonly type: Schema.Literal<"links">;
        readonly title: Schema.optional<Schema.NonEmptyString>;
        readonly links: Schema.NonEmptyArray<Schema.Struct<{
            readonly label: Schema.NonEmptyString;
            readonly url: Schema.NonEmptyString;
        }>>;
    }>, Schema.Struct<{
        readonly type: Schema.Literal<"flows">;
        readonly title: Schema.optional<Schema.NonEmptyString>;
    }>, Schema.Struct<{
        readonly type: Schema.Literal<"prompt">;
        readonly flow: Schema.optional<Schema.NonEmptyString>;
        readonly title: Schema.optional<Schema.NonEmptyString>;
        readonly placeholder: Schema.optional<Schema.NonEmptyString>;
    }>, Schema.Struct<{
        readonly type: Schema.Literal<"stack">;
        readonly title: Schema.optional<Schema.NonEmptyString>;
    }>, Schema.Struct<{
        readonly type: Schema.Literal<"app">;
        readonly flow: Schema.NonEmptyString;
        readonly title: Schema.NonEmptyString;
        readonly picture: Schema.Literals<readonly ["issue", "review", "wiki", "schedule"]>;
    }>]>>>;
}>;
/**
 * One flow as discovery reports it.
 *
 * @category models
 * @since 1.0.0
 */
export type DiscoveredFlow = typeof DiscoveredFlow.Type;
/**
 * One catalog row: the discovered flow joined with its declaration.
 *
 * `summary` is `null` and `featured` is `false` for a flow no declaration
 * names, so a consumer reads every row the same way.
 *
 * `view` is the view the flow DRAWS, and it has to be on the row: the row is
 * what `Factory.renderProjection` encodes into `.smithers/factory.json`, and
 * the projection is the only place the app reads a repository's flows from
 * (`@smthrs/rpc/FactoryProjection` `FactoryFlowSchema`, the app's
 * `RepositoryFlowsSeam`). A field the row omits is dropped on encode, so the
 * monitor's custom view and a homepage that names the flow owning the landing
 * both read "declares no view" however the repository declared it (#4025).
 * It is the same `Home.FlowView` the declaration carries, so there is one
 * declaration and one view vocabulary end to end.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const Row: Schema.Struct<{
    readonly id: Schema.NonEmptyString;
    readonly description: Schema.String;
    readonly summary: Schema.NullOr<Schema.String>;
    readonly featured: Schema.Boolean;
    readonly kind: Schema.Literals<readonly ["ts", "mdx", "skill"]>;
    readonly path: Schema.NonEmptyString;
    readonly capabilities: Schema.$Array<Schema.String>;
    readonly model: Schema.NullOr<Schema.Union<readonly [Schema.String, Schema.NonEmptyArray<Schema.String>]>>;
    readonly modelInvocable: Schema.Boolean;
    readonly inputSchema: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
    readonly flows: Schema.optional<Schema.$Array<Schema.String>>;
    readonly budget: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
    readonly view: Schema.optional<Schema.NonEmptyArray<Schema.Union<readonly [Schema.Struct<{
        readonly type: Schema.Literal<"text">;
        readonly title: Schema.optional<Schema.NonEmptyString>;
        readonly text: Schema.NonEmptyString;
    }>, Schema.Struct<{
        readonly type: Schema.Literal<"links">;
        readonly title: Schema.optional<Schema.NonEmptyString>;
        readonly links: Schema.NonEmptyArray<Schema.Struct<{
            readonly label: Schema.NonEmptyString;
            readonly url: Schema.NonEmptyString;
        }>>;
    }>, Schema.Struct<{
        readonly type: Schema.Literal<"flows">;
        readonly title: Schema.optional<Schema.NonEmptyString>;
    }>, Schema.Struct<{
        readonly type: Schema.Literal<"prompt">;
        readonly flow: Schema.optional<Schema.NonEmptyString>;
        readonly title: Schema.optional<Schema.NonEmptyString>;
        readonly placeholder: Schema.optional<Schema.NonEmptyString>;
    }>, Schema.Struct<{
        readonly type: Schema.Literal<"stack">;
        readonly title: Schema.optional<Schema.NonEmptyString>;
    }>, Schema.Struct<{
        readonly type: Schema.Literal<"app">;
        readonly flow: Schema.NonEmptyString;
        readonly title: Schema.NonEmptyString;
        readonly picture: Schema.Literals<readonly ["issue", "review", "wiki", "schedule"]>;
    }>]>>>;
}>;
/**
 * One catalog row.
 *
 * @category models
 * @since 1.0.0
 */
export type Row = typeof Row.Type;
declare const FlowCatalogError_base: Schema.Class<FlowCatalogError, Schema.TaggedStruct<"smithers-build/FlowCatalogError", {
    readonly message: Schema.NonEmptyString;
}>, import("effect/Cause").YieldableError>;
/**
 * The catalog could not be joined: a declaration names no discovered flow,
 * two declarations name one flow, or the flows directory could not be read.
 *
 * @category errors
 * @since 1.0.0
 */
export declare class FlowCatalogError extends FlowCatalogError_base {
}
/**
 * Joins the discovered flows with the declarations into catalog rows.
 *
 * Rows are ordered featured first, in declaration order; then the remaining
 * declared flows, in declaration order; then every other discovered flow by
 * id. A declaration that names no discovered flow, or a flow two declarations
 * name, is a failure carrying the id: a recommendation for a flow that does
 * not exist must never be written.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const rows: (discovered: ReadonlyArray<DiscoveredFlow>, declarations: ReadonlyArray<Flow.Declaration>) => ReadonlyArray<Row>;
export {};
