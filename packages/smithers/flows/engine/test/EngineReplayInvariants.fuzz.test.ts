/**
 * Model-based fuzzing of durable execution: replay equivalence across engine
 * restarts, step deduplication, and cancellation ordering.
 *
 * Every case generates a program (a sequence of steps and durable waits) and
 * an operation schedule, drives real engine instances with it, and compares
 * what happened with an explicit reference model after every transition.
 *
 * - Replay equivalence: a run interrupted at arbitrary waits and mid-step
 *   crash points, with the engine discarded and rebuilt over the same durable
 *   log each time, settles the same result and journals the same step state
 *   as the run that goes straight through.
 * - Deduplication: a keyed step runs once per key and a keyless step once per
 *   invocation, for any interleaving of callers and re-executions.
 * - Cancellation ordering: opening waits, cancelling, resuming and
 *   re-executing in any order agrees with a model in which the first
 *   settlement wins and nothing runs behind a cancellation.
 */
import { Action, DurableDeferred, Flow, FlowRuntime } from "@smthrs/flow"
import { Fuzz } from "@smthrs/fuzz"
import { Node } from "@smthrs/plan"
import { Arbitrary, Cause, Effect, Exit, Layer, Logger, Option, Result, Schema } from "effect"
import type * as EffectDigest from "effect/crypto/Digest"
import type * as SecureRandom from "effect/crypto/SecureRandom"
import { describe, expect, it } from "vitest"
import { FlowEngine } from "../src/index.ts"
import { withCrypto } from "./Crypto.ts"
import { type DurableLog, layerDurable, makeLog } from "./DurableLogEngine.ts"

const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "100"))
const pureExecutions = Math.max(25, Math.min(baseExecutions, 150))
const ioExecutions = Math.max(15, Math.min(Math.ceil(baseExecutions / 3), 50))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")

/** A violated invariant, as the message a counterexample is reported with. */
type Violation = string | undefined

/**
 * Runs a property whose body returns the first violated invariant. The
 * violation is the property's typed failure, so the report names it beside the
 * shrunk input.
 */
const holds = async <A>(
  arbitrary: Arbitrary.Arbitrary<A>,
  body: (input: A) => Effect.Effect<Violation, unknown>,
  options: { readonly seed: number; readonly executions: number }
): Promise<void> => {
  const report = await Effect.runPromise(
    Fuzz.run(
      arbitrary,
      (input) =>
        Effect.flatMap(
          body(input),
          (violation) => violation === undefined ? Effect.succeed(true) : Effect.fail(violation)
        ),
      options
    ).pipe(Effect.provide(Logger.layer([])))
  )
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const show = (value: unknown): string => JSON.stringify(value) ?? String(value)

const same = (left: unknown, right: unknown): boolean => show(left) === show(right)

const small = (minimum: number, maximum: number) => Schema.Int.check(Schema.isBetween({ minimum, maximum }))

/** Yields until the predicate holds, bounded by scheduler turns. */
const settle = (predicate: () => boolean, turns = 400): Effect.Effect<boolean> =>
  Effect.gen(function*() {
    for (let turn = 0; turn < turns && !predicate(); turn++) yield* Effect.yieldNow
    return predicate()
  })

/** Lets every forked fiber run until nothing more can happen without an input. */
const quiesce = Effect.gen(function*() {
  for (let turn = 0; turn < 60; turn++) yield* Effect.yieldNow
})

type Engine = Layer.Layer<FlowRuntime.FlowRuntime>

type Crypto = EffectDigest.Digest | SecureRandom.SecureRandom

/** What a poll shows, reduced to what the models predict. */
type Observed =
  | { readonly state: "unsettled" }
  | { readonly state: "suspended" }
  | { readonly state: "succeeded"; readonly value: unknown }
  | { readonly state: "failed"; readonly error: unknown }
  | { readonly state: "interrupted" }
  | { readonly state: "died" }

const observe = (result: Option.Option<Flow.Result<unknown, unknown>>): Observed => {
  if (Option.isNone(result)) return { state: "unsettled" }
  if (result.value._tag === "Suspended") return { state: "suspended" }
  if (result.value._tag !== "Complete") return { state: "unsettled" }
  const exit = result.value.exit
  if (Exit.isSuccess(exit)) return { state: "succeeded", value: exit.value }
  const typed = Cause.findErrorOption(exit.cause)
  if (Option.isSome(typed)) return { state: "failed", error: typed.value }
  return Exit.hasInterrupts(exit) ? { state: "interrupted" } : { state: "died" }
}

/** The settled step state a durable driver keeps: outcomes by `[key, attempt]`. */
const journal = (log: DurableLog): ReadonlyArray<readonly [string, string]> =>
  [...log.actionOutcomes.entries()]
    .map(([row, exit]) => [row, show(exit)] as const)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))

