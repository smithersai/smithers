/**
 * Bounded repeat-until-predicate loops.
 *
 * A loop is the one control-flow shape a plan cannot represent honestly: the
 * number of rounds is a runtime fact. This module answers that the same way
 * `ReviewLoop` answers it. {@link make} unrolls the declared bound into a
 * conservative topology, declaring every iteration a run could reach so that
 * capability and conflict analysis see the worst case. {@link run} performs the
 * value-dependent stop, short-circuiting the moment the predicate is
 * satisfied.
 *
 * For a loop whose rounds must survive a crash, hand each iteration to the
 * durable trampoline instead: `Flow.to` with `maxRounds`, described in the
 * loops reference at https://smithers.sh/docs/reference/api/patterns.
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
 * What a loop does when it reaches its iteration bound unsatisfied.
 *
 * @category models
 * @since 0.1.0
 */
export type OnMaxReached = "fail" | "return-last"

/**
 * Configuration for {@link make}.
 *
 * `body` runs once per iteration and receives `{ input, previous, iteration }`,
 * where `previous` is the preceding iteration's output and is absent on the
 * first. `until` receives `{ value, iteration }`; omit it for a loop whose body
 * reports its own completion, which is what {@link ralph} names.
 *
 * `onMaxReached` defaults to `"return-last"`, so a loop that omits it hands the
 * caller the last value it produced instead of failing.
 *
 * `captures` adds inert declaration identity for a caller that layers its own
 * runtime threshold over this loop, so two otherwise identical declarations
 * that differ in that threshold do not share a step key.
 *
 * @category models
 * @since 0.1.0
 */
export interface MakeOptions {
  readonly name?: string | undefined
  readonly description?: string | undefined
  readonly body: Flow.Any
  readonly until?: Flow.Any | undefined
  readonly maxIterations: number
  readonly onMaxReached?: OnMaxReached | undefined
  readonly captures?: Readonly<Record<string, unknown>> | undefined
}

/**
 * Configuration for {@link ralph}, a loop with no separate predicate flow.
 *
 * @category models
 * @since 0.1.0
 */
export type RalphOptions = Omit<MakeOptions, "until">

/**
 * Operational callbacks for {@link run}.
 *
 * `onMaxReached` defaults to `"return-last"`.
 *
 * @category models
 * @since 0.1.0
 */
export interface RuntimeOptions<I, A, E, R, E2, R2> {
  readonly body: (input: {
    readonly input: I
    readonly previous: A | undefined
    readonly iteration: number
  }) => Effect.Effect<A, E, R>
  readonly until?:
    | ((input: { readonly value: A; readonly iteration: number }) => Effect.Effect<unknown, E2, R2>)
    | undefined
  readonly maxIterations: number
  readonly onMaxReached?: OnMaxReached | undefined
}

/**
 * Operational callbacks for {@link runRalph}.
 *
 * @category models
 * @since 0.1.0
 */
export type RalphRuntimeOptions<I, A, E, R> = Omit<RuntimeOptions<I, A, E, R, never, never>, "until">

/**
 * The outcome of a bounded loop.
 *
 * `exhausted` is true when the bound stopped the loop rather than the
 * predicate. `iterations` counts the bodies that ran.
 *
 * @category models
 * @since 0.1.0
 */
export interface Result<A> {
  readonly value: A
  readonly iterations: number
  readonly exhausted: boolean
}

const call = (flow: Flow.Any, input: unknown): Node.Node<unknown, unknown> =>
  (flow as unknown as (input: unknown) => Node.Node<unknown, unknown>)(input)

/**
 * Reads the completion signals a loop predicate may return.
 *
 * A predicate answers with `true`, the string `"done"`, or an object carrying
 * `done: true`. Everything else continues the loop, which is what a symbolic
 * plan-time value does: an unresolved value never ends the declared unrolling,
 * so the topology stays conservative.
 *
 * An explicit `until` flow and a Ralph body are read by this one function, so
 * the two forms share one completion vocabulary. The match is exact: `"DONE"`,
 * `"yes"`, `1`, and `{ done: "true" }` all continue the loop.
 *
 * @category predicates
 * @since 0.1.0
 */
export const done = (value: unknown): boolean =>
  value === true ||
  value === "done" ||
  (typeof value === "object" && value !== null && "done" in value && value.done === true)

const defaultOnMaxReached: OnMaxReached = "return-last"

const bound = (maxIterations: number): PatternError | undefined =>
  Number.isSafeInteger(maxIterations) && maxIterations >= 1 ? undefined : new PatternError({
    code: "invalid_decorator",
    message: "Loop maxIterations must be a positive safe integer"
  })

