/**
 * A CI job: one machine, the commit checked out, its steps run in order, and
 * an outcome.
 *
 * `ci/job` is a flow a repository's CI calls once per job. It reserves one
 * machine for its life through the host's {@link Machine}, checks out exactly
 * the commit, then runs each step as its own durable action, so a step that
 * ran is never run again on resume and a run page can show each one.
 *
 * - **An outcome, never a failure.** The job settles `passed`, `failed`,
 *   `cancelled` or `skipped`. A step that exits non-zero fails the job and
 *   skips the steps after it; a machine that never answers fails it too,
 *   with one `machine` step, and is released all the same. So `Node.all`
 *   over many jobs reports every row, as a matrix should.
 * - **Exactly the commit.** A checkout that isn't exactly `sha` fails the job
 *   before any step runs, never a pass another commit earned.
 * - **The host owns the machine.** This module names no provider: the host
 *   provides {@link Machine} (a container per job on Cloudflare, a test's own
 *   machine in a test).
 *
 * ```ts
 * import { CiJob } from "@smthrs/sandbox"
 *
 * const lint = CiJob.make("lint", {
 *   steps: [
 *     { name: "install", run: "pnpm install --frozen-lockfile" },
 *     { name: "lint", run: "pnpm lint" }
 *   ]
 * })
 * // inside a flow's body, with the run's target:
 * // lint.call({ run, repo, sha, ref })
 * ```
 *
 * @since 1.0.0-rc.17
 */

import { Action, Flow, RetryPolicy } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

/**
 * Bounds on a job's declaration.
 *
 * @category constants
 * @since 1.0.0-rc.17
 */
export const limits = {
  steps: 32,
  commandLength: 16 * 1024,
  defaultTimeoutSeconds: 600,
  maxTimeoutSeconds: 600
} as const

/**
 * A job's or a step's name: a letter or digit, then up to 63 letters, digits,
 * dots, dashes or underscores.
 *
 * @category schemas
 * @since 1.0.0-rc.17
 */
export const Name = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/))

/**
 * How a job or a step ended.
 *
 * @category schemas
 * @since 1.0.0-rc.17
 */
export const Outcome = Schema.Literals(["passed", "failed", "cancelled", "skipped"])

/**
 * How a job or a step ended.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export type Outcome = typeof Outcome.Type

/**
 * One step: a shell command run with `sh -c` at the checkout's root, for at
 * most `timeoutSeconds` (`limits.defaultTimeoutSeconds` unless set).
 *
 * @category schemas
 * @since 1.0.0-rc.17
 */
export const Step = Schema.Struct({
  name: Name,
  run: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(limits.commandLength)),
  timeoutSeconds: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: limits.maxTimeoutSeconds }))
  )
})

/**
 * One step.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export type Step = typeof Step.Type

/**
 * A job: its name and its steps, in order.
 *
 * @category schemas
 * @since 1.0.0-rc.17
 */
export const Job = Schema.Struct({
  name: Name,
  steps: Schema.Array(Step).check(Schema.isMinLength(1), Schema.isMaxLength(limits.steps))
})

/**
 * A job.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export type Job = typeof Job.Type

/**
 * What a job runs on: the run it belongs to, the repository (`owner/name`),
 * the commit, and the ref the commit was pushed to or proposed from.
 *
 * @category schemas
 * @since 1.0.0-rc.17
 */
export const Target = Schema.Struct({
  run: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  repo: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/)),
  sha: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)),
  ref: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))
})

/**
 * What a job runs on.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export type Target = typeof Target.Type

/**
 * How one step ended: its outcome and, when it ran to an end, its exit code.
 *
 * @category schemas
 * @since 1.0.0-rc.17
 */
export const StepResult = Schema.Struct({
  name: Schema.String,
  outcome: Outcome,
  exitCode: Schema.NullOr(Schema.Int),
  output: Schema.optionalKey(Schema.Struct({ stdout: Schema.String, stderr: Schema.String, truncated: Schema.Boolean }))
})

/**
 * How one step ended.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export type StepResult = typeof StepResult.Type

/**
 * How a job ended: its outcome, then the checkout and each step.
 *
 * @category schemas
 * @since 1.0.0-rc.17
 */
