/**
 * The declaration side of `Debate`: its types and `make`, which throws a
 * `PatternError` for a declaration it cannot build. `Debate.vibe`
 * re-exports all of it beside `run`, the pattern's Effect form.
 *
 * @since 0.1.0
 */

import * as Flow from "@smthrs/flow/Flow"
import * as Node from "@smthrs/plan/Node"
import type * as Planned from "@smthrs/plan/Planned"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { PatternError } from "../PatternError.ts"
import * as Compose from "./Compose.ts"
import * as Failure from "./Failure.ts"
import type { Member } from "./Member.ts"
import { call as callMember } from "./Member.ts"
import { OpaqueInput } from "./Payload.ts"

/**
 * One immutable contribution to a debate transcript.
 *
 * @category models
 * @since 0.1.0
 */
export interface Turn {
  readonly proponent: unknown
  readonly opponent: unknown
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
  readonly proponent: Proponent
  readonly opponent: Opponent
}

/**
 * Operational callbacks for {@link run}.
 *
 * @category models
 * @since 0.1.0
 */
export interface RuntimeOptions<I, Proponent, Opponent, Judge, E, R, E2, R2, E3, R3> {
  readonly rounds: number
  readonly proponent: (state: {
    readonly input: I
    readonly transcript: ReadonlyArray<RuntimeTurn<Proponent, Opponent>>
    readonly round: number
  }) => Effect.Effect<Proponent, E, R>
  readonly opponent: (state: {
    readonly input: I
    readonly transcript: ReadonlyArray<RuntimeTurn<Proponent, Opponent>>
    readonly proponent: Proponent
    readonly round: number
  }) => Effect.Effect<Opponent, E2, R2>
  readonly judge: (state: {
    readonly input: I
    readonly transcript: ReadonlyArray<RuntimeTurn<Proponent, Opponent>>
  }) => Effect.Effect<Judge, E3, R3>
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
  readonly name?: string | undefined
  readonly description?: string | undefined
  readonly proponent: Member<R>
  readonly opponent: Member<R>
  readonly judge: Member<R>
  readonly rounds: number
}

/**
 * The declared form of a debate.
 *
 * @category models
 * @since 0.1.0
 */
export type DebateFlow<R = never> = Flow.Flow<
  string,
  typeof OpaqueInput,
  typeof Schema.Unknown,
  typeof Schema.Unknown,
  R
>

const invalidRounds = (rounds: number): never => {
  throw new PatternError({
    code: "invalid_decorator",
    message: `Debate rounds must be a positive safe integer, received ${rounds}`
  })
}

/**
 * Builds the conservative fixed-round participant topology. Use {@link run}
 * when participant outputs must accumulate into a runtime transcript.
 * A very large `rounds` value builds a very large graph before anything runs.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = <R = never>(options: MakeOptions<R>): DebateFlow<R> => {
  // The body runs when the graph builds, later than this call, so it reads
  // these snapshots and never the caller's options again.
  const participants = { proponent: options.proponent, opponent: options.opponent, judge: options.judge }
  const rounds = options.rounds
  if (!Number.isSafeInteger(rounds) || rounds < 1) invalidRounds(rounds)
  const { name, description } = Compose.label("debate", { rounds }, options, [
    participants.proponent,
    participants.opponent,
    participants.judge
  ])
  // The transcript is a real array of planned references, assembled while the
  // graph builds. A planned value may be read by field and passed into a
  // payload but never computed on, so a round appends to the array the builder
  // holds instead of spreading the symbol a previous round produced.
  const body = ({ input }: { readonly input: unknown }): Node.Node<unknown, unknown, R> => {
    const visit = (
      round: number,
      transcript: ReadonlyArray<
        { readonly proponent: Planned.Planned<unknown>; readonly opponent: Planned.Planned<unknown> }
      >
    ): Node.Node<unknown, unknown, R> => {
      if (round === rounds) return callMember(participants.judge, { input, transcript })
      // Members are handed the 1-based round number `run` hands them, so one
      // member serves both forms.
      return Node.bindPlanned(
        callMember(participants.proponent, { input, transcript, round: round + 1 }),
        Node.capture({ round }, (proponent) =>
          Node.bindPlanned(
            callMember(participants.opponent, { input, transcript, proponent, round: round + 1 }),
            Node.capture({ round }, (opponent) => visit(round + 1, [...transcript, { proponent, opponent }]))
          ))
      )
    }
    return visit(0, [])
  }
  return Flow.make(name, {
    ...(description === undefined ? {} : { description }),
    payload: OpaqueInput,
    success: Schema.Unknown,
    // The engine encodes a typed failure through this schema: the pattern's
    // own `PatternError`, and whatever a member it called failed with.
    error: Failure.schemaFor(
      [PatternError],
      [participants.proponent, participants.opponent, participants.judge]
    ) as typeof Schema.Unknown,
    body: Node.capture({ rounds }, body)
  })
}
