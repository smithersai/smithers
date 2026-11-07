/**
 * Forward steps with compensations that unwind in reverse.
 *
 * A saga is the answer to "the third call failed and the first two already
 * changed the world". Each step registers the call that undoes it, and a
 * failure walks those calls backwards, most recent first.
 *
 * @see https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/engine/docs/concepts/retries.md
 * @see https://smithers.sh/docs/reference/api/patterns#identity-and-ownership
 *
 * @since 0.1.0
 */
import * as Flow from "@smthrs/flow/Flow";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { Member } from "../../../src/internal/Member.ts";
import { OpaqueInput } from "./internal/Payload.vibe";
import { PatternError } from "./PatternError.vibe";
/**
 * What a step failure does to the steps that already completed.
 *
 * Both {@link make} and {@link run} default to `compensate` when the caller
 * names no policy.
 *
 * `compensate` unwinds and returns a settled {@link Compensated} outcome; the
 * other two policies only ever settle as {@link Completed}.
 * `compensate-and-fail` unwinds and re-raises the original failure.
 * `fail` leaves the completed work alone.
 *
 * @category models
 * @since 0.1.0
 */
export type OnFailure = "compensate" | "compensate-and-fail" | "fail";
/**
 * One declared step: the call that changes the world, and the call that undoes
 * it.
 *
 * The action receives `{ input, completed }`, where `completed` holds the
 * values of the steps before it, keyed by id. The compensation receives
 * `{ id, input, value }`, where `value` is what its own action returned.
 *
 * @category models
 * @since 0.1.0
 */
export interface Step<R = never> {
    readonly id: string;
    readonly action: Member<R>;
    readonly compensation: Member<R>;
}
/**
 * Configuration for {@link make}.
 *
 * @category models
 * @since 0.1.0
 */
export interface MakeOptions<R = never> {
    readonly name?: string | undefined;
    readonly description?: string | undefined;
    readonly steps: ReadonlyArray<Step<R>>;
    readonly onFailure?: OnFailure | undefined;
}
/**
 * One operational step.
 *
 * @category models
 * @since 0.1.0
 */
export interface RuntimeStep<I, A, E, R, E2, R2> {
    readonly id: string;
    readonly action: (input: {
        readonly input: I;
        readonly completed: Readonly<Record<string, A>>;
    }) => Effect.Effect<A, E, R>;
    readonly compensation: (input: {
        readonly id: string;
        readonly input: I;
        readonly value: A;
    }) => Effect.Effect<unknown, E2, R2>;
}
/**
 * Configuration for {@link run}.
 *
 * `run` snapshots `steps`, each step's `id`, `action`, and `compensation`,
 * and `onFailure` at the call, so a later edit to the array, a step record,
 * or the option object does not alter that run. See
 * https://smithers.sh/docs/reference/api/patterns#identity-and-ownership.
 *
 * @category models
 * @since 0.1.0
 */
export interface RuntimeOptions<I, A, E, R, E2, R2> {
    readonly steps: ReadonlyArray<RuntimeStep<I, A, E, R, E2, R2>>;
    readonly onFailure?: OnFailure | undefined;
}
/**
 * A saga whose forward chain ran to the end.
 *
 * The step values are nested under `values` so a step id can never forge the
 * settled arm: a saga with steps named `_tag` and `failure` still returns a
 * `Completed` envelope.
 *
 * @category models
 * @since 1.0.0
 */
export interface Completed<A> {
    readonly _tag: "Completed";
    readonly values: Readonly<Record<string, A>>;
}
/**
 * The settled outcome of a saga that unwound cleanly under `compensate`.
 *
 * @category models
 * @since 0.1.0
 */
export interface Compensated<E> {
    readonly _tag: "Compensated";
    readonly failure: E;
}
/**
 * One unambiguous saga outcome: the forward chain completed, or it unwound.
 *
 * Both arms carry `_tag`, so a caller branches on the discriminator rather
 * than on the shape of its own step values.
 *
 * @category models
 * @since 1.0.0
 */
export type Settled<A, E> = Completed<A> | Compensated<E>;
/**
 * The declared form of a saga.
 *
 * @category models
 * @since 1.0.0
 */
export type SagaFlow<R = never> = Flow.Flow<string, typeof OpaqueInput, typeof Schema.Unknown, typeof Schema.Unknown, R>;
/**
 * Declares the forward chain and its compensation arms.
 *
 * Each step's continuation is wrapped in a `Node.catch` whose arm calls that
 * step's compensation and re-raises, so a failure deeper in the chain unwinds
 * one step at a time, most recent first. Under `compensate`, the default, an
 * outer arm turns the re-raised failure into a settled {@link Compensated}
 * value only when every compensation succeeds; under `fail` no arm is declared
 * at all. Failed compensations are collected without stopping earlier undos.
 * Both compensation policies fail with `compensation_failed`, preserving the
 * original failure and the residue sorted by step id.
 *
 * A step whose action or compensation is not a flow is refused here, because
 * the declaration cannot be built out of anything else.
 *
 * `make` snapshots `steps` and each step's `id`, `action`, and
 * `compensation` at the call, so a later edit to the caller's array or
 * records does not change the declaration.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const make: <R = never>(options: MakeOptions<R>) => SagaFlow<R>;
/**
 * Runs the forward chain, unwinding completed steps on a failure or an
 * interruption.
 *
 * The policy defaults to `compensate`. Both outcomes are tagged: a chain that
 * ran to the end returns {@link Completed} with its step values nested under
 * `values`, and a clean unwind under `compensate` returns
 * {@link Compensated}.
 *
 * Each completed step registers a scope finalizer, so the unwind is LIFO and
 * runs on interruption as well as on failure. A compensation that fails does
 * not stop the ones behind it; every failing step id is collected and the run
 * fails `PatternError { code: "compensation_failed" }` naming them, because
 * state left dirty outranks the failure that started the unwind.
 *
 * A compensation that DIES counts as a failed compensation, not as a defect
 * the run raises: the undo did not happen, so the step belongs in the residue
 * with the typed failures. This includes a synchronous throw while constructing
 * the compensation effect. Letting the defect escape would lose both the
 * residue and the failure that started the unwind.
 *
 * @category combinators
 * @since 0.1.0
 */
export declare const run: <I, A, E, R, E2, R2>(input: I, options: RuntimeOptions<I, A, E, R, E2, R2>) => Effect.Effect<Settled<A, E>, E | PatternError, R | R2>;