export const Result = Schema.Struct({ outcome: Outcome, steps: Schema.Array(StepResult) })

/**
 * How a job ended.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export type Result = typeof Result.Type

/**
 * The name the checkout has among a job's steps.
 *
 * @category constants
 * @since 1.0.0-rc.17
 */
export const CHECKOUT = "checkout"

/**
 * The machine couldn't start or answer. The action retries it under
 * {@link RETRY}; past that the job fails.
 *
 * @category errors
 * @since 1.0.0-rc.17
 */
export class MachineUnavailable extends Schema.TaggedError<MachineUnavailable>()(
  "@smthrs/sandbox/CiJob/MachineUnavailable",
  {}
) {}

/**
 * A job's machine, which the host provides. One machine per `(target.run,
 * job)`: `checkout` puts exactly `target.sha` in its working copy and answers
 * whether it did; `run` runs one step there at most once per `(target.run,
 * job, index)`, answering its exit code; `release` lets the machine go,
 * best effort.
 *
 * @category services
 * @since 1.0.0-rc.17
 */
export class Machine extends Context.Service<
  Machine,
  {
    readonly checkout: (target: Target, job: string) => Effect.Effect<boolean, MachineUnavailable>
    readonly run: (
      target: Target,
      job: string,
      index: number,
      step: Step
    ) => Effect.Effect<
      {
        readonly exitCode: number
        readonly timedOut: boolean
        readonly output?: { readonly stdout: string; readonly stderr: string; readonly truncated: boolean }
      },
      MachineUnavailable
    >
    readonly release: (target: Target, job: string) => Effect.Effect<void>
  }
>()("@smthrs/sandbox/CiJob/Machine") {}

/**
 * How a step's action retries a machine that didn't answer: 1 s doubling to
 * a minute, for at most 30 minutes.
 *
 * @category constants
 * @since 1.0.0-rc.17
 */
export const RETRY = RetryPolicy.make({ initialMs: 1_000, factor: 2, maxMs: 60_000, expirationMs: 30 * 60_000 })

/**
 * Checks the commit out: the job's first result, `passed` with the checkout,
 * or `failed` when the machine has another commit.
 *
 * @category actions
 * @since 1.0.0-rc.17
 */
export const Checkout = Action.make("ci/job/Checkout", {
  payload: { target: Target, job: Job },
  success: Result,
  error: MachineUnavailable,
  retryPolicy: RETRY
})

/**
 * Runs step `index` unless the job already failed, adding its result to
 * `sofar`.
 *
 * @category actions
 * @since 1.0.0-rc.17
 */
export const RunStep = Action.make("ci/job/Step", {
  payload: { target: Target, job: Job, index: Schema.Int, sofar: Result },
  success: Result,
  error: MachineUnavailable,
  retryPolicy: RETRY
})

/**
 * Lets the job's machine go and answers the job's result.
 *
 * @category actions
 * @since 1.0.0-rc.17
 */
export const Release = Action.make("ci/job/Release", {
  payload: { target: Target, job: Job, result: Result },
  success: Result
})

/**
 * The name a job's result gives the machine when it never answered: the job failed there, and the steps it had run
 * are lost with it.
 *
 * @category constants
 * @since 1.0.0-rc.17
 */
export const MACHINE = "machine"

type Requires = Action.Requirement<"ci/job/Checkout" | "ci/job/Step" | "ci/job/Release">

/**
 * The `ci/job` flow: checkout, each step, release. It never fails: a machine
 * that never answers settles the job `failed`.
 *
 * @category flows
 * @since 1.0.0-rc.17
 */
