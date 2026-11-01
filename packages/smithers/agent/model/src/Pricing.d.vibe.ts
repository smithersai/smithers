/**
 * USD prices for model calls.
 *
 * The rates are the rate card in `internal/prices.generated.ts`, the one price
 * table in the tree. A caller that pays other rates passes its own rows over
 * {@link table}.
 *
 * A normalized {@link ModelEvent.Usage} counts cache reads and cache writes
 * inside `inputTokens`, so each class is taken out of the input count and
 * charged at its own rate.
 *
 * @since 1.0.0-rc.1
 */
import { Schema } from "effect";
import { type ModelPrice } from "./internal/prices.generated.js";
import type * as ModelEvent from "./ModelEvent.js";
/**
 * USD per million tokens for each token class a provider reports.
 *
 * @category schemas
 * @since 1.0.0-rc.1
 */
export declare const Rates: Schema.Struct<{
    readonly input: Schema.Finite;
    readonly cacheRead: Schema.Finite;
    readonly cacheWrite: Schema.Finite;
    readonly output: Schema.Finite;
}>;
/**
 * The decoded form of {@link Rates}.
 *
 * @category models
 * @since 1.0.0-rc.1
 */
export type Rates = typeof Rates.Type;
/**
 * One model's rate card: standard rates, an optional long-context card that
 * prices the whole call from `longContextFrom` prompt tokens, and an optional
 * dated successor.
 *
 * @category models
 * @since 1.0.0-rc.1
 */
export type Price = ModelPrice;
/**
 * Rate cards keyed by model id or seat (`provider:model`). An override row may
 * be plain {@link Rates}.
 *
 * @category models
 * @since 1.0.0-rc.1
 */
export type Table = Readonly<Record<string, Rates | Price>>;
/**
 * The backend rate card.
 *
 * @category constants
 * @since 1.0.0-rc.1
 */
export declare const table: Readonly<Record<string, Price>>;
/**
 * Where a cost came from: the provider's own charge, or usage priced here.
 *
 * @category schemas
 * @since 1.0.0-rc.1
 */
export declare const CostSource: Schema.Literals<readonly ["reported", "estimated"]>;
/**
 * The decoded form of {@link CostSource}.
 *
 * @category models
 * @since 1.0.0-rc.1
 */
export type CostSource = typeof CostSource.Type;
/**
 * One call's USD cost and its source.
 *
 * @category models
 * @since 1.0.0-rc.1
 */
export interface Cost {
    readonly costUsd: number;
    readonly costSource: CostSource;
}
/**
 * Options for {@link lookup} and {@link cost}.
 *
 * @category models
 * @since 1.0.0-rc.1
 */
export interface Options {
    /** Rate cards to use; defaults to {@link table}. Spread {@link table} to override single rows. */
    readonly table?: Table | undefined;
    /** The instant whose price applies, in epoch milliseconds; defaults to now. */
    readonly at?: number | undefined;
}
/**
 * The rate card in effect for a model id at an instant, or `undefined` for a
 * model the table does not price.
 *
 * An exact row wins. Otherwise a seat (`openai:gpt-5.6-sol`) or gateway id
 * (`anthropic/claude-sonnet-5`) resolves to its bare model, and a dated
 * snapshot (`claude-haiku-4-5-20251001`) to its family. A row's dated
 * successor applies from its `nextFrom`.
 *
 * @category resolvers
 * @since 1.0.0-rc.1
 */
export declare const lookup: (modelId: string, options?: Options) => Rates | Price | undefined;
/**
 * The rate-weighted token sum of one call: each token class times its rate.
 * With rates in USD per million tokens this is micro-dollars.
 *
 * Input and output counts are required, and every supplied counter must be
 * finite and non-negative, with cache reads and writes inside the input
 * count; anything else, including arithmetic overflow, is `NaN`, so malformed
 * usage is never priced low.
 *
 * @category accounting
 * @since 1.0.0-rc.1
 */
export declare const weigh: (usage: ModelEvent.Usage, rates: Rates) => number;
/**
 * The USD cost of one call under a rate card, `NaN` for malformed usage (see
 * {@link weigh}) or arithmetic overflow. A long-context card prices the whole
 * call once the prompt reaches its threshold.
 *
 * @category accounting
 * @since 1.0.0-rc.1
 */
export declare const costUsd: (usage: ModelEvent.Usage, price: Rates | Price) => number;
/**
 * The cost of one call: the provider's reported charge when there is a valid
 * one, otherwise its usage priced under the model's rate card. `undefined`
 * when neither is available, for an unpriced model or malformed usage.
 *
 * @category accounting
 * @since 1.0.0-rc.1
 */
export declare const cost: (usage: ModelEvent.Usage, modelId: string | undefined, options?: Options) => Cost | undefined;
