/**
 * The KeyMaterial → step-key compiler.
 *
 * Revived from the deleted `packages/smithers/flows/keys/src/StepKey.ts`. Two
 * deliberate deviations from the original:
 *
 * 1. **It lives here, not in `@smthrs/keys`.** That package owns generic
 *    derivation and stored-key validation; a compiler that understands plan
 *    material belongs above it.
 * 2. **It produces `@smthrs/keys` `StoredKey` values, not a second `sk1_` digest
 *    format.** The original minted its own prefix over a private `Digest`
 *    module. The engine dispatches under `StoredKey` (`FlowEngine/ActionKey.ts`),
 *    so a plan whose node keys were a *different* string format could never be
 *    the thing the cache is consulted against, and that is the whole point of
 *    a `Plan`. One key format, one hashing
 *    chokepoint (canonical JSON + injected `Crypto`), one namespace field
 *    (`kind`) distinguishing content keys from ordinal ones.
 *
 * Everything the original earned is kept: nominally branded digest inputs (a
 * literal that merely *looks* like `{digest}` hashes as a literal), set
 * normalization, the separate environment namespace, per-variant tagging of
 * resolved references, and the hashed `version`.
 *
 * Governing contract: the step-key rules at
 * https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/plan/docs/concepts/step-keys.md.
 *
 * @since 0.1.0
 */
import type { Crypto } from "@smthrs/crypto";
import { type StoredKey } from "@smthrs/keys";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as FileSet from "./FileSet.vibe";
import type * as KeyMaterial from "./KeyMaterial.vibe";
/**
 * A computed step key. Identical in representation to any other flow key —
 * `key1_` plus a SHA-256 digest of the canonical serialization of the material.
 *
 * @since 0.1.0
 * @category models
 */
export type StepKey = StoredKey;
/**
 * The nominal brand carried by every {@link DigestInput}. Kept private: the
 * only way to produce a value bearing it is {@link digestInput}, so a plain
 * value that merely happens to look like `{ digest: "..." }` — actions pass
 * content hashes around as ordinary data — can never be mistaken for a genuine
 * upstream-result digest reference. This closes a step-key collision where
 * shape-sniffing (`"digest" in value`) hashed the two identically.
 *
 * @since 0.1.0
 * @category symbols
 */
declare const DigestInputTypeId: unique symbol;
/**
 * Which kind of graph reference a {@link DigestInput} stands for. Declared
 * once here so the field on `DigestInput` and the parameter of
 * {@link digestInput} name one set and cannot drift apart.
 */
type GraphReference = "ref" | "pending" | "ref-projected";
/**
 * A precomputed digest supplied as a step input rather than a literal value.
 *
 * @since 0.1.0
 * @category models
 */
export interface DigestInput {
    readonly [DigestInputTypeId]: typeof DigestInputTypeId;
    readonly digest: string;
    /**
     * Which kind of graph reference resolved to this digest.
     *
     * Carrying the discriminator on the digest input keeps `normalizeInputs` the
     * single normalizer: it wraps every variant once, and the variants stay
     * mutually distinct because they differ in this field rather than in a
     * hand-built object a second wrap would hide.
     */
    readonly reference?: GraphReference;
    /** The projection applied to the referenced result, for `ref-projected`. */
    readonly path?: ReadonlyArray<string>;
}
/**
 * Nominally tags a precomputed digest so it is hashed as a digest reference
 * rather than a literal value.
 *
 * @param digest - The precomputed digest.
 * @param reference - Which graph reference resolved to the digest, and the
 *   projection path for `ref-projected`. Omit for a plain digest.
 * @returns The tagged digest input.
 * @since 0.1.0
 * @category constructors
 */
export declare const digestInput: (digest: string, reference?: {
    readonly reference: GraphReference;
    readonly path?: ReadonlyArray<string>;
}) => DigestInput;
/**
 * Type guard for values produced by {@link digestInput}. A plain object
 * shaped like `{ digest: "..." }` is not one.
 *
 * @param value - Any value.
 * @returns `true` only for a value carrying the private digest-input brand.
 * @since 0.1.0
 * @category guards
 */
