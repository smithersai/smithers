/**
 * The threshold math behind every `memory` routing decision.
 *
 * Each decision (include a wiki page, descend into a directory, include a
 * file, include a commit, ...) asks Jev one boolean per item. The answer's
 * probability `p` is mapped through a reliability table to a calibrated
 * `p̂`, and the item is included when `p̂ ≥ τ`. `τ` starts from the
 * decision's declared costs: include when `p̂ · miss ≥ (1 − p̂) · extra`, so
 * `τ = extra / (miss + extra)`. A missed file costs more than an extra one,
 * so file inclusion sits on a low bar.
 *
 * {@link refit} is the weekly step `memory/calibrate` runs over labels read
 * from journals and landed fixes. It never moves a threshold more than
 * {@link maxMove} in one fit and never fits on fewer than {@link minLabels}
 * labels; a refused fit is returned with the threshold it proposed, so the
 * caller files it for a person instead of landing it.
 *
 * @since 1.0.0
 */
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
/**
 * The routing decisions `memory` makes, each with its own threshold.
 *
 * @category models
 * @since 1.0.0
 */
export declare const Decision: Schema.Literals<readonly ["page", "skill", "dep", "descend", "file", "commit", "fact"]>;
/**
 * The decoded form of {@link Decision}.
 *
 * @category models
 * @since 1.0.0
 */
export type Decision = typeof Decision.Type;
/**
 * What a wrong answer costs, in any common unit: a missed needed item and an
 * included unneeded one.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const Costs: Schema.Struct<{
    readonly miss: Schema.Finite;
    readonly extra: Schema.Finite;
}>;
/**
 * One decision's current setting: its declared costs, the threshold on the
 * calibrated scale, and the ten-bucket reliability table (`null` until a fit
 * had enough labels, which makes `p̂ = p`).
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const Decided: Schema.Struct<{
    readonly costs: Schema.Struct<{
        readonly miss: Schema.Finite;
        readonly extra: Schema.Finite;
    }>;
    readonly tau: Schema.Finite;
    readonly reliability: Schema.NullOr<Schema.$Array<Schema.Finite>>;
}>;
/**
 * The decoded form of {@link Decided}.
 *
 * @category models
 * @since 1.0.0
 */
export type Decided = typeof Decided.Type;
/**
 * Every decision's setting, and the Jev model the settings were fitted for.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const Thresholds: Schema.Struct<{
    readonly version: Schema.Int;
    readonly model: Schema.String;
    readonly decisions: Schema.Struct<{
        readonly page: Schema.Struct<{
            readonly costs: Schema.Struct<{
                readonly miss: Schema.Finite;
                readonly extra: Schema.Finite;
            }>;
            readonly tau: Schema.Finite;
            readonly reliability: Schema.NullOr<Schema.$Array<Schema.Finite>>;
        }>;
        readonly skill: Schema.Struct<{
            readonly costs: Schema.Struct<{
                readonly miss: Schema.Finite;
                readonly extra: Schema.Finite;
            }>;
            readonly tau: Schema.Finite;
            readonly reliability: Schema.NullOr<Schema.$Array<Schema.Finite>>;
        }>;
        readonly dep: Schema.Struct<{
            readonly costs: Schema.Struct<{
                readonly miss: Schema.Finite;
                readonly extra: Schema.Finite;
            }>;
            readonly tau: Schema.Finite;
            readonly reliability: Schema.NullOr<Schema.$Array<Schema.Finite>>;
        }>;
        readonly descend: Schema.Struct<{
            readonly costs: Schema.Struct<{
                readonly miss: Schema.Finite;
                readonly extra: Schema.Finite;
            }>;
            readonly tau: Schema.Finite;
            readonly reliability: Schema.NullOr<Schema.$Array<Schema.Finite>>;
        }>;
        readonly file: Schema.Struct<{
            readonly costs: Schema.Struct<{
                readonly miss: Schema.Finite;
                readonly extra: Schema.Finite;
            }>;
            readonly tau: Schema.Finite;
            readonly reliability: Schema.NullOr<Schema.$Array<Schema.Finite>>;
        }>;
        readonly commit: Schema.Struct<{
            readonly costs: Schema.Struct<{
                readonly miss: Schema.Finite;
                readonly extra: Schema.Finite;
            }>;
            readonly tau: Schema.Finite;
            readonly reliability: Schema.NullOr<Schema.$Array<Schema.Finite>>;
        }>;
        readonly fact: Schema.Struct<{
            readonly costs: Schema.Struct<{
                readonly miss: Schema.Finite;
                readonly extra: Schema.Finite;
            }>;
            readonly tau: Schema.Finite;
            readonly reliability: Schema.NullOr<Schema.$Array<Schema.Finite>>;
        }>;
    }>;
}>;
/**
 * The decoded form of {@link Thresholds}.
 *
 * @category models
 * @since 1.0.0
 */
export type Thresholds = typeof Thresholds.Type;
/**
 * The largest threshold move one fit may land.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const maxMove = 0.05;
/**
 * The fewest labels a fit needs.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const minLabels = 200;
/**
 * The cost-optimal threshold for a calibrated probability.
 *
 * @category math
 * @since 1.0.0
 */
