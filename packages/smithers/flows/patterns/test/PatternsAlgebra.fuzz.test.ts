/**
 * Model-based and algebraic fuzzing of the operational (`run`) pattern forms.
 *
 * `Patterns.fuzz.test.ts` pins declared/operational parity. This suite pins the
 * operational forms against explicit reference models instead: every case
 * computes what the pattern must do from the generated script alone, then
 * compares the full call trace (order, arguments, counts, peak concurrency)
 * and the settled outcome with it.
 *
 * - Saga: compensation order and residue on arbitrary failure, defect and
 *   interruption indices.
 * - Bounded and Quarantine: fan-out width, priority order, fault isolation and
 *   the `settle` law joining the two policies.
 * - ReviewLoop, Supervisor and Escalation: the retry family, with the stall
 *   breaker as the circuit breaker and the ladder as the backoff.
 * - Intervene: the approval gate on adversarial decisions.
 * - ScanFixVerify: the bounded repair loop and its declared form.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import { Action, Interpreter } from "@smthrs/flow"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Cause, Deferred, Effect, Exit, Fiber, Layer, Logger, Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  Bounded,
  Escalation,
  Intervene,
  PatternError,
  Quarantine,
  ReviewLoop,
  Saga,
  ScanFixVerify,
  Supervisor
} from "../src/index.ts"
import { scripted } from "./Parity.ts"

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
  body: (input: A) => Effect.Effect<Violation>,
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

const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right)

const show = (value: unknown): string => JSON.stringify(value) ?? String(value)

const failureOf = (exit: Exit.Exit<unknown, unknown>): unknown => {
  if (Exit.isSuccess(exit)) return undefined
  const found = Cause.findErrorOption(exit.cause)
  return found._tag === "Some" ? found.value : undefined
}

const patternCode = (exit: Exit.Exit<unknown, unknown>): string | undefined => {
  const error = failureOf(exit)
  return error instanceof PatternError.PatternError ? error.code : undefined
}

const defectOf = (exit: Exit.Exit<unknown, unknown>): unknown =>
  Exit.isSuccess(exit) ? undefined : exit.cause.reasons.find(Cause.isDieReason)?.defect

/** Yields `turns` scheduler turns, so concurrent members really overlap. */
const turns = (count: number): Effect.Effect<void> =>
  Effect.gen(function*() {
    for (let turn = 0; turn < count; turn++) yield* Effect.yieldNow
  })

/** Tracks how many members are in flight and the most that ever were. */
const gauge = () => {
  let live = 0
  let peak = 0
  return {
    peak: () => peak,
    track: <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          live += 1
          peak = Math.max(peak, live)
        }),
        () => effect,
        () =>
          Effect.sync(() => {
            live -= 1
          })
      )
  }
}

const small = (minimum: number, maximum: number) => Schema.Int.check(Schema.isBetween({ minimum, maximum }))

// Names that collide with `Object.prototype` or carry non-BMP, NUL and
// separator characters: a pattern keying a record by one must keep it a data
// property.
const hostileNames = [
  "__proto__",
  "constructor",
  "toString",
  "hasOwnProperty",
  "a\0b",
  "../up",
  "\u{1F600}",
  "\uD83D",
  "",
  " ",
  "é",
  "é",
  "Z",
  "a"
] as const

const HostileName = Schema.Literals(hostileNames)

/** Distinct member names: the generated hostile ones, deduplicated, in order. */
const distinct = (names: ReadonlyArray<string>, minimum: number): ReadonlyArray<string> => {
  const unique = [...new Set(names)]
  for (let index = 0; unique.length < minimum; index++) unique.push(`m${index}`)
  return unique
}

