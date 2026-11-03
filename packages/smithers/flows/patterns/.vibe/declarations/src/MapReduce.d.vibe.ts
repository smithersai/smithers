/**
 * Deterministic map-reduce declaration pattern.
 *
 * @see https://smithers.sh/docs/reference/api/patterns
 * @see https://smithers.sh/docs/reference/api/patterns#identity-and-ownership
 *
 * @since 0.1.0
 */
import * as Flow from "@smthrs/flow/Flow";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { Member } from "../../../src/internal/Member.ts";
import { PatternError } from "./PatternError.vibe";
/**
 * Empty-input policy for {@link make}.
 *
 * `"fail"` deliberately reports `exhausted`: the caller explicitly chose a
 * spent-bound style failure for an input with no shards.
 *
 * @category models
 * @since 0.1.0
 */
export type OnEmpty = "reduce" | "succeed" | "fail";
/**
 * Configuration for {@link make}.
 *
 * Inputs to the resulting flow are `{ shards }`. Shard keys use their ordinal
 * (`shard-0`, `shard-1`, …), which makes the reduce input independent of
 * worker completion order.
 *
 * @category models
 * @since 0.1.0
 */
export interface MakeOptions<R = never> {
    readonly name?: string | undefined;
    readonly description?: string | undefined;
    readonly map: Member<R>;
    readonly reduce: Member<R>;
    readonly concurrency: number;
    readonly onEmpty: OnEmpty;
}
/**
 * Operational callbacks for {@link run}.
 *
 * @category models
 * @since 0.1.0
 */
export interface RuntimeOptions<I, Shard, Mapped, Reduced, E, R, E2, R2> {
    readonly map: (input: {
        readonly shard: Shard;
        readonly index: number;
        readonly input: I;
    }) => Effect.Effect<Mapped, E, R>;
    readonly reduce: (input: {
        readonly input: I;
        readonly mapped: ReadonlyArray<Mapped>;
    }) => Effect.Effect<Reduced, E2, R2>;
    readonly concurrency: number;
    readonly onEmpty: OnEmpty;
}
/**
 * The payload a declared map-reduce takes.
 *
 * `shards` must be an array. Its elements can have any shape.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const Payload: Schema.Struct<{
    readonly shards: Schema.$Array<Schema.Unknown>;
}>;
/**
 * The declared form of a map-reduce flow.
 *
 * @category models
 * @since 0.1.0
 */
export type MapReduceFlow<R = never> = Flow.Flow<string, typeof Payload, typeof Schema.Unknown, typeof Schema.Unknown, R>;
/**
 * Makes a map-reduce flow.
 *
 * The flow input must be a literal `{ shards }` available while planning.
 * Each shard becomes its own map call.
 * `Bounded.all` sequences map batches to enforce the declared concurrency
 * bound. The reducer receives values in shard order.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const make: <R = never>(options: MakeOptions<R>) => MapReduceFlow<R>;
/**
 * Executes map work with bounded concurrency, preserves shard order, and
 * reduces the real mapped values.
 *
 * `reduce` and `fail` return the reducer's result type. `succeed` can also
 * return an empty array of mapped values.
 *
 * @category combinators
 * @since 0.1.0
 */
export declare function run<I extends {
    readonly shards: ReadonlyArray<unknown>;
}, Mapped, Reduced, E, R, E2, R2>(input: I, options: RuntimeOptions<I, I["shards"][number], Mapped, Reduced, E, R, E2, R2> & {
    readonly onEmpty: "reduce" | "fail";
}): Effect.Effect<Reduced, E | E2 | PatternError, R | R2>;
export declare function run<I extends {
    readonly shards: ReadonlyArray<unknown>;
}, Mapped, Reduced, E, R, E2, R2>(input: I, options: RuntimeOptions<I, I["shards"][number], Mapped, Reduced, E, R, E2, R2>): Effect.Effect<Reduced | ReadonlyArray<Mapped>, E | E2 | PatternError, R | R2>;
