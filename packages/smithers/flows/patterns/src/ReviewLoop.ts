/**
 * Bounded produce-review-revise pattern.
 *
 * @see https://smithers.sh/docs/reference/api/patterns
 * @see https://smithers.sh/docs/reference/api/patterns#identity-and-ownership
 *
 * @since 0.1.0
 */
import { Flow, Node } from "@smthrs/core"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Compose from "./internal/Compose.ts"
import { PatternError } from "./PatternError.ts"

/**
 * Configuration for {@link make}.
 *
 * `produce` receives the pattern input. `review` receives the produced value;
 * `revise` receives `{ output, review }`. Rounds are expanded at declaration
 * time so cancellation remains ordinary structured fiber interruption.
 *
 * @category models
 * @since 0.1.0
 */
export interface MakeOptions {
  readonly name?: string | undefined
  readonly description?: string | undefined
  readonly produce: Flow.Any
  readonly review: Flow.Any
  readonly revise: Flow.Any
  readonly maxRounds: number
}

/**
 * Operational callbacks for {@link run}.
 *
 * @category models
 * @since 0.1.0
 */
export interface RuntimeOptions<I, A, Review, E, R, E2, R2, E3, R3> {
  readonly produce: (input: I) => Effect.Effect<A, E, R>
  readonly review: (output: A, round: number) => Effect.Effect<Review, E2, R2>
  readonly revise: (input: {
    readonly output: A
    readonly review: Review
    readonly round: number
  }) => Effect.Effect<A, E3, R3>
  readonly maxRounds: number
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
  readonly _tag: "Approved"
  readonly output: A
}

/**
 * An unapproved result returned after the round bound is reached, with the
 * review that refused it.
 *
 * @category models
 * @since 0.1.0
 */
export interface Exhausted<A, Review> {
  readonly _tag: "Exhausted"
  readonly output: A
  readonly review: Review
}

/**
 * One unambiguous loop outcome: a review approved the output, or the rounds
 * ran out.
 *
 * Both arms carry `_tag` and nest the produced value under `output`, so a
 * caller branches on the discriminator rather than on the shape of the value
 * the loop produced.
 *
 * @category models
 * @since 1.0.0
 */
export type Settled<A, Review> = Approved<A> | Exhausted<A, Review>

/**
 * Reads an accepted decision: `true`, `"approved"`, `{ approved: true }`, or
 * `{ accepted: true }`.
 *
 * @category predicates
 * @since 0.1.0
 */
export const accepted = Compose.accepted

/**
 * Builds the conservative topology for every declared review round. Use
 * {@link run} for runtime approval and short-circuiting.
 * A very large `maxRounds` builds a very large graph before anything runs.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (options: MakeOptions): Flow.Flow<typeof Schema.Unknown, typeof Schema.Unknown, unknown> => {
  // The body runs when the graph builds, later than this call, so it reads
  // these snapshots and never the caller's options again.
  const stages = { produce: options.produce, review: options.review, revise: options.revise }
  const maxRounds = options.maxRounds
  if (!Number.isSafeInteger(maxRounds) || maxRounds < 1) {
    throw new PatternError({
      code: "invalid_decorator",
      message: "ReviewLoop maxRounds must be a positive safe integer"
    })
  }
  const { name, description } = Compose.label("reviewLoop", { maxRounds }, options)
  return Flow.make({
    name,
    description,
    input: Schema.Unknown,
    output: Schema.Unknown,
    flows: [stages.produce, stages.review, stages.revise],
    body: Node.capture(
      { maxRounds },
      (input) =>
        Node.andThen(
          Compose.call(stages.produce, input),
          Node.capture({ maxRounds }, (initial) => {
            const visit = (output: unknown, round: number): Node.Node<unknown, unknown> =>
              Node.andThen(
                Compose.call(stages.review, output),
                Node.capture({ maxRounds, round }, (review) => {
                  if (accepted(review)) return Node.succeed({ _tag: "Approved", output })
                  if (round >= maxRounds) {
                    return Node.succeed({ _tag: "Exhausted", output, review })
                  }
                  return Node.andThen(
                    Compose.call(stages.revise, { output, review, round }),
                    Node.capture({ maxRounds, round }, (revised) => visit(revised, round + 1))
                  )
                })
              )
            return visit(initial, 1)
          })
        )
    )
  })
}

/**
 * Executes produce-review-revise rounds and short-circuits on approval.
 *
 * Both outcomes are tagged: an accepted review returns {@link Approved} and a
 * spent round bound returns {@link Exhausted} with the review that refused it.
 *
 * This Effect is the operational value-dependent branch; the flow declaration
 * remains a conservative topology because core plans continuations against
 * symbolic values. Fiber interruption propagates normally.
 *
 * @category combinators
 * @since 0.1.0
 */
export const run = <I, A, Review, E, R, E2, R2, E3, R3>(
  input: I,
  options: RuntimeOptions<I, A, Review, E, R, E2, R2, E3, R3>
): Effect.Effect<Settled<A, Review>, E | E2 | E3 | PatternError, R | R2 | R3> => {
  // Snapshots taken at the call: the effect may run later, and a caller's
  // edit to the option object in between must not reach it.
  const stages = { produce: options.produce, review: options.review, revise: options.revise }
  const maxRounds = options.maxRounds
  if (!Number.isSafeInteger(maxRounds) || maxRounds < 1) {
    return Effect.fail(
      new PatternError({
        code: "invalid_decorator",
        message: "ReviewLoop maxRounds must be a positive safe integer"
      })
    )
  }
  return Effect.gen(function*() {
    let output = yield* stages.produce(input)
    let round = 1
    while (true) {
      const review = yield* stages.review(output, round)
      if (accepted(review)) {
        const approved: Approved<A> = { _tag: "Approved", output }
        return approved
      }
      if (round === maxRounds) {
        const spent: Exhausted<A, Review> = { _tag: "Exhausted", output, review }
        return spent
      }
      output = yield* stages.revise({ output, review, round })
      round += 1
    }
  })
}
