/**
 * Run a cheap shadow beside the primary and measure the gap.
 *
 * A sidecar answers one question: would the cheaper model have been good
 * enough? It runs both over the same input, concurrently, and scores them.
 * The shadow is an experiment, so its failure is quarantined and the primary
 * result stands. The primary is not: a sidecar is not a fallback ladder, and a
 * failed primary is a failed run. {@link Escalation} is the pattern for
 * alternatives.
 *
 * @see https://smithers.sh/docs/reference/api/patterns
 * @see https://smithers.sh/docs/reference/api/patterns#identity-and-ownership
 *
 * @since 0.1.0
 */
import * as Flow from "@smthrs/flow/Flow";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { Member } from "../../../src/internal/Member.ts";
import { OpaqueInput } from "./internal/Payload.vibe";
import { PatternError } from "./PatternError.vibe";
/**
 * The declared form of a sidecar.
 *
 * @category models
 * @since 0.1.0
 */
export type SidecarFlow<R = never> = Flow.Flow<string, typeof OpaqueInput, typeof Schema.Unknown, typeof Schema.Unknown, R>;
/**
 * Configuration for {@link make}.
 *
 * Omit `score` for a sidecar that only records the shadow output for later
 * comparison.
 *
 * @category models
 * @since 0.1.0
 */
export interface MakeOptions<R = never> {
    readonly name?: string | undefined;
    readonly description?: string | undefined;
    readonly primary: Member<R>;
    readonly shadow: Member<R>;
    readonly score?: Member<R> | undefined;
}
/**
 * The two scores a comparison produces.
 *
 * @category models
 * @since 0.1.0
 */
export interface Scores {
    readonly primary: number;
    readonly shadow: number;
}
/**
 * A scored comparison of the primary against its shadow.
 *
 * `difference` is `primary - shadow`, so a positive difference means the
 * expensive run was better. `cheaperWins` is the finding a sidecar exists to
 * produce: the shadow matched or beat the primary, and the cheaper seat is a
 * candidate for the real work.
 *
 * Both scores and their computed difference are always finite numbers.
 *
 * @category models
 * @since 0.1.0
 */
export interface Delta extends Scores {
    readonly difference: number;
    readonly cheaperWins: boolean;
}
/**
 * The shadow's outcome, quarantined when it failed.
 *
 * A quarantined shadow carries its `Cause`, so an operator can read what the
 * experiment did without the run having failed. The declared form
 * ({@link make}) carries `error` instead: a recovery arm is planned against the
 * typed error the shadow may fail with, and only a running fiber has the whole
 * cause.
 *
 * @category models
 * @since 0.1.0
 */
export type Shadow<S> = {
    readonly quarantined: false;
    readonly value: S;
} | {
    readonly quarantined: true;
    readonly cause: Cause.Cause<unknown>;
};
/**
 * The outcome of one sidecar run.
 *
 * `delta` is absent when no scorer is configured and when the shadow was
 * quarantined, because there is nothing to compare against.
 *
 * @category models
 * @since 0.1.0
 */
export interface Result<P, S> {
    readonly primary: P;
    readonly shadow: Shadow<S>;
    readonly delta?: Delta | undefined;
}
/**
 * Operational callbacks for {@link run}.
 *
 * `score` receives both outputs and is called only when the shadow produced
 * one. Its failure is the run's failure: an unreadable measurement is worse
 * than no measurement. Both returned scores and their computed difference
 * must be finite, or `run` fails with a `PatternError`.
 *
 * @category models
 * @since 0.1.0
 */
export interface RuntimeOptions<I, P, S, E, R, E2, R2, E3 = never, R3 = never> {
    readonly primary: (input: I) => Effect.Effect<P, E, R>;
    readonly shadow: (input: I) => Effect.Effect<S, E2, R2>;
    readonly score?: ((input: {
        readonly primary: P;
        readonly shadow: S;
    }) => Effect.Effect<Scores, E3, R3>) | undefined;
}
/**
 * Compares two scores.
 *
 * The subtraction is rounded to twelve decimal places, because a raw
 * floating-point difference reports `0.30000000000000004` for two scores an
 * operator entered as `0.8` and `0.5`. A tie counts as `cheaperWins`: equal
 * quality at lower cost is the cheaper seat winning.
 * Both scores and the difference must be finite.
 *
 * @category combinators
 * @since 0.1.0
 */
export declare const delta: (primary: number, shadow: number) => Delta;
/**
 * Declares the sidecar topology: primary and shadow under one `All`, with the
 * shadow behind a `Catch`.
 *
 * The declared `All` is what makes the shadow concurrent rather than an extra
 * sequential step. The `Catch` is what makes it an experiment: the arm settles
 * the shadow as `{ quarantined: true, error }`, so the join cannot fail on the
 * shadow's behalf and a plan reader sees that a failed shadow does not fail the
 * run. A settled shadow is `{ quarantined: false, value }`, the shape
 * {@link run} reports.
 *
 * The score call is the settled arm of a `Node.branch` on the real shadow, so a
 * quarantined shadow is never scored, as in {@link run}. The declared result
 * is `{ primary, shadow, delta? }`, which is {@link Result}, except that a
 * quarantined shadow carries its typed `error` where `run` carries the whole
 * `Cause`: a cause does not cross the declared wire.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const make: <R = never>(options: MakeOptions<R>) => SidecarFlow<R>;
/**
 * Runs the primary and its shadow concurrently and scores the pair.
 *
 * The shadow's failure, defect included, becomes a quarantined result rather
 * than a run failure. Interruption is not quarantined: a cancelled run is
 * cancelled, and reporting the shadow as merely failed would hide that.
 *
 * @category combinators
 * @since 0.1.0
 */
export declare const run: <I, P, S, E, R, E2, R2, E3 = never, R3 = never>(input: I, options: RuntimeOptions<I, P, S, E, R, E2, R2, E3, R3>) => Effect.Effect<Result<P, S>, E | E3 | PatternError, R | R2 | R3>;
