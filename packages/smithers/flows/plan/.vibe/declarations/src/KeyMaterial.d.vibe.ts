/**
 * The key-material contract: what a planner hands the step-key compiler.
 *
 * Revived from the deleted `packages/smithers/flows/keys/src/KeyMaterial.ts`.
 * It does NOT return to `@smthrs/keys`: that package owns generic derivation
 * and stored-key validation, while material is a *plan-shaped* concept. It
 * lives here, above `@smthrs/keys`, so the key package stays a leaf.
 *
 * Governing contract: the step-key rules at
 * https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/plan/docs/concepts/step-keys.md. Material is computed with no I/O,
 * and two hardening rules shape it: the nominal, never shape-sniffed
 * `InputRef` and the hashed `version`.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema";
/**
 * A reference to one declared input of a node: a value hashed inline, or the
 * key of an upstream node whose result this node consumes.
 *
 * The three variants are tagged, and the tag is hashed, so `Pending{from}` and
 * `Ref{from, path: []}` — which resolve to the same dependency digest — can
 * never collide.
 *
 * - `Literal` hashes `value` inline.
 * - `Ref` consumes the value at `path` inside node `from`'s result.
 * - `Pending` consumes node `from`'s whole result.
 *
 * @since 0.1.0
 * @category schemas
 */
export declare const InputRef: Schema.Union<readonly [Schema.TaggedStruct<"Literal", {
    readonly value: Schema.Unknown;
}>, Schema.TaggedStruct<"Ref", {
    readonly from: Schema.NonEmptyString;
    readonly path: Schema.$Array<Schema.String>;
}>, Schema.TaggedStruct<"Pending", {
    readonly from: Schema.NonEmptyString;
}>]>;
/**
 * The value form of {@link InputRef}.
 *
 * @since 0.1.0
 * @category models
 */
export type InputRef = typeof InputRef.Type;
/**
 * The material version. Folded into every hashed body so a bump re-keys every
 * node derived from it — the original's second collision fix, kept.
 *
 * @since 0.1.0
 * @category constants
 */
export declare const version = "flows/key-material/v2";
/**
 * Everything that can change a node's result, handed to the digest.
 *
 * `effects` and `placement` are opaque: canonically serialized, never
 * interpreted, which is what keeps the compiler independent of whatever the
 * flow builder decides an effect declaration looks like.
 *
 * `version` must equal {@link version}. `kind` is the effect tier. `inputs`
 * are hashed in order; `layers` and `capabilities` name what the node runs
 * with.
 *
 * @since 0.1.0
 * @category schemas
 */
export declare const KeyMaterial: Schema.Struct<{
    readonly version: Schema.Literal<"flows/key-material/v2">;
    readonly kind: Schema.Literals<readonly ["sealed", "compensable", "irreversible"]>;
    readonly nondeterministic: Schema.optional<Schema.Literal<true>>;
    readonly body: Schema.Unknown;
    readonly inputs: Schema.$Array<Schema.Union<readonly [Schema.TaggedStruct<"Literal", {
        readonly value: Schema.Unknown;
    }>, Schema.TaggedStruct<"Ref", {
        readonly from: Schema.NonEmptyString;
        readonly path: Schema.$Array<Schema.String>;
    }>, Schema.TaggedStruct<"Pending", {
        readonly from: Schema.NonEmptyString;
    }>]>>;
    readonly layers: Schema.$Array<Schema.String>;
    readonly capabilities: Schema.$Array<Schema.String>;
    readonly effects: Schema.optional<Schema.Unknown>;
    readonly placement: Schema.optional<Schema.Unknown>;
}>;
/**
 * The value form of {@link KeyMaterial}.
 *
 * @since 0.1.0
 * @category models
 */
export type KeyMaterial = typeof KeyMaterial.Type;
/**
 * The graph-local dependencies a material names, in declaration order and
 * without duplicates. The compiler resolves exactly these before hashing, and
 * {@link module:Plan} uses them as the edge set — one derivation, so an edge
 * and a hashed reference can never disagree.
 *
 * @param material - The node's key material.
 * @returns The `from` of every `Ref` and `Pending` input, first occurrence
 * order, deduplicated.
 * @since 0.1.0
 * @category accessors
 */
export declare const dependencies: (material: KeyMaterial) => ReadonlyArray<string>;