/**
 * Declares a bounded loop as its fully unrolled conservative topology.
 *
 * Every iteration up to `maxIterations` is declared, because a plan cannot
 * know which iteration a run stops at. Reaching the bound is a value, not a
 * declared failure: core node declarations have no failure arm, so the
 * `"fail"` policy is applied by {@link run}.
 * A very large `maxIterations` builds a very large graph before anything runs,
 * and a bound whose chain nests past core's plan depth limit is refused here
 * rather than at `Graph.build`: 511 iterations without an `until` flow, 255
 * with one. {@link run} takes the same bounds without unrolling them, so an
 * unbounded loop belongs there.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (options: MakeOptions): Flow.Flow<typeof Schema.Unknown, typeof Schema.Unknown, unknown> => {
  // The body runs when the graph builds, later than this call, so it reads
  // these snapshots and never the caller's options again.
  const declared = { body: options.body, until: options.until }
  const maxIterations = options.maxIterations
  // One node per declared call, chained, so the plan nests one level per call:
  // a body alone spends one level an iteration, a body plus `until` two.
  const invalid = bound(maxIterations) ??
    Compose.sequencedBoundRefusal("Loop", "maxIterations", maxIterations, declared.until === undefined ? 1 : 2)
  if (invalid !== undefined) throw invalid
  const onMaxReached = options.onMaxReached ?? defaultOnMaxReached
  const captures = {
    ...options.captures,
    maxIterations,
    onMaxReached,
    predicate: declared.until === undefined ? "body" : "flow"
  }
  const { name, description } = Compose.label("loop", { maxIterations, onMaxReached }, options)
  return Flow.make({
    name,
    description,
    input: Schema.Unknown,
    output: Schema.Unknown,
    flows: declared.until === undefined ? [declared.body] : [declared.body, declared.until],
    body: Node.capture(captures, (input) => {
      const visit = (previous: unknown, iteration: number): Node.Node<unknown, unknown> =>
        Node.andThen(
          call(declared.body, { input, previous, iteration }),
          Node.capture({ ...captures, iteration }, (produced) => {
            const settle = (verdict: unknown): Node.Node<unknown, unknown> =>
              done(verdict)
                ? Node.succeed({ value: produced, iterations: iteration, exhausted: false })
                : iteration >= maxIterations
                ? Node.succeed({ value: produced, iterations: iteration, exhausted: true })
                : visit(produced, iteration + 1)
            return declared.until === undefined ? settle(produced) : Node.andThen(
              call(declared.until, { value: produced, iteration }),
              Node.capture({ ...captures, iteration }, settle)
            )
          })
        )
      return visit(undefined, 1)
    })
  })
}

/**
 * Declares a Ralph loop: a bounded loop whose body reports its own completion.
 *
 * Ralph is the loop that keeps handing an agent the same goal until the agent
 * says it is finished. There is no separate predicate flow, so the declared
 * topology is `maxIterations` body calls and nothing else. `onMaxReached`
 * defaults to `"return-last"`, so `ralph({ body, maxIterations })` is the whole
 * declaration.
 *
 * @category constructors
 * @since 0.1.0
 */
export const ralph = (options: RalphOptions): Flow.Flow<typeof Schema.Unknown, typeof Schema.Unknown, unknown> =>
  make(options)

/**
 * Runs a bounded loop, stopping at the first satisfied predicate.
 *
 * The bound is checked before the first body runs, so an invalid declaration
 * never starts work. The body always runs at least once, because the predicate
 * reads a produced value: a predicate that would answer `true` from the start
 * still costs one iteration. Fiber interruption propagates normally.
 *
 * @category combinators
 * @since 0.1.0
 */
export const run = <I, A, E, R, E2, R2>(
  input: I,
  options: RuntimeOptions<I, A, E, R, E2, R2>
): Effect.Effect<Result<A>, E | E2 | PatternError, R | R2> => {
  // Snapshots taken at the call: the effect may run later, and a caller's
  // edit to the option object in between must not reach it.
  const declared = { body: options.body, until: options.until }
  const maxIterations = options.maxIterations
  const invalid = bound(maxIterations)
  if (invalid !== undefined) return Effect.fail(invalid)
  const onMaxReached = options.onMaxReached ?? defaultOnMaxReached
  return Effect.gen(function*() {
    let previous: A | undefined = undefined
    // `bound` rejected a maxIterations below one, so iteration 1 always runs
    // and the bound arm below always returns. The loop needs no exit test.
    for (let iteration = 1;; iteration++) {
      const value: A = yield* declared.body({ input, previous, iteration })
      previous = value
      const verdict = declared.until === undefined ? value : yield* declared.until({ value, iteration })
      if (done(verdict)) return { value, iterations: iteration, exhausted: false }
      if (iteration >= maxIterations) {
        if (onMaxReached === "fail") {
          return yield* Effect.fail(
            new PatternError({
              code: "exhausted",
              message: `Loop reached its bound of ${maxIterations} iterations unsatisfied`
            })
          )
        }
        return { value, iterations: iteration, exhausted: true }
      }
    }
  })
}

/**
 * Runs a Ralph loop, stopping when the body reports `done`.
 *
 * Reaching the bound returns the last value with `exhausted: true` unless the
 * caller asks for `onMaxReached: "fail"`.
 *
 * @category combinators
 * @since 0.1.0
 */
export const runRalph = <I, A, E, R>(
  input: I,
  options: RalphRuntimeOptions<I, A, E, R>
): Effect.Effect<Result<A>, E | PatternError, R> => run(input, options)
