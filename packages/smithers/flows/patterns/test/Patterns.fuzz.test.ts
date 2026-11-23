import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import { Action, DurableDeferred, Fault, Flow, Graph, Interpreter, Sleep, WaitFor } from "@smthrs/flow"
import { Fuzz, FuzzSimulation } from "@smthrs/fuzz"
import * as Effects from "@smthrs/plan/Effects"
import * as Node from "@smthrs/plan/Node"
import { Arbitrary, Cause, Deferred, Duration, Effect, Exit, Fiber, Layer, Logger, Schema } from "effect"
import * as EffectDigest from "effect/crypto/Digest"
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import {
  Bounded,
  Burndown,
  CheckSuite,
  Debate,
  DelegationChain,
  DriftDetector,
  Escalation,
  Intervene,
  Kanban,
  MapReduce,
  MergeQueue,
  Optimizer,
  Panel,
  Pattern,
  PatternError,
  Quarantine,
  Recursion,
  ReviewLoop,
  Runbook,
  Saga,
  ScanFixVerify,
  Sidecar,
  Supervisor,
  Trellis
} from "../src/index.ts"
import { approval, fail, flow as parityFlow, scripted } from "./Parity.ts"

const rawEnv = process.env.EFFECT_FUZZ_EXECUTIONS
const baseExecutions = Number(rawEnv ?? (process.env.EFFECT_FUZZ ? "400" : "60"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261122")

const runs = (weight: number): number => {
  if (rawEnv !== undefined) return Math.max(5, Math.round(Number(rawEnv) * weight))
  return Math.max(10, Math.round(baseExecutions * weight))
}

const syncCrypto: typeof EffectDigest.Digest.Service = EffectDigest.Digest.of({
  digest: (_algorithm, data) =>
    Effect.sync(() => {
      const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data as Uint8Array)
      return new Uint8Array(createHash("sha256").update(bytes).digest())
    }),
  digestHex: (_algorithm, data) =>
    Effect.sync(() => {
      const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data as Uint8Array)
      return createHash("sha256").update(bytes).digest("hex")
    })
})

const syncCryptoLayer = Layer.merge(NodeCrypto.layer, Layer.succeed(EffectDigest.Digest)(syncCrypto))

let execCounter = 0

interface ExecutableFlow {
  readonly _tag: string
  readonly execute: (payload: any, options: { readonly executionId: string }) => Effect.Effect<any, any, any>
}

const runDeclaredExit = (
  target: ExecutableFlow,
  payload: unknown,
  prefix: string,
  ...extraLayers: ReadonlyArray<Layer.Layer<any, any, any>>
): Effect.Effect<Exit.Exit<unknown, unknown>> =>
  Effect.suspend(() =>
    (target.execute(payload, { executionId: `${prefix}-${++execCounter}` }) as Effect.Effect<unknown, unknown, never>)
      .pipe(
        Effect.provide(
          Layer.mergeAll(
            Interpreter.layer(target as never),
            ...extraLayers,
            Logger.layer([])
          ).pipe(
            Layer.provideMerge(Action.layerImplementations),
            Layer.provideMerge(FlowEngine.layerMemory),
            Layer.provideMerge(syncCryptoLayer)
          ) as Layer.Layer<any, never, never>
        ),
        Effect.scoped,
        Effect.exit
      )
  )

const errorOfExit = (exit: Exit.Exit<unknown, unknown>): unknown => {
  if (Exit.isSuccess(exit)) return undefined
  const found = Cause.findErrorOption(exit.cause)
  return found._tag === "Some" ? found.value : undefined
}

const errorCodeOf = (exit: Exit.Exit<unknown, unknown>): string | undefined => {
  const err = errorOfExit(exit)
  if (
    typeof err === "object" && err !== null && "code" in err &&
    typeof (err as { readonly code: unknown }).code === "string"
  ) {
    return (err as { readonly code: string }).code
  }
  return undefined
}

const decodeBadNumber = (tag: "zero" | "neg" | "frac" | "nan" | "inf"): number => {
  switch (tag) {
    case "zero":
      return 0
    case "neg":
      return -1
    case "frac":
      return 1.5
    case "nan":
      return Number.NaN
    case "inf":
      return Number.POSITIVE_INFINITY
  }
}