export declare const isDigestInput: (value: unknown) => value is DigestInput;
/**
 * The engine-resolved execution environment a content key is computed under,
 * hashed in its OWN namespace rather than merged into the caller's `layers`
 * and `capabilities`.
 *
 * Three properties matter and none survives a merge:
 *
 * 1. **Non-aliasing.** Concatenating environment material onto the caller's
 *    made `caller{fs:["a"]} + env{fs:["b"]}` hash identically to
 *    `caller{fs:["a","b"]} + env{}` — a cross-run collision in the very
 *    material whose purpose is preventing one.
 * 2. **Declared vs undeclared.** `declared: false` is not the same value as
 *    `declared: true` with empty sets.
 * 3. **Composition order.** Environment layers retain declaration order,
 *    because plugin and service composition order can change behavior. The
 *    caller-owned `ContentIdentity.layers` stays set-normalized.
 *
 * `runScope` is set only when `declared` is `false`: it pins the key to one
 * run, so a step whose environment identity is unknown can never serve a
 * cross-run hit. The union enforces this for typed callers; both
 * {@link content} and {@link dispatchIdentity} validate it at run time.
 *
 * @since 0.1.0
 * @category models
 */
export type EnvironmentIdentity = typeof EnvironmentIdentity.Type;
/**
 * Validated, copyable runtime environment identity. Layer order matters;
 * capability patterns are set-like. Unknown fields are not identity material.
 * @since 1.0.0
 * @category schemas
 */
export declare const EnvironmentIdentity: Schema.Union<readonly [Schema.Struct<{
    readonly declared: Schema.Literal<true>;
    readonly layers: Schema.$Array<Schema.String>;
    readonly capabilities: Schema.$Record<Schema.String, Schema.$Array<Schema.String>>;
    readonly runScope: Schema.optionalKey<Schema.Undefined>;
}>, Schema.Struct<{
    readonly declared: Schema.Literal<false>;
    readonly layers: Schema.$Array<Schema.String>;
    readonly capabilities: Schema.$Record<Schema.String, Schema.$Array<Schema.String>>;
    readonly runScope: Schema.NonEmptyString;
}>]>;
/**
 * Caller-owned memoization context for projected dependency-value digests.
 *
 * This is the flows counterpart of Bazel's `ActionKeyContext`: one context is
 * passed through related key computations so shared input material is hashed
 * once. Concurrent requests for the same projection share the in-flight
 * digest. Entries are sound only while each settled `from` value is immutable;
 * callers must create a fresh memo when those values can change.
 *
 * `digest(from, path, compute)` runs `compute` once per address and shares its
 * result with concurrent callers. A failed or interrupted computation is not
 * kept: the next caller recomputes, and a waiter whose leader was interrupted
 * becomes the new leader instead of inheriting the interrupt.
 *
 * @since 0.1.0
 * @category models
 */
export interface DigestMemo {
    readonly digest: (from: string, path: ReadonlyArray<string>, compute: Effect.Effect<StepKey, Schema.SchemaError, Crypto.Crypto>) => Effect.Effect<StepKey, Schema.SchemaError, Crypto.Crypto>;
}
/**
 * Creates an empty projected-value digest memo. Projection addresses are
 * JSON-encoded `[from, path]` tuples so segment boundaries are unambiguous.
 *
 * @returns A memo with no entries.
 * @since 0.1.0
 * @category constructors
 */
export declare const makeDigestMemo: () => DigestMemo;
/**
 * Material describing a sealed or hermetic content-addressed step.
 *
 * @since 0.1.0
 * @category models
 */