export declare const tau: (costs: typeof Costs.Type) => number;
/**
 * `p` mapped through the decision's reliability table; `p` itself when the
 * table is absent.
 *
 * @category math
 * @since 1.0.0
 */
export declare const calibrated: (decided: Decided, p: number) => number;
/**
 * Whether a probability clears the decision's threshold.
 *
 * @category math
 * @since 1.0.0
 */
export declare const include: (decided: Decided, p: number) => boolean;
/**
 * One observed outcome: Jev's raw probability for an item and whether the
 * item turned out to be needed. `weight` defaults to 1; a weak label such as
 * "included but never read" carries less.
 *
 * @category models
 * @since 1.0.0
 */
export interface Label {
    readonly p: number;
    readonly needed: boolean;
    readonly weight?: number | undefined;
}
/**
 * Fits a monotone ten-bucket map from raw probability to observed hit rate.
 *
 * Each bucket's weighted hit rate is pooled with its neighbours wherever it
 * would fall below the bucket before it (pool adjacent violators), so a
 * higher raw probability never maps to a lower calibrated one. A bucket with
 * no labels takes its own midpoint before pooling.
 *
 * @category math
 * @since 1.0.0
 */
export declare const fit: (labels: ReadonlyArray<Label>) => ReadonlyArray<number>;
/**
 * The weighted cost of deciding `labels` at threshold `t` on the scale
 * `table` gives.
 *
 * @category math
 * @since 1.0.0
 */
export declare const expectedCost: (labels: ReadonlyArray<Label>, table: ReadonlyArray<number> | null, t: number, costs: typeof Costs.Type) => number;
/**
 * The threshold in steps of 0.01 with the least {@link expectedCost}; on a
 * tie, the one closest to the cost-optimal {@link tau}.
 *
 * @category math
 * @since 1.0.0
 */
export declare const bestTau: (labels: ReadonlyArray<Label>, table: ReadonlyArray<number> | null, costs: typeof Costs.Type) => number;
/**
 * The outcome of one fit: a setting to land, or a refusal naming why and
 * what the fit proposed.
 *
 * @category models
 * @since 1.0.0
 */
export type Refit = {
    readonly _tag: "Refit";
    readonly decided: Decided;
    readonly labels: number;
} | {
    readonly _tag: "Refused";
    readonly reason: "too_few_labels" | "move_too_large";
    readonly proposed: number;
    readonly labels: number;
};
/**
 * Fits one decision's reliability table and threshold from `labels`.
 *
 * Refuses under {@link minLabels} labels, and refuses a threshold that would
 * move more than {@link maxMove} from `current.tau`.
 *
 * @category math
 * @since 1.0.0
 */
export declare const refit: (current: Decided, labels: ReadonlyArray<Label>) => Refit;
/**
 * The digest a `memory` step key carries, so a new fit never replays an old
 * selection.
 *
 * @category math
 * @since 1.0.0
 */
export declare const digest: (thresholds: Thresholds) => string;
/**
 * Where a repository's landed fit lives, relative to its root. `memory` reads
 * it with `Memory.thresholds`.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const file = ".smithers/memory-thresholds.json";
/**
 * The thresholds `memory` decides with until `memory/calibrate` lands a fit.
 *
 * Costs are declared per decision; each `τ` is the cost-optimal threshold:
 * include a page, skill or file at 0.35, descend at 0.30, include a commit
 * or dependency page at 0.50, accept a mined fact at 0.70.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const initial: Thresholds;
/**
 * The host's fitted calibration for transcript mining. Provide the result of
 * `Memory.thresholds(root)`; absent a fit, the declared defaults apply.
 *
 * @category services
 * @since 1.0.0
 */
export declare const Current: Context.Reference<{
    readonly version: number;
    readonly model: string;
    readonly decisions: {
        readonly page: {
            readonly costs: {
                readonly miss: number;
                readonly extra: number;
            };
            readonly tau: number;
            readonly reliability: readonly number[] | null;
        };
        readonly skill: {
            readonly costs: {
                readonly miss: number;
                readonly extra: number;
            };
            readonly tau: number;
            readonly reliability: readonly number[] | null;
        };
        readonly dep: {
            readonly costs: {
                readonly miss: number;
                readonly extra: number;
            };
            readonly tau: number;
            readonly reliability: readonly number[] | null;
        };
        readonly descend: {
            readonly costs: {
                readonly miss: number;
                readonly extra: number;
            };
            readonly tau: number;
            readonly reliability: readonly number[] | null;
        };
        readonly file: {
            readonly costs: {
                readonly miss: number;
                readonly extra: number;
            };
            readonly tau: number;
            readonly reliability: readonly number[] | null;
        };
        readonly commit: {
            readonly costs: {
                readonly miss: number;
                readonly extra: number;
            };
            readonly tau: number;
            readonly reliability: readonly number[] | null;
        };
        readonly fact: {
            readonly costs: {
                readonly miss: number;
                readonly extra: number;
            };
            readonly tau: number;
            readonly reliability: readonly number[] | null;
        };
    };
}>;
