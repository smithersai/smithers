/** Minimal generator protocol and helpers copied from smithersai/effect
 * packages/effect/src/internal/arbitrary/model.ts at fc84e193be6b202f34a7351cdfb693629c95a38c.
 * No public API exposes these helpers; Effect 4.1.1's Arbitrary.gen uses this identical protocol.
 * @since 4.0.0
 */
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
/** @internal */
export type ShrinkPull<A> = Effect.Effect<A, Cause.Done>

/**
 * Builds a cause handler that recovers typed failures, or propagates only
 * defects and interruptions, preserving their original annotations.
 *
 * @internal
 */
export const onTypedFailure = <E, A, E2, R>(
  f: (error: E) => Effect.Effect<A, E2, R>
) =>
(cause: Cause.Cause<E>): Effect.Effect<A, E2, R> => {
  if (!cause.reasons.every(Cause.isFailReason)) {
    return Effect.failCause(Cause.fromReasons<never>(cause.reasons.filter(
      (reason): reason is Cause.Die | Cause.Interrupt => reason._tag !== "Fail"
    )))
  }
  const error = Cause.findError(cause)
  return Result.isFailure(error) ? Effect.failCause(error.failure) : f(error.success)
}

/** @internal */
export interface Sample<out A> {
  readonly _tag: "Generated"
  readonly value: A
  readonly shrinks: ShrinkPull<Attempt<A>> | undefined
}

/** @internal */
export interface Discarded {
  readonly _tag: "Discarded"
}

/** @internal */
export type Attempt<A> = Sample<A> | Discarded

/** @internal */
export type Computation<A> = A | Effect.Effect<A>

/** @internal */
export type Generation<A> = Computation<Attempt<A>>

/** @internal */
export interface GenerationRandom {
  readonly nextUint32: () => number
  readonly nextDoubleUnsafe: () => number
  readonly clone: () => GenerationRandom
  readonly copyFrom: (source: GenerationRandom) => void
  readonly snapshot: () => readonly [number, number, number, number]
}

/** @internal */
export interface GenerationState {
  readonly size: number
  readonly shrinks: boolean
  readonly biasFactor: number
  readonly nullPrototype: boolean
  readonly random: GenerationRandom
  readonly budget: {
    remaining: number
  }
}

/** @internal */
export interface Generator<A> {
  readonly minCost: number
  readonly generate: (state: GenerationState) => Generation<A>
}

/** @internal */
export function isAttempt<A>(self: Generation<A>): self is Attempt<A> {
  return (self as Attempt<A>)._tag === "Generated" || (self as Attempt<A>)._tag === "Discarded"
}

/** @internal */
export function toEffectGeneration<A>(self: Generation<A>): Effect.Effect<Attempt<A>> {
  return isAttempt(self) ? Effect.succeed(self) : self
}


// The npm declaration strips Arbitrary.gen's @internal member. Mirror only that
// protocol member from packages/effect/src/Arbitrary.ts at the same fork commit.
// This is type-only: it neither patches Effect nor installs a runtime adapter.
declare module "effect/Arbitrary" {
  interface Arbitrary<out A> {
    readonly gen: Generator<A>
  }
}