export interface ContentIdentity {
    readonly body: unknown;
    readonly inputs: Readonly<Record<string, unknown | DigestInput>>;
    readonly layers: ReadonlyArray<string>;
    readonly capabilities: Readonly<Record<string, ReadonlyArray<string>>>;
    readonly environment?: EnvironmentIdentity | undefined;
    readonly hermetic?: {
        readonly readSet: ReadonlyArray<{
            readonly path: string;
            readonly digest: string;
        }>;
        readonly writeSet: ReadonlyArray<FileSet.Entry>;
        readonly removes?: ReadonlyArray<string> | undefined;
        readonly boundaryMode: FileSet.BoundaryMode;
    } | undefined;
}
/**
 * Material describing the run-local identity of a non-cacheable step.
 *
 * @since 0.1.0
 * @category models
 */
export interface OrdinalIdentity {
    readonly runId: string;
    readonly parentScope?: string | undefined;
    readonly ordinal: number;
    readonly tier: "compensable" | "irreversible" | "unsealed";
}
declare const KeyMaterialError_base: Schema.Class<KeyMaterialError, Schema.TaggedStruct<"@smthrs/plan/KeyMaterialError", {
    readonly code: Schema.Literals<readonly ["invalid_environment", "missing_dependency", "non_content_material"]>;
    readonly message: Schema.String;
}>, Cause.YieldableError>;
/**
 * Stable failures while deriving a key. `code` names the rule:
 *
 * - `invalid_environment`: an {@link EnvironmentIdentity} that is neither
 *   declared nor run-scoped.
 * - `missing_dependency`: a `Ref` or `Pending` input names a node with no
 *   recorded digest, or, at dispatch, a `Ref` names one with no settled
 *   result.
 * - `non_content_material`: a content-key constructor received material whose
 *   tier is not `sealed`.
 *
 * @since 0.1.0
 * @category errors
 */
export declare class KeyMaterialError extends KeyMaterialError_base {
}
/**
 * Fingerprint for binding one execution to its runtime environment, not an
 * action dispatch key. Uses the same normalization as content/dispatch keys.
 * An omitted environment is distinct from declared-empty and run-scoped ones.
 * @since 1.0.0
 * @category constructors
 */
export declare const environmentIdentity: (environment?: EnvironmentIdentity) => Effect.Effect<StoredKey, KeyMaterialError | Schema.SchemaError, Crypto.Crypto>;
/**
 * Produces a cross-run reusable key for a sealed or hermetic step. Set-like
 * declarations are normalized before serialization; write declarations remain
 * part of the identity even when the step writes nothing.
 *
 * @param identity - The step's content material.
 * @returns The content key. Fails with `invalid_environment` for a malformed
 * environment, or `SchemaError` when the material cannot be serialized.
 * @since 0.1.0
 * @category constructors
 */
export declare const content: (identity: ContentIdentity) => Effect.Effect<StepKey, KeyMaterialError | Schema.SchemaError, Crypto.Crypto>;
/**
 * Produces a run-local ordinal key for compensable, irreversible, or unsealed
 * work. These keys intentionally cannot be reused across runs.
 *
 * @param identity - The run id, optional parent scope, ordinal, and tier.
 * @returns The ordinal key.
 * @since 0.1.0
 * @category constructors
 */
export declare const ordinal: (identity: OrdinalIdentity) => Effect.Effect<StepKey, Schema.SchemaError, Crypto.Crypto>;
/**
 * Resolves graph-local references to dependency digests and constructs a
 * sealed content key. Use {@link planIdentity} to compile any effect tier.
 *
 * This is the handoff the Flow Builder Brief describes: the planner hands over
 * a topologically ordered sequence of `{ nodeId, material }`, and for each one
 * the compiler substitutes every `Ref`/`Pending` with the *already computed
 * key of the referenced node*. Structural node ids are lookup addresses only
 * and never enter the hashed value — rename a node and nothing re-keys; change
 * what a node consumes and everything downstream of it does.
 *
 * @param material - The node's key material; its tier must be `sealed`.
 * @param dependencyDigests - The key of every node the material references,
 *   by node id.
 * @returns The content key. Fails with `non_content_material` for a
 * non-sealed tier and `missing_dependency` for an unresolved reference.
 * @since 0.1.0
 * @category constructors
 */
