/**
 * A bounded, alternating deliberation pattern.
 *
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
 * One immutable contribution to a debate transcript.
 *
 * @category models
 * @since 0.1.0
 */
export interface Turn {
    readonly proponent: unknown;
    readonly opponent: unknown;
}
/**
 * One typed contribution produced by {@link run}. The turn wrapper is frozen,
 * while its proponent and opponent payloads remain opaque caller-owned
 * references and are not recursively frozen.
 *
 * @category models
 * @since 0.1.0
 */
export interface RuntimeTurn<Proponent, Opponent> {
    readonly proponent: Proponent;
    readonly opponent: Opponent;
}
/**
 * Operational callbacks for {@link run}.
 *
 * @category models
 * @since 0.1.0
 */
export interface RuntimeOptions<I, Proponent, Opponent, Judge, E, R, E2, R2, E3, R3> {
    readonly rounds: number;
    readonly proponent: (state: {
        readonly input: I;
        readonly transcript: ReadonlyArray<RuntimeTurn<Proponent, Opponent>>;
        readonly round: number;
    }) => Effect.Effect<Proponent, E, R>;
    readonly opponent: (state: {
        readonly input: I;
        readonly transcript: ReadonlyArray<RuntimeTurn<Proponent, Opponent>>;
        readonly proponent: Proponent;
        readonly round: number;
    }) => Effect.Effect<Opponent, E2, R2>;
    readonly judge: (state: {
        readonly input: I;
        readonly transcript: ReadonlyArray<RuntimeTurn<Proponent, Opponent>>;
    }) => Effect.Effect<Judge, E3, R3>;
}
/**
 * Configuration for {@link make}.
 *
 * The proponent receives `{ input, transcript, round }` and the opponent
 * receives that plus `proponent`, where `round` counts from 1 as in
 * {@link run}. The judge receives `{ input, transcript }` with the final
 * transcript. `rounds` is expanded while this flow is declared, rather than at
 * execution time.
 *
 * @category models
 * @since 0.1.0
 */
export interface MakeOptions<R = never> {
    readonly name?: string | undefined;
    readonly description?: string | undefined;
    readonly proponent: Member<R>;
    readonly opponent: Member<R>;
    readonly judge: Member<R>;
    readonly rounds: number;
}
/**
 * The declared form of a debate.
 *
 * @category models
 * @since 0.1.0
 */
export type DebateFlow<R = never> = Flow.Flow<string, typeof OpaqueInput, typeof Schema.Unknown, typeof Schema.Unknown, R>;
/**
 * Builds the conservative fixed-round participant topology. Use {@link run}
 * when participant outputs must accumulate into a runtime transcript.
 * A very large `rounds` value builds a very large graph before anything runs.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const make: <R = never>(options: MakeOptions<R>) => DebateFlow<R>;
/**
 * Executes a fixed-round debate and supplies the real accumulated transcript
 * to each participant and the judge.
 *
 * @category combinators
 * @since 0.1.0
 */
export declare const run: <I, Proponent, Opponent, Judge, E, R, E2, R2, E3, R3>(input: I, options: RuntimeOptions<I, Proponent, Opponent, Judge, E, R, E2, R2, E3, R3>) => Effect.Effect<Judge, E | E2 | E3 | PatternError, R | R2 | R3>;
