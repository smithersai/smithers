/**
 * Set up an environment, run smoke checks in parallel, and aggregate a pass/fail report.
 *
 * Port of the 0.x `smoketest.jsx`. A setup step prepares the directory with
 * `setupCmd` (default `npm install`). When it reports the environment ready,
 * each smoke check (default typecheck, lint, test and build) runs, at most
 * `maxParallel` (default 4) at a time, and a check that could not run fails
 * only its own row. The report passes only when at least one check ran and
 * every check passed.
 *
 * 0.x's setup and check agents ran shell commands; here they are the deterministic `Setup` and `RunCheck` actions a host implements, so a test never runs a command.
 * 0.x's per-task `timeoutMs` is a declaration constant in 1.0 (`attemptTimeoutMs`), so the run's `timeoutMs` goes to the host, which fails the check with `CheckFailed` when the command outlives it.
 * `CheckSuite` does not fit: it keeps no durations.
 * `Sandbox.run` acquires a machine per action, so it cannot keep one environment across the setup and the checks; the host owns the environment.
 * 0.x dropped a check that could not run and passed an empty report, so a setup that failed or checks that all timed out passed; here both fail.
 */
import { Action, Flow } from "@smthrs/flow"
import * as Bounded from "@smthrs/patterns/Bounded"
import { Node } from "@smthrs/plan"
import type * as Planned from "@smthrs/plan/Planned"
import type * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

/** What the setup step reports. */
export const SetupResult = Schema.Struct({
  environment: Schema.String,
  ready: Schema.Boolean,
  details: Schema.String
})

/** One smoke check to run. */
export const SmokeCheck = Schema.Struct({ name: Schema.String, cmd: Schema.String })

/** One check's outcome. */
export const CheckResult = Schema.Struct({
  name: Schema.String,
  passed: Schema.Boolean,
  duration: Schema.Number,
  error: Schema.optional(Schema.String),
  output: Schema.String
})

/** The report the flow settles with. */
export const Report = Schema.Struct({
  totalChecks: Schema.Number,
  passed: Schema.Number,
  failed: Schema.Number,
  duration: Schema.Number,
  verdict: Schema.Literals(["pass", "fail"]),
  failures: Schema.Array(Schema.String),
  summary: Schema.String
})

/** A check the host could not run to an outcome, such as one that outlived `timeoutMs`. */
export class CheckFailed extends Schema.TaggedError<CheckFailed>()("examples/Smoketest/CheckFailed", {
  name: Schema.String,
  reason: Schema.String
}) {}

type CheckResult = typeof CheckResult.Type

/** The checks 0.x ran when none were given. */
export const defaultChecks: ReadonlyArray<typeof SmokeCheck.Type> = [
  { name: "typecheck", cmd: "npx tsc --noEmit" },
  { name: "lint", cmd: "npx eslint ." },
  { name: "test", cmd: "npm test" },
  { name: "build", cmd: "npm run build" }
]

/** Prepares the environment. Deterministic: a host runs `setupCmd` in `directory`. */
export const Setup = Action.make("examples/Smoketest/Setup", {
  payload: { directory: Schema.String, setupCmd: Schema.String },
  success: SetupResult
})

/** Runs one smoke check. Deterministic: a host runs `cmd` in `directory`, bounded by `timeoutMs`. */
export const RunCheck = Action.make("examples/Smoketest/RunCheck", {
  payload: { name: Schema.String, cmd: Schema.String, directory: Schema.String, timeoutMs: Schema.Number },
  success: CheckResult,
  error: CheckFailed
})

/** 0.x's report task: counts and sums the checks. Pure, so it is a `Node.map`. No check run is a failure. */
const report = (checks: ReadonlyArray<CheckResult>): typeof Report.Type => {
  const passed = checks.filter((c) => c.passed).length
  return {
    totalChecks: checks.length,
    passed,
    failed: checks.filter((c) => !c.passed).length,
    duration: checks.reduce((sum, c) => sum + c.duration, 0),
    verdict: checks.length > 0 && passed === checks.length ? "pass" : "fail",
    failures: checks.filter((c) => !c.passed).map((c) => `${c.name}: ${c.error ?? "failed"}`),
    summary: `${passed}/${checks.length} checks passed`
  }
}

/** The report of a setup that left the environment not ready: no check ran, so it fails. */
const notReady = (setup: typeof SetupResult.Type): typeof Report.Type => ({
  ...report([]),
  failures: [`setup: ${setup.details}`],
  summary: `setup not ready: ${setup.details}`
})

/** Runs every check, `maxParallel` at a time. A check the host could not run is a failed row. */
const runChecks = (
  checks: ReadonlyArray<typeof SmokeCheck.Type>,
  directory: string,
  timeoutMs: number,
  maxParallel: number
): Node.Node<ReadonlyArray<CheckResult>, never, Action.Requirement<"examples/Smoketest/RunCheck">> => {
  if (checks.length === 0) return Node.succeed([])
  // 0.x `continueOnFail`: a check that could not run does not fail its siblings; it reports as failed.
  const members = Object.fromEntries(checks.map(({ cmd, name }) => [
    `check-${name}`,
    Node.catch(RunCheck.call({ name, cmd, directory, timeoutMs }), {
      onFailure: Node.capture({}, (failed: Planned.Planned<CheckFailed>) =>
        Node.map(
          Node.succeed(failed),
          Node.capture({}, ({ name, reason }: CheckFailed): CheckResult => ({
            name,
            passed: false,
            duration: 0,
            error: reason,
            output: ""
          }))
        ))
    })
  ]))
  const joined = Bounded.all(members, { concurrency: maxParallel })
  return Node.map(joined, Node.capture({}, (rows: Record<string, CheckResult>) => Object.values(rows)))
}

const payload = {
  directory: Schema.String,
  setupCmd: Schema.optional(Schema.String),
  checks: Schema.optional(Schema.Array(SmokeCheck)),
  maxParallel: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  timeoutMs: Schema.optional(Schema.Number)
}

/** The flow: set up, run the checks when the environment is ready, report. */
export const Smoketest = Flow.make("examples/Smoketest", {
  payload,
  success: Report,
  body: Node.capture({}, ({
    checks = defaultChecks,
    directory,
    maxParallel = 4,
    setupCmd = "npm install",
    timeoutMs = 120_000
  }: Schema.Struct.Type<typeof payload>) =>
    Node.branch(Setup.call({ directory, setupCmd }), {
      if: Node.capture({}, (setup: typeof SetupResult.Type) => setup.ready),
      then: Node.capture(
        { checks, directory, timeoutMs, maxParallel },
        () => Node.map(runChecks(checks, directory, timeoutMs, maxParallel), Node.capture({}, report))
      ),
      else: Node.capture({}, (setup: Planned.Planned<typeof SetupResult.Type>) =>
        Node.map(Node.succeed(setup), Node.capture({}, notReady)))
    }))
})

/** What a host supplies for the steps that run commands. */
export interface Host {
  readonly setup: (request: { readonly directory: string; readonly setupCmd: string }) => Effect.Effect<
    typeof SetupResult.Type
  >
  readonly runCheck: (
    request: { readonly name: string; readonly cmd: string; readonly directory: string; readonly timeoutMs: number }
  ) => Effect.Effect<CheckResult, CheckFailed>
}

/** Every step the flow calls, as the host implements them. */
export const layer = (host: Host) => Layer.mergeAll(Setup.toLayer(host.setup), RunCheck.toLayer(host.runCheck))
