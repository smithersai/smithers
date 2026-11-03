/**
 * Bounded produce-review-revise pattern.
 *
 * @see https://smithers.sh/docs/reference/api/patterns
 * @see https://smithers.sh/docs/reference/api/patterns#identity-and-ownership
 *
 * @since 0.1.0
 */
import * as Flow from "@smthrs/flow/Flow";
import * as Stall from "@smthrs/flow/Stall";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Compose from "./internal/Compose.vibe";
import type { Member } from "../../../src/internal/Member.ts";
import { OpaqueInput } from "./internal/Payload.vibe";
import * as Stalling from "../../../src/internal/Stalling.ts";
import { PatternError } from "./PatternError.vibe";
/**
 * Configuration for {@link make}.
 *
 * `produce` receives `{ input }`, `review` receives `{ output }` carrying the
 * produced value, and `revise` receives `{ output, review, round }`. Every
 * round the bound allows is declared, and each round's approval decision is a
 * `Node.branch` whose predicate runs at run time on the review the reviewer
 * really returned, so cancellation remains ordinary structured fiber
 * interruption.
 *
 * `stall` ends the loop once `stall.rounds` refused rounds in a row reviewed
 * the same output (`@smthrs/flow/Stall`): `stop` and `park` settle
 * {@link Stalled}, `escalate` fails `PatternError` `stalled`.
 *
 * @category models
 * @since 0.1.0
 */
export interface MakeOptions<R = never> {
    readonly name?: string | undefined;
    readonly description?: string | undefined;
    readonly produce: Member<R>;
    readonly review: Member<R>;
    readonly revise: Member<R>;
    readonly maxRounds: number;
    readonly stall?: Stall.Options | undefined;
}
/**
 * Operational callbacks for {@link run}.
 *
 * @category models
 * @since 0.1.0
 */
export interface RuntimeOptions<I, A, Review, E, R, E2, R2, E3, R3> {
    readonly produce: (input: I) => Effect.Effect<A, E, R>;
    readonly review: (output: A, round: number) => Effect.Effect<Review, E2, R2>;
    readonly revise: (input: {
        readonly output: A;
        readonly review: Review;
        readonly round: number;
    }) => Effect.Effect<A, E3, R3>;
    readonly maxRounds: number;
    readonly stall?: Stalling.RuntimeOptions<A> | undefined;
}
/**
 * An approved result, returned at the round whose review accepted it.
 *
 * The produced value is nested under `output` so it can never forge the
 * unapproved arm, however it is shaped.
 *
 * @category models
 * @since 1.0.0
 */
export interface Approved<A> {
    readonly _tag: "Approved";
    readonly output: A;
}
/**
 * An unapproved result returned after the round bound is reached, with the
 * review that refused it.
 *
 * @category models
 * @since 0.1.0
 */
export interface Exhausted<A, Review> {
    readonly _tag: "Exhausted";
    readonly output: A;
    readonly review: Review;
}
/**
 * An unapproved result whose revisions stopped changing, with the last review
 * and the stall verdict.
 *
 * @category models
 * @since 1.0.0
 */
export interface Stalled<A, Review> {
    readonly _tag: "Stalled";
    readonly output: A;
    readonly review: Review;
    readonly stalled: Stall.Stalled;
}
/**
 * One unambiguous loop outcome: a review approved the output, the rounds
 * ran out, or the revisions stalled.
 *
 * Both arms carry `_tag` and nest the produced value under `output`, so a
 * caller branches on the discriminator rather than on the shape of the value
 * the loop produced.
 *
 * @category models
 * @since 1.0.0
 */
export type Settled<A, Review> = Approved<A> | Exhausted<A, Review> | Stalled<A, Review>;
/**
 * Reads an accepted decision: `true`, `"approved"`, `{ approved: true }`, or
 * `{ accepted: true }`.
 *
 * @category predicates
 * @since 0.1.0
 */
export declare const accepted: typeof Compose.accepted;
/**
 * The declared form of a bounded review loop.
 *
 * @category models
 * @since 0.1.0
 */
export type ReviewLoopFlow<R = never> = Flow.Flow<string, typeof OpaqueInput, typeof Schema.Unknown, typeof Schema.Unknown, R>;
/**
 * Builds the conservative topology for every declared review round, with a
 * real run-time approval decision at each one. Use {@link run} for the
 * operational form.
 *
 * Each round is a `Node.branch`: the plan carries the approved arm and the
 * revise arm before anything runs, and the predicate is evaluated at run time
 * on the review the reviewer really returned. Reaching the round bound reads
 * the declared bound rather than a run value, so that one test stays at plan
 * time. A very large `maxRounds` builds a very large graph before anything
 * runs.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const make: <R = never>(options: MakeOptions<R>) => ReviewLoopFlow<R>;
/**
 * Executes produce-review-revise rounds and short-circuits on approval.
 *
 * Both outcomes are tagged: an accepted review returns {@link Approved} and a
 * spent round bound returns {@link Exhausted} with the review that refused it.
 *
 * This Effect is the operational form of the same decision {@link make}
 * declares as a `Node.branch`: it stops at the first approved round instead of
 * carrying every round the bound allows. Fiber interruption propagates
 * normally.
 *
 * @category combinators
 * @since 0.1.0
 */
export declare const run: <I, A, Review, E, R, E2, R2, E3, R3>(input: I, options: RuntimeOptions<I, A, Review, E, R, E2, R2, E3, R3>) => Effect.Effect<Settled<A, Review>, E | E2 | E3 | PatternError, R | R2 | R3>;
