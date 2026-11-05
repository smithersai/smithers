/**
 * The replaceable memory-recall seam.
 *
 * Recall is both a flow-valued injection slot and an Effect runtime service.
 *
 * @see https://memory.smithers.sh/reference/api/
 * @see https://smithers.sh/docs/reference/api/patterns
 *
 * @since 0.1.0
 */
import * as Pattern from "@smthrs/patterns/Pattern";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as MemoryError from "./MemoryError.vibe";
import * as MemoryStore from "../../../src/MemoryStore.ts";
import * as Namespace from "./Namespace.vibe";
/**
 * Maximum banks accepted by one model-facing recall request.
 *
 * @category constants
 * @since 0.1.0
 */
export declare const MAX_RECALL_BANKS = 16;
/**
 * Maximum code-unit length of one recall bank name.
 *
 * @category constants
 * @since 0.1.0
 */
export declare const MAX_RECALL_BANK_NAME_LENGTH = 128;
/**
 * Maximum UTF-8 byte length of a recall query.
 *
 * @category constants
 * @since 0.1.0
 */
export declare const MAX_RECALL_QUERY_BYTES: number;
/**
 * Maximum conservative byte budget accepted as `maxTokens`.
 *
 * @category constants
 * @since 0.1.0
 */
export declare const MAX_RECALL_TOKENS: number;
/**
 * Maximum tag groups accepted by one model-facing recall request.
 *
 * Every group is evaluated against every candidate row by each binding, so the
 * per-group depth and node bounds `Namespace.TagGroup` enforces only bound one
 * group. Without a cap on the array a single decoded request multiplies that
 * budget without limit, so the list is bounded here as well.
 *
 * @category constants
 * @since 0.1.0
 */
export declare const MAX_RECALL_TAG_GROUPS = 16;
/**
 * Byte budget applied when a recall request omits `maxTokens`.
 *
 * @category constants
 * @since 0.1.0
 */
export declare const DEFAULT_MAX_TOKENS = 2048;
/**
 * Rows a row-counting binding keeps for a byte budget: one per 256 bytes, at
 * least one.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const requestedRows: (maxTokens?: number) => number;
/**
 * A bank name recall accepts: non-empty and at most
 * {@link MAX_RECALL_BANK_NAME_LENGTH} code units.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const BankName: Schema.NonEmptyString;
/**
 * A recall budget: an integer UTF-8 byte ceiling from 0 to
 * {@link MAX_RECALL_TOKENS}.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const MaxTokens: Schema.Int;
/**
 * A boolean tag predicate accepted by every recall implementation.
 *
 * @category models
 * @since 0.1.0
 */
export type TagGroup = Namespace.TagGroup;
/**
 * Input to the recall slot.
 *
 * @category models
 * @since 0.1.0
 */
export declare const Input: Schema.Struct<{
    readonly banks: Schema.$Array<Schema.NonEmptyString>;
    readonly query: Schema.String;
    readonly tagGroups: Schema.optional<Schema.$Array<Schema.compose<Schema.Codec<Namespace.TagGroup, Namespace.TagGroup, never, never>, Schema.declare<Namespace.TagGroup, Namespace.TagGroup>>>>;
    readonly maxTokens: Schema.optional<Schema.Int>;
    readonly budget: Schema.optional<Schema.Literals<readonly ["low", "mid", "high"]>>;
}>;
/**
 * Input to the recall slot.
 *
 * @category models
 * @since 0.1.0
 */
export type Input = typeof Input.Type;
/**
 * One recalled memory row.
 *
 * @category models
 * @since 0.1.0
 */
export declare const Result: Schema.Struct<{
    readonly bank: Schema.String;
    readonly key: Schema.String;
    readonly text: Schema.String;
    readonly score: Schema.Number;
    readonly updatedAtMs: Schema.optional<Schema.Number>;
}>;
/**
 * One recalled memory row.
 *
 * @category models
 * @since 0.1.0
 */
