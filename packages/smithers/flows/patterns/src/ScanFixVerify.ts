/**
 * Scan for issues, fix them in parallel, verify, and repeat until clean.
 *
 * This is the shape of every lint-fix, test-repair, and audit-remediation
 * workflow: the number of issues is a runtime fact, and so is the number of
 * rounds. {@link ReviewLoop} cannot express it, because a review loop revises
 * one artifact; here each issue gets its own fix.
 *
 * The declaration is {@link Loop} over a batched fan-out: the retry bound and
 * the fan-out bound are both declared, so the plan shows the worst case.
 * {@link run} performs the real fan-out over the issues the scanner actually
 * returned.
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
import * as Loop from "./Loop.ts"
import { PatternError } from "./PatternError.ts"

/**
 * Configuration for {@link make}.
 *
 * `maxIssues` is the declared fan-out bound: a plan cannot know how many
 * issues a scan will find, so the declaration carries the largest fan-out the
 * author will admit. `concurrency` batches those calls exactly as
 * `MapReduce.make` does, so the declared topology never fans out wider than
 * the bound.
 *
 * @category models
 * @since 0.1.0
 */
export interface MakeOptions {
  readonly name?: string | undefined
  readonly description?: string | undefined
  readonly scan: Flow.Any
  readonly fix: Flow.Any
  readonly verify: Flow.Any
  readonly maxRetries: number
  readonly maxIssues: number
  readonly concurrency: number
}

/**
 * Operational callbacks for {@link run}.
 *
 * `run` fixes every issue the scan returns, so keep `MakeOptions.maxIssues` at
 * or above what the scanner can produce for the declaration to stay honest.
 *
 * @category models
 * @since 0.1.0
 */
export interface RuntimeOptions<I, Issue, Fix, Verification, E, R, E2, R2, E3, R3> {
  readonly scan: (input: {
    readonly input: I
    readonly iteration: number
  }) => Effect.Effect<ReadonlyArray<Issue>, E, R>
  readonly fix: (input: {
    readonly issue: Issue
    readonly index: number
    readonly iteration: number
  }) => Effect.Effect<Fix, E2, R2>
  readonly verify: (input: {
    readonly input: I
    readonly issues: ReadonlyArray<Issue>
    readonly fixes: ReadonlyArray<Fix>
    readonly iteration: number
  }) => Effect.Effect<Verification, E3, R3>
  readonly maxRetries: number
  readonly concurrency: number
}

/**
 * The outcome of a scan-fix-verify run.
 *
 * `resolved` is true only when a scan came back empty. `remaining` is empty on
 * that clean exit and lists the last scan's issues when the retry bound stopped
 * the loop. `verifications` holds one entry per round that had something to fix.
 *
 * @category models
 * @since 0.1.0
 */
export interface Report<Issue, Verification> {
  readonly iterations: number
  readonly remaining: ReadonlyArray<Issue>
  readonly resolved: boolean
  readonly verifications: ReadonlyArray<Verification>
}

interface Round<Issue> {
  readonly issues: ReadonlyArray<Issue>
  /** True only for a round whose scan came back empty, which is the terminal. */
  readonly resolved: boolean
}

/**
 * Reads the signals a verifier uses to report that nothing is left to fix.
 *
 * A verifier answers with `true` or an object carrying `resolved: true`.
 * A symbolic plan-time value is neither, which keeps the declared unrolling
 * conservative.
 *
 * {@link run} does not stop on this verdict; it records every verification in
 * {@link Report.verifications} and stops on an empty scan. Callers read the
 * recorded verdicts with this function, so both sides use one vocabulary.
 *
 * @category predicates
 * @since 0.1.0
 */
export const resolved = (value: unknown): boolean =>
  value === true ||
  (typeof value === "object" && value !== null && "resolved" in value && value.resolved === true)

const positive = (value: number): boolean => Number.isSafeInteger(value) && value >= 1

const validate = (options: {
  readonly maxRetries: number
  readonly maxIssues?: number | undefined
  readonly concurrency: number
}): PatternError | undefined =>
  positive(options.maxRetries) && positive(options.concurrency) &&
    (options.maxIssues === undefined || positive(options.maxIssues))
    ? undefined
    : new PatternError({
      code: "invalid_decorator",
      message: "ScanFixVerify maxRetries, maxIssues, and concurrency must be positive safe integers"
    })