const Step = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("step"), value: small(0, 9) }),
  Schema.Struct({ kind: Schema.Literal("failing"), value: small(0, 9) }),
  Schema.Struct({ kind: Schema.Literal("keyed"), key: small(0, 2) }),
  Schema.Struct({ kind: Schema.Literal("nested"), value: small(0, 9) }),
  Schema.Struct({
    kind: Schema.Literal("gate"),
    value: small(0, 9),
    outcome: Schema.Literals(["succeed", "succeed", "fail"]),
    crash: Schema.Literals(["restart", "live", "restartTwice"])
  }),
  Schema.Struct({ kind: Schema.Literal("hang"), value: small(0, 9) })
])
type Step = typeof Step.Type

describe("@smthrs/engine replay, deduplication and cancellation invariants", () => {
  it("a run crashed and replayed at arbitrary waits settles the same result and step state as a straight run", async () => {
    const flow = Flow.make("ReplayFuzz/program", {
      payload: { seed: Schema.Number },
      success: Schema.Array(Schema.String),
      error: Schema.String,
      body: () => Node.succeed([])
    })
    const executionId = "replay-program"

    /**
     * One world: the program's actions with their own run counters, so the
     * straight run and the crashed run never share an in-process effect.
     */
    const world = (program: ReadonlyArray<Step>, crashes: boolean) => {
      const runs = program.map(() => 0)
      const keyRuns = [0, 0, 0]
      const hung = program.map(() => false)
      let arrived = -1
      const gates = program.map((_, index) =>
        DurableDeferred.make(`ReplayFuzz/gate-${index}`, { success: Schema.Number, error: Schema.String })
      )
      const actions = program.map((step, index) => {
        const name = `ReplayFuzz/step-${index}`
        // A value that depends on how often the effect ran: a replay that
        // re-executes a settled step settles a different result.
        const counted = Effect.sync(() => `${index}:${step.kind}:${++runs[index]!}`)
        if (step.kind === "failing") {
          return Action.make({
            name,
            success: Schema.String,
            error: Schema.String,
            execute: Effect.flatMap(counted, (value) => Effect.fail(`failed:${value}`))
          })
        }
        if (step.kind === "keyed") {
          return Action.make({
            name: `ReplayFuzz/keyed-${step.key}`,
            success: Schema.String,
            error: Schema.String,
            idempotencyKey: `replay-fuzz-key-${step.key}`,
            execute: Effect.sync(() => {
              runs[index]! += 1
              return `key-${step.key}:${++keyRuns[step.key]!}`
            })
          })
        }
        if (step.kind === "nested") {
          const inner = Action.make({
            name: `${name}/inner`,
            success: Schema.String,
            error: Schema.String,
            execute: counted
          })
          return Action.make({
            name,
            success: Schema.String,
            error: Schema.String,
            execute: Effect.map(Effect.all([inner, inner]), (values) => values.join("+"))
          })
        }
        if (step.kind === "hang") {
          // The first attempt of a crashed run never settles: the engine dies
          // with the step in flight, and the restarted engine runs it again.
          return Action.make({
            name,
            success: Schema.String,
            error: Schema.String,
            execute: Effect.suspend(() => {
              runs[index]! += 1
              if (crashes && !hung[index]) {
                hung[index] = true
                return Effect.never
              }
              return Effect.succeed(`${index}:hang:${step.value}`)
            })
          })
        }
        return Action.make({ name, success: Schema.String, error: Schema.String, execute: counted })
      })
      const body = () =>
        Effect.gen(function*() {
          const out: Array<string> = []
          for (const [index, step] of program.entries()) {
            if (step.kind === "gate") {
              arrived = Math.max(arrived, index)
              const opened = yield* Effect.result(DurableDeferred.await(gates[index]!))
              out.push(Result.isSuccess(opened) ? `gate:${opened.success}` : `closed:${opened.failure}`)
              continue
            }
            const result = yield* Effect.result(actions[index]!)
            out.push(Result.isSuccess(result) ? result.success : `caught:${result.failure}`)
          }
          return out
        })
      return {
        runs,
        hung,
        gates,
        arrived: () => arrived,
        /** One engine instance over `log`; closing it is a process death. */
        instance: <A, E>(
          log: DurableLog,
          use: Effect.Effect<A, E, FlowRuntime.FlowRuntime | Crypto>
        ): Effect.Effect<A, E> =>
          Effect.scoped(Effect.gen(function*() {
            const engine = yield* FlowRuntime.FlowRuntime
            yield* engine.register(flow, body)
            return yield* use
          })).pipe(Effect.provide(layerDurable(log)), withCrypto)
      }
    }

    const open = (
      target: ReturnType<typeof world>,
      index: number,
      step: Extract<Step, { readonly kind: "gate" }>
    ) => {
      const gate = target.gates[index]!
      const token = DurableDeferred.tokenFromExecutionId(gate, { flow, executionId })
      return step.outcome === "succeed"
        ? DurableDeferred.succeed(gate, { token, value: step.value })
        : DurableDeferred.fail(gate, { token, error: `closed-${step.value}` })
    }

    await holds(
      Arbitrary.schema(Schema.Struct({ program: Schema.Array(Step), reexecute: Schema.Boolean })),
      ({ program: generated, reexecute }) =>
        Effect.gen(function*() {
          const program = generated.slice(0, 8)

          // Straight through: every wait is already resolved in the log.
          const straightLog = makeLog()
          const straight = world(program, false)
          for (const [index, step] of program.entries()) {
            if (step.kind !== "gate") continue
            straightLog.deferreds.set(
              show([flow._tag, executionId, straight.gates[index]!.name]),
              step.outcome === "succeed" ? Exit.succeed(step.value) : Exit.fail(`closed-${step.value}`)
            )
          }
          const expected = yield* straight.instance(
            straightLog,
            Effect.exit(flow.execute({ seed: 1 }, { executionId }))
          )
          if (!Exit.isSuccess(expected)) return `the straight run failed: ${show(expected)}`

          // The reference model of the straight run.
          const firstOfKey = new Map<number, number>()
          program.forEach((step, index) => {
            if (step.kind === "keyed" && !firstOfKey.has(step.key)) firstOfKey.set(step.key, index)
          })
          const modelRuns = program.map((step, index) =>
            step.kind === "gate" ? 0 : step.kind === "nested" ? 2 : step.kind === "keyed"
              ? (firstOfKey.get(step.key) === index ? 1 : 0)
              : 1
          )
          const model = program.map((step, index) => {
            switch (step.kind) {
              case "gate":
                return step.outcome === "succeed" ? `gate:${step.value}` : `closed:closed-${step.value}`
              case "failing":
                return `caught:failed:${index}:failing:1`
              case "keyed":
                return `key-${step.key}:1`
              case "nested":
                return `${index}:nested:1+${index}:nested:2`
              case "hang":
                return `${index}:hang:${step.value}`
              case "step":
                return `${index}:step:1`
            }
          })
          if (!same(expected.value, model)) return `straight result ${show(expected.value)}, model ${show(model)}`
          if (!same(straight.runs, modelRuns)) return `straight step runs ${show(straight.runs)}, model ${modelRuns}`

          // Crashed: the engine dies at every wait and mid-step crash point.
          const crashedLog = makeLog()
          const crashed = world(program, true)
          const crashPoints = program.flatMap((step, index) =>
            step.kind === "gate" || step.kind === "hang" ? [{ index, step }] : []
          )
          const start = flow.execute({ seed: 1 }, { executionId, discard: true })
          let live = false
          for (const point of crashPoints) {
            const { index, step } = point
            if (step.kind === "hang") {
              // Killed with the step in flight: nothing is journaled for it.
              const reached = yield* crashed.instance(
                crashedLog,
                Effect.andThen(live ? Effect.void : start, settle(() => crashed.hung[index]!))
              )
              if (!reached) return `the run never reached the hanging step ${index}`
              live = false
              continue
            }
            const parked = Effect.andThen(
              start,
              settle(() => crashed.arrived() >= index).pipe(Effect.andThen(quiesce))
            )
            if (step.crash === "live") {
              // The wait is resolved on the instance that parked on it, which
              // is then killed wherever the run got to.
              yield* crashed.instance(
                crashedLog,
                parked.pipe(Effect.andThen(open(crashed, index, step)), Effect.andThen(quiesce))
              )
            } else {
              yield* crashed.instance(crashedLog, parked)
              // A restart that changes nothing must change nothing.
              if (step.crash === "restartTwice") yield* crashed.instance(crashedLog, parked)
              yield* crashed.instance(crashedLog, open(crashed, index, step).pipe(Effect.andThen(quiesce)))
            }
            if (crashed.arrived() < index) return `the run never parked on the wait ${index}`
          }
          const replayed = yield* crashed.instance(
            crashedLog,
            Effect.gen(function*() {
              const first = yield* Effect.exit(flow.execute({ seed: 1 }, { executionId }))
              if (!reexecute) return first
              const second = yield* Effect.exit(flow.execute({ seed: 1 }, { executionId }))
              return same(first, second) ? first : Exit.fail(`a re-execution changed the result: ${show(second)}`)
            })
          )

          if (!same(replayed, expected)) return `replayed ${show(replayed)}, straight ${show(expected)}`
          // A settled step never runs again; only a step killed in flight does.
          const crashedRuns = modelRuns.map((count, index) => program[index]!.kind === "hang" ? 2 : count)
          if (!same(crashed.runs, crashedRuns)) {
            return `replayed step runs ${show(crashed.runs)}, expected ${show(crashedRuns)}`
          }
          if (!same(journal(crashedLog), journal(straightLog))) {
            return `step state diverged: replayed ${show(journal(crashedLog))}, straight ${show(journal(straightLog))}`
          }
          return same(crashedLog.results.get(executionId), straightLog.results.get(executionId))
            ? undefined
            : `settlement diverged: ${show(crashedLog.results.get(executionId))}`
        }),
      { seed, executions: ioExecutions }
    )
  })

  const engines: ReadonlyArray<readonly [string, () => Engine, boolean]> = [
    ["layerMemory", () => FlowEngine.layerMemory, true],
    ["a durable driver", () => layerDurable(makeLog()), false]
  ]

  for (const [name, makeEngine, admitsConcurrentKeys] of engines) {
    it(`${name}: a keyed step runs once per key and a keyless step once per invocation, for any callers`, async () => {
      const flow = Flow.make("DedupFuzz/program", {
        payload: { seed: Schema.Number },
        success: Schema.Array(Schema.String),
        error: Schema.String,
        body: () => Node.succeed([])
      })
      await holds(
        Arbitrary.schema(
          Schema.Struct({
            invocations: Schema.Array(
              Schema.Struct({
                key: Schema.Union([small(0, 3), Schema.Literal("keyless")]),
                site: small(0, 2)
              })
            ),
            failingKeys: small(0, 15),
            concurrent: Schema.Boolean,
            callers: small(1, 4),
            later: small(0, 3)
          })
        ),
        ({ callers, concurrent, failingKeys, invocations: generated, later }) =>
          Effect.gen(function*() {
            const invocations = generated.slice(0, 10)
            const keyRuns = [0, 0, 0, 0]
            const siteRuns = [0, 0, 0]
            let bodies = 0
            const keyed = [0, 1, 2, 3].map((key) =>
              Action.make({
                name: `DedupFuzz/keyed-${key}`,
                success: Schema.String,
                error: Schema.String,
                idempotencyKey: `dedup-fuzz-${key}`,
                execute: Effect.suspend(() => {
                  const run = ++keyRuns[key]!
                  return ((failingKeys >> key) & 1) === 1
                    ? Effect.fail(`key-${key}-failed:${run}`)
                    : Effect.succeed(`key-${key}:${run}`)
                })
              })
            )
            // One keyless action invoked from several places is a distinct
            // step at each invocation.
            const keyless = [0, 1, 2].map((site) =>
              Action.make({
                name: `DedupFuzz/keyless-${site}`,
                success: Schema.String,
                error: Schema.String,
                execute: Effect.sync(() => `site-${site}:${++siteRuns[site]!}`)
              })
            )
            const body = () =>
              Effect.gen(function*() {
                bodies += 1
                return yield* Effect.forEach(
                  invocations,
                  (invocation) =>
                    Effect.map(
                      Effect.result(invocation.key === "keyless" ? keyless[invocation.site]! : keyed[invocation.key]!),
                      (result) => Result.isSuccess(result) ? result.success : `caught:${result.failure}`
                    ),
                  { concurrency: concurrent && admitsConcurrentKeys ? "unbounded" : 1 }
                )
              })

            const results = yield* Effect.scoped(Effect.gen(function*() {
              const engine = yield* FlowRuntime.FlowRuntime
              yield* engine.register(flow, body)
              const execute = Effect.exit(flow.execute({ seed: 1 }, { executionId: "dedup-run" }))
              const first = yield* Effect.all(Array.from({ length: callers }, () => execute), {
                concurrency: admitsConcurrentKeys ? "unbounded" : 1
              })
              const again = yield* Effect.all(Array.from({ length: later }, () => execute))
              return [...first, ...again]
            })).pipe(Effect.provide(makeEngine()), withCrypto)

            const usedKeys = new Set(invocations.flatMap((entry) => entry.key === "keyless" ? [] : [entry.key]))
            const expectedKeyRuns = [0, 1, 2, 3].map((key) => usedKeys.has(key) ? 1 : 0)
            if (!same(keyRuns, expectedKeyRuns)) return `keyed runs ${show(keyRuns)}, expected ${show(expectedKeyRuns)}`
            const expectedSiteRuns = [0, 1, 2].map((site) =>
              invocations.filter((entry) => entry.key === "keyless" && entry.site === site).length
            )
            if (!same(siteRuns, expectedSiteRuns)) {
              return `keyless runs ${show(siteRuns)}, expected ${show(expectedSiteRuns)}`
            }
            if (bodies !== 1) return `the body ran ${bodies} times for one execution id`

            const first = results[0]!
            if (!Exit.isSuccess(first)) return `the run failed: ${show(first)}`
            if (!results.every((result) => same(result, first))) return `callers disagree: ${show(results)}`
            const value = first.value
            if (value.length !== invocations.length) return `result ${show(value)}`
            const siteSeen = [0, 0, 0]
            for (const [index, invocation] of invocations.entries()) {
              const entry = value[index]!
              if (invocation.key === "keyless") {
                // Sequential invocations settle in order; concurrent ones each
                // still own exactly one run.
                siteSeen[invocation.site]! += 1
                const sequential = `site-${invocation.site}:${siteSeen[invocation.site]}`
                if (
                  concurrent && admitsConcurrentKeys
                    ? !entry.startsWith(`site-${invocation.site}:`)
                    : entry !== sequential
                ) {
                  return `keyless invocation ${index} settled ${entry}`
                }
                continue
              }
              const expected = ((failingKeys >> invocation.key) & 1) === 1
                ? `caught:key-${invocation.key}-failed:1`
                : `key-${invocation.key}:1`
              if (entry !== expected) return `keyed invocation ${index} settled ${entry}, expected ${expected}`
            }
            const keylessValues = value.filter((entry) => entry.startsWith("site-"))
            return new Set(keylessValues).size === keylessValues.length
              ? undefined
              : `two keyless invocations shared one run: ${show(value)}`
          }),
        { seed: seed + 1, executions: pureExecutions }
      )
    })
  }

  const Operation = Schema.Union([
    Schema.Struct({ op: Schema.Literal("open"), gate: small(0, 3), value: small(1, 9) }),
    Schema.Struct({ op: Schema.Literal("open"), gate: small(0, 3), value: small(1, 9) }),
    Schema.Struct({ op: Schema.Literal("close"), gate: small(0, 3), value: small(1, 9) }),
    Schema.Struct({ op: Schema.Literal("cancel") }),
    Schema.Struct({ op: Schema.Literal("resume") }),
    Schema.Struct({ op: Schema.Literal("execute") })
  ])

  for (const [name, makeEngine] of engines) {
    it(`${name}: opening, cancelling, resuming and re-executing in any order agrees with the reference model`, async () => {
      const flow = Flow.make("CancelFuzz/program", {
        payload: { seed: Schema.Number },
        success: Schema.Number,
        error: Schema.String,
        body: () => Node.succeed(0)
      })
      const executionId = "cancel-run"
      await holds(
        Arbitrary.schema(Schema.Struct({ gates: small(1, 4), operations: Schema.Array(Operation) })),
        ({ gates: gateCount, operations: generated }) =>
          Effect.gen(function*() {
            const operations = generated.slice(0, 12)
            const gates = Array.from(
              { length: gateCount },
              (_, index) =>
                DurableDeferred.make(`CancelFuzz/gate-${index}`, { success: Schema.Number, error: Schema.String })
            )
            // Step `i` runs before wait `i`; the last runs after every wait.
            const runs = Array.from({ length: gateCount + 1 }, () => 0)
            const steps = runs.map((_, index) =>
              Action.make({
                name: `CancelFuzz/step-${index}`,
                success: Schema.Number,
                error: Schema.String,
                execute: Effect.sync(() => {
                  runs[index]! += 1
                  return 100
                })
              })
            )
            const body = () =>
              Effect.gen(function*() {
                let total = 0
                for (let index = 0; index < gateCount; index++) {
                  total += yield* steps[index]!
                  total += yield* DurableDeferred.await(gates[index]!)
                }
                return total + (yield* steps[gateCount]!)
              })

            // The reference model: the first settlement of a wait wins, the
            // first settlement of the run wins, and a cancelled run goes no
            // further.
            const settled = new Map<number, { readonly ok: boolean; readonly value: number }>()
            let outcome: Observed = { state: "suspended" }
            let stepsRun = 1
            const advance = (): void => {
              if (outcome.state !== "suspended") return
              let total = 0
              for (let index = 0; index < gateCount; index++) {
                const gate = settled.get(index)
                if (gate === undefined) {
                  stepsRun = Math.max(stepsRun, index + 1)
                  return
                }
                if (!gate.ok) {
                  stepsRun = Math.max(stepsRun, index + 1)
                  outcome = { state: "failed", error: `closed-${gate.value}` }
                  return
                }
                total += 100 + gate.value
              }
              stepsRun = gateCount + 1
              outcome = { state: "succeeded", value: total + 100 }
            }

            return yield* Effect.scoped(Effect.gen(function*() {
              const engine = yield* FlowRuntime.FlowRuntime
              yield* engine.register(flow, body)
              const snapshot = Effect.map(flow.poll(executionId), observe)
              const expectedRuns = (): ReadonlyArray<number> => runs.map((_, index) => index < stepsRun ? 1 : 0)
              const agrees = (observed: Observed): boolean => same(observed, outcome) && same(runs, expectedRuns())

              yield* flow.execute({ seed: 1 }, { executionId, discard: true })
              for (const [at, operation] of [{ op: "start" as const }, ...operations].entries()) {
                switch (operation.op) {
                  case "start":
                    break
                  case "open":
                  case "close": {
                    const index = operation.gate % gateCount
                    const gate = gates[index]!
                    const token = DurableDeferred.tokenFromExecutionId(gate, { flow, executionId })
                    yield* operation.op === "open"
                      ? DurableDeferred.succeed(gate, { token, value: operation.value })
                      : DurableDeferred.fail(gate, { token, error: `closed-${operation.value}` })
                    if (!settled.has(index)) settled.set(index, { ok: operation.op === "open", value: operation.value })
                    advance()
                    break
                  }
                  case "cancel":
                    yield* flow.interrupt(executionId)
                    if (outcome.state === "suspended") outcome = { state: "interrupted" }
                    break
                  case "resume":
                    yield* flow.resume(executionId)
                    break
                  case "execute":
                    yield* flow.execute({ seed: 1 }, { executionId, discard: true })
                    break
                }
                let observed = yield* snapshot
                for (let turn = 0; turn < 400 && !agrees(observed); turn++) {
                  yield* Effect.yieldNow
                  observed = yield* snapshot
                }
                // Nothing may move after the model's state is reached either.
                yield* quiesce
                observed = yield* snapshot
                if (!agrees(observed)) {
                  return `after operation ${at} (${show(operation)}): observed ${show(observed)} with step runs ` +
                    `${show(runs)}, model ${show(outcome)} with step runs ${show(expectedRuns())}`
                }
              }
              return undefined
            })).pipe(Effect.provide(makeEngine()), withCrypto)
          }),
        { seed: seed + 2, executions: ioExecutions }
      )
    })
  }
})
