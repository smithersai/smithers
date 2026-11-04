/**
 * The closed JSON Schema subset a manifest may use, its `$ref` resolution,
 * and a validator for it.
 *
 * A schema names only `#/$defs/<Name>` refs from its own manifest, never a URL,
 * so nothing is ever fetched. A field that would collect a secret refuses:
 * secrets stay opaque, and a plugin never asks a person for one. `pattern` is
 * outside the subset: a host would run a plugin's regular expression on
 * arbitrary text, and a backtracking one (`^(a+)+$`) hangs it.
 *
 * @since 1.1.0
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Schema from "effect/Schema";
import { Refusal } from "./Contribution.vibe";
/**
 * A JSON value.
 *
 * @category models
 * @since 1.1.0
 */
export type Json = Schema.Json;
/**
 * A JSON type name the subset admits.
 *
 * @category models
 * @since 1.1.0
 */
export type TypeName = "object" | "array" | "string" | "integer" | "number" | "boolean" | "null";
/**
 * A schema with every `$ref` inlined: only the admitted keywords remain.
 *
 * @category models
 * @since 1.1.0
 */
export interface Resolved {
    readonly type?: TypeName | ReadonlyArray<TypeName>;
    readonly properties?: {
        readonly [name: string]: Resolved;
    };
    readonly required?: ReadonlyArray<string>;
    readonly additionalProperties?: boolean;
    readonly items?: Resolved;
    readonly enum?: ReadonlyArray<Json>;
    readonly const?: Json;
    readonly minimum?: number;
    readonly maximum?: number;
    readonly minLength?: number;
    readonly maxLength?: number;
    readonly minItems?: number;
    readonly maxItems?: number;
    readonly oneOf?: ReadonlyArray<Resolved>;
    readonly anyOf?: ReadonlyArray<Resolved>;
    readonly title?: string;
    readonly description?: string;
    readonly default?: Json;
}
/**
 * The largest schema, in UTF-8 bytes serialized, before and after its refs
 * are inlined.
 *
 * @category limits
 * @since 1.1.0
 */
export declare const maximumBytes = 16384;
/**
 * The deepest a schema nests, counting inlined references.
 *
 * @category limits
 * @since 1.1.0
 */
export declare const maximumDepth = 32;
/**
 * Admits a schema in the closed subset and inlines every `$ref` from `defs`.
 *
 * Refuses `schema_unresolved` for a keyword outside the subset, a URL or
 * unknown ref, or a ref cycle; `secret_field` for a `password` format,
 * `writeOnly: true`, or a property named like a secret; `invalid` for a
 * malformed keyword or a schema over {@link maximumBytes}. `at` prefixes
 * every path the refusal names; refs inside `defs` are named `$defs.<Name>`.
 *
 * @category resolution
 * @since 1.1.0
 */
export declare const resolve: (schema: Json, defs?: {
    readonly [name: string]: Json;
}, at?: string) => Effect.Effect<Resolved, Refusal>;
/**
 * Every property name a resolved schema declares, its `oneOf` and `anyOf`
 * members' included, first declaration first.
 *
 * @category accessors
 * @since 1.1.0
 */
export declare const properties: (resolved: Resolved) => ReadonlyArray<string>;
/**
 * Validates a value against a resolved schema: the path of the first value
 * that fails (`$.note`, `$.options[2]`), or none when it conforms.
 *
 * @category validation
 * @since 1.1.0
 */
export declare const validate: (resolved: Resolved, value: unknown) => Option.Option<string>;
/**
 * The schema of a named property: from `properties`, else from the first
 * `oneOf` or `anyOf` member that declares it.
 *
 * @category accessors
 * @since 1.1.0
 */
export declare const property: (resolved: Resolved, name: string) => Resolved | undefined;
/**
 * The schema a path reaches: a name steps into a property, a number into
 * `items`. Undefined when the schema does not declare the step.
 *
 * @category accessors
 * @since 1.1.0
 */
export declare const at: (resolved: Resolved, path: ReadonlyArray<string | number>) => Resolved | undefined;
