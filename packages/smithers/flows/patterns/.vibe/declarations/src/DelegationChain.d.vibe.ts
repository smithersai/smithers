/**
 * The fixed delegation chain: refine, plan, derisk, execute, review, settle.
 *
 * Nothing here is new machinery. The chain is assembled from the patterns that
 * already exist: {@link ReviewLoop} runs the derisk rounds, {@link Trellis}
 * admits and executes the derisked plan, and {@link Escalation} walks the tier
 * ladder weakest first. A tier retries through the `RetryPolicy` its own
 * actions declare, so the engine spends those attempts durably and the chain
 * escalates only once a tier has failed or its output was rejected. This
 * module owns the order those parts run in and the bounds they run under.
 *
 * {@link make} declares what {@link run} executes: every tier call it declares
 * carries the same `Work` a tier is run with, every leaf review carries the
 * tier that produced the output, and settle carries the keys `run` settles
 * with. The one payload that still differs is inside the derisk loop, which
 * `ReviewLoop` owns: it reviews with `{ output }` carrying the produced plan
 * and revises with `{ output, review, round }`, while `run` names the goal and
 * the round in both.
 *
 * @see https://smithers.sh/docs/reference/api/patterns#identity-and-ownership
 *
 * @since 0.1.0
 */
import * as Flow from "@smthrs/flow/Flow";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Compose from "./internal/Compose.vibe";
import type { Member } from "../../../src/internal/Member.ts";
import * as Trellis from "../../../src/Trellis.ts";
/**
 * Stable delegation-chain failure codes.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const DelegationErrorCode: Schema.Literals<readonly ["invalid_bounds", "missing_tier", "derisk_failed", "leaf_failed"]>;
/**
 * Stable delegation-chain failure code.
 *
 * @category models
 * @since 0.1.0
 */
export type DelegationErrorCode = typeof DelegationErrorCode.Type;
declare const DelegationError_base: Schema.Class<DelegationError, Schema.TaggedStruct<"flows/patterns/DelegationError", {
    readonly code: Schema.Literals<readonly ["invalid_bounds", "missing_tier", "derisk_failed", "leaf_failed"]>;
    readonly path: Schema.String;
    readonly message: Schema.String;
    readonly cause: Schema.optional<Schema.Unknown>;
}>, import("effect/Cause").YieldableError>;
/**
 * A refused chain declaration or a leaf no tier could settle.
 *
 * `path` names the plan path the failure belongs to, or `root` for a failure
 * of the chain itself. `cause` carries the reported error or per-tier
 * outcomes. It never carries the input that produced them.
 *
 * @category errors
 * @since 0.1.0
 */
export declare class DelegationError extends DelegationError_base {
}
/**
 * The run budget threaded into every leaf call. A host that implements a
 * budget capability enforces it; the chain only carries it.
 *
 * A USD ceiling is not carried here: it is enforced where every model call is
 * made, by `@smthrs/agent`'s `Budget.make({ usd })`, which a chain's leaves
 * spend through like any other call.
 *
 * @category models
 * @since 0.1.0
 */
export interface Budget {
    readonly maxMinutes?: number | undefined;
}
/**
 * The bounds every chain declares: the tier ladder, the depth of the plan, and
 * the derisk rounds.
 *
 * The chain declares no attempt budget of its own. A tier's retries are the
 * `RetryPolicy` its actions declare, which the engine spends with durable
 * attempt state.
 *
 * @category models
 * @since 0.1.0
 */
export interface Bounds {
    readonly tierOrder: ReadonlyArray<string>;
    /**
     * The plan envelope and the number of declared leaf slots. A plan may hold at
     * most `maxDepth` leaves, nest `maxDepth` levels, and put `maxDepth` members
     * in one container.
     */
    readonly maxDepth: number;
    readonly maxDeriskRounds: number;
}
/**
 * Configuration for {@link make}.
 *
 * `execute` supplies one flow per tier named in `tierOrder`, weakest first.
 * `review` is asked twice over: once about each escalation rung, and once
 * about the assembled leaf outputs.
 *
 * @category models
 * @since 0.1.0
 */
export interface MakeOptions<R = never> extends Bounds {
    readonly name?: string | undefined;
    readonly description?: string | undefined;
    readonly refine: Member<R>;
    readonly plan: Member<R>;
    readonly derisk: Member<R>;
    readonly execute: Readonly<Record<string, Member<R>>>;
    readonly review: Member<R>;
    readonly settle: Member<R>;
    readonly budget?: Budget | undefined;
}
/**
 * One delegated unit of work handed to a tier.
 *
 * @category models
 * @since 0.1.0
 */
export interface Work {
    readonly leaf: Trellis.Leaf;
    readonly tier: string;
    readonly goal: unknown;
    readonly budget?: Budget | undefined;
}
/**
 * What the review is asked about: one escalation rung, or the whole chain.
 *
 * @category models
 * @since 0.1.0
 */
export type ReviewRequest = {
    readonly stage: "leaf";
    readonly leaf: Trellis.Leaf;
    readonly tier: string;
    readonly output: unknown;
} | {
    readonly stage: "chain";
    readonly goal: unknown;
    readonly plan: Trellis.Plan;
    readonly leaves: ReadonlyArray<unknown>;
};
/**
 * What the derisk review is asked about on each round.
 *
 * @category models
 * @since 0.1.0
 */
export interface DeriskRequest {
    readonly goal: unknown;
    readonly plan: unknown;
    readonly round: number;
}
/**
 * What the planner is asked for on each derisk round.
 *
 * @category models
 * @since 0.1.0
 */
export interface PlanRequest {
    readonly goal: unknown;
    readonly round: number;
    readonly previous?: unknown;
    readonly derisk?: unknown;
}
/**
 * What `settle` receives once every leaf has produced an output.
 *
 * @category models
 * @since 0.1.0
 */
