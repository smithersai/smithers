/**
 * Generate, evaluate, improve: a bounded search for a candidate that reaches a
 * target score.
 *
 * The optimizer is {@link Loop} plus two things a loop does not have: a score
 * threshold as its predicate, and a best-so-far ledger, because the last
 * candidate a search produces is often not its best one. Every iteration hands
 * the previous candidate's score and feedback to the next generation, which is
 * what makes the search a search rather than a retry.
 *
 * This pattern scores one candidate with one evaluator. A search that scores
 * candidates against a fixed suite belongs above the pattern layer, in the
 * caller that owns the suite.
 *
 * @see https://smithers.sh/docs/reference/api/patterns
 * @see https://smithers.sh/docs/reference/api/patterns#identity-and-ownership
 *
 * @since 0.1.0
 */
import { Flow, Node } from "@smthrs/core"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Loop from "./Loop.ts"
import { PatternError } from "./PatternError.ts"

/**
 * What an optimizer does when it exhausts its iteration bound below target.
 *
 * @category models
 * @since 0.1.0
 */
export type OnMaxReached = Loop.OnMaxReached

/**
 * A scored candidate produced by one iteration.
 *
 * @category models
 * @since 0.1.0
 */
export interface Attempt<C> {
  readonly candidate: C
  readonly score: number
  readonly feedback?: unknown | undefined
  readonly iteration: number
}

/**
 * What an evaluator returns for one candidate.
 *
 * `score` must be a finite number. A non-finite evaluator answer is a broken
 * evaluation, not an exhausted search, and {@link run} refuses it immediately.
 *
 * `feedback` is opaque to the pattern and is handed back to the next
 * generation unchanged.
 *
 * @category models
 * @since 0.1.0
 */
export interface Evaluation {
  readonly score: number
  readonly feedback?: unknown | undefined
}

/**
 * Configuration for {@link make}.
 *
 * `generate` is called with `{ input, previous, iteration }`, where `previous`
 * is the whole preceding attempt, `{ candidate, score, feedback, iteration }`,
 * and is absent on the first. `evaluate` is called with `{ value, iteration }`
 * and answers `{ score, feedback? }`. `onMaxReached: "fail"` requires a
 * `targetScore`, because without one there is nothing for the search to fall
 * short of.
 *
 * @category models
 * @since 0.1.0
 */
export interface MakeOptions {
  readonly generate: Flow.Any
  readonly evaluate: Flow.Any
  readonly targetScore?: number | undefined
  readonly maxIterations: number
  readonly onMaxReached: OnMaxReached
}

/**
 * Operational callbacks for {@link run}.
 *
 * @category models
 * @since 0.1.0
 */
export interface RuntimeOptions<I, C, E, R, E2, R2> {
  readonly generate: (input: {
    readonly input: I
    readonly previous: Attempt<C> | undefined
    readonly iteration: number
  }) => Effect.Effect<C, E, R>
  readonly evaluate: (input: {
    readonly value: C
    readonly iteration: number
  }) => Effect.Effect<Evaluation, E2, R2>
  readonly targetScore?: number | undefined
  readonly maxIterations: number
  readonly onMaxReached: OnMaxReached
}

/**
 * The outcome of a bounded optimization.
 *
 * `best` is the highest-scoring attempt, which is not always the last one, and
 * the earliest of equal scores. `converged` is true when `best` reached the
 * target score.
 *
 * @category models
 * @since 0.1.0
 */
export interface Result<C> {
  readonly best: Attempt<C>
  readonly iterations: number
  readonly converged: boolean
}

const validate = (options: {
  readonly targetScore?: number | undefined
  readonly maxIterations: number
  readonly onMaxReached: OnMaxReached
}): PatternError | undefined => {
  if (options.targetScore !== undefined && !Number.isFinite(options.targetScore)) {
    return new PatternError({ code: "invalid_decorator", message: "Optimizer targetScore must be a finite number" })
  }
  if (options.targetScore === undefined && options.onMaxReached === "fail") {
    return new PatternError({
      code: "invalid_decorator",
      message: "Optimizer onMaxReached 'fail' requires a targetScore to fall short of"
    })
  }
  if (!Number.isSafeInteger(options.maxIterations) || options.maxIterations < 1) {
    return new PatternError({
      code: "invalid_decorator",
      message: "Optimizer maxIterations must be a positive safe integer"
    })
  }
  return undefined
}

const call = (flow: Flow.Any, input: unknown): Node.Node<unknown, unknown> =>
  (flow as unknown as (input: unknown) => Node.Node<unknown, unknown>)(input)

// What one iteration hands the next: the attempt just scored, which the
// following generation reads, and the standing best, which the result reports.
// The pair is the whole memory of the search, so the only candidates alive at
// any point are the best one, the previous one, and the one being scored.
interface Generation<C> {
  readonly attempt: Attempt<C>
  readonly best: Attempt<C>
}