export const CiJob = Flow.make("ci/job", {
  description: "Run one CI job on its own machine: check out the commit, run each step in order, and settle an " +
    "outcome, passed, failed, cancelled or skipped.",
  capabilities: ["sandbox:job"],
  modelInvocable: false,
  payload: { target: Target, job: Job },
  success: Result,
  // Captured, so the body has a stable identity wherever the run is driven, a child run on another host included.
  body: Node.capture(
    { checkout: Checkout.name, step: RunStep.name, release: Release.name, machine: MACHINE },
    ({ job, target }: { readonly target: Target; readonly job: Job }) =>
      job.steps.reduce<Node.Node<Result, MachineUnavailable, Requires>>(
        (chain, _, index) =>
          chain.pipe(Node.bindPlanned(Node.capture(
            { step: RunStep.name, index, target, job },
            function(this: { readonly index: number; readonly target: Target; readonly job: Job }, sofar) {
              return RunStep.call({ target: this.target, job: this.job, index: this.index, sofar })
            }
          ))),
        Checkout.call({ target, job })
      ).pipe(
        Node.bindPlanned(Node.capture(
          { release: Release.name, target, job },
          function(this: { readonly target: Target; readonly job: Job }, result) {
            return Release.call({ target: this.target, job: this.job, result })
          }
        )),
        // A machine that never answered fails the job, and is let go all the same.
        Node.catch({
          onFailure: Node.capture(
            { release: Release.name, target, job, machine: MACHINE },
            function(this: { readonly target: Target; readonly job: Job; readonly machine: string }) {
              const result: Result = {
                outcome: "failed",
                steps: [{ name: this.machine, outcome: "failed", exitCode: null }]
              }
              return Release.call({ target: this.target, job: this.job, result })
            }
          )
        })
      )
  )
})

// Reserve room for all 32 outcome rows inside RunInspection's 16 KiB value.
// Bound encoded JSON bytes, including escapes, instead of raw string length.
const outputText = (text: string) => {
  const bytes = (length: number) => new TextEncoder().encode(JSON.stringify(text.slice(0, length))).length
  let low = 0, high = text.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (bytes(mid) <= 4096) low = mid
    else high = mid - 1
  }
  return text.slice(0, low)
}

const machine = Effect.gen(function*() {
  return yield* Machine
})

/**
 * The implementations of `ci/job`'s actions over the host's {@link Machine}.
 *
 * @category layers
 * @since 1.0.0-rc.17
 */
export const layer = Layer.mergeAll(
  Checkout.toLayer(({ job, target }) =>
    Effect.flatMap(machine, (m) => m.checkout(target, job.name)).pipe(
      Effect.map((exact): Result => ({
        outcome: exact ? "passed" : "failed",
        steps: [{ name: CHECKOUT, outcome: exact ? "passed" : "failed", exitCode: null }]
      }))
    )
  ),
  RunStep.toLayer(({ index, job, sofar, target }) => {
    const step = job.steps[index]!
    // Each action's own sealed outcome owns its output. Carry only outcome
    // metadata forward so earlier verbose commands cannot clip later records.
    const prior = sofar.steps.map(({ output: _, ...row }) => row)
    if (sofar.outcome !== "passed") {
      return Effect.succeed<Result>({
        outcome: sofar.outcome,
        steps: [...prior, { name: step.name, outcome: "skipped", exitCode: null }]
      })
    }
    return Effect.flatMap(machine, (m) => m.run(target, job.name, index, step)).pipe(
      Effect.map(({ exitCode, timedOut, output }): Result => {
        const outcome = exitCode === 0 && !timedOut ? "passed" : "failed"
        const stdout = output === undefined ? "" : outputText(output.stdout)
        const stderr = output === undefined ? "" : outputText(output.stderr)
        return {
          outcome,
          steps: [...prior, {
            name: step.name,
            outcome,
            exitCode: timedOut ? null : exitCode,
            ...(output === undefined
              ? {}
              : {
                output: {
                  stdout,
                  stderr,
                  truncated: output.truncated || stdout !== output.stdout || stderr !== output.stderr
                }
              })
          }]
        }
      })
    )
  }),
  Release.toLayer(({ job, result, target }) =>
    Effect.flatMap(machine, (m) => m.release(target, job.name)).pipe(Effect.as(result))
  )
)

/**
 * A job a repository's flow declares: `make(name, { steps })`, then
 * `.call(target)` inside the flow's body starts it as a `ci/job` child run.
 *
 * @category constructors
 * @since 1.0.0-rc.17
 */
export const make = (name: string, options: { readonly steps: ReadonlyArray<Step> }) => {
  const job: Job = { name, steps: options.steps }
  return {
    job,
    call: (target: Target) => CiJob.child({ target, job })
  }
}