export declare const fromKeyMaterial: (material: KeyMaterial.KeyMaterial, dependencyDigests: Readonly<Record<string, string>>) => Effect.Effect<StepKey, KeyMaterialError | Schema.SchemaError, Crypto.Crypto>;
/**
 * Identifies a declaration in a plan, independently of whether its execution
 * can be cached. Sealed material retains its existing content-key format;
 * compensable and irreversible material use a distinct, tier-bearing plan
 * namespace. These fingerprints bind approvals, not cross-run result reuse.
 * Dispatch non-cacheable work under a run-local {@link ordinal} instead.
 *
 * @since 1.0.0
 * @category constructors
 */
export declare const planIdentity: (material: KeyMaterial.KeyMaterial, dependencyDigests: Readonly<Record<string, string>>) => Effect.Effect<StepKey, KeyMaterialError | Schema.SchemaError, Crypto.Crypto>;
/**
 * Projects a settled result along a `Ref` path. Only own data properties
 * resolve, so a missing, inherited, or accessor segment yields `undefined`
 * without invoking a getter. This is a stable, distinct value: a projection that
 * walks off the end of a result is a fact about the graph, not a failure.
 * `undefined` drops out of the canonical form, so it hashes distinctly from
 * every JSON value including `null`.
 *
 * Exported because it is the ONE projection semantics for the value channel:
 * {@link dispatchIdentity} digests what this returns, so every consumer that
 * resolves a `Ref` at execution time must resolve it the same way, or two
 * inputs that key identically could be consumed differently — a stale-hit
 * vector.
 *
 * @since 0.1.0
 * @category utilities
 */
export declare const project: (value: unknown, path: ReadonlyArray<string>) => unknown;
/**
 * The key a dispatch is *cached* under, as distinct from the plan key a node
 * is *identified* by.
 *
 * A plan key folds the resolved keys of every upstream node, transitively, so
 * an edit anywhere upstream re-keys everything below it — even when the edited
 * node's output value is byte for byte what it was before. Bazel does not work
 * that way: `ActionCacheChecker` keys an action by the *content* of its
 * inputs, so an unchanged output stops invalidation dead. The file channel in
 * flows already had that property through the measured boundary digests; the
 * JSON value channel did not, and this is what gives it one.
 *
 * The derivation folds the node's OWN material — body, version, effects,
 * placement, layers, capabilities — and never an upstream key. Each material
 * input contributes content instead: a `Literal` its value, a `Ref` the digest
 * of the settled result of `from` projected along `path`, and a `Pending`
 * nothing beyond its tag. The measured hermetic boundary is folded unchanged.
 *
 * `results` must hold every dependency the material names. The scheduler's
 * halt rule guarantees it: a dependent of failed or skipped work never
 * dispatches, so a `Ref` always resolves against a success.
 *
 * @param options - The material, the dependencies' settled results, the
 *   measured hermetic boundary, and an optional environment and memo.
 * @returns The dispatch key. Fails with `non_content_material` for a
 * non-sealed tier, `missing_dependency` for a `Ref` absent from `results`,
 * or `invalid_environment` for a malformed environment.
 * @since 0.1.0
 * @category constructors
 */
export declare const dispatchIdentity: (options: {
    readonly material: KeyMaterial.KeyMaterial;
    /** The settled output value of each dependency, by node id. */
    readonly results: Readonly<Record<string, unknown>>;
    readonly hermetic: NonNullable<ContentIdentity["hermetic"]>;
    /** The engine-resolved execution environment this dispatch runs under. */
    readonly environment?: EnvironmentIdentity | undefined;
    /** Reuses projected-value digests while the corresponding settled values remain immutable. */
    readonly digestMemo?: DigestMemo | undefined;
}) => Effect.Effect<StepKey, KeyMaterialError | Schema.SchemaError, Crypto.Crypto>;
export {};