export interface Settlement {
    readonly prompt: string;
    readonly goal: unknown;
    readonly plan: Trellis.Plan;
    readonly leaves: ReadonlyArray<unknown>;
    readonly review: unknown;
    readonly deriskExhausted: boolean;
}
/**
 * Operational callbacks for {@link run}.
 *
 * @category models
 * @since 0.1.0
 */
export interface RuntimeOptions<Settled, E1, R1, E2, R2, E3, R3, E4, R4, E5, R5, E6, R6> extends Bounds {
    readonly refine: (input: {
        readonly prompt: string;
    }) => Effect.Effect<unknown, E1, R1>;
    readonly plan: (request: PlanRequest) => Effect.Effect<unknown, E2, R2>;
    readonly derisk: (request: DeriskRequest) => Effect.Effect<unknown, E3, R3>;
    readonly execute: Readonly<Record<string, (work: Work) => Effect.Effect<unknown, E4, R4>>>;
    readonly review: (request: ReviewRequest) => Effect.Effect<unknown, E5, R5>;
    readonly settle: (settlement: Settlement) => Effect.Effect<Settled, E6, R6>;
    readonly budget?: Budget | undefined;
    readonly concurrency?: number | undefined;
}
/**
 * Reads the acceptance vocabulary both house patterns use: `true`,
 * `"approved"`, `{ approved: true }`, or `{ accepted: true }`.
 *
 * @category predicates
 * @since 0.1.0
 */
export declare const accepted: typeof Compose.accepted;
/**
 * The most flow calls a declared chain makes across its two rounds, counting
 * only the calls the chain itself contributes.
 *
 * Four calls are fixed: refine, the derisk loop, the chain review, and settle.
 * The derisk loop adds two calls per round minus the revision the last round
 * never makes, and each of the at most `maxDepth` leaves a plan may name adds
 * one execute plus one review call per tier it climbs. A supplied flow whose
 * own body calls other flows adds those on top, and the engine's retries of a
 * tier's actions are attempts of the same calls, not more of them.
 *
 * @category introspection
 * @since 0.1.0
 */
export declare const bound: (options: Bounds) => number;
/**
 * The state the execution round of a declared chain is handed: the refined
 * goal and what the derisk loop settled with.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const ExecutionState: Schema.Struct<{
    readonly goal: Schema.Unknown;
    readonly derisked: Schema.Unknown;
}>;
/**
 * What a declared chain is called with. A caller passes `input` alone; the
 * chain hands itself `execution` when it opens its execution round.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const Payload: Schema.Struct<{
    readonly input: Schema.Unknown;
    readonly execution: Schema.optionalKey<Schema.Struct<{
        readonly goal: Schema.Unknown;
        readonly derisked: Schema.Unknown;
    }>>;
}>;
/**
 * What a declared chain fails with: a {@link DelegationError} or a
 * `TrellisError`, each encoded through its own schema, or the error of a stage
 * it called.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const Failure: Schema.Union<readonly [typeof DelegationError, typeof Trellis.TrellisError, Schema.Unknown]>;
/**
 * The declared form of a delegation chain.
 *
 * @category models
 * @since 0.1.0
 */
export type DelegationChainFlow<R = never> = Flow.Flow<string, typeof Payload, typeof Schema.Unknown, typeof Failure, R>;
/**
 * Declares a chain that runs the plan its derisk loop settles on, in two
 * durable rounds.
 *
 * The first round refines the caller's input into a goal and runs the derisk
 * loop (a `ReviewLoop` unrolled to `maxDeriskRounds`), then hands the goal and
 * the loop's outcome to the execution round with the `To` outcome
 * `@smthrs/flow` defines. The execution round reads the derisked plan as
 * data: it validates it against the envelope `{ fuel, depth, fanout }`, all
 * `maxDepth`, and declares one tier ladder for each leaf the plan names, with
 * the leaf's real goal and path. A plan outside the envelope fails with the
 * `Trellis` refusal and no leaf runs. The chain review then sees every leaf
 * output in plan order, and settle receives the keys {@link run} settles with,
 * `deriskExhausted` included.
 *
 * A crash resumes at the round boundary. Very large derisk-round bounds build a
 * large first-round graph.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const make: <R = never>(caller: MakeOptions<R>) => DelegationChainFlow<R>;
/**
 * Runs the chain: refine the prompt into a goal, plan and derisk it, execute
 * every leaf through the tier ladder, review the assembled outputs, settle.
 *
 * The derisk loop stops at the first approved round. Each leaf climbs the tier
 * ladder weakest first, calling each tier once: a tier that fails, or whose
 * result the review rejects, admits the next one. Retrying a tier is the job
 * of its own effect here and of its actions' `RetryPolicy` in a declared
 * chain, never of the chain. Only a reached rung contributes its
 * `result.output`; an exhausted ladder fails `leaf_failed` naming the leaf's
 * plan path, and no later stage runs.
 *
 * `maxDepth` is the whole plan envelope: the derisked plan may hold at most
 * `maxDepth` leaves, nest `maxDepth` levels, and put `maxDepth` members in one
 * container. A wider plan is refused with the `Trellis` code that names the
 * bound it broke.
 *
 * @category combinators
 * @since 0.1.0
 */
export declare const run: <Settled, E1, R1, E2, R2, E3, R3, E4, R4, E5, R5, E6, R6>(prompt: string, caller: RuntimeOptions<Settled, E1, R1, E2, R2, E3, R3, E4, R4, E5, R5, E6, R6>) => Effect.Effect<Settled, E1 | E2 | E3 | E5 | E6 | DelegationError | Trellis.TrellisError, R1 | R2 | R3 | R4 | R5 | R6>;
export {};
