/**
 * Deterministic token accounting for context windows.
 *
 * @since 0.1.0
 */
import { Schema } from "effect";
declare const Count_base: Schema.Class<Count, Schema.Struct<{
    readonly value: Schema.Int;
    readonly estimated: Schema.Boolean;
}>, {}>;
/**
 * A token count, and whether it was estimated locally or reported by a
 * provider. The flag travels with the number so a consumer never mistakes
 * an approximation for billing data.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export declare class Count extends Count_base {
}
declare const Segment_base: Schema.Class<Segment, Schema.Struct<{
    readonly digest: Schema.String;
    readonly zone: Schema.Literals<readonly ["prefix", "tail"]>;
    readonly tokens: typeof Count;
}>, {}>;
/**
 * One segment's contribution to the accounting, keyed by its content
 * digest so an unchanged segment keeps its count across turns.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export declare class Segment extends Segment_base {
}
declare const Accounting_base: Schema.Class<Accounting, Schema.Struct<{
    readonly prefix: typeof Count;
    readonly tail: typeof Count;
    readonly total: typeof Count;
    readonly bySegment: Schema.$Array<typeof Segment>;
}>, {}>;
/**
 * The token totals of a whole context window, split by cache zone and
 * broken down per segment.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export declare class Accounting extends Accounting_base {
}
/** A deterministic local approximation, not provider billing data.
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Estimator = (text: string) => number;
/**
 * Estimates tokens using four characters per token, with code punctuation and
 * newline density accounting for the typically shorter tokens in source text.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export declare const estimate: Estimator;
/**
 * Counts the tokens of `text`, defaulting to {@link estimate}. The result
 * is always marked estimated.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export declare const count: (text: string, estimator?: Estimator) => Count;
/**
 * Sums per-segment counts into one {@link Accounting}.
 *
 * @category combinators
 * @since 0.1.0
 * @slop
 */
export declare const combine: (segments: ReadonlyArray<Segment>) => Accounting;
export {};