export type Result = typeof Result.Type;
/**
 * Output of the recall slot.
 *
 * @category models
 * @since 0.1.0
 */
export declare const Output: Schema.$Array<Schema.Struct<{
    readonly bank: Schema.String;
    readonly key: Schema.String;
    readonly text: Schema.String;
    readonly score: Schema.Number;
    readonly updatedAtMs: Schema.optional<Schema.Number>;
}>>;
/**
 * Output of the recall slot.
 *
 * @category models
 * @since 0.1.0
 */
export type Output = typeof Output.Type;
/**
 * Flow-valued recall injection slot.
 *
 * @category slots
 * @since 0.1.0
 */
export declare const slot: Pattern.Slot<Schema.Struct<{
    readonly banks: Schema.$Array<Schema.NonEmptyString>;
    readonly query: Schema.String;
    readonly tagGroups: Schema.optional<Schema.$Array<Schema.compose<Schema.Codec<Namespace.TagGroup, Namespace.TagGroup, never, never>, Schema.declare<Namespace.TagGroup, Namespace.TagGroup>>>>;
    readonly maxTokens: Schema.optional<Schema.Int>;
    readonly budget: Schema.optional<Schema.Literals<readonly ["low", "mid", "high"]>>;
}>, Schema.$Array<Schema.Struct<{
    readonly bank: Schema.String;
    readonly key: Schema.String;
    readonly text: Schema.String;
    readonly score: Schema.Number;
    readonly updatedAtMs: Schema.optional<Schema.Number>;
}>>>;
/**
 * Runtime recall implementation.
 *
 * @category services
 * @since 0.1.0
 */
export interface Service {
    readonly recall: (input: Input) => Effect.Effect<Output, MemoryError.MemoryError>;
}
declare const Recall_base: Context.ServiceClass<Recall, "flows/memory/Recall", Service>;
/**
 * Context tag for the replaceable recall implementation.
 *
 * @category services
 * @since 0.1.0
 */
export declare class Recall extends Recall_base {
}
/**
 * Applies Smithers' conservative UTF-8 byte cap: complete rows are selected
 * greedily, then only the first overflowing row is truncated by binary search.
 * `maxTokens` is treated as a byte ceiling because UTF-8 bytes conservatively
 * bound token count without selecting a model-specific tokenizer.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const capRecallResults: (results: ReadonlyArray<Result>, maxTokens?: number) => Array<Result>;
/**
 * The ranking every binding sorts by: score descending, newest update, key,
 * then bank, so the order never depends on the request's bank order.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const compareResults: (left: Result, right: Result) => number;
/**
 * Provides a store-backed recall binding, capturing the MemoryStore once so
 * the service method needs no environment.
 *
 * @category layers
 * @since 0.1.0
 */
export declare const layerFrom: (run: (input: Input) => Effect.Effect<Output, MemoryError.MemoryError, MemoryStore.MemoryStore>) => Layer.Layer<Recall, never, MemoryStore.MemoryStore>;
/**
 * Provides a recall service.
 *
 * @category layers
 * @since 0.1.0
 */
export declare const layer: (implementation: Service) => Layer.Layer<Recall>;
/**
 * Constructs a recall service that returns no rows.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const makeNoop: () => Service;
/**
 * Provides the empty recall implementation.
 *
 * @category layers
 * @since 0.1.0
 */
export declare const layerNoop: Layer.Layer<Recall>;
/**
 * Maps a structured namespace back to the public bank name recall accepts.
 * `namespaceForBank` is its inverse for every prefixed bank.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const bankForNamespace: (namespace: Namespace.Namespace) => string;
/**
 * Performs the unvalidated syntactic inverse of {@link bankForNamespace}.
 * Prefixes preserve explicit lifetimes; an unprefixed bank is flow-local.
 * The returned `id` is intentionally typed as `string`, not
 * `Namespace.NonEmptyString`. Use `Bank.parse` at every I/O boundary.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const namespaceForBank: (bank: string) => {
    readonly kind: Namespace.Kind;
    readonly id: string;
};
export {};
