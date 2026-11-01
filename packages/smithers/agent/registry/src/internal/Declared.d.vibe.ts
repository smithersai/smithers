/**
 * Schema/metadata records matching the FlowBinding.Declared contract.
 *
 * @since 0.1.0
 */
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
/**
 * The schema and metadata fields accepted at module admission.
 * @since 0.1.0
 * @private
 */
export declare const Declared: Schema.Struct<{
    readonly name: Schema.optional<Schema.String>;
    readonly description: Schema.optional<Schema.String>;
    readonly input: Schema.declare<Schema.Top, unknown>;
    readonly output: Schema.declare<Schema.Top, unknown>;
    readonly capabilities: Schema.$Array<Schema.String>;
    readonly effects: Schema.Union<readonly [Schema.Undefined, Schema.Struct<{
        readonly reads: Schema.$Array<Schema.String>;
        readonly writes: Schema.$Array<Schema.String>;
        readonly mode: Schema.Literals<readonly ["hermetic", "expected"]>;
        readonly onConflict: Schema.Literals<readonly ["serialize", "lane", "fail"]>;
        readonly tier: Schema.optional<Schema.Literals<readonly ["sealed", "compensable", "irreversible"]>>;
    }>]>;
    readonly flows: Schema.optional<Schema.$Array<Schema.String>>;
    readonly model: Schema.optional<Schema.Union<readonly [Schema.String, Schema.NonEmptyArray<Schema.String>]>>;
    readonly annotations: Schema.optional<Schema.declare<Context.Context<never>, Context.Context<never>>>;
    readonly budget: Schema.optional<Schema.Struct<{
        readonly tokens: Schema.optional<Schema.Int>;
        readonly milliseconds: Schema.optional<Schema.Int>;
        readonly usd: Schema.optional<Schema.Finite>;
        readonly onExceeded: Schema.optional<Schema.Literals<readonly ["fail", "warn", "skip-remaining", "park"]>>;
        readonly deadline: Schema.optional<Schema.Int>;
    }>>;
    readonly deadline: Schema.optional<Schema.Int>;
    readonly modelInvocable: Schema.optional<Schema.Boolean>;
    readonly disableModelInvocation: Schema.optional<Schema.Boolean>;
}>;
/**
 * Refuses misspelled fields at every record level.
 * @since 0.1.0
 * @private
 */
export declare const decode: (input: unknown, options?: import("effect/SchemaAST").ParseOptions) => import("effect/Effect").Effect<{
    readonly name?: string | undefined;
    readonly description?: string | undefined;
    readonly input: Schema.Top;
    readonly output: Schema.Top;
    readonly capabilities: readonly string[];
    readonly effects: {
        readonly reads: readonly string[];
        readonly writes: readonly string[];
        readonly mode: "expected" | "hermetic";
        readonly onConflict: "fail" | "lane" | "serialize";
        readonly tier?: "compensable" | "irreversible" | "sealed" | undefined;
    } | undefined;
    readonly flows?: readonly string[] | undefined;
    readonly model?: string | readonly [string, ...string[]] | undefined;
    readonly annotations?: Context.Context<never> | undefined;
    readonly budget?: {
        readonly tokens?: number | undefined;
        readonly milliseconds?: number | undefined;
        readonly usd?: number | undefined;
        readonly onExceeded?: "fail" | "park" | "skip-remaining" | "warn" | undefined;
        readonly deadline?: number | undefined;
    } | undefined;
    readonly deadline?: number | undefined;
    readonly modelInvocable?: boolean | undefined;
    readonly disableModelInvocation?: boolean | undefined;
}, Schema.SchemaError, never>;
/**
 * Metadata-only key validation; values remain source text and are never evaluated.
 * @since 0.1.0
 * @private
 */
export declare const keys: Schema.Struct<{
    [k: string]: Schema.optionalKey<Schema.Unknown>;
}>;
