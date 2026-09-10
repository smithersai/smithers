/**
 * Repair a configuration and refine a summary with bounded loop patterns.
 *
 * The example calls each pattern's runtime `run` operation, which stops when its
 * value-dependent condition is met. The declaration-side `make` operation
 * describes the conservative graph with its bound.
 *
 * The fixtures are deterministic and need no model, durable engine, or network.
 * See the patterns API reference for the declaration forms.
 */
import * as DriftDetector from "@smthrs/patterns/DriftDetector"
import * as Loop from "@smthrs/patterns/Loop"
import * as Optimizer from "@smthrs/patterns/Optimizer"
import * as ScanFixVerify from "@smthrs/patterns/ScanFixVerify"
import * as Sidecar from "@smthrs/patterns/Sidecar"
import * as Effect from "effect/Effect"

interface Setting {
  readonly key: string
  readonly value: number
}

interface Violation {
  readonly key: string
  readonly value: number
  readonly limit: number
}

const limits: Readonly<Record<string, number>> = { retries: 3, timeoutMs: 30_000, concurrency: 8 }

/**
 * A config the repair loop edits in place, the way a real fixer edits files.
 */
const config = (): Map<string, number> =>
  new Map([["retries", 9], ["timeoutMs", 90_000], ["concurrency", 4]])

const violations = (current: ReadonlyMap<string, number>): ReadonlyArray<Violation> =>
  [...current].flatMap(([key, value]) => {
    const limit = limits[key]
    return limit !== undefined && value > limit ? [{ key, value, limit }] : []
  })

/**
 * Scans a config for settings above policy, repairs each one on its own, and
 * verifies the result, until a scan comes back clean.
 *
 * `retries` and `timeoutMs` both start above their limits, so the first round
 * fixes two settings concurrently and the verifier reports them resolved. That
 * verdict does not end the loop: the second round rescans, finds nothing, and
 * that empty scan is the terminal. Two rounds, one of them a confirmation.
 * `remaining` is empty on a clean exit and lists the last scan's issues when
 * the retry bound stopped the loop, which is the signal an operator acts on.
 */
export const repair: Effect.Effect<{
  readonly iterations: number
  readonly remaining: ReadonlyArray<Violation>
  readonly settled: ReadonlyArray<Setting>
}> = Effect.gen(function*() {
  const current = config()
  const report = yield* ScanFixVerify.run(current, {
    maxRetries: 4,
    concurrency: 4,
    scan: ({ input }) => Effect.succeed(violations(input)),
    fix: ({ issue }) => Effect.sync(() => (current.set(issue.key, issue.limit), issue.key)),
    verify: ({ input }) => Effect.succeed({ resolved: violations(input).length === 0 })
  }).pipe(
    // `run` validates its bounds before scanning and fails `PatternError` when
    // they are not positive integers. They are literals here, so a refusal
    // would be a defect in this example rather than an error a caller handles.
    Effect.orDie
  )
  return {
    iterations: report.iterations,
    remaining: report.remaining,
    settled: [...current].map(([key, value]) => ({ key, value }))
  }
})

/**
 * Compares the repaired config to the baseline an operator recorded, and pages
 * only when it moved: a changed value, a missing setting, or one the baseline
 * never approved.
 * The baseline is the config as last recorded, so the repair is exactly what
 * the detector reports: two settings moved away from what the operator
 * approved, and the alert names them.
 *
 * The detector runs once. Polling is the caller's decision: wrap this in
 * `Loop.run` for rounds inside one execution, or register the flow on a
 * schedule for rounds the control plane owns.
 */
export const audit = (
  settled: ReadonlyArray<Setting>
): Effect.Effect<{ readonly drifted: boolean; readonly paged: ReadonlyArray<string> }> =>
  Effect.gen(function*() {
    const paged: Array<string> = []
    const result = yield* DriftDetector.run(settled, {
      baseline: { retries: 9, timeoutMs: 90_000, concurrency: 4 } as Record<string, number>,
      capture: ({ input }) => Effect.succeed(Object.fromEntries(input.map((s) => [s.key, s.value]))),
      // Walk the union of both key sets: a setting the operator never approved
      // is drift just as much as an approved one that moved or went missing.
      compare: ({ baseline, snapshot }) =>
        Effect.sync(() => {
          const keys = new Set([...Object.keys(baseline), ...Object.keys(snapshot)])
          const changed = [...keys].filter((key) => baseline[key] !== snapshot[key])
          return { drifted: changed.length > 0, changed }
        }),
      alert: ({ comparison }) => Effect.sync(() => (paged.push(...comparison.changed), comparison.changed.length))
    })
    return { drifted: result.drifted, paged }
  })