/**
 * Declares the bounded scan-fix-verify topology.
 *
 * Every retry is unrolled, and every retry declares `maxIssues` fix calls in
 * `concurrency`-sized batches, so the declaration already shows the confirming
 * rescan that follows a verified round. Which issues exist, and therefore which
 * fixes run, is a runtime fact that {@link run} settles.
 * Very large retry and issue bounds build a very large graph before anything runs.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (options: MakeOptions): Flow.Flow<typeof Schema.Unknown, typeof Schema.Unknown, unknown> => {
  const invalid = validate(options)
  if (invalid !== undefined) throw invalid
  // The body runs when the graph builds, later than this call, so it reads
  // these snapshots and never the caller's options again.
  const stages = { scan: options.scan, fix: options.fix, verify: options.verify }
  const maxRetries = options.maxRetries
  const maxIssues = options.maxIssues
  const concurrency = options.concurrency
  const captures = { maxRetries, maxIssues, concurrency }
  const { name, description } = Compose.label("scanFixVerify", { maxRetries, maxIssues, concurrency }, options)
  return Flow.make({
    name,
    description,
    input: Schema.Unknown,
    output: Schema.Unknown,
    flows: [stages.scan, stages.fix, stages.verify],
    body: Node.capture(captures, (input) => {
      const visit = (iteration: number): Node.Node<unknown, unknown> =>
        Node.andThen(
          Compose.call(stages.scan, { input, iteration }),
          Node.capture({ ...captures, iteration }, (issues) => {
            const found = issues as ReadonlyArray<unknown>
            let fixes: Node.Node<ReadonlyArray<unknown>, unknown> = Node.succeed([])
            for (let offset = 0; offset < maxIssues; offset += concurrency) {
              const members: Record<string, Node.Node<unknown, unknown>> = {}
              const last = Math.min(offset + concurrency, maxIssues)
              for (let index = offset; index < last; index++) {
                members[`fix-${index}`] = Compose.call(stages.fix, { issue: found[index], index, iteration })
              }
              fixes = Node.andThen(
                fixes,
                Node.capture({ ...captures, iteration, offset }, (previous) =>
                  Node.map(
                    Node.all(members),
                    Node.capture({ ...captures, iteration, offset }, (values) => [
                      ...previous,
                      ...Object.keys(values)
                        .sort((left, right) => Number(left.slice(4)) - Number(right.slice(4)))
                        .map((key) => values[key])
                    ])
                  ))
              )
            }
            return Node.andThen(
              fixes,
              Node.capture({ ...captures, iteration }, (fixed) =>
                Node.andThen(
                  Compose.call(stages.verify, { input, issues, fixes: fixed, iteration }),
                  Node.capture({ ...captures, iteration }, (verification) =>
                    iteration >= maxRetries
                      ? Node.succeed({
                        iterations: iteration,
                        remaining: issues,
                        resolved: false,
                        verifications: [verification]
                      })
                      : visit(iteration + 1))
                ))
            )
          })
        )
      return visit(1)
    })
  })
}

/**
 * Runs scan, per-issue fix, and verify until a scan comes back empty or the
 * retry bound is reached.
 *
 * An empty scan is the only terminal. A round whose verifier reports the issues
 * resolved is followed by one confirming rescan, because the scanner is the
 * authority on what is left and a verifier can be wrong. A clean scan ends the
 * loop without fixing or verifying anything, which is why a run whose first
 * scan is clean reports one iteration and no verifications. Fixes fan out with
 * `Effect.forEach` over a snapshot of the issues, so `concurrency` is the real
 * in-flight bound.
 *
 * @category combinators
 * @since 0.1.0
 */
export const run = <I, Issue, Fix, Verification, E, R, E2, R2, E3, R3>(
  input: I,
  options: RuntimeOptions<I, Issue, Fix, Verification, E, R, E2, R2, E3, R3>
): Effect.Effect<Report<Issue, Verification>, E | E2 | E3 | PatternError, R | R2 | R3> => {
  const invalid = validate(options)
  if (invalid !== undefined) return Effect.fail(invalid)
  // Snapshots taken at the call: the effect may run later, and a caller's
  // edit to the option object in between must not reach it.
  const stages = { scan: options.scan, fix: options.fix, verify: options.verify }
  const maxRetries = options.maxRetries
  const concurrency = options.concurrency
  return Effect.gen(function*() {
    const verifications: Array<Verification> = []
    const loop = yield* Loop.run<
      I,
      Round<Issue>,
      E | E2 | E3 | PatternError,
      R | R2 | R3,
      never,
      never
    >(input, {
      maxIterations: maxRetries,
      onMaxReached: "return-last",
      body: ({ input, iteration }) =>
        Effect.gen(function*() {
          const issues = yield* stages.scan({ input, iteration })
          if (issues.length === 0) return { issues, resolved: true }
          // A snapshot, so a fix that mutates the array the scan returned
          // cannot widen this round's fan-out.
          const fixes = yield* Effect.forEach(
            [...issues],
            (issue, index) => stages.fix({ issue, index, iteration }),
            { concurrency }
          )
          const verification = yield* stages.verify({ input, issues, fixes, iteration })
          verifications.push(verification)
          // A verification is evidence about the round it ends, not the
          // terminal. The next scan confirms it, and only an empty scan stops
          // the loop.
          return { issues, resolved: false }
        }),
      until: ({ value }) => Effect.succeed(value.resolved)
    })
    return {
      iterations: loop.iterations,
      remaining: loop.value.resolved ? [] : loop.value.issues,
      resolved: loop.value.resolved,
      verifications
    }
  })
}