describe("@smthrs/patterns algebra and state-machine fuzz", () => {
  it("Saga.run unwinds exactly the completed prefix in reverse for any failure, defect and compensation outcome", async () => {
    const arbitrary = Arbitrary.schema(
      Schema.Struct({
        steps: Schema.Array(
          Schema.Struct({
            name: HostileName,
            action: Schema.Literals(["ok", "ok", "ok", "fail", "die"]),
            compensation: Schema.Literals(["ok", "ok", "fail", "die", "throw"]),
            uninterruptible: Schema.Boolean
          })
        ),
        onFailure: Schema.Literals(["compensate", "compensate-and-fail", "fail", "default"])
      })
    )
    await holds(
      arbitrary,
      ({ onFailure, steps: generated }) =>
        Effect.gen(function*() {
          const scripts = generated.slice(0, 6).map((step, index) => ({ ...step, id: `${index}:${step.name}` }))
          const forward: Array<string> = []
          const unwound: Array<{ readonly id: string; readonly input: string; readonly value: number }> = []
          const seen: Array<Readonly<Record<string, number>>> = []
          const steps = scripts.map((
            script,
            index
          ): Saga.RuntimeStep<string, number, string, never, string, never> => ({
            id: script.id,
            uninterruptible: script.uninterruptible,
            action: ({ completed, input }) =>
              Effect.gen(function*() {
                yield* Effect.yieldNow
                forward.push(script.id)
                seen.push({ ...completed })
                if (input !== "world") return yield* Effect.die("the input did not reach the action")
                if (script.action === "fail") return yield* Effect.fail(`action:${script.id}`)
                if (script.action === "die") return yield* Effect.die(`defect:${script.id}`)
                return index * 10
              }),
            compensation: (args) => {
              unwound.push(args)
              if (script.compensation === "throw") throw new Error(`threw:${script.id}`)
              if (script.compensation === "fail") return Effect.fail(`undo:${script.id}`)
              if (script.compensation === "die") return Effect.die(`undo-defect:${script.id}`)
              return Effect.yieldNow
            }
          }))
          const exit = yield* Effect.exit(
            Saga.run("world", onFailure === "default" ? { steps } : { steps, onFailure })
          )
          const policy = onFailure === "default" ? "compensate" : onFailure

          if (scripts.length === 0) {
            return patternCode(exit) === "invalid_decorator" && forward.length === 0
              ? undefined
              : `an empty saga must be refused, got ${show(exit)}`
          }

          const stop = scripts.findIndex((script) => script.action !== "ok")
          const reached = stop === -1 ? scripts.length : stop + 1
          const done = scripts.slice(0, stop === -1 ? scripts.length : stop)
          const values = Object.fromEntries(done.map((script) => [script.id, scripts.indexOf(script) * 10]))

          if (!same(forward, scripts.slice(0, reached).map((script) => script.id))) {
            return `forward order ${show(forward)}`
          }
          // Step k sees exactly the values of the steps before it.
          for (let index = 0; index < reached; index++) {
            const expected = Object.fromEntries(scripts.slice(0, index).map((script, at) => [script.id, at * 10]))
            if (!same(Object.entries(seen[index]!), Object.entries(expected))) {
              return `step ${index} saw completed ${show(seen[index])}`
            }
          }

          const expectedUnwind = stop === -1 || policy === "fail"
            ? []
            : [...done].reverse().map((script) => ({ id: script.id, input: "world", value: values[script.id]! }))
          if (!same(unwound, expectedUnwind)) {
            return `unwind ${show(unwound)} is not the reversed completed prefix ${show(expectedUnwind)}`
          }

          if (stop === -1) {
            if (!Exit.isSuccess(exit) || exit.value._tag !== "Completed") return `expected Completed, got ${show(exit)}`
            return same(Object.entries(exit.value.values), Object.entries(values))
              ? undefined
              : `completed values ${show(exit.value.values)}`
          }

          const failing = scripts[stop]!
          const residue = policy === "fail"
            ? []
            : done.filter((script) => script.compensation !== "ok").map((script) => script.id)
          if (residue.length > 0) {
            const error = failureOf(exit)
            if (!(error instanceof PatternError.PatternError) || error.code !== "compensation_failed") {
              return `dirty state must outrank the trigger, got ${show(exit)}`
            }
            const cause = error.cause as {
              readonly failure?: unknown
              readonly residue: ReadonlyArray<{ readonly id: string; readonly error: unknown }>
            }
            const ids = cause.residue.map((entry) => entry.id)
            if (!same([...ids].sort(), [...residue].sort())) return `residue ${show(ids)} is not ${show(residue)}`
            for (let index = 1; index < ids.length; index++) {
              if (ids[index - 1]!.localeCompare(ids[index]!) > 0) return `residue ${show(ids)} is unsorted`
            }
            if (!ids.every((id) => error.message.includes(id))) return `message omits a residue id: ${error.message}`
            // The typed trigger is kept; a defect trigger has no typed failure.
            const kept = "failure" in cause ? cause.failure : undefined
            return same(kept, failing.action === "fail" ? `action:${failing.id}` : undefined)
              ? undefined
              : `residue cause kept the trigger ${show(kept)}`
          }
          if (failing.action === "die") {
            return defectOf(exit) === `defect:${failing.id}` ? undefined : `expected the defect, got ${show(exit)}`
          }
          if (policy === "compensate") {
            return Exit.isSuccess(exit) && exit.value._tag === "Compensated" &&
                exit.value.failure === `action:${failing.id}`
              ? undefined
              : `expected Compensated, got ${show(exit)}`
          }
          return failureOf(exit) === `action:${failing.id}` ? undefined : `expected the failure, got ${show(exit)}`
        }),
      { seed, executions: pureExecutions }
    )
  })

  it("Saga.run compensates every committed step, last first, when interrupted at an arbitrary step", async () => {
    const arbitrary = Arbitrary.schema(
      Schema.Struct({
        count: small(1, 6),
        at: small(0, 5),
        sealed: Schema.Boolean,
        dirty: small(0, 63),
        onFailure: Schema.Literals(["compensate", "compensate-and-fail", "fail"])
      })
    )
    await holds(
      arbitrary,
      ({ at: generatedAt, count, dirty, onFailure, sealed }) =>
        Effect.gen(function*() {
          const at = generatedAt % count
          const entered = yield* Deferred.make<void>()
          const started: Array<number> = []
          const unwound: Array<number> = []
          const steps = Array.from(
            { length: count },
            (_, index): Saga.RuntimeStep<string, number, never, never, string, never> => ({
              id: `s${index}`,
              // A sealed step finishes and registers its undo as one unit, so a
              // cancel that lands inside it must still compensate it.
              uninterruptible: index === at && sealed,
              action: () =>
                Effect.gen(function*() {
                  started.push(index)
                  if (index !== at) return index
                  yield* Deferred.succeed(entered, undefined)
                  if (!sealed) return yield* Effect.never
                  yield* turns(4)
                  return index
                }),
              compensation: () =>
                Effect.suspend(() => {
                  unwound.push(index)
                  return ((dirty >> index) & 1) === 1 ? Effect.fail(`undo:${index}`) : Effect.void
                })
            })
          )
          const fiber = yield* Effect.forkChild(Saga.run("x", { steps, onFailure }))
          yield* Deferred.await(entered)
          const exit = yield* Fiber.interrupt(fiber).pipe(Effect.andThen(Fiber.await(fiber)))

          if (!Exit.isFailure(exit) || !Exit.hasInterrupts(exit)) return `expected an interruption, got ${show(exit)}`
          if (!same(started, Array.from({ length: at + 1 }, (_, index) => index))) {
            return `a step ran after the interruption: ${show(started)}`
          }
          const committed = sealed ? at + 1 : at
          const expected = onFailure === "fail" ? [] : Array.from({ length: committed }, (_, index) => index).reverse()
          return same(unwound, expected) ? undefined : `unwind ${show(unwound)}, expected ${show(expected)}`
        }),
      { seed: seed + 1, executions: pureExecutions }
    )
  })

  it("Bounded.run starts members in descending priority, never exceeds its width, and stops starting after a failure", async () => {
    const arbitrary = Arbitrary.schema(
      Schema.Struct({
        members: Schema.Array(
          Schema.Struct({ name: HostileName, priority: small(-3, 3), work: small(0, 3), explicit: Schema.Boolean })
        ),
        concurrency: small(1, 5),
        fallback: Schema.Literals(["none", "low", "high"]),
        failAt: small(-1, 8)
      })
    )
    await holds(
      arbitrary,
      ({ concurrency, failAt, fallback, members: generated }) =>
        Effect.gen(function*() {
          const names = distinct(generated.slice(0, 8).map((member) => member.name), 1)
          const scripts = names.map((name, index) => ({
            name,
            priority: generated[index]?.priority ?? 0,
            work: generated[index]?.work ?? 0,
            explicit: generated[index]?.explicit ?? false
          }))
          const basePriority = fallback === "none" ? undefined : fallback === "low" ? -2 : 2
          const rank = (script: typeof scripts[number]): number => script.explicit ? script.priority : basePriority ?? 0
          const order = scripts
            .map((script, index) => ({ script, index }))
            .sort((left, right) => rank(right.script) - rank(left.script) || left.index - right.index)
            .map((entry) => entry.script.name)
          const failing = failAt >= 0 && failAt < order.length ? order[failAt] : undefined

          const started: Array<string> = []
          const width = gauge()
          const members: Record<string, Effect.Effect<string, string>> = {}
          for (const script of scripts) {
            // A computed key, so a prototype-shaped name is an own property.
            Object.defineProperty(members, script.name, {
              enumerable: true,
              value: width.track(Effect.gen(function*() {
                started.push(script.name)
                yield* turns(script.work)
                if (script.name === failing) return yield* Effect.fail(`failed:${script.name}`)
                return `value:${script.name}`
              }))
            })
          }
          const priorities = Object.fromEntries(
            scripts.filter((script) => script.explicit).map((script) => [script.name, script.priority])
          )
          const exit = yield* Effect.exit(Bounded.run(members, {
            concurrency,
            ...(basePriority === undefined ? {} : { priority: basePriority }),
            priorities
          }))

          if (width.peak() > concurrency) return `peak ${width.peak()} exceeds the width ${concurrency}`
          // Members are admitted in ranked order: what started is a prefix.
          if (!same(started, order.slice(0, started.length))) {
            return `start order ${show(started)} is not a prefix of ${show(order)}`
          }
          if (failing === undefined) {
            if (!Exit.isSuccess(exit)) return `expected success, got ${show(exit)}`
            if (started.length !== order.length) return `only ${started.length} members started`
            const entries = Object.entries(exit.value)
            if (!same(entries.map(([name]) => name).sort(), [...names].sort())) {
              return `result names ${show(entries)}`
            }
            if (!entries.every(([name, value]) => value === `value:${name}`)) return `result values ${show(entries)}`
            // Every slot fills when every member holds its slot for a turn.
            if (scripts.every((script) => script.work > 0) && width.peak() !== Math.min(concurrency, names.length)) {
              return `peak ${width.peak()} left width ${concurrency} unused for ${names.length} members`
            }
            return undefined
          }
          if (failureOf(exit) !== `failed:${failing}`) return `expected the member failure, got ${show(exit)}`
          // At width 1 nothing behind the failing member is ever started.
          if (concurrency === 1 && started.length !== failAt + 1) {
            return `width 1 started ${started.length} members past a failure at ${failAt}`
          }
          return undefined
        }),
      { seed: seed + 2, executions: pureExecutions }
    )
  })

  it("Quarantine.run isolates exactly the failing members, and settle joins quarantine to halt", async () => {
    const arbitrary = Arbitrary.schema(
      Schema.Struct({
        members: Schema.Array(
          Schema.Struct({
            name: HostileName,
            outcome: Schema.Literals(["ok", "ok", "fail", "envelope"]),
            work: small(0, 2)
          })
        ),
        concurrency: Schema.Union([small(1, 4), Schema.Literal("unbounded")]),
        defectAt: small(-1, 12)
      })
    )
    await holds(
      arbitrary,
      ({ concurrency, defectAt, members: generated }) =>
        Effect.gen(function*() {
          const names = distinct(generated.slice(0, 8).map((member) => member.name), 1)
          const scripts = names.map((name, index) => ({
            name,
            outcome: generated[index]?.outcome ?? "ok",
            work: generated[index]?.work ?? 0
          }))
          const defect = defectAt >= 0 && defectAt < scripts.length ? scripts[defectAt]!.name : undefined
          const failing = scripts.filter((script) => script.outcome === "fail").map((script) => script.name)
          // A success value shaped like a quarantine envelope is still a value.
          const valueOf = (script: typeof scripts[number]): unknown =>
            script.outcome === "envelope"
              ? { _tag: "Quarantined", member: script.name, error: "not an error" }
              : `value:${script.name}`

          const build = () => {
            const ran: Array<string> = []
            const width = gauge()
            const members: Record<string, Effect.Effect<unknown, string>> = {}
            for (const script of scripts) {
              Object.defineProperty(members, script.name, {
                enumerable: true,
                value: width.track(Effect.gen(function*() {
                  ran.push(script.name)
                  yield* turns(script.work)
                  if (script.name === defect) return yield* Effect.die(`defect:${script.name}`)
                  if (script.outcome === "fail") return yield* Effect.fail(`failed:${script.name}`)
                  return valueOf(script)
                }))
              })
            }
            return { members, ran, width }
          }

          const isolated = build()
          const quarantine = yield* Effect.exit(
            Quarantine.run(isolated.members, { policy: "quarantine", concurrency })
          )
          const halting = build()
          const halt = yield* Effect.exit(Quarantine.run(halting.members, { policy: "halt", concurrency }))

          for (const form of [isolated, halting]) {
            if (typeof concurrency === "number" && form.width.peak() > concurrency) {
              return `peak ${form.width.peak()} exceeds the width ${concurrency}`
            }
            if (new Set(form.ran).size !== form.ran.length) return `a member ran twice: ${show(form.ran)}`
          }

          if (defect !== undefined) {
            // Quarantine isolates declared failures, never a broken process.
            if (defectOf(quarantine) !== `defect:${defect}`) return `the defect was absorbed: ${show(quarantine)}`
            return Exit.isFailure(halt) ? undefined : `halt absorbed a defect: ${show(halt)}`
          }

          if (!Exit.isSuccess(quarantine)) return `quarantine failed: ${show(quarantine)}`
          if (!same([...isolated.ran].sort(), [...names].sort())) return `quarantine skipped a member: ${isolated.ran}`
          const settled = quarantine.value
          if (!same(Object.keys(settled), names)) return `result names ${show(Object.keys(settled))}`
          for (const script of scripts) {
            const entry = settled[script.name]
            if (script.outcome === "fail") {
              if (!Quarantine.isQuarantined(entry) || entry.error !== `failed:${script.name}`) {
                return `member ${show(script.name)} should be quarantined: ${show(entry)}`
              }
            } else if (!Quarantine.isSucceeded(entry) || !same(entry.value, valueOf(script))) {
              return `member ${show(script.name)} should have succeeded: ${show(entry)}`
            }
          }

          // The joining law: settling a quarantined join succeeds exactly when
          // halt does, on the same values.
          const joined = yield* Effect.exit(Quarantine.settle(settled))
          if (failing.length === 0) {
            if (!Exit.isSuccess(joined) || !Exit.isSuccess(halt)) return `a clean join failed: ${show([joined, halt])}`
            const expected = scripts.map((script) => [script.name, valueOf(script)])
            return same(Object.entries(joined.value), expected) && same(Object.entries(halt.value), expected)
              ? undefined
              : `settle and halt disagree: ${show([joined, halt])}`
          }
          const error = failureOf(joined)
          if (!(error instanceof PatternError.PatternError) || error.code !== "quarantined") {
            return `settle accepted quarantined members: ${show(joined)}`
          }
          if (!same(error.cause, [...failing].sort().map((member) => ({ member, error: `failed:${member}` })))) {
            return `settle lost member errors: ${show(error.cause)}`
          }
          const halted = failureOf(halt)
          return typeof halted === "string" && failing.some((member) => halted === `failed:${member}`)
            ? undefined
            : `halt should fail with a member error: ${show(halt)}`
        }),
      { seed: seed + 3, executions: pureExecutions }
    )
  })

  it("Quarantine.settle refuses any entry that is not a complete envelope", async () => {
    const arbitrary = Arbitrary.schema(
      Schema.Struct({
        entries: Schema.Array(
          Schema.Struct({
            name: HostileName,
            shape: Schema.Literals(["succeeded", "quarantined", "raw", "null", "tagOnly", "wrongMember", "inherited"])
          })
        )
      })
    )
    await holds(
      arbitrary,
      ({ entries: generated }) =>
        Effect.gen(function*() {
          const names = distinct(generated.slice(0, 6).map((entry) => entry.name), 1)
          const shapes = names.map((name, index) => ({ name, shape: generated[index]?.shape ?? "succeeded" }))
          const record: Record<string, unknown> = {}
          for (const { name, shape } of shapes) {
            const value = shape === "succeeded"
              ? { _tag: "Succeeded", member: name, value: `v:${name}` }
              : shape === "quarantined"
              ? { _tag: "Quarantined", member: name, error: `e:${name}` }
              : shape === "raw"
              ? `v:${name}`
              : shape === "null"
              ? null
              : shape === "tagOnly"
              ? { _tag: "Succeeded" }
              : shape === "wrongMember"
              ? { _tag: "Succeeded", member: 7, value: 1 }
              : Object.create({ _tag: "Succeeded", member: name, value: 1 })
            Object.defineProperty(record, name, { enumerable: true, value })
          }
          const exit = yield* Effect.exit(
            Quarantine.settle(record as Readonly<Record<string, Quarantine.Settled<unknown, unknown>>>)
          )
          const complete = (shape: string): boolean => shape === "succeeded" || shape === "quarantined"
          const invalid = shapes.filter(({ shape }) => !complete(shape))
          if (invalid.length > 0) {
            return patternCode(exit) === "invalid_input" ? undefined : `an incomplete envelope settled: ${show(exit)}`
          }
          if (shapes.some(({ shape }) => shape === "quarantined")) {
            return patternCode(exit) === "quarantined" ? undefined : `a quarantined entry settled: ${show(exit)}`
          }
          return Exit.isSuccess(exit) &&
              same(Object.entries(exit.value), shapes.map(({ name }) => [name, `v:${name}`]))
            ? undefined
            : `clean envelopes did not settle: ${show(exit)}`
        }),
      { seed: seed + 4, executions: pureExecutions }
    )
  })

  const acceptedVerdicts = [true, "approved", { approved: true }, { accepted: true }] as const
  const refusedVerdicts = [
    false,
    "denied",
    "Approved",
    "approved ",
    null,
    1,
    { approved: "true" },
    { approved: 1 },
    { accepted: false },
    {}
  ] as const

  it("ReviewLoop.run follows the retry state machine: approval, the round bound, and the stall breaker", async () => {
    const arbitrary = Arbitrary.schema(
      Schema.Struct({
        maxRounds: small(1, 7),
        verdicts: Schema.Array(Schema.Struct({ approve: Schema.Boolean, form: small(0, 9) })),
        outputs: Schema.Array(small(0, 2)),
        stall: Schema.Union([
          Schema.Literal("none"),
          Schema.Struct({ rounds: small(2, 4), on: Schema.Literals(["stop", "park", "escalate", "default"]) })
        ]),
        inherited: Schema.Boolean
      })
    )
    await holds(
      arbitrary,
      ({ inherited, maxRounds, outputs, stall, verdicts }) =>
        Effect.gen(function*() {
          const outputAt = (round: number): { readonly draft: number } => ({ draft: outputs[round - 1] ?? 0 })
          const approves = (round: number): boolean => (verdicts[round - 1]?.approve ?? false) && !inherited
          const verdictAt = (round: number): unknown => {
            const script = verdicts[round - 1]
            if (script?.approve !== true) return refusedVerdicts[(script?.form ?? 0) % refusedVerdicts.length]
            const verdict = acceptedVerdicts[script.form % acceptedVerdicts.length]
            // An inherited approval is not an approval: only own fields count.
            return inherited ? Object.create({ approved: true, accepted: true, verdict }) : verdict
          }
          const trace: Array<string> = []
          const exit = yield* Effect.exit(ReviewLoop.run("brief", {
            maxRounds,
            ...(stall === "none"
              ? {}
              : { stall: stall.on === "default" ? { rounds: stall.rounds } : { rounds: stall.rounds, on: stall.on } }),
            produce: (input) =>
              Effect.sync(() => {
                trace.push(`produce:${input}`)
                return outputAt(1)
              }),
            review: (output, round) =>
              Effect.sync(() => {
                trace.push(`review:${round}:${output.draft}`)
                return verdictAt(round)
              }),
            revise: ({ output, round }) =>
              Effect.sync(() => {
                trace.push(`revise:${round}:${output.draft}`)
                return outputAt(round + 1)
              })
          }))

          // The reference model.
          const expectedTrace = ["produce:brief"]
          let round = 1
          let streak = 0
          let previous: number | undefined
          let expected: unknown
          while (true) {
            const draft = outputAt(round).draft
            expectedTrace.push(`review:${round}:${draft}`)
            if (approves(round)) {
              expected = { _tag: "Approved", output: { draft } }
              break
            }
            if (round === maxRounds) {
              expected = { _tag: "Exhausted", output: { draft } }
              break
            }
            if (stall !== "none") {
              streak = previous === draft ? streak + 1 : 1
              previous = draft
              if (streak >= stall.rounds) {
                const on = stall.on === "default" ? "stop" : stall.on
                expected = on === "escalate" ? "stalled" : {
                  _tag: "Stalled",
                  output: { draft },
                  stalled: { _tag: "Stalled", signal: "output", rounds: streak, on }
                }
                break
              }
            }
            expectedTrace.push(`revise:${round}:${draft}`)
            round += 1
          }

          if (!same(trace, expectedTrace)) return `trace ${show(trace)}, expected ${show(expectedTrace)}`
          if (expected === "stalled") {
            return patternCode(exit) === "stalled" ? undefined : `expected a stalled failure, got ${show(exit)}`
          }
          if (!Exit.isSuccess(exit)) return `expected ${show(expected)}, got ${show(exit)}`
          const { review: _review, ...settled } = exit.value as ReviewLoop.Settled<unknown, unknown> & {
            readonly review?: unknown
          }
          return same(settled, expected) ? undefined : `settled ${show(settled)}, expected ${show(expected)}`
        }),
      { seed: seed + 5, executions: pureExecutions }
    )
  })

  it("Supervisor.run re-delegates exactly the retriable tasks each round, under the width and round bounds", async () => {
    const arbitrary = Arbitrary.schema(
      Schema.Struct({
        tasks: Schema.Array(
          Schema.Struct({
            name: HostileName,
            succeedsAt: small(1, 5),
            retriable: Schema.Boolean,
            redoWhenDone: Schema.Boolean
          })
        ),
        maxRounds: small(1, 5),
        concurrency: small(1, 4),
        junk: Schema.Boolean
      })
    )
    await holds(
      arbitrary,
      ({ concurrency, junk, maxRounds, tasks: generated }) =>
        Effect.gen(function*() {
          const ids = distinct(generated.slice(0, 5).map((task) => task.name), 1)
          const scripts = ids.map((id, index) => ({
            id,
            succeedsAt: generated[index]?.succeedsAt ?? 1,
            retriable: generated[index]?.retriable ?? true,
            redoWhenDone: generated[index]?.redoWhenDone ?? false
          }))
          const plan = { tasks: scripts.map((script) => ({ id: script.id, workerType: "worker" })) }
          const calls: Array<{ readonly id: string; readonly round: number; readonly previous: unknown }> = []
          const reviews: Array<ReadonlyArray<{ readonly id: string; readonly tag: string; readonly round: number }>> =
            []
          const width = gauge()
          // The review names what to retry from the outcomes it is handed.
          const again = (
            results: ReadonlyArray<{ readonly id: string; readonly _tag: string }>
          ): ReadonlyArray<string> =>
            scripts
              .filter((script) => {
                const outcome = results.find((result) => result.id === script.id)!
                return outcome._tag === "Failed" ? script.retriable : script.redoWhenDone
              })
              .map((script) => script.id)
          const exit = yield* Effect.exit(Supervisor.run("goal", {
            maxRounds,
            maxTasks: 5,
            concurrency,
            plan: () => Effect.succeed(plan),
            worker: ({ retriable, review, round, task }) =>
              width.track(Effect.gen(function*() {
                calls.push({ id: task.id, round, previous: review === undefined ? undefined : retriable })
                yield* Effect.yieldNow
                const script = scripts.find((entry) => entry.id === task.id)!
                if (round < script.succeedsAt) return yield* Effect.fail(`failed:${task.id}:${round}`)
                return `done:${task.id}:${round}`
              })),
            review: ({ results, round }) =>
              Effect.sync(() => {
                reviews.push(results.map((result) => ({ id: result.id, tag: result._tag, round: result.round })))
                const retry = again(results)
                return {
                  allDone: results.every((result) => result._tag === "Done") && retry.length === 0,
                  // Unknown ids and non-strings name no task and are ignored.
                  retriable: junk ? [...retry, "no-such-task", 7, null, ...retry] : retry,
                  round
                }
              }),
            finalize: ({ results, rounds }) => Effect.succeed({ rounds, outputs: results.map((result) => result._tag) })
          }))

          // The reference model.
          const expectedCalls: Array<{ readonly id: string; readonly round: number; readonly previous: unknown }> = []
          const expectedReviews: typeof reviews = []
          const latest = new Map<string, { readonly id: string; readonly _tag: string; readonly round: number }>()
          let pending = scripts
          let round = 1
          let previous: ReadonlyArray<string> | undefined
          let expected: { readonly exhausted: boolean; readonly rounds: number }
          while (true) {
            for (const script of pending) {
              expectedCalls.push({ id: script.id, round, previous })
              latest.set(script.id, {
                id: script.id,
                _tag: round < script.succeedsAt ? "Failed" : "Done",
                round
              })
            }
            const results = scripts.map((script) => latest.get(script.id)!)
            expectedReviews.push(results.map((result) => ({ id: result.id, tag: result._tag, round: result.round })))
            const retry = again(results)
            if (results.every((result) => result._tag === "Done") && retry.length === 0) {
              expected = { exhausted: false, rounds: round }
              break
            }
            if (round === maxRounds || retry.length === 0) {
              expected = { exhausted: true, rounds: round }
              break
            }
            pending = scripts.filter((script) => retry.includes(script.id))
            previous = junk ? [...retry, "no-such-task", ...retry] : retry
            round += 1
          }

          if (width.peak() > concurrency) return `peak ${width.peak()} exceeds the width ${concurrency}`
          const byRound = (entries: typeof calls) =>
            [...entries].sort((left, right) => left.round - right.round || ids.indexOf(left.id) - ids.indexOf(right.id))
          if (!same(byRound(calls), byRound(expectedCalls))) {
            return `worker calls ${show(byRound(calls))}, expected ${show(byRound(expectedCalls))}`
          }
          // Rounds never interleave: every call of round n precedes round n+1.
          for (let index = 1; index < calls.length; index++) {
            if (calls[index - 1]!.round > calls[index]!.round) return `rounds interleaved: ${show(calls)}`
          }
          if (!same(reviews, expectedReviews)) return `reviews ${show(reviews)}, expected ${show(expectedReviews)}`
          if (!Exit.isSuccess(exit)) return `expected a settlement, got ${show(exit)}`
          return exit.value.exhausted === expected.exhausted && exit.value.rounds === expected.rounds
            ? undefined
            : `settled ${show(exit.value)}, expected ${show(expected)}`
        }),
      { seed: seed + 6, executions: pureExecutions }
    )
  })

  it("Supervisor.run refuses a malformed, oversized or duplicated plan before any worker runs", async () => {
    const arbitrary = Arbitrary.schema(
      Schema.Struct({
        fault: Schema.Literals(["none", "empty", "notArray", "noTasks", "badTask", "duplicate", "oversized"]),
        count: small(1, 4),
        name: HostileName
      })
    )
    await holds(
      arbitrary,
      ({ count, fault, name }) =>
        Effect.gen(function*() {
          let workers = 0
          const tasks: Array<unknown> = Array.from(
            { length: count },
            (_, index) => ({ id: `${name}:${index}`, workerType: "w" })
          )
          if (fault === "badTask") tasks.push({ id: 7, workerType: "w" })
          if (fault === "duplicate") tasks.push({ id: `${name}:0`, workerType: "other" })
          const plan: unknown = fault === "empty"
            ? { tasks: [] }
            : fault === "notArray"
            ? { tasks: "all of them" }
            : fault === "noTasks"
            ? Object.create({ tasks })
            : { tasks }
          const exit = yield* Effect.exit(Supervisor.run("goal", {
            maxRounds: 2,
            maxTasks: fault === "oversized" ? count - 1 || 1 : 6,
            concurrency: 2,
            plan: () => Effect.succeed(plan as Supervisor.Plan),
            worker: () =>
              Effect.sync(() => {
                workers += 1
                return "done"
              }),
            review: () => Effect.succeed(true),
            finalize: () => Effect.succeed("final")
          }))
          const refused = fault !== "none" && !(fault === "oversized" && count === 1)
          if (!refused) {
            return Exit.isSuccess(exit) && workers === count ? undefined : `a valid plan failed: ${show(exit)}`
          }
          return patternCode(exit) === "invalid_input" && workers === 0
            ? undefined
            : `fault ${fault} ran ${workers} workers and settled ${show(exit)}`
        }),
      { seed: seed + 7, executions: pureExecutions }
    )
  })

  const rungResults = [
    null,
    undefined,
    0,
    "",
    7,
    { ok: false },
    { ok: true },
    { failed: true },
    { failed: "true" },
    { error: "boom" },
    { error: false },
    { error: null },
    { error: 0 },
    {}
  ] as const
  const escalatesByDefault = [
    true,
    true,
    false,
    false,
    false,
    true,
    false,
    true,
    false,
    true,
    false,
    false,
    true,
    false
  ]

  it("Escalation.run climbs the ladder in order and settles on the first rung that does not escalate", async () => {
    const arbitrary = Arbitrary.schema(
      Schema.Struct({
        rungs: Schema.Array(
          Schema.Struct({
            result: small(0, 13),
            escalateIf: Schema.Literals(["none", "none", "yes", "no"]),
            accept: small(0, 13),
            fails: Schema.Literals([false, false, false, false, true]),
            bare: Schema.Boolean
          })
        ),
        accept: Schema.Boolean,
        fallback: Schema.Boolean
      })
    )
    await holds(
      arbitrary,
      ({ accept, fallback, rungs: generated }) =>
        Effect.gen(function*() {
          const rungs = generated.slice(0, 6)
          const decisions = [...acceptedVerdicts, ...refusedVerdicts]
          const trace: Array<string> = []
          const exit = yield* Effect.exit(Escalation.run("ask", {
            rungs: rungs.map((rung, level) => {
              const run = (input: string) =>
                Effect.suspend(() => {
                  trace.push(`rung:${level}:${input}`)
                  return rung.fails
                    ? Effect.fail(`rung-failed:${level}`)
                    : Effect.succeed<unknown>(rungResults[rung.result])
                })
              // A bare function and a record are the same rung.
              return rung.escalateIf === "none"
                ? rung.bare ? run : { run }
                : {
                  run,
                  escalateIf: (_result: unknown, at: number) =>
                    Effect.sync(() => {
                      trace.push(`escalateIf:${at}`)
                      return rung.escalateIf === "yes"
                    })
                }
            }),
            ...(accept
              ? {
                accept: (result: unknown) =>
                  Effect.sync(() => {
                    const level = trace.filter((entry) => entry.startsWith("rung:")).length - 1
                    trace.push(`accept:${level}:${show(result)}`)
                    return decisions[rungs[level]!.accept % decisions.length]
                  })
              }
              : {}),
            ...(fallback
              ? {
                fallback: (input: string) =>
                  Effect.sync(() => {
                    trace.push(`fallback:${input}`)
                    return "human"
                  })
              }
              : {})
          }))

          if (rungs.length === 0) {
            return patternCode(exit) === "invalid_decorator" && trace.length === 0
              ? undefined
              : `an empty ladder must be refused: ${show(exit)}`
          }

          // The reference model.
          const expectedTrace: Array<string> = []
          let expected: unknown
          for (const [level, rung] of rungs.entries()) {
            expectedTrace.push(`rung:${level}:ask`)
            if (rung.fails) {
              expected = { failed: `rung-failed:${level}` }
              break
            }
            const result = rungResults[rung.result]
            let escalate: boolean
            if (rung.escalateIf !== "none") {
              expectedTrace.push(`escalateIf:${level}`)
              escalate = rung.escalateIf === "yes"
            } else if (accept) {
              expectedTrace.push(`accept:${level}:${show(result)}`)
              escalate = rung.accept % decisions.length >= acceptedVerdicts.length
            } else {
              escalate = escalatesByDefault[rung.result]!
            }
            if (!escalate) {
              expected = { level, result, exhausted: false }
              break
            }
          }
          if (expected === undefined) {
            if (fallback) {
              expectedTrace.push("fallback:ask")
              expected = { level: rungs.length, result: "human", exhausted: false }
            } else {
              expected = {
                level: rungs.length - 1,
                result: rungResults[rungs.at(-1)!.result],
                accepted: false,
                exhausted: true
              }
            }
          }

          if (!same(trace, expectedTrace)) return `trace ${show(trace)}, expected ${show(expectedTrace)}`
          const settled = Exit.isSuccess(exit) ? exit.value : { failed: failureOf(exit) }
          return same(settled, expected) && Object.keys(settled).length === Object.keys(expected as object).length
            ? undefined
            : `settled ${show(settled)}, expected ${show(expected)}`
        }),
      { seed: seed + 8, executions: pureExecutions }
    )
  })

  // Values one edit away from the accepted literal `"approved"`: case,
  // padding, NUL, a zero-width space, a Cyrillic homoglyph, and the truthy
  // containers a loose check would accept.
  const nearMisses: ReadonlyArray<unknown> = [
    "Approved",
    "approved ",
    " approved",
    "approved\0",
    "APPROVED",
    "approved\u200B",
    "\u0430pproved",
    "",
    true,
    { approved: true },
    ["approved"],
    new String("approved")
  ]

  it("Intervene.run applies only behind the literal approval and never under a dry run", async () => {
    const arbitrary = Arbitrary.schema(
      Schema.Struct({
        dryRun: Schema.Boolean,
        approval: Schema.Literals(["decides", "decides", "decides", "none", "fails"]),
        // Near misses of the one accepted literal, then anything at all.
        near: small(0, 15),
        arbitrary: Schema.Union([Schema.String, Schema.Boolean, Schema.Null, Schema.Number]),
        failing: Schema.Literals(["none", "none", "none", "none", "read", "propose", "apply", "report"])
      })
    )
    await holds(
      arbitrary,
      ({ approval, arbitrary: anything, dryRun, failing, near }) =>
        Effect.gen(function*() {
          const decision: unknown = near < nearMisses.length ? nearMisses[near] : near === 15 ? anything : "approved"
          const trace: Array<string> = []
          const stage = <A>(name: string, value: A): Effect.Effect<A, string> =>
            Effect.suspend(() => {
              trace.push(name)
              return failing === name ? Effect.fail(`failed:${name}`) : Effect.succeed(value)
            })
          const exit = yield* Effect.exit(Intervene.run("target", {
            dryRun,
            read: ({ input, phase }) => stage("read", `${phase}:${input}`),
            propose: ({ context, phase }) => stage("propose", `${phase}:${context}`),
            apply: ({ phase, proposal }) => stage("apply", `${phase}:${proposal}`),
            report: (args) => stage("report", { applied: args.applied, dryRun: args.dryRun, proposal: args.proposal }),
            ...(approval === "none"
              ? {}
              : {
                approval: ({ proposal }: { readonly proposal: string }) =>
                  Effect.suspend(() => {
                    trace.push(`approval:${proposal}`)
                    return approval === "fails" ? Effect.fail("failed:approval") : Effect.succeed<unknown>(decision)
                  })
              })
          }))

          // The reference model.
          const proposal = "propose:read:target"
          const expectedTrace = ["read"]
          let expected: unknown
          const model = (): void => {
            if (failing === "read") return void (expected = { failed: "failed:read" })
            expectedTrace.push("propose")
            if (failing === "propose") return void (expected = { failed: "failed:propose" })
            if (dryRun) {
              expectedTrace.push("report")
              expected = failing === "report" ? { failed: "failed:report" } : { dryRun: true, proposal }
              return
            }
            if (approval !== "none") {
              expectedTrace.push(`approval:${proposal}`)
              if (approval === "fails") return void (expected = { failed: "failed:approval" })
              if (decision !== "approved") return void (expected = "denied")
            }
            expectedTrace.push("apply")
            if (failing === "apply") return void (expected = { failed: "failed:apply" })
            expectedTrace.push("report")
            expected = failing === "report"
              ? { failed: "failed:report" }
              : { applied: `apply:${proposal}`, dryRun: false, proposal }
          }
          model()

          if (!same(trace, expectedTrace)) {
            return `trace ${show(trace)}, expected ${show(expectedTrace)} for decision ${show(decision)}`
          }
          if (expected === "denied") {
            // A denial is a typed schema failure, never a defect or a success.
            return Schema.isSchemaError(failureOf(exit)) ? undefined : `a denial settled as ${show(exit)}`
          }
          const settled = Exit.isSuccess(exit) ? exit.value : { failed: failureOf(exit) }
          return same(settled, expected) ? undefined : `settled ${show(settled)}, expected ${show(expected)}`
        }),
      { seed: seed + 9, executions: pureExecutions }
    )
  })

  /** One repair world: issues by id, each fixable or not. */
  const world = (count: number, fixable: number) => {
    const open = new Set(Array.from({ length: count }, (_, index) => index))
    return {
      scan: (): ReadonlyArray<string> => [...open].map((index) => `issue-${index}`),
      fix: (issue: string): string => {
        const index = Number(issue.slice("issue-".length))
        if (((fixable >> index) & 1) === 1) open.delete(index)
        return `fixed:${issue}`
      },
      clean: (): boolean => open.size === 0
    }
  }

  const repair = Schema.Struct({
    issues: small(0, 6),
    fixable: small(0, 63),
    maxRetries: small(1, 4),
    maxIssues: small(1, 4),
    concurrency: small(1, 3),
    verify: Schema.Literals(["never", "truthful", "lying"])
  })

  it("ScanFixVerify.run fixes at most maxIssues per round at the declared width and stops on the model's round", async () => {
    await holds(
      Arbitrary.schema(Schema.Struct({ ...repair.fields, capped: Schema.Boolean })),
      ({ capped, concurrency, fixable, issues, maxIssues, maxRetries, verify }) =>
        Effect.gen(function*() {
          const cap = capped ? maxIssues : Number.POSITIVE_INFINITY
          const live = world(issues, fixable)
          const trace: Array<string> = []
          const width = gauge()
          const exit = yield* Effect.exit(ScanFixVerify.run("repo", {
            maxRetries,
            concurrency,
            ...(capped ? { maxIssues } : {}),
            scan: ({ input, iteration }) =>
              Effect.sync(() => {
                trace.push(`scan:${iteration}:${input}`)
                return live.scan()
              }),
            fix: ({ index, issue, iteration }) =>
              width.track(Effect.gen(function*() {
                yield* Effect.yieldNow
                trace.push(`fix:${iteration}:${index}:${issue}`)
                return live.fix(issue)
              })),
            verify: ({ fixes, issues: found, iteration }) =>
              Effect.sync(() => {
                trace.push(`verify:${iteration}:${found.length}:${fixes.join(",")}`)
                return { resolved: verify === "lying" || (verify === "truthful" && live.clean()), iteration }
              })
          }))

          // The reference model, on its own world.
          const model = world(issues, fixable)
          const expectedTrace: Array<string> = []
          const verifications: Array<unknown> = []
          let iteration = 1
          let expected: unknown
          while (true) {
            const found = model.scan()
            expectedTrace.push(`scan:${iteration}:repo`)
            if (found.length === 0 || iteration > maxRetries) {
              expected = {
                iterations: Math.min(iteration, maxRetries),
                remaining: found,
                resolved: found.length === 0,
                verifications
              }
              break
            }
            const batch = found.slice(0, cap)
            const fixes = batch.map((issue, index) => {
              expectedTrace.push(`fix:${iteration}:${index}:${issue}`)
              return model.fix(issue)
            })
            expectedTrace.push(`verify:${iteration}:${found.length}:${fixes.join(",")}`)
            const resolved = verify === "lying" || (verify === "truthful" && model.clean())
            verifications.push({ resolved, iteration })
            if (resolved) {
              expected = { iterations: iteration, remaining: [], resolved: true, verifications }
              break
            }
            iteration += 1
          }

          if (width.peak() > concurrency) return `peak ${width.peak()} exceeds the width ${concurrency}`
          // Fixes of one round may finish in any order; everything else is ordered.
          const normal = (entries: ReadonlyArray<string>): ReadonlyArray<string> => {
            const out: Array<string> = []
            let fixes: Array<string> = []
            for (const entry of entries) {
              if (entry.startsWith("fix:")) fixes.push(entry)
              else {
                out.push(...fixes.sort(), entry)
                fixes = []
              }
            }
            return [...out, ...fixes.sort()]
          }
          if (!same(normal(trace), normal(expectedTrace))) {
            return `trace ${show(trace)}, expected ${show(expectedTrace)}`
          }
          if (!Exit.isSuccess(exit)) return `expected a settlement, got ${show(exit)}`
          const settled = exit.value
          if (settled.resolved !== (settled.remaining.length === 0)) return `resolved disagrees with remaining`
          if (settled.iterations < 1 || settled.iterations > maxRetries) return `iterations ${settled.iterations}`
          if (trace.filter((entry) => entry.startsWith("scan:")).length > maxRetries + 1) return `too many scans`
          return same(settled, expected) ? undefined : `settled ${show(settled)}, expected ${show(expected)}`
        }),
      { seed: seed + 10, executions: pureExecutions }
    )
  })

  it("ScanFixVerify.make settles the same repair as run when the verifier never short-circuits", async () => {
    let execution = 0
    await holds(
      Arbitrary.schema(repair),
      ({ concurrency, fixable, issues, maxIssues, maxRetries }) =>
        Effect.gen(function*() {
          const bounds = { maxRetries, maxIssues, concurrency }
          const script = (live: ReturnType<typeof world>) => ({
            scan: () => live.scan(),
            fix: ({ issue }: { readonly issue: string }) => live.fix(issue),
            verify: ({ fixes }: { readonly fixes: ReadonlyArray<string> }) => ({ resolved: false, fixed: fixes.length })
          })
          const ran = scripted(script(world(issues, fixable)))
          const operational = yield* Effect.exit(ScanFixVerify.run("repo", {
            ...bounds,
            scan: ran.effects.scan!,
            fix: ran.effects.fix!,
            verify: ran.effects.verify!
          }))

          const declared = scripted(script(world(issues, fixable)))
          const flow = ScanFixVerify.make({
            ...bounds,
            scan: declared.members.scan!,
            fix: declared.members.fix!,
            verify: declared.members.verify!
          })
          const layer = Layer.mergeAll(Interpreter.layer(flow), declared.layer, Logger.layer([])).pipe(
            Layer.provideMerge(Action.layerImplementations),
            Layer.provideMerge(FlowEngine.layerMemory),
            Layer.provideMerge(NodeCrypto.layer)
          ) as Layer.Layer<any, never, never>
          const settled = yield* Effect.exit(
            (flow.execute({ input: "repo" }, { executionId: `algebra-sfv-${++execution}` }) as Effect.Effect<unknown>)
              .pipe(Effect.provide(layer), Effect.scoped)
          )

          if (!same(operational, settled)) return `run ${show(operational)} and make ${show(settled)} disagree`
          const roles = (tape: ReadonlyArray<{ readonly role: string }>, role: string): number =>
            tape.filter((call) => call.role === role).length
          for (const role of ["scan", "fix", "verify"]) {
            if (roles(ran.ranTape, role) !== roles(declared.declaredTape, role)) {
              return `run called ${role} ${roles(ran.ranTape, role)} times, make ${roles(declared.declaredTape, role)}`
            }
          }
          return undefined
        }),
      { seed: seed + 11, executions: ioExecutions }
    )
  })
})