/**
 * Declares the bounded search as its conservative topology.
 *
 * Every iteration the bound allows is declared as a `generate` call followed
 * by an `evaluate` call. The search is not {@link Loop.make} with `evaluate`
 * as the predicate, because a loop hands the next body its predecessor's
 * output: `generate` would then be declared as reading the previous candidate
 * and nothing else. Here the next `generate` call reads the previous attempt,
 * `{ candidate, score, feedback, iteration }`, so the declared dataflow carries
 * the same edge the search actually depends on and dependency analysis sees
 * `evaluate` feeding the generation that follows it.
 *
 * The target score never enters the topology, because comparing a score is a
 * runtime decision; it enters declaration identity instead, so two searches
 * that differ only in their target do not share a step key.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (options: MakeOptions): Flow.Flow<typeof Schema.Unknown, typeof Schema.Unknown, unknown> => {
  const invalid = validate(options)
  if (invalid !== undefined) throw invalid
  // The body runs when the graph builds, later than this call, so it reads
  // these snapshots and never the caller's options again.
  const stages = { generate: options.generate, evaluate: options.evaluate }
  const maxIterations = options.maxIterations
  const captures = {
    ...options.targetScore === undefined ? {} : { targetScore: options.targetScore },
    maxIterations,
    onMaxReached: options.onMaxReached
  }
  return Flow.make({
    input: Schema.Unknown,
    output: Schema.Unknown,
    flows: [stages.generate, stages.evaluate],
    body: Node.capture(captures, (input) => {
      const visit = (previous: unknown, iteration: number): Node.Node<unknown, unknown> =>
        Node.andThen(
          call(stages.generate, { input, previous, iteration }),
          Node.capture({ ...captures, iteration }, (candidate) =>
            Node.andThen(
              call(stages.evaluate, { value: candidate, iteration }),
              Node.capture({ ...captures, iteration }, (evaluation) => {
                const scored = evaluation as { readonly score: number; readonly feedback: unknown }
                const attempt = {
                  candidate,
                  score: scored.score,
                  feedback: scored.feedback,
                  iteration
                }
                // A declaration cannot compare a score it does not have, so the
                // declared terminal is the exhausted one; `run` reports the
                // convergent case.
                return iteration >= maxIterations
                  ? Node.succeed({ best: attempt, iterations: iteration, converged: false })
                  : visit(attempt, iteration + 1)
              })
            ))
        )
      return visit(undefined, 1)
    })
  })
}

/**
 * Runs the search, stopping at the first candidate that reaches the target.
 *
 * Every iteration carries the standing best beside the attempt it just scored,
 * so `best` survives a later iteration that scores worse without the search
 * holding on to the candidates it has already lost. A later attempt has to beat
 * the standing best rather than match it, so equal scores keep the earliest
 * attempt. Reaching the bound below target fails `PatternError`
 * `exhausted` under `onMaxReached: "fail"` and returns the best attempt with
 * `converged: false` under `"return-last"`.
 *
 * @category combinators
 * @since 0.1.0
 */
export const run = <I, C, E, R, E2, R2>(
  input: I,
  options: RuntimeOptions<I, C, E, R, E2, R2>
): Effect.Effect<Result<C>, E | E2 | PatternError, R | R2> => {
  const invalid = validate(options)
  if (invalid !== undefined) return Effect.fail(invalid)
  // Snapshots taken at the call: the effect may run later, and a caller's
  // edit to the option object in between must not reach it.
  const stages = { generate: options.generate, evaluate: options.evaluate }
  const targetScore = options.targetScore
  const maxIterations = options.maxIterations
  const onMaxReached = options.onMaxReached
  return Effect.gen(function*() {
    const loop = yield* Loop.run<I, Generation<C>, E | E2 | PatternError, R | R2, never, never>(input, {
      maxIterations,
      onMaxReached: "return-last",
      body: ({ input, iteration, previous }) =>
        Effect.gen(function*() {
          const candidate = yield* stages.generate({ input, previous: previous?.attempt, iteration })
          const evaluation = yield* stages.evaluate({ value: candidate, iteration })
          if (!Number.isFinite(evaluation.score)) {
            return yield* Effect.fail(
              new PatternError({
                code: "invalid_input",
                message:
                  `Optimizer evaluation score at iteration ${iteration} must be a finite number, received ${evaluation.score}`
              })
            )
          }
          const attempt: Attempt<C> = {
            candidate,
            score: evaluation.score,
            feedback: evaluation.feedback,
            iteration
          }
          // A later attempt has to beat the standing best rather than match
          // it, so equal scores keep the earliest attempt wherever the tie
          // falls. Comparing here rather than folding a ledger at the end is
          // what releases a losing candidate as soon as the next one is
          // scored.
          return {
            attempt,
            best: previous === undefined || attempt.score > previous.best.score ? attempt : previous.best
          }
        }),
      until: ({ value }) => Effect.succeed(targetScore !== undefined && value.attempt.score >= targetScore)
    })
    const best = loop.value.best
    const converged = targetScore !== undefined && best.score >= targetScore
    if (!converged && onMaxReached === "fail") {
      return yield* Effect.fail(
        new PatternError({
          code: "exhausted",
          message: `Optimizer reached its bound of ${maxIterations} iterations below ${targetScore}`
        })
      )
    }
    return { best, iterations: loop.iterations, converged }
  })
}
