/**
 * Sequential escalation pattern.
 *
 * A ladder tries strategies in order and stops at the first rung whose result
 * is good enough. Two deciders answer "good enough": the shared `accept` flow,
 * and a per-rung `escalateIf` that overrides it. A `fallback` runs only after
 * every rung escalated, which is where a human approval flow belongs.
 *
 * @see https://smithers.sh/docs/reference/api/patterns
 * @see https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/engine/docs/concepts/retries.md
 * @see https://smithers.sh/docs/reference/api/patterns#identity-and-ownership
 *
 * @since 0.1.0
 */
import * as Flow from "@smthrs/flow/Flow";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Compose from "./internal/Compose.vibe";
import type { Member } from "../../../src/internal/Member.ts";
import { OpaqueInput } from "./internal/Payload.vibe";
import { PatternError } from "./PatternError.vibe";
/**
 * One declared rung and the flow that decides whether it escalates.
 *
 * `escalateIf` receives `{ result, level }` and replaces the shared `accept`
 * flow for this rung alone. It escalates with anything but `false`.
 *
 * @category models
 * @since 0.1.0
 */
export interface Rung<R = never> {
    readonly flow: Member<R>;
    readonly escalateIf?: Member<R> | undefined;
}
/**
 * Configuration for {@link make}.
 *
 * Rungs are alternative strategies, not model-seat fallback. Provider or
 * seat fallback belongs to model routing before a flow is selected.
 *
 * `accept` decides every rung that declares no `escalateIf`. `fallback` is the
 * last rung: it runs only after every declared rung escalated.
 * A rung with no `escalateIf` and no `accept` is decided by
 * {@link defaultEscalate}, in `make` and in {@link run} alike.
 *
 * @category models
 * @since 0.1.0
 */
export interface MakeOptions<R = never> {
    readonly name?: string | undefined;
    readonly description?: string | undefined;
    readonly rungs: ReadonlyArray<Member<R> | Rung<R>>;
    readonly accept?: Member<R> | undefined;
    readonly fallback?: Member<R> | undefined;
}
/**
 * One operational rung and its optional escalation predicate.
 *
 * @category models
 * @since 0.1.0
 */
export interface RuntimeRung<I, A, E, R, E2, R2> {
    readonly run: (input: I) => Effect.Effect<A, E, R>;
    readonly escalateIf?: ((result: A, level: number) => Effect.Effect<boolean, E2, R2>) | undefined;
}
/**
 * Operational callbacks for {@link run}.
 *
 * A rung is either a plain effectful function or a {@link RuntimeRung} that
 * carries its own `escalateIf`. With no `accept` and no `escalateIf`,
 * {@link defaultEscalate} decides.
 *
 * `run` snapshots `rungs`, each rung's `run` and `escalateIf`, `accept`, and
 * `fallback` at the call, so a later edit to the array, a rung record, or the
 * option object does not alter that run.
 *
 * @category models
 * @since 0.1.0
 */
export interface RuntimeOptions<I, A, E, R, E2, R2, F = A, E3 = never, R3 = never> {
    readonly rungs: ReadonlyArray<((input: I) => Effect.Effect<A, E, R>) | RuntimeRung<I, A, E, R, E2, R2>>;
    readonly accept?: ((result: A) => Effect.Effect<unknown, E2, R2>) | undefined;
    readonly fallback?: ((input: I) => Effect.Effect<F, E3, R3>) | undefined;
}
/**
 * The rung that produced the settled result, and the result itself.
 *
 * `level` is the rung's index. A `fallback` result carries the rung count,
 * one past the last declared rung. `exhausted` is always `false` here, so a
 * caller reads it on either arm without a property check.
 *
 * @category models
 * @since 0.1.0
 */
export interface Reached<A> {
    readonly level: number;
    readonly result: A;
    readonly exhausted: false;
}
/**
 * The last rung's result, returned when every rung escalated and no fallback
 * was declared.
 *
 * @category models
 * @since 0.1.0
 */
export interface Exhausted<A> {
    readonly level: number;
    readonly result: A;
    readonly accepted: false;
    readonly exhausted: true;
}
/**
 * One unambiguous ladder outcome: a rung settled, or every rung escalated.
 *
 * `exhausted` discriminates the two arms and the rung's own value stays
 * nested under `result`.
 *
 * @category models
 * @since 1.0.0
 */
export type Settled<A, F = A> = Reached<A> | Reached<F> | Exhausted<A>;
/**
 * Reads an accepted decision: `true`, `"approved"`, `{ approved: true }`, or
 * `{ accepted: true }`.
 *
 * @category predicates
 * @since 0.1.0
 */
export declare const accepted: typeof Compose.accepted;
/**
 * Decides escalation for a rung that names no predicate and no `accept` flow,
 * in {@link make} as a `Node.branch` on the rung's result and in {@link run}
 * on the same result.
 *
 * A missing result escalates. So does a result that reports a failure the way
 * flows conventionally do: a set `error`, `failed: true`, or `ok: false`.
 * Anything else settles the ladder.
 *
 * @category combinators
 * @since 0.1.0
 */
export declare const defaultEscalate: (result: unknown) => boolean;
/**
 * The declared form of an escalation ladder.
 *
 * @category models
 * @since 0.1.0
 */
export type EscalationFlow<R = never> = Flow.Flow<string, typeof OpaqueInput, typeof Schema.Unknown, typeof Schema.Unknown, R>;
/**
 * Builds the bounded ladder topology, including every rung, every decider, and
 * the fallback, with a real run-time decision at each rung that has one. Use
 * {@link run} for the operational form.
 *
 * A rung with a decider is a `Node.branch`: the plan carries both the settled
 * arm and the next rung before anything runs, and the decider's answer is read
 * at run time off the result the rung really produced. A rung with neither
 * its own decider nor a shared `accept` branches on {@link defaultEscalate},
 * the rule {@link run} applies to the same result.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const make: <R = never>(options: MakeOptions<R>) => EscalationFlow<R>;
/**
 * Executes an escalation ladder and stops at the first rung that does not
 * escalate.
 *
 * Every outcome carries `exhausted`: `false` on a rung that settled and on a
 * fallback result, `true` on the last rung's result when every rung escalated.
 *
 * This is the operational form of the same decision {@link make} declares as a
 * `Node.branch` per rung: it stops at the first settled rung instead of
 * carrying every rung the ladder declares. Fiber interruption propagates
 * normally.
 *
 * @category combinators
 * @since 0.1.0
 */
export declare const run: <I, A, E, R, E2 = never, R2 = never, F = A, E3 = never, R3 = never>(input: I, options: RuntimeOptions<I, A, E, R, E2, R2, F, E3, R3>) => Effect.Effect<Settled<A, F>, E | E2 | E3 | PatternError, R | R2 | R3>;