/**
 * The candidates the search produces, in order. The second is the shortest, so
 * the last attempt is not the best one.
 */
export const wordy: ReadonlyArray<string> = [
  "the config was repaired successfully by the loop",
  "repaired",
  "config repaired"
]

/**
 * Searches for a summary short enough to fit an alert line.
 *
 * The scorer rewards brevity and no candidate reaches the target, so the search
 * spends its whole budget. It still answers with the shortest summary it saw
 * rather than the one it happened to end on. Keeping the best attempt is the
 * difference between an optimizer and a retry.
 */
export const tune: Effect.Effect<{
  readonly best: string
  readonly score: number
  readonly iterations: number
  readonly converged: boolean
}> = Effect.gen(function*() {
  const result = yield* Optimizer.run("summary", {
    maxIterations: 3,
    targetScore: 0.9,
    onMaxReached: "return-last",
    generate: ({ iteration }) => Effect.succeed(wordy[iteration - 1] ?? ""),
    // The candidate type is annotated because `generate` reads `previous`,
    // which makes its own parameter depend on the candidate type. TypeScript
    // then has nothing to infer that type from when it types `evaluate`. See
    // the reference page, "Inline callbacks and inference".
    evaluate: ({ value }: { readonly value: string }) =>
      Effect.succeed({ score: 1 - value.length / 60, feedback: "shorter" })
  }).pipe(Effect.orDie)
  return {
    best: result.best.candidate,
    score: Number(result.best.score.toFixed(4)),
    iterations: result.iterations,
    converged: result.converged
  }
})

/**
 * Runs a cheap shadow beside the expensive summary to see whether the cheap
 * seat would have been good enough.
 *
 * The shadow here fails. A sidecar quarantines that, because the shadow is an
 * experiment and the primary result is the answer. `delta` stays absent, since
 * there is nothing to compare against.
 */
export const shadow: Effect.Effect<{
  readonly primary: string
  readonly quarantined: boolean
  readonly delta: number | undefined
}> = Effect.gen(function*() {
  const result = yield* Sidecar.run("summary", {
    primary: () => Effect.succeed("config repaired"),
    // Annotated because this shadow only fails: without it the shadow output
    // type infers as `never` and the scorer cannot read it.
    shadow: (): Effect.Effect<string, string> => Effect.fail("the cheap seat is out of quota"),
    score: ({ primary, shadow }) => Effect.succeed({ primary: primary.length, shadow: shadow.length })
    // `Sidecar.run` refuses an unsafe configuration with a `PatternError`, the
    // same way `Optimizer.run` above does. Every input here is a literal, so a
    // refusal would be a defect in this file rather than a run-time outcome.
  }).pipe(Effect.orDie)
  return {
    primary: result.primary,
    quarantined: result.shadow.quarantined,
    delta: result.delta?.difference
  }
})

/**
 * Keeps handing the same goal back until the body reports itself finished.
 *
 * This is the Ralph loop: no separate predicate, `maxIterations` as the budget,
 * and `exhausted` telling the caller which of the two ended the loop. It omits
 * `onMaxReached`, which defaults to `"return-last"`.
 */
export const settle: Effect.Effect<{ readonly turns: number; readonly exhausted: boolean }> = Effect.gen(function*() {
  let pending = 3
  const result = yield* Loop.runRalph("drain the queue", {
    maxIterations: 10,
    body: () => Effect.sync(() => ({ done: --pending <= 0, pending }))
  }).pipe(Effect.orDie)
  return { turns: result.iterations, exhausted: result.exhausted }
})

/**
 * Runs the whole story: repair, audit, tune, shadow, settle.
 */
export const main: Effect.Effect<{
  readonly repair: { readonly iterations: number; readonly remaining: ReadonlyArray<Violation> }
  readonly audit: { readonly drifted: boolean; readonly paged: ReadonlyArray<string> }
  readonly tune: { readonly best: string; readonly converged: boolean }
  readonly shadow: { readonly quarantined: boolean }
  readonly settle: { readonly turns: number }
}> = Effect.gen(function*() {
  const repaired = yield* repair
  const audited = yield* audit(repaired.settled)
  const tuned = yield* tune
  const shadowed = yield* shadow
  const settled = yield* settle
  return {
    repair: { iterations: repaired.iterations, remaining: repaired.remaining },
    audit: audited,
    tune: { best: tuned.best, converged: tuned.converged },
    shadow: { quarantined: shadowed.quarantined },
    settle: { turns: settled.turns }
  }
})