const assertFuzz = async <A, E>(effect: Effect.Effect<Fuzz.Report<A, E>, Fuzz.FuzzError, never>) => {
  const report = await Effect.runPromise(effect.pipe(Effect.provide(Logger.layer([]))))
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

// Register a test infra fault for Burndown requeue fuzzing.
Fault.register("PatternsFuzzInfra", "infra")

describe("@smthrs/patterns fuzz invariants & coverage", () => {
  it("Bounded.run & Bounded.all enforce concurrency caps, preserve values, and validate bounds", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        count: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 6 })),
        concurrency: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4 })),
        delays: Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 }))),
        failIndex: Schema.Int.check(Schema.isBetween({ minimum: -1, maximum: 6 }))
      })
    )
    await assertFuzz(
      Fuzz.run(
        arb,
        ({ count, concurrency, delays, failIndex }) =>
          Effect.gen(function*() {
            let active = 0
            let peak = 0
            const members: Record<string, Effect.Effect<number, string>> = {}
            const script: Record<string, (p: any) => unknown> = {}
            const shouldFail = failIndex >= 0 && failIndex < count ? failIndex : -1
            for (let i = 0; i < count; i++) {
              const delay = delays[i] ?? 0
              const key = `m${i}`
              members[key] = Effect.gen(function*() {
                active++
                if (active > peak) peak = active
                yield* Effect.sleep(Duration.millis(delay))
                yield* Effect.yieldNow
                if (i === shouldFail) return yield* Effect.fail(`boom-${i}`)
                return i * 3 + 1
              }).pipe(Effect.ensuring(Effect.sync(() => {
                active--
              })))
              script[key] = () => (i === shouldFail ? fail(`boom-${i}`) : i * 3 + 1)
            }
            const runExit = yield* Effect.exit(Bounded.run(members, { concurrency }))
            if (peak > concurrency || active !== 0) return false
            if (shouldFail === -1) {
              if (!Exit.isSuccess(runExit)) return false
              for (let i = 0; i < count; i++) {
                if (runExit.value[`m${i}`] !== i * 3 + 1) return false
              }
            } else {
              if (Exit.isSuccess(runExit)) return false
            }

            // Declared Bounded.all
            const forms = scripted(script)
            const flow = Flow.make("fuzz/bounded", {
              payload: { input: Schema.Unknown },
              success: Schema.Unknown,
              error: Schema.Unknown,
              body: ({ input }) =>
                Bounded.all(
                  Object.fromEntries(
                    Array.from({ length: count }, (_, i) => [`m${i}`, forms.members[`m${i}`]!.call({ input })])
                  ),
                  { concurrency }
                )
            })
            const decExit = yield* runDeclaredExit(flow, { input: "x" }, "bounded", forms.layer)
            if (shouldFail === -1) {
              if (!Exit.isSuccess(decExit)) return false
              const rec = decExit.value as Record<string, number>
              for (let i = 0; i < count; i++) {
                if (rec[`m${i}`] !== i * 3 + 1) return false
              }
            } else {
              if (Exit.isSuccess(decExit)) return false
            }
            return true
          }),
        { seed, executions: runs(0.5), execution: FuzzSimulation.execution() }
      )
    )

    // Validation refusals for Bounded.run & Bounded.all
    const badArb = Arbitrary.schema(
      Schema.Struct({
        badTag: Schema.Literals(["zero", "neg", "frac", "nan", "inf"]),
        empty: Schema.Boolean
      })
    )
    await assertFuzz(
      Fuzz.run(
        badArb,
        ({ badTag, empty }) =>
          Effect.gen(function*() {
            const badConcurrency = decodeBadNumber(badTag)
            const members: Record<string, Effect.Effect<number>> = empty ? {} : { a: Effect.succeed(1) }
            const exit = yield* Effect.exit(Bounded.run(members, { concurrency: empty ? 1 : badConcurrency }))
            if (Exit.isSuccess(exit)) return false
            const err = errorOfExit(exit)
            if (!(err instanceof PatternError.PatternError) || err.code !== "invalid_decorator") return false

            let threw = false
            try {
              const flow = Flow.make("fuzz/bounded-bad", {
                payload: { input: Schema.Unknown },
                success: Schema.Unknown,
                error: Schema.Unknown,
                body: () =>
                  Bounded.all(
                    empty ? {} : { a: Node.succeed(1) },
                    { concurrency: empty ? 1 : badConcurrency }
                  )
              })
              Graph.build(flow, { input: null })
            } catch (e) {
              threw = e instanceof PatternError.PatternError && e.code === "invalid_decorator"
            }
            return threw
          }),
        { seed: seed + 1, executions: runs(0.4) }
      )
    )
  })

  it("Quarantine.run & Quarantine.all isolate faults under quarantine and fail fast under halt", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        kinds: Schema.Array(Schema.Literals(["ok", "fail"])),
        policy: Schema.Literals(["quarantine", "halt"]),
        bounded: Schema.Boolean,
        concurrency: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 }))
      })
    )
    await assertFuzz(
      Fuzz.run(
        arb,
        ({ kinds: raw, policy, bounded, concurrency }) =>
          Effect.gen(function*() {
            const kinds = raw.length === 0 ? ["ok" as const] : raw.slice(0, 6)
            const members: Record<string, Effect.Effect<number, string>> = {}
            const script: Record<string, () => unknown> = {}
            let anyFail = false
            for (let i = 0; i < kinds.length; i++) {
              const k = kinds[i]!
              if (k === "fail") anyFail = true
              members[`k${i}`] = Effect.gen(function*() {
                yield* Effect.yieldNow
                if (k === "fail") return yield* Effect.fail(`err-${i}`)
                return i
              })
              script[`k${i}`] = () => (k === "fail" ? fail(`err-${i}`) : i)
            }
            const conc = bounded ? concurrency : ("unbounded" as const)
            if (policy === "halt") {
              const runExit = yield* Effect.exit(Quarantine.run(members, { policy: "halt", concurrency: conc }))
              if (anyFail && Exit.isSuccess(runExit)) return false
              if (!anyFail && !Exit.isSuccess(runExit)) return false
            } else {
              const runExit = yield* Effect.exit(Quarantine.run(members, { policy: "quarantine", concurrency: conc }))
              if (!Exit.isSuccess(runExit)) return false
              const settled = runExit.value
              for (let i = 0; i < kinds.length; i++) {
                const entry = settled[`k${i}`]
                if (!entry) return false
                if (kinds[i] === "ok" && (!Quarantine.isSucceeded(entry) || entry.value !== i)) return false
                if (kinds[i] === "fail" && !Quarantine.isQuarantined(entry)) return false
              }
            }

            const forms = scripted(script)
            const flow = Flow.make("fuzz/quarantine", {
              payload: { input: Schema.Unknown },
              success: Schema.Unknown,
              error: Schema.Unknown,
              body: ({ input }) => {
                const nodes = Object.fromEntries(
                  kinds.map((_, i) => [`k${i}`, forms.members[`k${i}`]!.call({ input })])
                )
                return policy === "halt"
                  ? Quarantine.all(nodes, { policy: "halt" })
                  : Quarantine.all(nodes, { policy: "quarantine" })
              }
            })
            const decExit = yield* runDeclaredExit(flow, { input: "q" }, "quarantine", forms.layer)
            if (policy === "halt") {
              if (anyFail && Exit.isSuccess(decExit)) return false
              if (!anyFail && !Exit.isSuccess(decExit)) return false
            } else {
              if (!Exit.isSuccess(decExit)) return false
              const settled = decExit.value as Record<string, unknown>
              for (let i = 0; i < kinds.length; i++) {
                const entry = settled[`k${i}`]
                if (!entry) return false
                if (kinds[i] === "ok" && (!Quarantine.isSucceeded(entry) || entry.value !== i)) return false
                if (kinds[i] === "fail" && !Quarantine.isQuarantined(entry)) return false
              }
            }
            return true
          }),
        { seed: seed + 2, executions: runs(0.5), execution: FuzzSimulation.execution() }
      )
    )

    // Validation & defect quarantine check
    await assertFuzz(
      Fuzz.run(
        Arbitrary.schema(Schema.Literals(["zero", "neg", "frac", "nan"])),
        (badTag) =>
          Effect.gen(function*() {
            const badConc = decodeBadNumber(badTag)
            const emptyMembers: Record<string, Effect.Effect<number>> = {}
            const e1 = yield* Effect.exit(Quarantine.run(emptyMembers, { policy: "quarantine" }))
            const e2 = yield* Effect.exit(
              Quarantine.run({ a: Effect.succeed(1) }, { policy: "halt", concurrency: badConc })
            )
            const defectExit = yield* Effect.exit(
              Quarantine.run({ a: Effect.die("boom"), b: Effect.succeed(42) }, { policy: "quarantine" })
            )
            // Quarantine.settle on all-succeeded, quarantined, and malformed records
            const okSettled = yield* Effect.exit(
              Quarantine.settle({
                a: { _tag: "Succeeded", member: "a", value: 1 },
                b: { _tag: "Succeeded", member: "b", value: 2 }
              })
            )
            const qSettled = yield* Effect.exit(
              Quarantine.settle({
                a: { _tag: "Succeeded", member: "a", value: 1 },
                b: { _tag: "Quarantined", member: "b", error: "err-b" }
              })
            )
            const badSettled = yield* Effect.exit(
              Quarantine.settle({ a: "raw-value" as never })
            )
            let makeRefused = false
            try {
              const f = Flow.make("fuzz/q-bad", {
                payload: { input: Schema.Unknown },
                success: Schema.Unknown,
                error: Schema.Unknown,
                body: () => Quarantine.all({}, { policy: "quarantine" })
              })
              Graph.build(f, { input: null })
            } catch (e) {
              makeRefused = e instanceof PatternError.PatternError
            }
            return (
              !Exit.isSuccess(e1) &&
              !Exit.isSuccess(e2) &&
              !Exit.isSuccess(defectExit) &&
              Exit.isSuccess(okSettled) &&
              okSettled.value.a === 1 &&
              okSettled.value.b === 2 &&
              errorCodeOf(qSettled) === "quarantined" &&
              errorCodeOf(badSettled) === "invalid_input" &&
              makeRefused
            )
          }),
        { seed: seed + 3, executions: runs(0.25) }
      )
    )
  })

  it("Saga.run & Saga.make unwind LIFO across all onFailure modes and validate declarations", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        stepCount: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 })),
        failAt: Schema.Int.check(Schema.isBetween({ minimum: -1, maximum: 5 })),
        compFailMask: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 31 })),
        onFailure: Schema.Literals(["compensate", "compensate-and-fail", "fail"])
      })
    )
    await assertFuzz(
      Fuzz.run(
        arb,
        ({ stepCount, failAt, compFailMask, onFailure }) =>
          Effect.gen(function*() {
            const forwardLog: Array<string> = []
            const unwindLog: Array<string> = []
            const shouldFailAt = failAt >= 0 && failAt < stepCount ? failAt : -1

            const steps: ReadonlyArray<Saga.RuntimeStep<string, number, string, never, string, never>> = Array.from(
              { length: stepCount },
              (_, i) => {
                const id = `s${i}`
                const compFails = ((compFailMask >> i) & 1) === 1
                return {
                  id,
                  action: () =>
                    Effect.gen(function*() {
                      yield* Effect.yieldNow
                      if (i === shouldFailAt) return yield* Effect.fail(`step-${id}-failed`)
                      forwardLog.push(id)
                      return i
                    }),
                  compensation: () =>
                    Effect.gen(function*() {
                      yield* Effect.yieldNow
                      unwindLog.push(id)
                      if (compFails) return yield* Effect.fail(`comp-${id}-failed`)
                    })
                }
              }
            )

            const runExit = yield* Effect.exit(Saga.run("input", { steps, onFailure }))
            const expectedForward = shouldFailAt === -1
              ? Array.from({ length: stepCount }, (_, i) => `s${i}`)
              : Array.from({ length: shouldFailAt }, (_, i) => `s${i}`)
            if (JSON.stringify(forwardLog) !== JSON.stringify(expectedForward)) return false

            const expectedUnwind = shouldFailAt === -1 || onFailure === "fail"
              ? []
              : [...expectedForward].reverse()
            if (JSON.stringify(unwindLog) !== JSON.stringify(expectedUnwind)) return false

            const compFailed = expectedUnwind.some((id) => {
              const idx = Number(id.slice(1))
              return ((compFailMask >> idx) & 1) === 1
            })

            if (shouldFailAt === -1) {
              if (!Exit.isSuccess(runExit) || runExit.value._tag !== "Completed") return false
            } else if (onFailure === "fail") {
              if (Exit.isSuccess(runExit)) return false
            } else if (compFailed) {
              if (errorCodeOf(runExit) !== "compensation_failed") return false
            } else if (onFailure === "compensate-and-fail") {
              if (Exit.isSuccess(runExit)) return false
            } else {
              if (!Exit.isSuccess(runExit) || runExit.value._tag !== "Compensated") return false
            }

            // Declared Saga.make parity
            const script: Record<string, () => unknown> = {}
            for (let i = 0; i < stepCount; i++) {
              const id = `s${i}`
              const compFails = ((compFailMask >> i) & 1) === 1
              script[`act_${i}`] =
                () => (i === shouldFailAt ? fail({ code: "step_err", message: `step-${id}-failed` }) : i)
              script[`cmp_${i}`] =
                () => (compFails ? fail({ code: "comp_err", message: `comp-${id}-failed` }) : "undone")
            }
            const forms = scripted(script)
            const flow = Saga.make({
              steps: Array.from({ length: stepCount }, (_, i) => ({
                id: `s${i}`,
                action: forms.members[`act_${i}`]!,
                compensation: forms.members[`cmp_${i}`]!
              })),
              onFailure
            })
            const decExit = yield* runDeclaredExit(flow, { input: "input" }, "saga", forms.layer)
            if (shouldFailAt === -1) {
              if (!Exit.isSuccess(decExit) || (decExit.value as { readonly _tag: string })._tag !== "Completed") {
                return false
              }
            } else if (onFailure === "compensate" && !compFailed) {
              if (!Exit.isSuccess(decExit) || (decExit.value as { readonly _tag: string })._tag !== "Compensated") {
                return false
              }
            } else {
              if (Exit.isSuccess(decExit)) return false
            }
            return true
          }),
        { seed: seed + 4, executions: runs(0.5), execution: FuzzSimulation.execution() }
      )
    )

    // Saga validation refusals (empty steps, duplicate ids, non-callable action/compensation)
    await assertFuzz(
      Fuzz.run(
        Arbitrary.schema(Schema.Literals(["empty", "dup", "badAction", "noComp"])),
        (kind) =>
          Effect.gen(function*() {
            const act = (): Effect.Effect<number, never, never> => Effect.succeed(1)
            const cmp = (): Effect.Effect<void, never, never> => Effect.void
            if (kind === "empty" || kind === "dup") {
              const steps: ReadonlyArray<Saga.RuntimeStep<string, number, never, never, never, never>> =
                kind === "empty"
                  ? []
                  : [{ id: "a", action: act, compensation: cmp }, { id: "a", action: act, compensation: cmp }]
              const e = yield* Effect.exit(Saga.run("x", { steps }))
              let makeThrew = false
              const forms = scripted({ a: () => 1, u: () => "ok" })
              try {
                Saga.make({
                  steps: kind === "empty"
                    ? []
                    : [
                      { id: "a", action: forms.members.a!, compensation: forms.members.u! },
                      { id: "a", action: forms.members.a!, compensation: forms.members.u! }
                    ]
                })
              } catch (err) {
                makeThrew = err instanceof PatternError.PatternError
              }
              return !Exit.isSuccess(e) && makeThrew
            }
            const forms = scripted({ a: () => 1, u: () => "ok" })
            let makeThrew = false
            try {
              Saga.make({
                steps: kind === "badAction"
                  ? [{ id: "a", action: (() => 1) as never, compensation: forms.members.u! }]
                  : [{ id: "a", action: forms.members.a!, compensation: undefined as never }]
              })
            } catch (err) {
              makeThrew = err instanceof PatternError.PatternError
            }
            return makeThrew
          }),
        { seed: seed + 5, executions: runs(0.25) }
      )
    )
  })

  it("Debate.run & Debate.make accumulate round transcripts identically and reject invalid rounds", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        rounds: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4 })),
        topic: Schema.String,
        failRole: Schema.Literals(["none", "proponent", "opponent", "judge"])
      })
    )
    await assertFuzz(
      Fuzz.run(
        arb,
        ({ rounds, topic, failRole }) =>
          Effect.gen(function*() {
            const script = {
              proponent: (
                { round, transcript }: { readonly round: number; readonly transcript: ReadonlyArray<unknown> }
              ) =>
                failRole === "proponent" && round === rounds
                  ? fail({ code: "p_err", message: "proponent failed" })
                  : `p${round}:${transcript.length}`,
              opponent: ({ proponent, round }: { readonly proponent: string; readonly round: number }) =>
                failRole === "opponent" && round === rounds
                  ? fail({ code: "o_err", message: "opponent failed" })
                  : `o${round}:${proponent}`,
              judge: ({ transcript }: { readonly transcript: ReadonlyArray<unknown> }) =>
                failRole === "judge"
                  ? fail({ code: "j_err", message: "judge failed" })
                  : { count: transcript.length, topic }
            }
            const forms = scripted(script)
            const runExit = yield* Effect.exit(
              Debate.run(topic, {
                proponent: forms.effects.proponent!,
                opponent: forms.effects.opponent!,
                judge: forms.effects.judge!,
                rounds
              })
            )
            const flow = Debate.make({
              proponent: forms.members.proponent!,
              opponent: forms.members.opponent!,
              judge: forms.members.judge!,
              rounds
            })
            const decExit = yield* runDeclaredExit(flow, { input: topic }, "debate", forms.layer)
            if (failRole !== "none") {
              return !Exit.isSuccess(runExit) && !Exit.isSuccess(decExit)
            }
            if (!Exit.isSuccess(runExit) || !Exit.isSuccess(decExit)) return false
            return JSON.stringify(runExit.value) === JSON.stringify(decExit.value) &&
              (runExit.value as { readonly count: number }).count === rounds
          }),
        { seed: seed + 6, executions: runs(0.5) }
      )
    )

    // Invalid rounds refusal
    await assertFuzz(
      Fuzz.run(
        Arbitrary.schema(Schema.Literals(["zero", "neg", "frac", "nan", "inf"])),
        (badTag) =>
          Effect.gen(function*() {
            const badRounds = decodeBadNumber(badTag)
            const forms = scripted({ p: () => 1, o: () => 2, j: () => 3 })
            const runExit = yield* Effect.exit(
              Debate.run("t", {
                proponent: forms.effects.p!,
                opponent: forms.effects.o!,
                judge: forms.effects.j!,
                rounds: badRounds
              })
            )
            let makeThrew = false
            try {
              Debate.make({
                proponent: forms.members.p!,
                opponent: forms.members.o!,
                judge: forms.members.j!,
                rounds: badRounds
              })
            } catch (e) {
              makeThrew = e instanceof PatternError.PatternError
            }
            return !Exit.isSuccess(runExit) && makeThrew
          }),
        { seed: seed + 7, executions: runs(0.25) }
      )
    )
  })

  it("Panel.run & Panel.make preserve declaration key order under arbitrary concurrency", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        panelistCount: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 })),
        bounded: Schema.Boolean,
        concurrency: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 })),
        failIdx: Schema.Int.check(Schema.isBetween({ minimum: -1, maximum: 5 })),
        modFails: Schema.Boolean
      })
    )
    await assertFuzz(
      Fuzz.run(
        arb,
        ({ panelistCount, bounded, concurrency, failIdx, modFails }) =>
          Effect.gen(function*() {
            const shouldFail = failIdx >= 0 && failIdx < panelistCount ? failIdx : -1
            const script: Record<string, (p: any) => unknown> = {
              moderator: ({ opinions }: { readonly opinions: Record<string, string> }) =>
                modFails ? fail({ code: "mod_err", message: "mod" }) : { keys: Object.keys(opinions), opinions }
            }
            for (let i = 0; i < panelistCount; i++) {
              script[`p${i}`] = ({ prompt }: { readonly prompt: string }) =>
                i === shouldFail ? fail({ code: "seat_err", message: `p${i}` }) : `opinion-${i}:${prompt}`
            }
            const forms = scripted(script)
            const panelistsRun = Object.fromEntries(
              Array.from({ length: panelistCount }, (_, i) => [
                `p${i}`,
                (input: { readonly prompt: string }) =>
                  Effect.flatMap(Effect.yieldNow, () => forms.effects[`p${i}`]!(input))
              ])
            )
            const panelistsMake = Object.fromEntries(
              Array.from({ length: panelistCount }, (_, i) => [`p${i}`, forms.members[`p${i}`]!])
            )
            const opts = bounded ? { concurrency } : {}
            const promptPayload = { prompt: "q" }
            const runExit = yield* Effect.exit(
              Panel.run(promptPayload, { panelists: panelistsRun, moderator: forms.effects.moderator!, ...opts })
            )
            const flow = Panel.make({ panelists: panelistsMake, moderator: forms.members.moderator!, ...opts })
            const decExit = yield* runDeclaredExit(flow, { input: promptPayload }, "panel", forms.layer)
            if (shouldFail !== -1 || modFails) {
              return !Exit.isSuccess(runExit) && !Exit.isSuccess(decExit)
            }
            if (!Exit.isSuccess(runExit) || !Exit.isSuccess(decExit)) return false
            const expectedKeys = Array.from({ length: panelistCount }, (_, i) => `p${i}`)
            const rVal = runExit.value as { readonly keys: ReadonlyArray<string> }
            const dVal = decExit.value as { readonly keys: ReadonlyArray<string> }
            return JSON.stringify(rVal.keys) === JSON.stringify(expectedKeys) &&
              JSON.stringify(dVal.keys) === JSON.stringify(expectedKeys)
          }),
        { seed: seed + 8, executions: runs(0.5), execution: FuzzSimulation.execution() }
      )
    )

    // Panel validation refusals
    await assertFuzz(
      Fuzz.run(
        Arbitrary.schema(Schema.Literals(["zero", "neg", "frac"])),
        (badTag) =>
          Effect.gen(function*() {
            const badConc = decodeBadNumber(badTag)
            const forms = scripted({ p: () => 1, m: () => 2 })
            const emptyPanelists: Record<string, (input: unknown) => Effect.Effect<unknown, unknown, never>> = {}
            const e1 = yield* Effect.exit(Panel.run("q", { panelists: emptyPanelists, moderator: forms.effects.m! }))
            const e2 = yield* Effect.exit(
              Panel.run("q", { panelists: { p: forms.effects.p! }, moderator: forms.effects.m!, concurrency: badConc })
            )
            let t1 = false
            let t2 = false
            let t3 = false
            try {
              Panel.make({ panelists: {}, moderator: forms.members.m! })
            } catch {
              t1 = true
            }
            try {
              Panel.make({ panelists: { p: forms.members.p! }, moderator: forms.members.m!, concurrency: badConc })
            } catch {
              t2 = true
            }
            try {
              Panel.make({
                panelists: { p: forms.members.p! },
                roles: { unknownSeat: "critic" },
                moderator: forms.members.m!
              })
            } catch {
              t3 = true
            }
            // Valid roles + special-character panelist name (triggers JSON-quoted label)
            const specialForms = scripted({
              s: () => "ok",
              m: ({ opinions }: { readonly opinions: unknown }) => opinions
            })
            const specialFlow = Panel.make({
              panelists: { "seat, [1]": specialForms.members.s! },
              roles: { "seat, [1]": "reviewer" },
              moderator: specialForms.members.m!
            })
            const specialExit = yield* runDeclaredExit(
              specialFlow,
              { input: { prompt: "q" } },
              "panel-roles",
              specialForms.layer
            )
            return !Exit.isSuccess(e1) && !Exit.isSuccess(e2) && t1 && t2 && t3 && Exit.isSuccess(specialExit)
          }),
        { seed: seed + 9, executions: runs(0.2) }
      )
    )
  })

  it("MapReduce.run & MapReduce.make preserve shard order and agree on all onEmpty policies", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        shards: Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: -50, maximum: 50 }))),
        concurrency: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 })),
        onEmpty: Schema.Literals(["fail", "succeed", "reduce"]),
        failShardIdx: Schema.Int.check(Schema.isBetween({ minimum: -1, maximum: 5 }))
      })
    )
    await assertFuzz(
      Fuzz.run(
        arb,
        ({ shards: raw, concurrency, onEmpty, failShardIdx }) =>
          Effect.gen(function*() {
            const shards = raw.slice(0, 5)
            const shouldFail = failShardIdx >= 0 && failShardIdx < shards.length ? failShardIdx : -1
            const script = {
              map: ({ index, shard }: { readonly index: number; readonly shard: number }) =>
                index === shouldFail ? fail({ code: "map_err", message: "map fail" }) : shard * 2 + index,
              reduce: ({ mapped }: { readonly mapped: ReadonlyArray<number> }) => ({
                sum: mapped.reduce((a, b) => a + b, 0),
                len: mapped.length
              })
            }
            const forms = scripted(script)
            const runExit = yield* Effect.exit(
              MapReduce.run({ shards }, {
                map: (args) => Effect.flatMap(Effect.yieldNow, () => forms.effects.map!(args)),
                reduce: forms.effects.reduce!,
                concurrency,
                onEmpty
              })
            )
            const flow = MapReduce.make({
              map: forms.members.map!,
              reduce: forms.members.reduce!,
              concurrency,
              onEmpty
            })
            const decExit = yield* runDeclaredExit(flow, { shards }, "mapreduce", forms.layer)
            if (shards.length === 0) {
              if (onEmpty === "fail") return !Exit.isSuccess(runExit) && !Exit.isSuccess(decExit)
              if (!Exit.isSuccess(runExit) || !Exit.isSuccess(decExit)) return false
              return JSON.stringify(runExit.value) === JSON.stringify(decExit.value)
            }
            if (shouldFail !== -1) {
              return !Exit.isSuccess(runExit) && !Exit.isSuccess(decExit)
            }
            if (!Exit.isSuccess(runExit) || !Exit.isSuccess(decExit)) return false
            return JSON.stringify(runExit.value) === JSON.stringify(decExit.value)
          }),
        { seed: seed + 10, executions: runs(0.5), execution: FuzzSimulation.execution() }
      )
    )

    // Validation refusals
    await assertFuzz(
      Fuzz.run(
        Arbitrary.schema(Schema.Literals(["zero", "neg", "frac"])),
        (badTag) =>
          Effect.gen(function*() {
            const badConc = decodeBadNumber(badTag)
            const forms = scripted({ map: () => 1, reduce: () => 2 })
            const e1 = yield* Effect.exit(
              MapReduce.run({ shards: [1] }, {
                map: forms.effects.map!,
                reduce: forms.effects.reduce!,
                concurrency: badConc,
                onEmpty: "fail"
              })
            )
            let t1 = false
            try {
              MapReduce.make({
                map: forms.members.map!,
                reduce: forms.members.reduce!,
                concurrency: badConc,
                onEmpty: "fail"
              })
            } catch {
              t1 = true
            }
            return !Exit.isSuccess(e1) && t1
          }),
        { seed: seed + 11, executions: runs(0.2) }
      )
    )
  })

  it("CheckSuite (run, make, runDiscovered, makeDiscovered) compute exact verdicts across strategies", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        outcomes: Schema.Array(Schema.Literals(["true", "false", "okTrue", "okFalse", "passedTrue", "error"])),
        strategy: Schema.Literals(["all-pass", "majority", "any-pass"]),
        continueOnFail: Schema.Boolean,
        concurrency: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 })),
        onEmpty: Schema.Literals(["pass", "fail"])
      })
    )
    await assertFuzz(
      Fuzz.run(
        arb,
        ({ outcomes: raw, strategy, continueOnFail, concurrency, onEmpty }) =>
          Effect.gen(function*() {
            const outcomes = raw.slice(0, 5)
            const interpret = (kind: string) => {
              switch (kind) {
                case "true":
                  return true
                case "false":
                  return false
                case "okTrue":
                  return { ok: true }
                case "okFalse":
                  return { ok: false }
                case "passedTrue":
                  return { passed: true }
                default:
                  return fail({ code: "chk_err", message: "boom" })
              }
            }

            // Discovered form handles 0..N ids
            const ids = outcomes.map((_, i) => `c${i}`)
            const discScript = {
              check: ({ check }: { readonly check: string }) => {
                const idx = Number(check.slice(1))
                return interpret(outcomes[idx]!)
              }
            }
            const dForms = scripted(discScript)
            const dRunExit = yield* Effect.exit(
              CheckSuite.runDiscovered(
                { checks: ids, input: "head" },
                {
                  check: (args) => Effect.flatMap(Effect.yieldNow, () => dForms.effects.check!(args)),
                  strategy,
                  concurrency,
                  continueOnFail,
                  onEmpty
                }
              )
            )
            const dFlow = CheckSuite.makeDiscovered({
              check: dForms.members.check!,
              strategy,
              concurrency,
              continueOnFail,
              onEmpty
            })
            const dDecExit = yield* runDeclaredExit(dFlow, { checks: ids, input: "head" }, "chk-disc", dForms.layer)

            const hasError = outcomes.includes("error")
            if (outcomes.length === 0) {
              if (!Exit.isSuccess(dRunExit) || !Exit.isSuccess(dDecExit)) return false
              if (dRunExit.value.verdict !== (onEmpty === "pass")) return false
              if (JSON.stringify(dRunExit.value) !== JSON.stringify(dDecExit.value)) return false
            } else if (hasError && !continueOnFail) {
              if (Exit.isSuccess(dRunExit) || Exit.isSuccess(dDecExit)) return false
            } else {
              if (!Exit.isSuccess(dRunExit) || !Exit.isSuccess(dDecExit)) return false
              if (JSON.stringify(dRunExit.value) !== JSON.stringify(dDecExit.value)) return false
              const v = dRunExit.value
              const p = v.passed.length
              const total = outcomes.length
              const expectedVerdict = strategy === "all-pass"
                ? p === total
                : strategy === "any-pass"
                ? p > 0
                : p > total / 2
              if (v.verdict !== expectedVerdict) return false
              // Also exercise CheckSuite.rows helper
              const rawRec = Object.fromEntries(
                ids.map((id, i) => [id, outcomes[i] === "error" ? false : interpret(outcomes[i]!)])
              )
              if (CheckSuite.rows(rawRec, ids).length !== total) return false
            }

            // Static record form when non-empty
            if (outcomes.length > 0) {
              const script: Record<string, () => unknown> = {}
              for (let i = 0; i < outcomes.length; i++) {
                script[`c${i}`] = () => interpret(outcomes[i]!)
              }
              const forms = scripted(script)
              const checksRun = Object.fromEntries(
                outcomes.map((_, i) => [`c${i}`, (input: unknown) => forms.effects[`c${i}`]!({ input })])
              )
              const checksMake = Object.fromEntries(outcomes.map((_, i) => [`c${i}`, forms.members[`c${i}`]!]))
              const rExit = yield* Effect.exit(
                CheckSuite.run("head", { checks: checksRun, strategy, concurrency, continueOnFail })
              )
              const flow = CheckSuite.make({ checks: checksMake, strategy, concurrency, continueOnFail })
              const mExit = yield* runDeclaredExit(flow, { input: "head" }, "chk-static", forms.layer)
              if (hasError && !continueOnFail) {
                if (Exit.isSuccess(rExit) || Exit.isSuccess(mExit)) return false
              } else {
                if (!Exit.isSuccess(rExit) || !Exit.isSuccess(mExit)) return false
                if (JSON.stringify(rExit.value) !== JSON.stringify(mExit.value)) return false
              }
            }
            return true
          }),
        { seed: seed + 12, executions: runs(0.5), execution: FuzzSimulation.execution() }
      )
    )

    // Validation refusals for CheckSuite
    await assertFuzz(
      Fuzz.run(
        Arbitrary.schema(Schema.Literals(["empty", "emptyId", "badConc", "dupDisc"])),
        (kind) =>
          Effect.gen(function*() {
            const forms = scripted({ c: () => true })
            if (kind === "empty") {
              const emptyChecks: Record<string, (input: unknown) => Effect.Effect<unknown, unknown, never>> = {}
              const e = yield* Effect.exit(
                CheckSuite.run("x", { checks: emptyChecks, strategy: "all-pass", concurrency: 1, continueOnFail: true })
              )
              let threw = false
              try {
                CheckSuite.make({ checks: {}, strategy: "all-pass", concurrency: 1, continueOnFail: true })
              } catch {
                threw = true
              }
              return !Exit.isSuccess(e) && threw
            }
            if (kind === "emptyId") {
              const e = yield* Effect.exit(
                CheckSuite.run("x", {
                  checks: { "": forms.effects.c! },
                  strategy: "all-pass",
                  concurrency: 1,
                  continueOnFail: true
                })
              )
              let threw = false
              try {
                CheckSuite.make({
                  checks: { "": forms.members.c! },
                  strategy: "all-pass",
                  concurrency: 1,
                  continueOnFail: true
                })
              } catch {
                threw = true
              }
              return !Exit.isSuccess(e) && threw
            }
            if (kind === "badConc") {
              const e = yield* Effect.exit(
                CheckSuite.runDiscovered(
                  { checks: ["a"], input: "x" },
                  {
                    check: forms.effects.c!,
                    strategy: "all-pass",
                    concurrency: 0,
                    continueOnFail: true,
                    onEmpty: "pass"
                  }
                )
              )
              let threw = false
              try {
                CheckSuite.makeDiscovered({
                  check: forms.members.c!,
                  strategy: "all-pass",
                  concurrency: 0,
                  continueOnFail: true,
                  onEmpty: "pass"
                })
              } catch {
                threw = true
              }
              return !Exit.isSuccess(e) && threw
            }
            // dupDisc
            const e = yield* Effect.exit(
              CheckSuite.runDiscovered(
                { checks: ["a", "a"], input: "x" },
                { check: forms.effects.c!, strategy: "all-pass", concurrency: 1, continueOnFail: true, onEmpty: "pass" }
              )
            )
            const df = CheckSuite.makeDiscovered({
              check: forms.members.c!,
              strategy: "all-pass",
              concurrency: 1,
              continueOnFail: true,
              onEmpty: "pass"
            })
            const de = yield* runDeclaredExit(df, { checks: ["a", "a"], input: "x" }, "chk-dup", forms.layer)
            return !Exit.isSuccess(e) && !Exit.isSuccess(de)
          }),
        { seed: seed + 13, executions: runs(0.25) }
      )
    )
  })

  it("ReviewLoop.run & ReviewLoop.make agree on approval, exhaustion, and stall stop/escalate", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        maxRounds: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4 })),
        approveAt: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 6 })),
        stalling: Schema.Boolean,
        stallMode: Schema.Literals(["none", "stop", "escalate"]),
        verdictForm: Schema.Literals(["bool", "string", "approvedObj", "acceptedObj"])
      })
    )
    await assertFuzz(
      Fuzz.run(
        arb,
        ({ maxRounds, approveAt, stalling, stallMode, verdictForm }) =>
          Effect.gen(function*() {
            const okVerdict = verdictForm === "bool"
              ? true
              : verdictForm === "string"
              ? "approved"
              : verdictForm === "approvedObj"
              ? { approved: true }
              : { accepted: true }

            const script = {
              produce: () => "draft-1",
              review: ({ output }: { readonly output: string }) => {
                const roundNum = Number(output.split("-")[1])
                return roundNum >= approveAt ? okVerdict : { approved: false, seen: output }
              },
              revise: ({ output, round }: { readonly output: string; readonly round: number }) =>
                stalling ? output : `draft-${round + 1}`
            }
            const forms = scripted(script)
            const stallOpt = stallMode === "none" ? {} : { stall: { rounds: 2, on: stallMode } }
            const runExit = yield* Effect.exit(
              ReviewLoop.run("brief", {
                produce: (value) => forms.effects.produce!({ input: value }),
                review: (output) => forms.effects.review!({ output }),
                revise: forms.effects.revise!,
                maxRounds,
                ...stallOpt
              })
            )
            const flow = ReviewLoop.make({
              produce: forms.members.produce!,
              review: forms.members.review!,
              revise: forms.members.revise!,
              maxRounds,
              ...stallOpt
            })
            const decExit = yield* runDeclaredExit(flow, { input: "brief" }, "reviewloop", forms.layer)

            if (Exit.isSuccess(runExit) !== Exit.isSuccess(decExit)) return false
            if (Exit.isSuccess(runExit) && Exit.isSuccess(decExit)) {
              return JSON.stringify(runExit.value) === JSON.stringify(decExit.value)
            }
            return errorCodeOf(runExit) === "stalled" && errorCodeOf(decExit) === "stalled"
          }),
        { seed: seed + 14, executions: runs(0.5) }
      )
    )

    // Validation refusals (bad maxRounds, bad stall rounds)
    await assertFuzz(
      Fuzz.run(
        Arbitrary.schema(Schema.Literals(["badRounds", "badStall"])),
        (kind) =>
          Effect.gen(function*() {
            const forms = scripted({ p: () => "a", r: () => true, v: () => "b" })
            const badOpts = kind === "badRounds"
              ? { maxRounds: 0 }
              : { maxRounds: 2, stall: { rounds: 1, on: "stop" as const } }
            const e = yield* Effect.exit(
              ReviewLoop.run("x", {
                produce: forms.effects.p!,
                review: forms.effects.r!,
                revise: forms.effects.v!,
                ...badOpts
              })
            )
            let threw = false
            try {
              ReviewLoop.make({
                produce: forms.members.p!,
                review: forms.members.r!,
                revise: forms.members.v!,
                ...badOpts
              })
            } catch {
              threw = true
            }
            return !Exit.isSuccess(e) && threw
          }),
        { seed: seed + 15, executions: runs(0.2) }
      )
    )
  })

  it("Escalation.run & Escalation.make agree across rung counts, accept, escalateIf, and fallback", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        rungCount: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4 })),
        settleAt: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 5 })),
        hasAccept: Schema.Boolean,
        hasEscalateIf: Schema.Boolean,
        hasFallback: Schema.Boolean,
        failRung: Schema.Int.check(Schema.isBetween({ minimum: -1, maximum: 4 }))
      })
    )
    await assertFuzz(
      Fuzz.run(
        arb,
        ({ rungCount, settleAt, hasAccept, hasEscalateIf, hasFallback, failRung }) =>
          Effect.gen(function*() {
            const script: Record<string, (p: any) => unknown> = {
              accept: ({ result }: { readonly result: { readonly ok: boolean } }) => result.ok,
              escalateIf: ({ result }: { readonly result: { readonly ok: boolean } }) => !result.ok,
              fallback: () => ({ ok: true, by: "fallback" })
            }
            for (let i = 0; i < rungCount; i++) {
              script[`r${i}`] = () =>
                i === failRung
                  ? fail({ code: "rung_err", message: `r${i}` })
                  : { ok: i === settleAt, approved: i === settleAt, by: `r${i}` }
            }
            const forms = scripted(script)
            const runExit = yield* Effect.exit(
              Escalation.run("ticket", {
                rungs: Array.from({ length: rungCount }, (_, i) =>
                  hasEscalateIf && i === 0
                    ? {
                      run: (input: unknown) => forms.effects[`r${i}`]!({ input }),
                      escalateIf: (result: unknown, level: number) => forms.effects.escalateIf!({ result, level })
                    }
                    : (input: unknown) => forms.effects[`r${i}`]!({ input })),
                ...(hasAccept ? { accept: (result: unknown) => forms.effects.accept!({ result }) } : {}),
                ...(hasFallback ? { fallback: (input: unknown) => forms.effects.fallback!({ input }) } : {})
              })
            )
            const flow = Escalation.make({
              rungs: Array.from({ length: rungCount }, (_, i) =>
                hasEscalateIf && i === 0
                  ? { flow: forms.members[`r${i}`]!, escalateIf: forms.members.escalateIf! }
                  : forms.members[`r${i}`]!),
              ...(hasAccept ? { accept: forms.members.accept! } : {}),
              ...(hasFallback ? { fallback: forms.members.fallback! } : {})
            })
            const decExit = yield* runDeclaredExit(flow, { input: "ticket" }, "escalation", forms.layer)
            if (Exit.isSuccess(runExit) !== Exit.isSuccess(decExit)) return false
            if (Exit.isSuccess(runExit) && Exit.isSuccess(decExit)) {
              return JSON.stringify(runExit.value) === JSON.stringify(decExit.value)
            }
            return true
          }),
        { seed: seed + 16, executions: runs(0.5) }
      )
    )

    // Empty rungs refusal & defaultEscalate predicate fuzzing
    await assertFuzz(
      Fuzz.run(
        Arbitrary.schema(Schema.Literals(["null", "undef", "prim", "error", "failed", "okFalse", "okTrue"])),
        (kind) =>
          Effect.gen(function*() {
            const emptyRungs: ReadonlyArray<(input: string) => Effect.Effect<unknown, never, never>> = []
            const e = yield* Effect.exit(Escalation.run("x", { rungs: emptyRungs }))
            let threw = false
            try {
              Escalation.make({ rungs: [] })
            } catch {
              threw = true
            }
            const sample = kind === "null"
              ? null
              : kind === "undef"
              ? undefined
              : kind === "prim"
              ? "settled"
              : kind === "error"
              ? { error: "bad" }
              : kind === "failed"
              ? { failed: true }
              : kind === "okFalse"
              ? { ok: false }
              : { ok: true }
            const expectedEscalate = kind !== "prim" && kind !== "okTrue"
            return !Exit.isSuccess(e) && threw && Escalation.defaultEscalate(sample) === expectedEscalate
          }),
        { seed: seed + 17, executions: runs(0.3) }
      )
    )
  })

  it("Intervene.run & Intervene.make enforce dryRun skip and approval gating", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        dryRun: Schema.Boolean,
        gated: Schema.Boolean,
        approvalAnswer: Schema.Literals(["approved", "denied", "fail"]),
        failStage: Schema.Literals(["none", "read", "propose", "apply", "report"])
      })
    )
    await assertFuzz(
      Fuzz.run(
        arb,
        ({ dryRun, gated, approvalAnswer, failStage }) =>
          Effect.gen(function*() {
            let applyCountRun = 0
            let applyCountDec = 0
            const script = {
              read: () => (failStage === "read" ? fail({ code: "r_err", message: "r" }) : { files: 3 }),
              propose: ({ context }: { readonly context: unknown }) =>
                failStage === "propose" ? fail({ code: "p_err", message: "p" }) : { change: context },
              apply: ({ proposal }: { readonly proposal: unknown }) => {
                applyCountRun++
                return failStage === "apply" ? fail({ code: "a_err", message: "a" }) : { applied: proposal }
              },
              report: ({ applied, dryRun: dr }: { readonly applied?: unknown; readonly dryRun: boolean }) =>
                failStage === "report"
                  ? fail({ code: "rep_err", message: "rep" })
                  : { applied: applied ?? null, dryRun: dr },
              approval: () => approvalAnswer === "fail" ? fail({ code: "app_err", message: "app" }) : approvalAnswer
            }
            const forms = scripted(script)
            const runExit = yield* Effect.exit(
              Intervene.run("repo", {
                read: forms.effects.read!,
                propose: forms.effects.propose!,
                apply: forms.effects.apply!,
                report: forms.effects.report!,
                dryRun,
                ...(gated
                  ? {
                    approval: ({ input, proposal }) =>
                      forms.effects.approval!({
                        input: { phase: "apply", input, proposal },
                        reason: "Apply proposed change",
                        scope: "run"
                      })
                  }
                  : {})
              })
            )
            const decForms = scripted({
              ...script,
              apply: ({ proposal }: { readonly proposal: unknown }) => {
                applyCountDec++
                return failStage === "apply" ? fail({ code: "a_err", message: "a" }) : { applied: proposal }
              }
            })
            const flow = Intervene.make({
              read: decForms.members.read!,
              propose: decForms.members.propose!,
              apply: parityFlow("apply"),
              report: decForms.members.report!,
              dryRun,
              ...(gated ? { approval: approval("approval"), reason: "Apply proposed change" } : {})
            })
            const decExit = yield* runDeclaredExit(flow, { input: "repo" }, "intervene", decForms.layer)

            if (dryRun || (gated && approvalAnswer !== "approved") || failStage === "read" || failStage === "propose") {
              if (applyCountRun !== 0 || applyCountDec !== 0) return false
            }
            if (Exit.isSuccess(runExit) !== Exit.isSuccess(decExit)) return false
            if (Exit.isSuccess(runExit) && Exit.isSuccess(decExit)) {
              return JSON.stringify(runExit.value) === JSON.stringify(decExit.value)
            }
            return true
          }),
        { seed: seed + 18, executions: runs(0.5) }
      )
    )
  })

  it("DriftDetector.run & DriftDetector.make alert iff drifted", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        comparisonKind: Schema.Literals(["true", "false", "driftedObj", "cleanObj", "number"]),
        hasAlert: Schema.Boolean,
        useAlertIf: Schema.Boolean,
        alertFails: Schema.Boolean
      })
    )
    await assertFuzz(
      Fuzz.run(
        arb,
        ({ comparisonKind, hasAlert, useAlertIf, alertFails }) =>
          Effect.gen(function*() {
            const cmp = comparisonKind === "true"
              ? true
              : comparisonKind === "false"
              ? false
              : comparisonKind === "driftedObj"
              ? { drifted: true, delta: 5 }
              : comparisonKind === "cleanObj"
              ? { drifted: false, delta: 0 }
              : 42
            const script = {
              capture: ({ input }: { readonly input: string }) => ({ snap: input }),
              compare: () => cmp,
              alert: ({ comparison }: { readonly comparison: unknown }) =>
                alertFails ? fail({ code: "alert_err", message: "pager down" }) : { paged: comparison }
            }
            const forms = scripted(script)
            const runExit = yield* Effect.exit(
              DriftDetector.run("cfg", {
                baseline: { v: 1 },
                capture: forms.effects.capture!,
                compare: forms.effects.compare!,
                ...(hasAlert ? { alert: forms.effects.alert! } : {}),
                ...(useAlertIf ? { alertIf: (c) => c === 42 || DriftDetector.drifted(c) } : {})
              })
            )
            const expectedDriftedRun = useAlertIf
              ? cmp === 42 || DriftDetector.drifted(cmp)
              : DriftDetector.drifted(cmp)
            if (expectedDriftedRun && hasAlert && alertFails) {
              if (Exit.isSuccess(runExit)) return false
            } else {
              if (!Exit.isSuccess(runExit)) return false
              if (runExit.value.drifted !== expectedDriftedRun) return false
              if ((runExit.value.alert !== undefined) !== (expectedDriftedRun && hasAlert)) return false
            }

            if (!useAlertIf) {
              const flow = DriftDetector.make({
                baseline: { v: 1 },
                capture: forms.members.capture!,
                compare: forms.members.compare!,
                ...(hasAlert ? { alert: forms.members.alert! } : {})
              })
              const decExit = yield* runDeclaredExit(flow, { input: "cfg" }, "drift", forms.layer)
              if (Exit.isSuccess(runExit) !== Exit.isSuccess(decExit)) return false
              if (Exit.isSuccess(runExit) && Exit.isSuccess(decExit)) {
                return JSON.stringify(runExit.value) === JSON.stringify(decExit.value)
              }
            }
            return true
          }),
        { seed: seed + 19, executions: runs(0.5) }
      )
    )
  })

  it("Sidecar.run & Sidecar.make quarantine shadow faults and validate score deltas", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        primaryFails: Schema.Boolean,
        shadowOutcome: Schema.Literals(["ok", "fail", "defect"]),
        hasScore: Schema.Boolean,
        scoreKind: Schema.Literals(["finite", "nan", "overflow", "fail"]),
        primaryScore: Schema.Int.check(Schema.isBetween({ minimum: -100, maximum: 100 })),
        shadowScore: Schema.Int.check(Schema.isBetween({ minimum: -100, maximum: 100 }))
      })
    )
    await assertFuzz(
      Fuzz.run(
        arb,
        ({ primaryFails, shadowOutcome, hasScore, scoreKind, primaryScore, shadowScore }) =>
          Effect.gen(function*() {
            const scoreVal = scoreKind === "finite"
              ? { primary: primaryScore, shadow: shadowScore }
              : scoreKind === "nan"
              ? { primary: Number.NaN, shadow: 1 }
              : scoreKind === "overflow"
              ? { primary: 1e308, shadow: -1e308 }
              : fail({ code: "score_err", message: "score failed" })

            const script = {
              primary: ({ prompt }: { readonly prompt: string }) =>
                primaryFails ? fail({ code: "p_err", message: "p" }) : `primary:${prompt}`,
              shadow: ({ prompt }: { readonly prompt: string }) =>
                shadowOutcome === "fail" ? fail({ code: "s_err", message: "s" }) : `shadow:${prompt}`,
              score: () => scoreVal
            }
            const forms = scripted(script)
            const promptPayload = { prompt: "x" }
            const runExit = yield* Effect.exit(
              Sidecar.run(promptPayload, {
                primary: (input) => Effect.flatMap(Effect.yieldNow, () => forms.effects.primary!(input)),
                shadow: (input) =>
                  shadowOutcome === "defect"
                    ? Effect.die("shadow-crash")
                    : Effect.flatMap(Effect.yieldNow, () => forms.effects.shadow!(input)),
                ...(hasScore ? { score: forms.effects.score! } : {})
              })
            )

            if (primaryFails) {
              if (Exit.isSuccess(runExit)) return false
            } else if (shadowOutcome !== "ok") {
              if (!Exit.isSuccess(runExit)) return false
              if (runExit.value.primary !== "primary:x" || !runExit.value.shadow.quarantined) return false
            } else if (hasScore && scoreKind !== "finite") {
              if (Exit.isSuccess(runExit)) return false
            } else {
              if (!Exit.isSuccess(runExit)) return false
              if (hasScore) {
                const expectedDelta = Sidecar.delta(primaryScore, shadowScore)
                if (JSON.stringify(runExit.value.delta) !== JSON.stringify(expectedDelta)) return false
              }
            }

            if (shadowOutcome !== "defect") {
              const flow = Sidecar.make({
                primary: forms.members.primary!,
                shadow: forms.members.shadow!,
                ...(hasScore ? { score: forms.members.score! } : {})
              })
              const decExit = yield* runDeclaredExit(flow, { input: promptPayload }, "sidecar", forms.layer)
              if (Exit.isSuccess(runExit) !== Exit.isSuccess(decExit)) return false
              if (Exit.isSuccess(decExit) && hasScore && shadowOutcome === "ok" && scoreKind === "finite") {
                const dVal = decExit.value as { readonly delta?: unknown }
                if (JSON.stringify(dVal.delta) !== JSON.stringify(Sidecar.delta(primaryScore, shadowScore))) {
                  return false
                }
              }
            }
            return true
          }),
        { seed: seed + 20, executions: runs(0.5), execution: FuzzSimulation.execution() }
      )
    )

    // Sidecar.delta error cases & Sidecar.run interruption propagation
    await assertFuzz(
      Fuzz.run(
        Arbitrary.schema(Schema.Literals(["badPrimary", "badShadow", "overflow", "interrupt"])),
        (kind) =>
          Effect.gen(function*() {
            if (kind === "interrupt") {
              const started = yield* Deferred.make<void>()
              const fiber = yield* Effect.forkChild(
                Sidecar.run("x", {
                  primary: () => Effect.never,
                  shadow: () => Effect.andThen(Deferred.succeed(started, undefined), Effect.never)
                })
              )
              yield* Deferred.await(started)
              yield* Fiber.interrupt(fiber)
              const exit = yield* Fiber.await(fiber)
              return Exit.hasInterrupts(exit)
            }
            let threw = false
            try {
              if (kind === "badPrimary") Sidecar.delta(Number.NaN, 1)
              else if (kind === "badShadow") Sidecar.delta(1, Number.POSITIVE_INFINITY)
              else Sidecar.delta(1e308, -1e308)
            } catch (e) {
              threw = e instanceof PatternError.PatternError && e.code === "invalid_input"
            }
            // Also test non-finite shadow score in Sidecar.make
            const forms = scripted({
              primary: () => "p",
              shadow: () => "s",
              score: () =>
                kind === "badPrimary"
                  ? { primary: "bad", shadow: 1 }
                  : kind === "badShadow"
                  ? { primary: 1, shadow: "bad" }
                  : { primary: 1e308, shadow: -1e308 }
            })
            const flow = Sidecar.make({
              primary: forms.members.primary!,
              shadow: forms.members.shadow!,
              score: forms.members.score!
            })
            const decExit = yield* runDeclaredExit(flow, { input: { prompt: "x" } }, "sidecar-bad-score", forms.layer)
            return threw && errorCodeOf(decExit) === "invalid_input"
          }),
        { seed: seed + 120, executions: runs(0.25) }
      )
    )
  })

  it("MergeQueue.run & MergeQueue.make sort by descending priority and honor halt vs quarantine", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        priorities: Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: -10, maximum: 10 }))),
        concurrency: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 })),
        failurePolicy: Schema.Literals(["halt", "quarantine"]),
        failIdx: Schema.Int.check(Schema.isBetween({ minimum: -1, maximum: 5 }))
      })
    )
    await assertFuzz(
      Fuzz.run(
        arb,
        ({ priorities: raw, concurrency, failurePolicy, failIdx }) =>
          Effect.gen(function*() {
            const priorities = raw.length === 0 ? [0] : raw.slice(0, 4)
            const shouldFail = failIdx >= 0 && failIdx < priorities.length ? failIdx : -1
            const script: Record<string, (p: any) => unknown> = {}
            for (let i = 0; i < priorities.length; i++) {
              script[`m${i}`] = ({ position }: { readonly position: number }) =>
                i === shouldFail ? fail({ code: "conflict", message: `m${i}` }) : { id: `m${i}`, position }
            }
            const forms = scripted(script)
            const invalidHaltWidth = failurePolicy === "halt" && concurrency > 1

            const runExit = yield* Effect.exit(
              MergeQueue.run("main", {
                members: priorities.map((priority, i) => ({
                  id: `m${i}`,
                  priority,
                  run: (args) => Effect.flatMap(Effect.yieldNow, () => forms.effects[`m${i}`]!(args))
                })),
                concurrency,
                failurePolicy
              })
            )

            if (invalidHaltWidth) {
              let makeThrew = false
              try {
                MergeQueue.make({
                  members: priorities.map((priority, i) => ({ id: `m${i}`, priority, flow: forms.members[`m${i}`]! })),
                  concurrency,
                  failurePolicy
                })
              } catch (e) {
                makeThrew = e instanceof PatternError.PatternError
              }
              return !Exit.isSuccess(runExit) && makeThrew
            }

            const flow = MergeQueue.make({
              members: priorities.map((priority, i) => ({ id: `m${i}`, priority, flow: forms.members[`m${i}`]! })),
              concurrency,
              failurePolicy
            })
            const decExit = yield* runDeclaredExit(flow, { input: "main" }, "mergequeue", forms.layer)

            if (failurePolicy === "halt" && shouldFail !== -1) {
              return !Exit.isSuccess(runExit) && !Exit.isSuccess(decExit)
            }
            if (!Exit.isSuccess(runExit) || !Exit.isSuccess(decExit)) return false
            if (JSON.stringify(runExit.value) !== JSON.stringify(decExit.value)) return false

            const expectedOrder = MergeQueue.ordered(
              priorities.map((priority, i) => ({ id: `m${i}`, priority })),
              MergeQueue.DefaultPriority
            ).map((e) => e.id)
            return JSON.stringify(runExit.value.order) === JSON.stringify(expectedOrder)
          }),
        { seed: seed + 21, executions: runs(0.5), execution: FuzzSimulation.execution() }
      )
    )

    // Validation refusals for MergeQueue
    await assertFuzz(
      Fuzz.run(
        Arbitrary.schema(Schema.Literals(["empty", "dup", "badPriority", "badConc"])),
        (kind) =>
          Effect.gen(function*() {
            const forms = scripted({ a: () => 1 })
            const membersMake = kind === "empty"
              ? []
              : kind === "dup"
              ? [{ id: "a", flow: forms.members.a! }, { id: "a", flow: forms.members.a! }]
              : kind === "badPriority"
              ? [{ id: "a", priority: 1.5, flow: forms.members.a! }]
              : [{ id: "a", flow: forms.members.a! }]
            const membersRun = kind === "empty"
              ? []
              : kind === "dup"
              ? [{ id: "a", run: forms.effects.a! }, { id: "a", run: forms.effects.a! }]
              : kind === "badPriority"
              ? [{ id: "a", priority: 1.5, run: forms.effects.a! }]
              : [{ id: "a", run: forms.effects.a! }]
            const conc = kind === "badConc" ? 0 : 1
            const e = yield* Effect.exit(
              MergeQueue.run("main", { members: membersRun, concurrency: conc, failurePolicy: "quarantine" })
            )
            let threw = false
            try {
              MergeQueue.make({ members: membersMake, concurrency: conc, failurePolicy: "quarantine" })
            } catch {
              threw = true
            }
            return !Exit.isSuccess(e) && threw
          }),
        { seed: seed + 22, executions: runs(0.25) }
      )
    )
  })

  it("Kanban.run & Kanban.make advance items through columns, isolate rejections, and support until/maxIterations", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        colCount: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 })),
        itemCount: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4 })),
        concurrency: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 })),
        failItemIdx: Schema.Int.check(Schema.isBetween({ minimum: -1, maximum: 4 })),
        failColIdx: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 })),
        hasOnComplete: Schema.Boolean,
        maxIterations: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 }))
      })
    )
    await assertFuzz(
      Fuzz.run(
        arb,
        ({ colCount, itemCount, concurrency, failItemIdx, failColIdx, hasOnComplete, maxIterations }) =>
          Effect.gen(function*() {
            const items = Array.from({ length: itemCount }, (_, i) => ({ id: `i${i}` }))
            const failCol = failColIdx % colCount
            const script: Record<string, (p: any) => unknown> = {
              done: ({ board }: { readonly board: unknown }) => ({ finished: board })
            }
            for (let c = 0; c < colCount; c++) {
              script[`col${c}`] = (
                { item, previous }: { readonly item: { readonly id: string }; readonly previous?: unknown }
              ) =>
                item.id === `i${failItemIdx}` && c === failCol
                  ? fail({ code: "col_fail", message: `${item.id}@col${c}` })
                  : { col: c, prev: previous ?? null }
            }
            const forms = scripted(script)
            const runExit = yield* Effect.exit(
              Kanban.run(items, {
                columns: Array.from({ length: colCount }, (_, c) => ({
                  name: `col${c}`,
                  run: (args) => Effect.flatMap(Effect.yieldNow, () => forms.effects[`col${c}`]!(args))
                })),
                concurrency,
                ...(hasOnComplete ? { onComplete: forms.effects.done! } : {})
              })
            )
            const flow = Kanban.make({
              columns: Array.from(
                { length: colCount },
                (_, c) => ({ name: `col${c}`, flow: forms.members[`col${c}`]! })
              ),
              items,
              concurrency,
              ...(hasOnComplete ? { onComplete: forms.members.done! } : {})
            })
            const decExit = yield* runDeclaredExit(flow, { input: "board" }, "kanban", forms.layer)
            if (!Exit.isSuccess(runExit) || !Exit.isSuccess(decExit)) return false
            if (JSON.stringify(runExit.value) !== JSON.stringify(decExit.value)) return false

            const multi = yield* Kanban.run(items, {
              columns: [{ name: "col0", run: forms.effects.col0! }],
              concurrency,
              maxIterations,
              until: (b) => b.iterations >= Math.min(2, maxIterations)
            })
            if (multi.iterations !== Math.min(2, maxIterations)) return false
            return true
          }),
        { seed: seed + 23, executions: runs(0.5), execution: FuzzSimulation.execution() }
      )
    )

    // Kanban validation refusals
    await assertFuzz(
      Fuzz.run(
        Arbitrary.schema(
          Schema.Literals(["noCols", "noItems", "dupItems", "dupCols", "badConc", "untilNoMax", "badMax"])
        ),
        (kind) =>
          Effect.gen(function*() {
            const forms = scripted({ c: () => 1 })
            const col = { name: "c", run: forms.effects.c! }
            const colM = { name: "c", flow: forms.members.c! }
            const e = yield* Effect.exit(
              kind === "noCols"
                ? Kanban.run([{ id: "a" }], { columns: [], concurrency: 1 })
                : kind === "noItems"
                ? Kanban.run([], { columns: [col], concurrency: 1 })
                : kind === "dupItems"
                ? Kanban.run([{ id: "a" }, { id: "a" }], { columns: [col], concurrency: 1 })
                : kind === "dupCols"
                ? Kanban.run([{ id: "a" }], { columns: [col, col], concurrency: 1 })
                : kind === "badConc"
                ? Kanban.run([{ id: "a" }], { columns: [col], concurrency: 0 })
                : kind === "untilNoMax"
                ? Kanban.run([{ id: "a" }], { columns: [col], concurrency: 1, until: () => true })
                : Kanban.run([{ id: "a" }], { columns: [col], concurrency: 1, maxIterations: 0 })
            )
            if (kind === "untilNoMax" || kind === "badMax") return !Exit.isSuccess(e)
            let threw = false
            try {
              if (kind === "noCols") Kanban.make({ columns: [], items: [{ id: "a" }], concurrency: 1 })
              else if (kind === "noItems") Kanban.make({ columns: [colM], items: [], concurrency: 1 })
              else if (kind === "dupItems") {
                Kanban.make({ columns: [colM], items: [{ id: "a" }, { id: "a" }], concurrency: 1 })
              } else if (kind === "dupCols") {
                Kanban.make({ columns: [colM, colM], items: [{ id: "a" }], concurrency: 1 })
              } else Kanban.make({ columns: [colM], items: [{ id: "a" }], concurrency: 0 })
            } catch {
              threw = true
            }
            return !Exit.isSuccess(e) && threw
          }),
        { seed: seed + 24, executions: runs(0.25) }
      )
    )
  })

  it("Runbook.run & Runbook.make enforce risk gating, elevated flags, and onDeny skip vs fail", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        risks: Schema.Array(Schema.Literals(["safe", "risky", "critical"])),
        denyMask: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 15 })),
        onDeny: Schema.Literals(["fail", "skip"]),
        failIdx: Schema.Int.check(Schema.isBetween({ minimum: -1, maximum: 4 }))
      })
    )
    await assertFuzz(
      Fuzz.run(
        arb,
        ({ risks: raw, denyMask, onDeny, failIdx }) =>
          Effect.gen(function*() {
            const risks = raw.length === 0 ? (["safe"] as const) : raw.slice(0, 4)
            const script: Record<string, (p: any) => unknown> = {
              approve: ({ input }: { readonly input: { readonly step: string } }) => {
                const idx = Number(input.step.slice(1))
                return ((denyMask >> idx) & 1) === 1 ? "denied" : "approved"
              }
            }
            for (let i = 0; i < risks.length; i++) {
              script[`s${i}`] = (
                { elevated, previous, step }: {
                  readonly elevated: boolean
                  readonly previous?: unknown
                  readonly step: string
                }
              ) =>
                i === failIdx
                  ? fail({ code: "step_err", message: `${step} failed` })
                  : { step, elevated, prev: previous ?? null }
            }
            const forms = scripted(script)
            const runExit = yield* Effect.exit(
              Runbook.run("deploy", {
                steps: risks.map((risk, i) => ({ id: `s${i}`, risk, run: forms.effects[`s${i}`]! })),
                approve: (request) =>
                  forms.effects.approve!({
                    input: request,
                    reason: `run the step: ${request.step}`,
                    scope: "run"
                  }),
                onDeny
              })
            )

            if (onDeny === "skip") {
              // Runbook.make explicitly refuses onDeny: "skip"
              let makeRefused = false
              try {
                Runbook.make({
                  steps: risks.map((risk, i) => ({ id: `s${i}`, risk, flow: parityFlow(`s${i}`) })),
                  approval: approval("approve"),
                  onDeny: "skip"
                })
              } catch (e) {
                makeRefused = e instanceof PatternError.PatternError && e.code === "invalid_decorator"
              }
              if (!makeRefused) return false
              if (Exit.isSuccess(runExit)) {
                const total = runExit.value.ran.length + runExit.value.skipped.length
                if (total !== risks.length) return false
                for (let i = 0; i < risks.length; i++) {
                  if (!Runbook.gated(risks[i]!) && runExit.value.skipped.includes(`s${i}`)) return false
                  if (Runbook.elevated(risks[i]!) !== (risks[i] === "critical")) return false
                }
              }
              return true
            }

            const flow = Runbook.make({
              steps: risks.map((risk, i) => ({ id: `s${i}`, risk, flow: parityFlow(`s${i}`) })),
              approval: approval("approve"),
              onDeny: "fail"
            })
            const decExit = yield* runDeclaredExit(flow, { input: "deploy" }, "runbook", forms.layer)

            if (Exit.isSuccess(runExit) !== Exit.isSuccess(decExit)) return false
            if (Exit.isSuccess(runExit) && Exit.isSuccess(decExit)) {
              if (JSON.stringify(runExit.value) !== JSON.stringify(decExit.value)) return false
              const total = runExit.value.ran.length + runExit.value.skipped.length
              if (total !== risks.length) return false
            }
            return true
          }),
        { seed: seed + 25, executions: runs(0.5) }
      )
    )

    // Validation refusals
    await assertFuzz(
      Fuzz.run(
        Arbitrary.schema(Schema.Literals(["empty", "dup"])),
        (kind) =>
          Effect.gen(function*() {
            const forms = scripted({ s: () => 1, a: () => "approved" })
            const stepsRun = kind === "empty"
              ? []
              : [{ id: "s", risk: "safe" as const, run: forms.effects.s! }, {
                id: "s",
                risk: "safe" as const,
                run: forms.effects.s!
              }]
            const stepsMake = kind === "empty"
              ? []
              : [{ id: "s", risk: "safe" as const, flow: parityFlow("s") }, {
                id: "s",
                risk: "safe" as const,
                flow: parityFlow("s")
              }]
            const e = yield* Effect.exit(
              Runbook.run("x", { steps: stepsRun, approve: () => Effect.succeed("approved"), onDeny: "fail" })
            )
            let threw = false
            try {
              Runbook.make({ steps: stepsMake, approval: approval("a"), onDeny: "fail" })
            } catch {
              threw = true
            }
            return !Exit.isSuccess(e) && threw
          }),
        { seed: seed + 26, executions: runs(0.2) }
      )
    )
  })

  it("Supervisor.run & Supervisor.make agree on delegation, retries, exhaustion, and stall policies", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        maxRounds: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 })),
        concurrency: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 })),
        scenario: Schema.Literals(["done1", "retryA", "exhaust", "noRetriable", "stallStop", "stallEscalate"]),
        workerFailOnRound1: Schema.Boolean
      })
    )
    await assertFuzz(
      Fuzz.run(
        arb,
        ({ maxRounds, concurrency, scenario, workerFailOnRound1 }) =>
          Effect.gen(function*() {
            const tasks = [
              { id: "a", workerType: "coder" },
              { id: "b", workerType: "tester" }
            ]
            const stallOpt = scenario === "stallStop"
              ? { stall: { rounds: 2, on: "stop" as const } }
              : scenario === "stallEscalate"
              ? { stall: { rounds: 2, on: "escalate" as const } }
              : {}
            const isStalling = scenario === "stallStop" || scenario === "stallEscalate"

            const script = {
              plan: ({ input }: { readonly input: { readonly tasks: unknown } }) => ({ tasks: input.tasks }),
              coder: ({ round, task }: { readonly round: number; readonly task: { readonly id: string } }) =>
                workerFailOnRound1 && round === 1 && !isStalling
                  ? fail({ code: "w_err", message: "coder fail" })
                  : isStalling
                  ? "same"
                  : `${task.id}-${round}`,
              tester: ({ round, task }: { readonly round: number; readonly task: { readonly id: string } }) =>
                isStalling ? "same" : `${task.id}-${round}`,
              review: ({ round }: { readonly round: number }) => {
                if (scenario === "done1") return { allDone: true }
                if (scenario === "retryA") return round === 1 ? { allDone: false, retriable: ["a"] } : { allDone: true }
                if (scenario === "noRetriable") return { allDone: false, retriable: ["missing"] }
                return { allDone: false, retriable: ["a"] }
              },
              finalize: ({ rounds, results }: { readonly rounds: number; readonly results: unknown }) => ({
                rounds,
                results
              })
            }
            const forms = scripted(script)
            const input = { goal: "ship", tasks }
            const opts = { maxRounds: isStalling ? 3 : maxRounds, maxTasks: 8, concurrency, ...stallOpt }

            const runExit = yield* Effect.exit(
              Supervisor.run(input, {
                plan: (value) => forms.effects.plan!({ input: value }),
                worker: (args) =>
                  Effect.flatMap(
                    Effect.yieldNow,
                    () => (args.task.workerType === "coder" ? forms.effects.coder! : forms.effects.tester!)(args)
                  ),
                review: forms.effects.review!,
                finalize: forms.effects.finalize!,
                ...opts
              })
            )
            const flow = Supervisor.make({
              plan: forms.members.plan!,
              workers: { coder: forms.members.coder!, tester: forms.members.tester! },
              review: forms.members.review!,
              finalize: forms.members.finalize!,
              ...opts
            })
            const decExit = yield* runDeclaredExit(flow, { input }, "supervisor", forms.layer)

            if (Exit.isSuccess(runExit) !== Exit.isSuccess(decExit)) return false
            if (Exit.isSuccess(runExit) && Exit.isSuccess(decExit)) {
              return JSON.stringify(runExit.value) === JSON.stringify(decExit.value)
            }
            return true
          }),
        { seed: seed + 27, executions: runs(0.5), execution: FuzzSimulation.execution() }
      )
    )

    // Supervisor validation refusals
    await assertFuzz(
      Fuzz.run(
        Arbitrary.schema(Schema.Literals(["badBounds", "badStall", "emptyTasks", "dupTasks", "tooMany", "badWorker"])),
        (kind) =>
          Effect.gen(function*() {
            const forms = scripted({
              plan: () =>
                kind === "emptyTasks"
                  ? { tasks: [] }
                  : kind === "dupTasks"
                  ? { tasks: [{ id: "a", workerType: "coder" }, { id: "a", workerType: "coder" }] }
                  : kind === "tooMany"
                  ? { tasks: [{ id: "a", workerType: "coder" }, { id: "b", workerType: "coder" }] }
                  : { tasks: [{ id: "a", workerType: "unknown" }] },
              coder: () => "ok",
              review: () => ({ allDone: true }),
              finalize: () => "done"
            })
            if (kind === "badBounds" || kind === "badStall") {
              const bad = kind === "badBounds"
                ? { maxRounds: 0, maxTasks: 2, concurrency: 1 }
                : { maxRounds: 2, maxTasks: 2, concurrency: 1, stall: { rounds: 1, on: "stop" as const } }
              const e = yield* Effect.exit(
                Supervisor.run({ tasks: [] }, {
                  plan: forms.effects.plan!,
                  worker: forms.effects.coder!,
                  review: forms.effects.review!,
                  finalize: forms.effects.finalize!,
                  ...bad
                })
              )
              let threw = false
              try {
                Supervisor.make({
                  plan: forms.members.plan!,
                  workers: { coder: forms.members.coder! },
                  review: forms.members.review!,
                  finalize: forms.members.finalize!,
                  ...bad
                })
              } catch {
                threw = true
              }
              return !Exit.isSuccess(e) && threw
            }
            const e = yield* Effect.exit(
              Supervisor.run({ tasks: [] }, {
                plan: forms.effects.plan!,
                worker: forms.effects.coder!,
                review: forms.effects.review!,
                finalize: forms.effects.finalize!,
                maxRounds: 2,
                maxTasks: 1,
                concurrency: 1
              })
            )
            if (kind === "badWorker") {
              const flow = Supervisor.make({
                plan: forms.members.plan!,
                workers: { coder: forms.members.coder! },
                review: forms.members.review!,
                finalize: forms.members.finalize!,
                maxRounds: 2,
                maxTasks: 2,
                concurrency: 1
              })
              let builtBad = false
              try {
                Graph.build(flow, { input: { tasks: [{ id: "a", workerType: "unknown" }] } })
              } catch {
                builtBad = true
              }
              return builtBad
            }
            return !Exit.isSuccess(e)
          }),
        { seed: seed + 28, executions: runs(0.25) }
      )
    )
  })

  it("Trellis validate, leaves, execute, compile, and make (with multi-round continuation & refusals)", async () => {
    const planArb = Arbitrary.schema(
      Schema.Struct({
        shape: Schema.Literals([
          "leaf",
          "seq",
          "par",
          "nested",
          "invalidEmpty",
          "invalidGoal",
          "invalidSeat",
          "overFanout"
        ]),
        concurrency: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 })),
        continueRounds: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 })),
        failLeaf: Schema.Boolean,
        forgedState: Schema.Boolean
      })
    )
    await assertFuzz(
      Fuzz.run(
        planArb,
        ({ shape, concurrency, continueRounds, failLeaf, forgedState }) =>
          Effect.gen(function*() {
            const plan: unknown = shape === "leaf"
              ? { agent: { goal: "g1", seat: "writer" } }
              : shape === "seq"
              ? { sequence: [{ agent: { goal: "a" } }, { agent: { goal: "b" } }] }
              : shape === "par"
              ? { parallel: [{ agent: { goal: "a" } }, { agent: { goal: "b" } }] }
              : shape === "nested"
              ? {
                sequence: [{ agent: { goal: "a" } }, { parallel: [{ agent: { goal: "b" } }, { agent: { goal: "c" } }] }]
              }
              : shape === "invalidEmpty"
              ? { sequence: [] }
              : shape === "invalidGoal"
              ? { agent: { goal: "" } }
              : shape === "invalidSeat"
              ? { agent: { goal: "ok", seat: 123 } }
              : { parallel: [{ agent: { goal: "a" } }, { agent: { goal: "b" } }, { agent: { goal: "c" } }] }

            const envelope: Trellis.Envelope = { fuel: 6, depth: 3, fanout: 2 }
            const refusals = Trellis.validate(plan, envelope)
            const validShape = shape === "leaf" || shape === "seq" || shape === "par" || shape === "nested"
            if (validShape && refusals.length > 0) return false
            if (!validShape && refusals.length === 0) return false

            // Trellis.execute concurrency cap & validation
            let active = 0
            let peak = 0
            const execExit = yield* Effect.exit(
              Trellis.execute(plan as Trellis.Plan, {
                concurrency,
                leaf: (leaf) =>
                  Effect.gen(function*() {
                    active++
                    if (active > peak) peak = active
                    yield* Effect.yieldNow
                    if (failLeaf) return yield* Effect.fail("leaf-boom")
                    return leaf
                  }).pipe(Effect.ensuring(Effect.sync(() => {
                    active--
                  })))
              })
            )
            if (peak > concurrency || active !== 0) return false
            if (shape === "invalidEmpty" || shape === "invalidGoal" || shape === "invalidSeat") {
              if (Exit.isSuccess(execExit)) return false
            } else if (failLeaf) {
              if (Exit.isSuccess(execExit)) return false
            } else {
              if (!Exit.isSuccess(execExit)) return false
            }

            // Trellis.make with optional continuation & forged state checks
            const forms = scripted({
              author: () => plan,
              leaf: ({ goal, path }: { readonly goal: string; readonly path: string }) =>
                failLeaf ? fail({ code: "l_err", message: "leaf fail" }) : { goal, path },
              cont: ({ round }: { readonly round: number }) =>
                round <= continueRounds ? { agent: { goal: `follow-${round}` } } : null
            })
            const flow = Trellis.make({
              author: forms.members.author!,
              leaf: forms.members.leaf!,
              ...(continueRounds > 0 ? { continue: forms.members.cont! } : {}),
              envelope
            })

            if (forgedState) {
              const forgedExit = yield* runDeclaredExit(
                flow,
                {
                  input: { input: "x" },
                  round: { plan: { agent: { goal: "a" } }, round: 1, remaining: 99, rounds: [] }
                },
                "trellis-forged",
                forms.layer
              )
              return !Exit.isSuccess(forgedExit)
            }

            const decExit = yield* runDeclaredExit(flow, { input: { input: "go" } }, "trellis", forms.layer)
            if (!validShape || failLeaf) {
              return !Exit.isSuccess(decExit)
            }
            const totalLeaves = Trellis.leaves(plan as Trellis.Plan).length + continueRounds
            if (totalLeaves > envelope.fuel) {
              return !Exit.isSuccess(decExit)
            }
            if (!Exit.isSuccess(decExit)) return false
            const result = decExit.value as Trellis.RunResult
            return result.rounds.length === 1 + continueRounds && result.remaining === envelope.fuel - totalLeaves
          }),
        { seed: seed + 29, executions: runs(0.5), execution: FuzzSimulation.execution() }
      )
    )

    // Invalid envelope, malformed plans (sparse/cyclic/depth/multi-key), continuation fuel exhaustion, & bad execute concurrency
    await assertFuzz(
      Fuzz.run(
        Arbitrary.schema(Schema.Literals(["badEnv", "sparse", "cyclic", "multiKey", "deep", "fuelCont", "badConc"])),
        (kind) =>
          Effect.gen(function*() {
            const env: Trellis.Envelope = { fuel: 2, depth: 2, fanout: 2 }
            if (kind === "badEnv") {
              const forms = scripted({ a: () => 1, l: () => 2 })
              let threw = false
              try {
                Trellis.make({
                  author: forms.members.a!,
                  leaf: forms.members.l!,
                  envelope: { fuel: 0, depth: 2, fanout: 2 }
                })
              } catch (e) {
                threw = e instanceof Trellis.TrellisError && e.code === "invalid_envelope"
              }
              return threw
            }
            if (kind === "badConc") {
              const e = yield* Effect.exit(
                Trellis.execute({ agent: { goal: "a" } }, { concurrency: 0, leaf: () => Effect.succeed(1) })
              )
              return errorCodeOf(e) === "invalid_envelope"
            }
            if (kind === "sparse") {
              const arr: Array<unknown> = new Array(2)
              arr[0] = { agent: { goal: "a" } }
              const refs = Trellis.validate({ sequence: arr }, env)
              return refs.some((r) => r.code === "invalid_plan")
            }
            if (kind === "cyclic") {
              const cyc: { sequence: Array<unknown> } = { sequence: [] }
              cyc.sequence.push(cyc)
              // A cycle must fail closed: the depth bound always terminates the walk.
              const refs = Trellis.validate(cyc, env)
              return refs.length > 0 && refs.every((r) => r.code === "invalid_plan" || r.code === "depth_exceeded")
            }
            if (kind === "multiKey") {
              const refs = Trellis.validate({ agent: { goal: "a" }, sequence: [{ agent: { goal: "b" } }] }, env)
              return refs.some((r) => r.code === "invalid_plan")
            }
            if (kind === "deep") {
              const deepPlan = { sequence: [{ parallel: [{ agent: { goal: "too-deep" } }] }] }
              const refs = Trellis.validate(deepPlan, env)
              return refs.some((r) => r.code === "depth_exceeded")
            }
            // fuelCont: round 1 uses 1 fuel, continuation asks for 2 leaves with only 1 remaining!
            const forms = scripted({
              author: () => ({ agent: { goal: "first" } }),
              leaf: () => "ok",
              cont: () => ({ sequence: [{ agent: { goal: "b" } }, { agent: { goal: "c" } }] })
            })
            const flow = Trellis.make({
              author: forms.members.author!,
              leaf: forms.members.leaf!,
              continue: forms.members.cont!,
              envelope: env
            })
            const e = yield* runDeclaredExit(flow, { input: { input: "x" } }, "trellis-fuel-cont", forms.layer)
            return errorCodeOf(e) === "fuel_exhausted"
          }),
        { seed: seed + 30, executions: runs(0.3) }
      )
    )
  })

  it("DelegationChain.run & DelegationChain.make cover derisk rounds, tier escalation, exhaustion, and bounds", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        planKind: Schema.Literals(["single", "seq", "par", "invalid"]),
        deriskApproveRound: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4 })),
        maxDeriskRounds: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2 })),
        weakOutcome: Schema.Literals(["approve", "reject", "fail"]),
        strongOutcome: Schema.Literals(["approve", "reject"]),
        hasBudget: Schema.Boolean
      })
    )
    await assertFuzz(
      Fuzz.run(
        arb,
        ({ planKind, deriskApproveRound, maxDeriskRounds, weakOutcome, strongOutcome, hasBudget }) =>
          Effect.gen(function*() {
            const plan = planKind === "single"
              ? { agent: { goal: "a" } }
              : planKind === "seq"
              ? { sequence: [{ agent: { goal: "a" } }, { agent: { goal: "b" } }] }
              : planKind === "par"
              ? { parallel: [{ agent: { goal: "a" } }, { agent: { goal: "b" } }] }
              : { agent: { goal: "" } }

            const makeScript = () => {
              let deriskCalls = 0
              return {
                refine: ({ prompt }: { readonly prompt: unknown }) => ({ goal: `refined:${String(prompt)}` }),
                plan: () => plan,
                derisk: () => {
                  deriskCalls++
                  return { approved: deriskCalls >= deriskApproveRound }
                },
                weak: ({ leaf }: { readonly leaf: Trellis.Leaf }) =>
                  weakOutcome === "fail" ? fail({ code: "w_err", message: "weak failed" }) : `weak:${leaf.goal}`,
                strong: ({ leaf }: { readonly leaf: Trellis.Leaf }) => `strong:${leaf.goal}`,
                review: ({ stage, tier }: { readonly stage: string; readonly tier?: string }) => {
                  if (stage === "chain") return { approved: true }
                  if (tier === "weak") return { approved: weakOutcome === "approve" }
                  return { approved: strongOutcome === "approve" }
                },
                settle: (
                  { deriskExhausted, leaves }: {
                    readonly deriskExhausted: boolean
                    readonly leaves: ReadonlyArray<unknown>
                  }
                ) => ({
                  leaves,
                  deriskExhausted
                })
              }
            }
            const runForms = scripted(makeScript())
            const decForms = scripted(makeScript())
            const bounds = {
              tierOrder: ["weak", "strong"],
              maxDepth: 2,
              maxDeriskRounds,
              ...(hasBudget ? { budget: { maxMinutes: 5 } } : {})
            }

            const runExit = yield* Effect.exit(
              DelegationChain.run("build it", {
                refine: runForms.effects.refine!,
                plan: runForms.effects.plan!,
                derisk: runForms.effects.derisk!,
                execute: {
                  weak: (w) => Effect.flatMap(Effect.yieldNow, () => runForms.effects.weak!(w)),
                  strong: (w) => Effect.flatMap(Effect.yieldNow, () => runForms.effects.strong!(w))
                },
                review: runForms.effects.review!,
                settle: runForms.effects.settle!,
                concurrency: 2,
                ...bounds
              })
            )

            const flow = DelegationChain.make({
              refine: decForms.members.refine!,
              plan: decForms.members.plan!,
              derisk: decForms.members.derisk!,
              execute: { weak: decForms.members.weak!, strong: decForms.members.strong! },
              review: decForms.members.review!,
              settle: decForms.members.settle!,
              ...bounds
            })
            const decExit = yield* runDeclaredExit(flow, { input: "build it" }, "delegation", decForms.layer)

            if (planKind === "invalid") {
              return !Exit.isSuccess(runExit) && !Exit.isSuccess(decExit)
            }
            const leafExhausted = weakOutcome !== "approve" && strongOutcome !== "approve"
            if (leafExhausted) {
              return errorCodeOf(runExit) === "leaf_failed" && errorCodeOf(decExit) === "leaf_failed"
            }
            if (!Exit.isSuccess(runExit) || !Exit.isSuccess(decExit)) return false
            return JSON.stringify(runExit.value) === JSON.stringify(decExit.value) &&
              DelegationChain.bound(bounds) >= 1
          }),
        { seed: seed + 31, executions: runs(0.45), execution: FuzzSimulation.execution() }
      )
    )

    // DelegationChain validation refusals & forged execution state
    await assertFuzz(
      Fuzz.run(
        Arbitrary.schema(
          Schema.Literals(["badDepth", "emptyTiers", "missingExec", "badConc", "badDerisk", "forgedExec"])
        ),
        (kind) =>
          Effect.gen(function*() {
            const forms = scripted({
              refine: () => "g",
              plan: () => ({ agent: { goal: "a" } }),
              derisk: () => true,
              weak: () => "w",
              review: () => true,
              settle: () => "s"
            })
            if (kind === "forgedExec") {
              const flow = DelegationChain.make({
                refine: forms.members.refine!,
                plan: forms.members.plan!,
                derisk: forms.members.derisk!,
                execute: { weak: forms.members.weak! },
                review: forms.members.review!,
                settle: forms.members.settle!,
                tierOrder: ["weak"],
                maxDepth: 1,
                maxDeriskRounds: 1
              })
              const e = yield* runDeclaredExit(
                flow,
                { input: "x", execution: { goal: "g", derisked: { _tag: "Broken" } } },
                "del-forged",
                forms.layer
              )
              return !Exit.isSuccess(e)
            }
            if (kind === "badConc") {
              const runE = yield* Effect.exit(
                DelegationChain.run("x", {
                  refine: forms.effects.refine!,
                  plan: forms.effects.plan!,
                  derisk: forms.effects.derisk!,
                  execute: { weak: forms.effects.weak! },
                  review: forms.effects.review!,
                  settle: forms.effects.settle!,
                  tierOrder: ["weak"],
                  maxDepth: 1,
                  maxDeriskRounds: 1,
                  concurrency: 0
                })
              )
              return errorCodeOf(runE) === "invalid_bounds"
            }
            const badOpts = kind === "badDepth"
              ? { tierOrder: ["weak"], maxDepth: 0, maxDeriskRounds: 1 }
              : kind === "emptyTiers"
              ? { tierOrder: [], maxDepth: 1, maxDeriskRounds: 1 }
              : kind === "missingExec"
              ? { tierOrder: ["weak", "missing"], maxDepth: 1, maxDeriskRounds: 1 }
              : { tierOrder: ["weak"], maxDepth: 1, maxDeriskRounds: 0 }
            const runE = yield* Effect.exit(
              DelegationChain.run("x", {
                refine: forms.effects.refine!,
                plan: forms.effects.plan!,
                derisk: forms.effects.derisk!,
                execute: { weak: forms.effects.weak! },
                review: forms.effects.review!,
                settle: forms.effects.settle!,
                ...badOpts
              })
            )
            let makeThrew = false
            try {
              DelegationChain.make({
                refine: forms.members.refine!,
                plan: forms.members.plan!,
                derisk: forms.members.derisk!,
                execute: { weak: forms.members.weak! },
                review: forms.members.review!,
                settle: forms.members.settle!,
                ...badOpts
              })
            } catch {
              makeThrew = true
            }
            return !Exit.isSuccess(runE) && makeThrew
          }),
        { seed: seed + 32, executions: runs(0.25) }
      )
    )
  })

  it("Burndown.round invariants: concurrency, claim/release symmetry, infra requeue, select, land, stop, capacity", async () => {
    const itemModeArb = Schema.Literals(["land", "skip", "selectErr", "held", "workFail", "infra", "landFail", "stop"])
    const arb = Arbitrary.schema(
      Schema.Struct({
        modes: Schema.Array(itemModeArb),
        concurrency: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 })),
        landConcurrency: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2 })),
        slots: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 4 })),
        maxRequeues: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 })),
        prevRequeues: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 })),
        hasCapacityCheck: Schema.Boolean,
        capacityKind: Schema.Literals(["available", "exhausted", "waitUntil"])
      })
    )
    await assertFuzz(
      Fuzz.run(
        arb,
        (
          { modes: raw, concurrency, landConcurrency, slots, maxRequeues, prevRequeues, hasCapacityCheck, capacityKind }
        ) =>
          Effect.gen(function*() {
            const modes = raw.slice(0, 5)
            const items = modes.map((_, i) => ({ id: `item-${i}` }))
            const claimed = new Set<string>()
            const released = new Map<string, Burndown.Status>()
            let activeWork = 0
            let peakWork = 0
            let activeLand = 0
            let peakLand = 0

            const carriedRows: ReadonlyArray<Burndown.Row> = items.length > 0 && prevRequeues > 0
              ? [{ id: items[0]!.id, status: "requeued", detail: "prev", requeues: prevRequeues }]
              : []

            const cap = capacityKind === "available"
              ? Burndown.available(2)
              : capacityKind === "waitUntil"
              ? Burndown.waitUntil(Date.now() + 1000)
              : Burndown.exhausted("full")

            const roundExit = yield* Effect.exit(
              Burndown.round(
                {
                  input: { repo: "acme/app" },
                  round: 0,
                  items,
                  rows: carriedRows,
                  ...(slots > 0 ? { slots } : {})
                },
                {
                  key: "fuzz-sweep",
                  concurrency,
                  landConcurrency,
                  maxRequeues,
                  select: ({ item }) => {
                    const idx = Number(item.id.split("-")[1])
                    const m = modes[idx]!
                    if (m === "skip") return Effect.succeed(Burndown.skip("not-ours"))
                    if (m === "selectErr") return Effect.fail("select-failed")
                    return Effect.succeed(Burndown.ours)
                  },
                  claim: ({ item }) => {
                    const idx = Number(item.id.split("-")[1])
                    const m = modes[idx]!
                    if (m === "held") return Effect.fail(new Burndown.Held({ message: "busy" }))
                    claimed.add(item.id)
                    return Effect.void
                  },
                  work: ({ item }) =>
                    Effect.gen(function*() {
                      activeWork++
                      if (activeWork > peakWork) peakWork = activeWork
                      yield* Effect.yieldNow
                      const idx = Number(item.id.split("-")[1])
                      const m = modes[idx]!
                      if (m === "stop") return yield* Effect.fail(new Burndown.Stop({ message: "halt" }))
                      if (m === "workFail") return yield* Effect.fail("domain-fail")
                      if (m === "infra") return yield* Effect.fail({ _tag: "PatternsFuzzInfra", message: "offline" })
                      return `done-${item.id}`
                    }).pipe(Effect.ensuring(Effect.sync(() => {
                      activeWork--
                    }))),
                  land: ({ item, output }) =>
                    Effect.gen(function*() {
                      activeLand++
                      if (activeLand > peakLand) peakLand = activeLand
                      yield* Effect.yieldNow
                      const idx = Number(item.id.split("-")[1])
                      if (modes[idx] === "landFail") return yield* Effect.fail("land-boom")
                      return `landed:${output}`
                    }).pipe(Effect.ensuring(Effect.sync(() => {
                      activeLand--
                    }))),
                  detail: (out, landed) => `${out}|${landed ?? ""}`,
                  release: ({ item, status }) =>
                    Effect.sync(() => {
                      released.set(item.id, status)
                    }),
                  ...(hasCapacityCheck ? { capacity: () => Effect.succeed(cap) } : {})
                }
              )
            )

            const effectiveCap = slots > 0 ? Math.min(concurrency, slots) : concurrency
            if (peakWork > effectiveCap || activeWork !== 0) return false
            if (peakLand > landConcurrency || activeLand !== 0) return false

            for (const id of claimed) {
              if (!released.has(id)) return false
            }

            if (Exit.isSuccess(roundExit)) {
              const res = roundExit.value
              const ids = res.rows.map((r) => r.id)
              if (new Set(ids).size !== ids.length) return false
            }
            return true
          }),
        { seed: seed + 33, executions: runs(0.5), execution: FuzzSimulation.execution() }
      )
    )
  })

  it("Burndown.make + Burndown.layer + Burndown.child execute multi-round durable lineages & capacity gates", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        itemCount: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 4 })),
        maxRounds: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 })),
        slotsPerRound: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 })),
        capacitySeq: Schema.Literals(["none", "available", "waitThenAvail", "exhaustThenAvail"]),
        hasDeadline: Schema.Boolean
      })
    )
    await assertFuzz(
      Fuzz.run(
        arb,
        ({ itemCount, maxRounds, slotsPerRound, capacitySeq, hasDeadline }) =>
          Effect.gen(function*() {
            const discoverAction = Action.make("fuzz/bd-discover", {
              payload: { input: Schema.Unknown, round: Schema.Number },
              success: Schema.Array(Schema.Struct({ id: Schema.String })),
              error: Schema.Unknown
            })
            const capacityAction = Action.make("fuzz/bd-capacity", {
              payload: { input: Schema.Unknown, round: Schema.Number },
              success: Burndown.Capacity,
              error: Schema.Unknown
            })
            const dispatchAction = Burndown.dispatch("fuzz/bd-dispatch")
            const childFlow = Flow.make("fuzz/bd-child", {
              payload: { id: Schema.String },
              success: Schema.String,
              error: Schema.Unknown,
              body: ({ id }) => Node.succeed(`child:${id}`)
            })

            const allItems = Array.from({ length: itemCount }, (_, i) => ({ id: `t${i}` }))
            let capCalls = 0
            const sigName = "fuzz/burndown-cap"

            const burndown = Burndown.make({
              discover: discoverAction,
              dispatch: dispatchAction,
              ...(capacitySeq !== "none" ? { capacity: capacityAction } : {}),
              maxRounds,
              ...(hasDeadline ? { deadline: Duration.seconds(30) } : {}),
              signal: sigName
            })

            const discoverLayer = discoverAction.toLayer(() => Effect.succeed(allItems))
            const capacityLayer = capacityAction.toLayer(() =>
              Effect.sync(() => {
                capCalls++
                if (capacitySeq === "waitThenAvail" && capCalls === 1) return Burndown.waitUntil(Date.now() - 1)
                if (capacitySeq === "exhaustThenAvail" && capCalls === 1) return Burndown.exhausted("paused")
                return Burndown.available(slotsPerRound)
              })
            )
            const dispatchLayer = Burndown.layer(dispatchAction, {
              key: "lineage",
              concurrency: slotsPerRound,
              claim: () => Effect.void,
              work: ({ item }: Burndown.ItemArgs<unknown, { readonly id: string }>) =>
                Effect.succeed(`worked:${item.id}`),
              land: (
                { item, output }: Burndown.ItemArgs<unknown, { readonly id: string }> & { readonly output: string }
              ) => item.id === "t2" ? Effect.fail("land-err") : Effect.succeed(`landed:${output}`),
              detail: (out, landed) => `${out}/${landed ?? ""}`,
              release: ({ item }) => (item.id === "t3" ? Effect.fail("rel-err") : Effect.void)
            })

            const sig = Burndown.signal(sigName)
            if (sig.name !== `WaitFor/${sigName}`) return false

            const executionId = `burndown-${++execCounter}`
            const hostLayer = Layer.mergeAll(
              Interpreter.layer(burndown as never),
              Sleep.layer,
              WaitFor.layer,
              discoverLayer as unknown as Layer.Layer<any, any, any>,
              capacityLayer as unknown as Layer.Layer<any, any, any>,
              dispatchLayer as unknown as Layer.Layer<any, any, any>,
              Logger.layer([])
            ).pipe(
              Layer.provideMerge(Action.layerImplementations),
              Layer.provideMerge(FlowEngine.layerMemory),
              Layer.provideMerge(syncCryptoLayer)
            ) as Layer.Layer<any, never, never>

            const exit = yield* (Effect.gen(function*() {
              if (capacitySeq === "exhaustThenAvail") {
                const token = DurableDeferred.tokenFromExecutionId(sig, { flow: burndown, executionId })
                yield* DurableDeferred.succeed(sig, { token, value: { reset: true } })
              }
              return yield* burndown.execute({ input: { repo: "acme" } }, { executionId })
            }).pipe(
              Effect.provide(hostLayer),
              Effect.scoped,
              Effect.exit
            ) as Effect.Effect<Exit.Exit<unknown, unknown>>)
            if (!Exit.isSuccess(exit)) return false
            const result = exit.value as Burndown.Result
            if (result.stopped !== "drained" && result.stopped !== "max_rounds") return false
            if (result.rounds < 1 || result.rounds > maxRounds) return false

            // Also exercise Burndown.child with a real durable child flow + FlowEngine
            if (itemCount > 0) {
              const workChild = Burndown.child(
                childFlow,
                ({ item }: Burndown.ItemArgs<unknown, { readonly id: string }>) => ({ id: item.id })
              )
              const childRoundExit = yield* (Burndown.round(
                { input: { repo: "acme" }, round: 0, items: allItems.slice(0, 2) },
                {
                  key: `child-sweep-${execCounter}`,
                  concurrency: 2,
                  claim: () => Effect.void,
                  work: workChild,
                  detail: (out) => out,
                  release: () => Effect.void
                }
              ).pipe(
                Effect.provide(
                  Layer.mergeAll(Interpreter.layer(childFlow as never), Logger.layer([])).pipe(
                    Layer.provideMerge(Action.layerImplementations),
                    Layer.provideMerge(FlowEngine.layerMemory),
                    Layer.provideMerge(syncCryptoLayer)
                  ) as Layer.Layer<any, never, never>
                ),
                Effect.scoped,
                Effect.exit
              ) as Effect.Effect<Exit.Exit<Burndown.RoundResult, unknown>>)
              if (!Exit.isSuccess(childRoundExit)) return false
              if (childRoundExit.value.rows.some((r) => r.status !== "landed")) return false
            }
            return true
          }),
        { seed: seed + 34, executions: runs(0.35) }
      )
    )

    // Burndown.make & Burndown.round validation refusals
    await assertFuzz(
      Fuzz.run(
        Arbitrary.schema(
          Schema.Literals([
            "badMaxRounds",
            "badDeadline",
            "blankSignal",
            "badKey",
            "badRound",
            "dupId",
            "blankId",
            "badSlots"
          ])
        ),
        (kind) =>
          Effect.gen(function*() {
            const disc = Action.make("fuzz/bd-val-d", {
              payload: { input: Schema.Unknown, round: Schema.Number },
              success: Schema.Array(Schema.Struct({ id: Schema.String })),
              error: Schema.Unknown
            })
            const disp = Burndown.dispatch("fuzz/bd-val-disp")
            if (kind === "badMaxRounds" || kind === "badDeadline" || kind === "blankSignal") {
              let threw = false
              try {
                Burndown.make({
                  discover: disc,
                  dispatch: disp,
                  maxRounds: kind === "badMaxRounds" ? 0 : 2,
                  ...(kind === "badDeadline" ? { deadline: Duration.zero } : {}),
                  ...(kind === "blankSignal" ? { signal: "   " } : {})
                })
              } catch (e) {
                threw = e instanceof PatternError.PatternError
              }
              return threw
            }
            const base = {
              key: kind === "badKey" ? "  " : "k",
              concurrency: 1,
              claim: () => Effect.void,
              work: () => Effect.succeed("ok"),
              release: () => Effect.void
            }
            const exit = yield* Effect.exit(
              Burndown.round(
                {
                  input: null,
                  round: kind === "badRound" ? -1 : 0,
                  items: kind === "dupId"
                    ? [{ id: "a" }, { id: "a" }]
                    : kind === "blankId"
                    ? [{ id: "  " }]
                    : [{ id: "a" }],
                  ...(kind === "badSlots" ? { slots: 0 } : {})
                },
                base
              )
            )
            return !Exit.isSuccess(exit)
          }),
        { seed: seed + 35, executions: runs(0.3) }
      )
    )

    // Burndown.round interruption cleanup (cancelled true vs false + release failure)
    await assertFuzz(
      Fuzz.run(
        Arbitrary.schema(Schema.Struct({ cancelled: Schema.Boolean, releaseFails: Schema.Boolean })),
        ({ cancelled, releaseFails }) =>
          Effect.gen(function*() {
            const started = yield* Deferred.make<void>()
            const released: Array<{ readonly id: string; readonly status: Burndown.Status }> = []
            const fiber = yield* Effect.forkChild(
              Burndown.round({ input: null, round: 0, items: [{ id: "a" }] }, {
                key: "int-sweep",
                concurrency: 1,
                claim: () => Effect.void,
                work: () => Effect.andThen(Deferred.succeed(started, undefined), Effect.never),
                cancelled: () => Effect.succeed(cancelled),
                release: ({ item, status }) =>
                  Effect.gen(function*() {
                    released.push({ id: item.id, status })
                    if (releaseFails) return yield* Effect.fail("cleanup-err")
                  })
              })
            )
            yield* Deferred.await(started)
            yield* Fiber.interrupt(fiber)
            const exit = yield* Fiber.await(fiber)
            const expectedStatus: Burndown.Status = cancelled ? "failed" : "requeued"
            return Exit.hasInterrupts(exit) &&
              released.length === 1 &&
              released[0]!.status === expectedStatus
          }),
        { seed: seed + 135, executions: runs(0.25) }
      )
    )
  })

  it("Optimizer.make tracks best-so-far across score trajectories, converges at target, and rejects non-finite scores", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        scores: Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: -20, maximum: 20 }))),
        maxIterations: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4 })),
        hasTarget: Schema.Boolean,
        targetScore: Schema.Int.check(Schema.isBetween({ minimum: -10, maximum: 15 })),
        onMaxReached: Schema.Literals(["return-last", "fail"]),
        injectNonFinite: Schema.Boolean
      })
    )
    await assertFuzz(
      Fuzz.run(
        arb,
        ({ scores: raw, maxIterations, hasTarget, targetScore, onMaxReached, injectNonFinite }) =>
          Effect.gen(function*() {
            const scores = Array.from({ length: maxIterations }, (_, i) => raw[i] ?? i)
            const forms = scripted({
              generate: ({ iteration }: { readonly iteration: number }) => `cand-${iteration}`,
              evaluate: ({ iteration }: { readonly iteration: number }) => ({
                score: injectNonFinite && iteration === 1
                  ? ("not-a-number" as unknown as number)
                  : scores[iteration - 1]!,
                feedback: `fb-${iteration}`
              })
            })
            if (!hasTarget && onMaxReached === "fail") {
              let threw = false
              try {
                Optimizer.make({
                  generate: forms.members.generate!,
                  evaluate: forms.members.evaluate!,
                  maxIterations,
                  onMaxReached: "fail"
                })
              } catch (e) {
                threw = e instanceof PatternError.PatternError
              }
              return threw
            }
            const flow = Optimizer.make({
              generate: forms.members.generate!,
              evaluate: forms.members.evaluate!,
              maxIterations,
              ...(hasTarget ? { targetScore } : {}),
              onMaxReached
            })
            const exit = yield* runDeclaredExit(flow, { input: "seed" }, "optimizer", forms.layer)
            if (injectNonFinite) {
              return errorCodeOf(exit) === "invalid_input"
            }
            const firstHit = hasTarget ? scores.findIndex((s) => s >= targetScore) : -1
            if (firstHit === -1 && hasTarget && onMaxReached === "fail") {
              return errorCodeOf(exit) === "exhausted"
            }
            if (!Exit.isSuccess(exit)) return false
            const res = exit.value as {
              readonly best: Optimizer.Attempt<string>
              readonly iterations: number
              readonly converged: boolean
            }
            const ranCount = firstHit === -1 ? maxIterations : firstHit + 1
            const expectedMax = Math.max(...scores.slice(0, ranCount))
            return res.iterations === ranCount &&
              res.converged === (firstHit !== -1) &&
              res.best.score === expectedMax
          }),
        { seed: seed + 36, executions: runs(0.5) }
      )
    )
  })

  it("ScanFixVerify.make fixes only discovered issues per batch, stops on clean scan, and rejects non-array scans", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        maxRetries: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 })),
        maxIssues: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 })),
        concurrency: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2 })),
        initialIssues: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 4 })),
        shrinkPerRound: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 })),
        badScan: Schema.Boolean
      })
    )
    await assertFuzz(
      Fuzz.run(
        arb,
        ({ maxRetries, maxIssues, concurrency, initialIssues, shrinkPerRound, badScan }) =>
          Effect.gen(function*() {
            let fixCalls = 0
            const forms = scripted({
              scan: ({ iteration }: { readonly iteration: number }) => {
                if (badScan) return "not-an-array"
                const left = Math.max(0, initialIssues - (iteration - 1) * shrinkPerRound)
                return Array.from({ length: left }, (_, i) => `iss-${iteration}-${i}`)
              },
              fix: ({ issue }: { readonly issue: string }) => {
                fixCalls++
                return `fixed:${issue}`
              },
              verify: ({ fixes }: { readonly fixes: ReadonlyArray<string> }) => ({
                resolved: fixes.length === 0,
                count: fixes.length
              })
            })
            const flow = ScanFixVerify.make({
              scan: forms.members.scan!,
              fix: forms.members.fix!,
              verify: forms.members.verify!,
              maxRetries,
              maxIssues,
              concurrency
            })
            const exit = yield* runDeclaredExit(flow, { input: "repo" }, "sfv", forms.layer)
            if (badScan) {
              return errorCodeOf(exit) === "invalid_input"
            }
            if (!Exit.isSuccess(exit)) return false
            const res = exit.value as {
              readonly iterations: number
              readonly remaining: ReadonlyArray<string>
              readonly resolved: boolean
              readonly verifications: ReadonlyArray<unknown>
            }
            if (initialIssues === 0 && fixCalls !== 0) return false
            if (res.resolved !== (res.remaining.length === 0)) return false
            if (ScanFixVerify.resolved(true) !== true || ScanFixVerify.resolved({ resolved: true }) !== true) {
              return false
            }
            if (ScanFixVerify.resolved({ resolved: false }) !== false) return false
            return true
          }),
        { seed: seed + 37, executions: runs(0.5) }
      )
    )

    // Validation refusal
    await assertFuzz(
      Fuzz.run(
        Arbitrary.schema(Schema.Literals(["zero", "neg", "frac"])),
        (badTag) =>
          Effect.sync(() => {
            const bad = decodeBadNumber(badTag)
            const forms = scripted({ s: () => [], f: () => 1, v: () => true })
            let threw = false
            try {
              ScanFixVerify.make({
                scan: forms.members.s!,
                fix: forms.members.f!,
                verify: forms.members.v!,
                maxRetries: bad,
                maxIssues: 2,
                concurrency: 1
              })
            } catch (e) {
              threw = e instanceof PatternError.PatternError
            }
            return threw
          }),
        { seed: seed + 38, executions: runs(0.2) }
      )
    )
  })

  it("Recursion.recurse enforces fuel, depth, fanout, and parent envelope attenuation", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        fuel: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 6 })),
        depth: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 })),
        fanout: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 })),
        treeKind: Schema.Literals(["leaf", "wide", "deep", "balanced", "badChildren", "fnInput"]),
        withParent: Schema.Boolean,
        widenParent: Schema.Boolean
      })
    )
    await assertFuzz(
      Fuzz.run(
        arb,
        ({ fuel, depth, fanout, treeKind, withParent, widenParent }) =>
          Effect.gen(function*() {
            let calls = 0
            const forms = scripted({
              child: ({ input }: { readonly input: unknown }) => {
                calls++
                return { visited: input }
              }
            })
            const parent = withParent
              ? widenParent
                ? { fuel: Math.max(1, fuel - 1), depth, fanout }
                : { fuel: fuel + 1, depth: depth + 1, fanout: fanout + 1 }
              : undefined

            if (withParent && widenParent && fuel > 1) {
              let threw = false
              try {
                Recursion.recurse({ child: forms.members.child!, fuel, depth, fanout, parent })
              } catch (e) {
                threw = e instanceof PatternError.PatternError && e.code === "recursion_bound"
              }
              return threw
            }

            const flow = Recursion.recurse({
              child: forms.members.child!,
              fuel,
              depth,
              fanout,
              ...(withParent && !widenParent ? { parent } : {})
            })
            const tree: unknown = treeKind === "leaf"
              ? "root"
              : treeKind === "wide"
              ? { input: "r", children: [{ input: "c1" }, { input: "c2" }, { input: "c3" }] }
              : treeKind === "deep"
              ? { input: "r", children: [{ input: "d1", children: [{ input: "d2", children: [{ input: "d3" }] }] }] }
              : treeKind === "balanced"
              ? { input: "r", children: [{ input: "c1" }, { input: "c2" }] }
              : treeKind === "badChildren"
              ? { input: "r", children: "nope" }
              : () => "fn"

            const exit = yield* runDeclaredExit(flow, { input: tree }, "recursion", forms.layer)
            if (treeKind === "badChildren" || treeKind === "fnInput") {
              return !Exit.isSuccess(exit)
            }
            if (treeKind === "leaf") {
              return Exit.isSuccess(exit) && calls === 1
            }
            if (treeKind === "balanced") {
              const allowed = fuel >= 3 && depth >= 2 && fanout >= 2
              return allowed ? (Exit.isSuccess(exit) && calls === 3) : !Exit.isSuccess(exit)
            }
            if (treeKind === "wide") {
              const allowed = fuel >= 4 && depth >= 2 && fanout >= 3
              return allowed ? (Exit.isSuccess(exit) && calls === 4) : !Exit.isSuccess(exit)
            }
            return !Exit.isSuccess(exit)
          }),
        { seed: seed + 39, executions: runs(0.5) }
      )
    )
  })

  it("Pattern slot, bind, clipped, decorate, and decorateAll enforce schema compatibility & authority narrowing", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        templateCaps: Schema.Array(Schema.Literals(["read", "write", "net"])),
        suppliedCaps: Schema.Array(Schema.Literals(["read", "write", "net"])),
        templateWrites: Schema.Boolean,
        suppliedWrites: Schema.Boolean,
        compatibleSchema: Schema.Boolean,
        useDefault: Schema.Boolean,
        pipeStyle: Schema.Boolean
      })
    )
    await assertFuzz(
      Fuzz.run(
        arb,
        ({ templateCaps, suppliedCaps, templateWrites, suppliedWrites, compatibleSchema, useDefault, pipeStyle }) =>
          Effect.gen(function*() {
            const tCaps = [...new Set(templateCaps)]
            const sCaps = [...new Set(suppliedCaps)]
            const tEffects = templateWrites
              ? Effects.make({
                reads: ["fs"],
                writes: ["fs"],
                mode: "expected",
                tier: "compensable",
                onConflict: "serialize"
              })
              : Effects.make({ reads: ["fs"], writes: [], mode: "hermetic", tier: "sealed", onConflict: "serialize" })
            const sEffects = suppliedWrites
              ? Effects.make({
                reads: ["fs"],
                writes: ["fs"],
                mode: "expected",
                tier: "compensable",
                onConflict: "serialize"
              })
              : Effects.make({ reads: ["fs"], writes: [], mode: "hermetic", tier: "sealed", onConflict: "serialize" })

            const template = Flow.make("fuzz/pat-template", {
              payload: { input: Schema.String },
              success: Schema.String,
              error: Schema.Unknown,
              capabilities: tCaps,
              effects: tEffects,
              body: ({ input }) => Node.succeed(`t:${input}`)
            })
            const supplied = Flow.make("fuzz/pat-supplied", {
              description: "supplied decorator",
              payload: compatibleSchema ? { input: Schema.String } : { input: Schema.Number },
              success: Schema.String,
              error: Schema.Unknown,
              capabilities: sCaps,
              effects: sEffects,
              body: ({ input }) => Node.succeed(`s:${String(input)}`)
            })

            const s = Pattern.slot({
              input: Schema.Struct({ input: Schema.String }),
              output: Schema.String,
              ...(useDefault ? { default: template } : {})
            })
            if (compatibleSchema) {
              const bound = Pattern.bind(s, useDefault ? undefined : supplied)
              if (bound._tag !== (useDefault ? template._tag : supplied._tag)) return false
            } else {
              let refused = false
              try {
                Pattern.bind(s, supplied)
              } catch (e) {
                refused = e instanceof PatternError.PatternError && e.code === "invalid_decorator"
              }
              if (!refused) return false
              if (!useDefault) {
                let missing = false
                try {
                  Pattern.bind(s, undefined)
                } catch (e) {
                  missing = e instanceof PatternError.PatternError && e.code === "missing_slot"
                }
                if (!missing) return false
              }
            }

            const clip = Pattern.clipped(template, supplied)
            const expectedClippedCaps = sCaps.filter((c) => !tCaps.includes(c))
            if (JSON.stringify([...clip.capabilities].sort()) !== JSON.stringify([...expectedClippedCaps].sort())) {
              return false
            }

            const widens = suppliedWrites && !templateWrites
            if (!compatibleSchema) {
              let schemaRefused = false
              try {
                const dec: Pattern.Decorator = () => supplied
                if (pipeStyle) Pattern.decorate(dec)(template)
                else Pattern.decorate(template, dec)
              } catch (e) {
                schemaRefused = e instanceof PatternError.PatternError && e.code === "invalid_decorator"
              }
              return schemaRefused
            }
            if (widens) {
              let conflict = false
              try {
                const dec: Pattern.Decorator = () => supplied
                if (pipeStyle) Pattern.decorate(dec)(template)
                else Pattern.decorate(template, dec)
              } catch (e) {
                conflict = e instanceof PatternError.PatternError && e.code === "envelope_conflict"
              }
              return conflict
            }

            const dec: Pattern.Decorator = () => supplied
            const wrapped = pipeStyle ? Pattern.decorate(dec)(template) : Pattern.decorate(template, dec)
            const wrappedAll = Pattern.decorateAll(template, [dec])
            const exit1 = yield* runDeclaredExit(wrapped as unknown as ExecutableFlow, { input: "hi" }, "pat-dec")
            const exit2 = yield* runDeclaredExit(wrappedAll as unknown as ExecutableFlow, { input: "hi" }, "pat-all")
            return Exit.isSuccess(exit1) && Exit.isSuccess(exit2) && exit1.value === "s:hi" && exit2.value === "s:hi"
          }),
        { seed: seed + 40, executions: runs(0.45) }
      )
    )

    // Pattern edge cases: invalid slot default, non-JSON schema conversion failure, non-Flow decorator, incompatible error schema, unannotated flows
    await assertFuzz(
      Fuzz.run(
        Arbitrary.schema(Schema.Literals(["badDefault", "nonJson", "notFlow", "badError", "noEffects"])),
        (kind) =>
          Effect.sync(() => {
            const base = Flow.make("fuzz/pat-edge", {
              payload: { input: Schema.String },
              success: Schema.String,
              error: Schema.String,
              body: ({ input }) => Node.succeed(input)
            })
            if (kind === "badDefault") {
              let threw = false
              try {
                Pattern.slot({ input: Schema.Struct({ input: Schema.Number }), output: Schema.String, default: base })
              } catch (e) {
                threw = e instanceof PatternError.PatternError && e.code === "invalid_decorator"
              }
              return threw
            }
            if (kind === "nonJson") {
              let threw = false
              try {
                Pattern.slot({ input: Schema.Symbol, output: Schema.String, default: base })
              } catch (e) {
                threw = e instanceof PatternError.PatternError && e.code === "invalid_decorator"
              }
              return threw
            }
            if (kind === "notFlow") {
              let threw = false
              try {
                Pattern.decorate(base, () => ("not-a-flow" as never))
              } catch (e) {
                threw = e instanceof PatternError.PatternError && e.code === "invalid_decorator"
              }
              return threw
            }
            if (kind === "badError") {
              const badErrFlow = Flow.make("fuzz/pat-baderr", {
                payload: { input: Schema.String },
                success: Schema.String,
                error: Schema.Number,
                body: ({ input }) => Node.succeed(input)
              })
              let threw = false
              try {
                Pattern.decorate(base, () => badErrFlow)
              } catch (e) {
                threw = e instanceof PatternError.PatternError && e.code === "invalid_decorator"
              }
              return threw
            }
            // noEffects: template without effects decorated by flow without effects (and clipped with no effects)
            const wrapped = Pattern.decorate(base, function namedDec(inner) {
              return inner
            })
            const clip = Pattern.clipped(base, base)
            return wrapped._tag.includes("namedDec") && clip.capabilities.length === 0 && !clip.mode && !clip.tier
          }),
        { seed: seed + 140, executions: runs(0.25) }
      )
    )
  })
})
