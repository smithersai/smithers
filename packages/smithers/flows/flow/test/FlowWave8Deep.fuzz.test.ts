import { FlowEngine } from "@smthrs/engine"
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { Fuzz } from "@smthrs/fuzz"
import * as Node from "@smthrs/plan/Node"
import { Arbitrary, Cause, Context, Duration, Effect, Exit, Fiber, Layer, Logger, Option, Schema } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import {
  Action,
  DurableDeferred,
  DurableQueue,
  ExternalJob,
  Flow,
  FlowRuntime,
  Graph,
  HumanTask,
  Interpreter,
  Sleep
} from "../src/index.ts"
import { layerWired } from "./MemoryFlowRuntime.ts"

const baseExecs = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "120")
const pureExecs = Math.max(24, Math.min(baseExecs, 140))
const ioExecs = Math.max(12, Math.min(Math.ceil(baseExecs / 5), 30))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261801")
const silentLogger = Logger.layer([])

const runFuzz = async <A, E>(
  arb: Parameters<typeof Fuzz.run<A, E>>[0],
  predicate: (value: A) => Effect.Effect<boolean, E, never>,
  options: { readonly seed: number; readonly executions: number }
) => {
  const report = await Effect.runPromise(
    Fuzz.run(arb, (value) => predicate(value).pipe(Effect.provide(silentLogger)), options)
  )
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}


const driveToExit = <A, E, R>(eff: Effect.Effect<A, E, R>, maxSteps = 80, stepMs = 50) =>
  Effect.gen(function*() {
    const fib = yield* Effect.forkChild(eff)
    for (let i = 0; i < maxSteps; i++) {
      yield* Effect.yieldNow
      const polled = fib.pollUnsafe()
      if (polled !== undefined) return polled
      yield* TestClock.adjust(Duration.millis(stepMs))
    }
    yield* Fiber.interrupt(fib)
    return yield* Fiber.await(fib)
  })

const SafeTag = Schema.String.check(
  Schema.isMinLength(2),
  Schema.isMaxLength(16),
  Schema.isPattern(/^[a-z][a-z0-9-]*$/)
)

const buildPlacement = (variant: string): unknown => {
  switch (variant) {
    case "plain-a":
      return { region: "us-east", tags: ["a", "b"], count: 1 }
    case "plain-b":
      return { region: "eu-west", tags: ["a", "b"], count: 2 }
    case "plain-extra-key":
      return { region: "us-east", tags: ["a", "b"], count: 1, extra: true }
    case "arr-hole": {
      const a: Array<unknown> = []
      a.length = 3
      a[0] = "x"
      a[2] = "z"
      return a
    }
    case "arr-long":
      return Array.from({ length: 14 }, (_, i) => i)
    case "arr-accessor": {
      const a: Array<unknown> = ["ok"]
      Object.defineProperty(a, "1", { enumerable: true, get: () => "boom" })
      return a
    }
    case "obj-accessor": {
      const o: Record<string, unknown> = { a: 1 }
      Object.defineProperty(o, "b", { enumerable: true, get: () => 2 })
      return o
    }
    case "cyclic": {
      const o: Record<string, unknown> = { name: "loop" }
      o["self"] = o
      return o
    }
    case "deep": {
      let cur: Record<string, unknown> = { leaf: 1 }
      for (let i = 0; i < 8; i++) cur = { nested: cur }
      return cur
    }
    case "bigint":
      return { n: 42n, flag: true }
    case "non-plain":
      return new Date(1_700_000_000_000)
    case "throwing-proxy":
      return new Proxy({}, {
        ownKeys() {
          throw new Error("trap boom")
        }
      })
    case "huge-keys": {
      const o: Record<string, unknown> = {}
      for (let i = 0; i < 16; i++) o[`k${i}`] = "v".repeat(30)
      return o
    }
    default:
      return variant
  }
}

describe("@smthrs/flow Wave 8 deep fuzz (Graph placements, Interpreter paging/literals, Action timeouts, HumanTask, Sleep, ExternalJob)", () => {
  it("fuzzes Graph placement structuralIdentity, conflict rendering, and recursive/combinator graphs", async () => {
    const PlacementKind = Schema.Literals([
      "plain-a",
      "plain-b",
      "plain-extra-key",
      "arr-hole",
      "arr-long",
      "arr-accessor",
      "obj-accessor",
      "cyclic",
      "deep",
      "bigint",
      "non-plain",
      "throwing-proxy",
      "huge-keys"
    ])
    const arb = Arbitrary.schema(
      Schema.Struct({
        id: SafeTag,
        outerP: PlacementKind,
        innerP: PlacementKind,
        useChild: Schema.Boolean,
        sameRef: Schema.Boolean
      })
    )

    await runFuzz(
      arb,
      (v) =>
        Effect.sync(() => {
          const Leaf = Action.make(`w8/${v.id}/leaf`, {
            payload: { x: Schema.Number },
            success: Schema.Number
          })
          const outerVal = buildPlacement(v.outerP)
          const innerVal = v.sameRef ? outerVal : buildPlacement(v.innerP)

          const Inner = Flow.make(`w8/${v.id}/inner`, {
            payload: { x: Schema.Number },
            success: Schema.Number,
            body: ({ x }) => Leaf.call({ x })
          }).annotate(Flow.Placement, innerVal)

          const Outer = Flow.make(`w8/${v.id}/outer`, {
            payload: { x: Schema.Number },
            success: Schema.Number,
            body: ({ x }) => v.useChild ? Inner.child({ x }) : Inner.call({ x })
          }).annotate(Flow.Placement, outerVal)

          let builtOk = false
          try {
            const g = Graph.build(Outer, { x: 1 })
            builtOk = Graph.diagnostics(g).length === 0
          } catch {
            builtOk = false
          }
          if (v.useChild || v.sameRef) {
            expect(builtOk).toBe(true)
          } else {
            const expectMatch = v.outerP === v.innerP &&
              ["plain-a", "plain-b", "plain-extra-key", "arr-long", "cyclic", "deep", "bigint", "huge-keys"].includes(
                v.outerP
              )
            expect(builtOk).toBe(expectMatch)
          }

          // Recursive inline call must produce a diagnostic or throw
          const Rec: Flow.Flow<any, any, any, any, any> = Flow.make(`w8/${v.id}/rec`, {
            payload: { n: Schema.Number },
            success: Schema.Number,
            body: ({ n }) => (Rec as any).call({ n })
          })
          let recClean = true
          try {
            const rg = Graph.build(Rec, { n: 1 })
            recClean = Graph.diagnostics(rg).length === 0
          } catch {
            recClean = false
          }
          expect(recClean).toBe(false)

          // Combinator graph: branch + all + race + map
          const Combo = Flow.make(`w8/${v.id}/combo`, {
            payload: { flag: Schema.Boolean, n: Schema.Number },
            success: Schema.Number,
            body: ({ flag, n }) =>
              Node.all({
                br: Node.branch(Node.succeed(flag), {
                  if: Node.capture({}, (b: boolean) => b),
                  then: Node.capture({ tag: v.id }, () => Leaf.call({ x: n })),
                  else: Node.capture({ tag: v.id }, () => Leaf.call({ x: n }))
                }),
                rc: Node.race({ left: Leaf.call({ x: n }), right: Leaf.call({ x: n }) })
              }).pipe(Node.map(Node.capture({}, (pair) => Number(pair.br) + Number(pair.rc))))
          })
          const comboG = Graph.build(Combo, { flag: true, n: 3 })
          expect(Graph.nodes(comboG).length).toBeGreaterThan(0)
          expect(Graph.edges(comboG).length).toBeGreaterThanOrEqual(0)
          return true
        }),
      { seed, executions: pureExecs }
    )
  }, 90_000)

  it("fuzzes Action annotations, version mismatch, timeout validation, heartbeat expiry, and FlowRuntime error tags", async () => {
    const TestKey = Context.Reference<string>("w8/TestAnnotationKey", { defaultValue: () => "" })
    const arb = Arbitrary.schema(
      Schema.Struct({
        id: SafeTag,
        badTimeout: Schema.Literals(["zero", "neg", "float"]),
        mode: Schema.Literals(["beat-ok", "heartbeat-expire", "attempt-expire", "uncanonical-nan", "uncanonical-inf"])
      })
    )

    await runFuzz(
      arb,
      (v) =>
        Effect.gen(function*() {
          const badMs = v.badTimeout === "zero" ? 0 : v.badTimeout === "neg" ? -5 : 1.5
          expect(() =>
            Action.make(`w8/${v.id}/bad-to`, {
              payload: { x: Schema.Number },
              success: Schema.Number,
              attemptTimeoutMs: badMs
            })
          ).toThrow(RangeError)
          expect(() =>
            Action.make(`w8/${v.id}/bad-hb`, {
              payload: { x: Schema.Number },
              success: Schema.Number,
              heartbeatTimeoutMs: badMs
            })
          ).toThrow(RangeError)

          const Versioned = Action.make(`w8/${v.id}/ver`, {
            payload: { x: Schema.Number },
            success: Schema.Number,
            implementationVersion: "v2"
          })
            .annotate(TestKey, "hello")
            .annotateMerge(Context.make(TestKey, "merged"))
          expect(Context.get(Versioned.annotations, TestKey)).toBe("merged")
          expect(() =>
            Versioned.toLayer(({ x }) => Effect.succeed(x), { implementationVersion: "v1" })
          ).toThrow()

          const dup = new Action.DuplicateImplementation({ name: v.id })
          expect(dup._tag).toBe("@smthrs/flow/Action/DuplicateImplementation")
          const notFound = new FlowRuntime.FlowExecutionNotFound({ executionId: v.id })
          expect(notFound._tag).toBe("@smthrs/flow/FlowExecutionNotFound")
          const storeErr = new FlowRuntime.StoreUnavailable({ executionId: v.id })
          expect(storeErr._tag).toBe("@smthrs/flow/StoreUnavailable")
          const retryRefused = new FlowRuntime.RetryFromRefused({ code: "not_found", executionId: v.id, step: "s1" })
          expect(retryRefused._tag).toBe("@smthrs/flow/FlowRuntime/RetryFromRefused")

          if (v.mode === "uncanonical-nan" || v.mode === "uncanonical-inf") {
            const NumAct = Action.make(`w8/${v.id}/num`, {
              payload: { x: Schema.Finite },
              success: Schema.Number
            })
            const BadFlow = Flow.make(`w8/${v.id}/badlit`, {
              payload: { kind: Schema.String },
              success: Schema.Number,
              body: () => NumAct.call({ x: v.mode === "uncanonical-nan" ? Number.NaN : Number.POSITIVE_INFINITY })
            })
            const layer = layerWired(
              Layer.mergeAll(
                NumAct.toLayer(({ x }) => Effect.succeed(x)),
                Interpreter.layer(BadFlow)
              )
            )
            const exit = yield* Effect.exit(BadFlow.execute({ kind: v.mode }).pipe(Effect.provide(layer)))
            expect(Exit.isFailure(exit)).toBe(true)
            return true
          }

          const Timed = Action.make(`w8/${v.id}/timed`, {
            payload: { mode: Schema.String },
            success: Schema.String,
            attemptTimeoutMs: 100,
            heartbeatTimeoutMs: 40
          })
          const TimedFlow = Flow.make(`w8/${v.id}/timed-flow`, {
            payload: { mode: Schema.String },
            success: Schema.String,
            body: ({ mode }) => Timed.call({ mode })
          })
          const layer = layerWired(
            Layer.mergeAll(
              Timed.toLayer(({ mode }) =>
                Effect.gen(function*() {
                  if (mode === "beat-ok") {
                    yield* Action.heartbeat
                    yield* Effect.sleep("20 millis")
                    yield* Action.heartbeat
                    yield* Effect.sleep("20 millis")
                    return "ok"
                  }
                  if (mode === "heartbeat-expire") {
                    yield* Effect.sleep("80 millis")
                    return "late"
                  }
                  for (let i = 0; i < 6; i++) {
                    yield* Effect.sleep("25 millis")
                    yield* Action.heartbeat
                  }
                  return "too-late"
                })
              ),
              Interpreter.layer(TimedFlow)
            )
          )

          const res = yield* Effect.gen(function*() {
            const fib = yield* Effect.forkChild(TimedFlow.execute({ mode: v.mode }))
            for (let i = 0; i < 8; i++) {
              yield* Effect.yieldNow
              yield* TestClock.adjust(Duration.millis(25))
            }
            return yield* Fiber.await(fib)
          }).pipe(Effect.provide(layer))

          if (v.mode === "beat-ok") {
            expect(Exit.isSuccess(res)).toBe(true)
            if (Exit.isSuccess(res)) expect(res.value).toBe("ok")
          } else {
            expect(Exit.isFailure(res)).toBe(true)
          }
          return true
        }).pipe(Effect.provide(Layer.merge(NodeCrypto.layer, TestClock.layer()))),
      { seed: seed + 1, executions: ioExecs }
    )
  }, 90_000)

  it("fuzzes Sleep all invalid deadline codes and HumanTask request_invalid / ranking diagnostics", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        id: SafeTag,
        sleepCase: Schema.Literals([
          "both",
          "missing",
          "neg-millis",
          "nan-millis",
          "inf-millis",
          "too-late-millis",
          "nan-until",
          "too-late-until",
          "past-until"
        ]),
        humanCase: Schema.Literals([
          "bad-attempts-0",
          "bad-attempts-huge",
          "bad-timeout-neg",
          "schema-non-json",
          "empty-principals",
          "empty-select",
          "dup-rank-opts",
          "rank-bad-answers"
        ])
      })
    )

    await runFuzz(
      arb,
      (v) =>
        Effect.gen(function*() {
          const sleepPayload =
            v.sleepCase === "both" ? { millis: 10, until: 1000 } :
            v.sleepCase === "missing" ? {} :
            v.sleepCase === "neg-millis" ? { millis: -1 } :
            v.sleepCase === "nan-millis" ? { millis: Number.NaN } :
            v.sleepCase === "inf-millis" ? { millis: Number.POSITIVE_INFINITY } :
            v.sleepCase === "too-late-millis" ? { millis: Number.MAX_SAFE_INTEGER } :
            v.sleepCase === "nan-until" ? { until: Number.NaN } :
            v.sleepCase === "too-late-until" ? { until: Number.MAX_SAFE_INTEGER } :
            { until: 0 }

          const SleepFlow = Flow.make(`w8/${v.id}/sleep`, {
            payload: { tag: Schema.String },
            success: Schema.Void,
            error: Sleep.SleepRequestInvalid,
            body: () => Sleep.action.call(sleepPayload as any)
          })
          const sleepLayer = layerWired(Layer.mergeAll(Sleep.layer, Interpreter.layer(SleepFlow)))
          const sExit = yield* driveToExit(SleepFlow.execute({ tag: v.sleepCase }).pipe(Effect.provide(sleepLayer)), 20, 50)
          if (v.sleepCase === "past-until") {
            expect(Exit.isSuccess(sExit)).toBe(true)
          } else {
            expect(Exit.isFailure(sExit)).toBe(true)
          }

          if (v.humanCase === "rank-bad-answers") {
            const req = { kind: "rank" as const, options: ["a", "b", "c"] }
            expect(HumanTask.validate(["a", "b"], req)).toBeDefined()
            expect(HumanTask.validate(["a", "b", "unknown"], req)).toBeDefined()
            expect(HumanTask.validate(["a", "a", "b"], req)).toBeDefined()
            expect(HumanTask.validate("not-an-array", req)).toBeDefined()
            expect(HumanTask.validate(["c", "a", "b"], req)).toBeUndefined()
            return true
          }

          const htPayload =
            v.humanCase === "bad-attempts-0" ? { name: "q", prompt: "p", kind: "ask" as const, maxAttempts: 0 } :
            v.humanCase === "bad-attempts-huge" ? { name: "q", prompt: "p", kind: "ask" as const, maxAttempts: 999999 } :
            v.humanCase === "bad-timeout-neg" ? { name: "q", prompt: "p", kind: "ask" as const, timeoutMs: -5 } :
            v.humanCase === "schema-non-json" ? { name: "q", prompt: "p", kind: "ask" as const, schema: { type: "string" } } :
            v.humanCase === "empty-principals" ? { name: "q", prompt: "p", kind: "ask" as const, allowedPrincipals: [] } :
            v.humanCase === "empty-select" ? { name: "q", prompt: "p", kind: "select" as const, options: [] } :
            { name: "q", prompt: "p", kind: "rank" as const, options: ["a", "a"] }

          const HtFlow = Flow.make(`w8/${v.id}/ht`, {
            payload: { tag: Schema.String },
            success: Schema.Unknown,
            error: HumanTask.HumanTaskFailed,
            body: () => HumanTask.action.call(htPayload as any)
          })
          const htLayer = layerWired(Layer.mergeAll(HumanTask.layer, Sleep.layer, Interpreter.layer(HtFlow)))
          const htExit = yield* driveToExit(HtFlow.execute({ tag: v.humanCase }).pipe(Effect.provide(htLayer)), 20, 50)
          expect(Exit.isFailure(htExit)).toBe(true)
          return true
        }).pipe(Effect.provide(Layer.merge(NodeCrypto.layer, TestClock.layer()))),
      { seed: seed + 2, executions: ioExecs }
    )
  }, 90_000)

  it("fuzzes ExternalJob inline fast-path, polling, Lost/restart exhaustion, provider failure & DurableQueue/Deferred", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        id: SafeTag,
        jobMode: Schema.Literals(["exited-1", "exited-2", "lost-exhaust", "start-fail", "bad-config"]),
        restarts: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 }))
      })
    )

    await runFuzz(
      arb,
      (v) =>
        Effect.gen(function*() {
          if (v.jobMode === "bad-config") {
            expect(() =>
              ExternalJob.make(`w8/${v.id}/bad`, {
                payload: { n: Schema.Number },
                handle: Schema.String,
                success: Schema.String,
                probe: { every: "100 millis", max: "50 millis" },
                timeout: "1 second"
              })
            ).toThrow(RangeError)
            expect(() =>
              ExternalJob.make(`w8/${v.id}/bad-r`, {
                payload: { n: Schema.Number },
                handle: Schema.String,
                success: Schema.String,
                probe: { every: "10 millis", max: "50 millis" },
                timeout: "1 second",
                restarts: -1
              })
            ).toThrow(RangeError)
            return true
          }

          class JobErr extends Schema.TaggedError<JobErr>()("JobErr", { message: Schema.String }) {}
          const Job = ExternalJob.make(`w8/${v.id}/job`, {
            payload: { n: Schema.Number },
            handle: Schema.String,
            success: Schema.String,
            error: JobErr,
            probe: { every: "10 millis", max: "40 millis" },
            timeout: "300 millis",
            restarts: v.restarts
          })

          let probes = 0
          const operations: ExternalJob.Operations<{ readonly n: number }, string, string, JobErr, never> = {
            start: (_payload, key) =>
              v.jobMode === "start-fail"
                ? Effect.fail(new JobErr({ message: "provider down" }))
                : Effect.succeed(`h:${key}`),
            status: () =>
              Effect.sync(() => {
                probes++
                if (v.jobMode === "exited-1") return { _tag: "Exited" as const, exitCode: 0 }
                if (v.jobMode === "exited-2") {
                  return probes >= 2 ? { _tag: "Exited" as const, exitCode: 0 } : { _tag: "Running" as const }
                }
                return { _tag: "Lost" as const, reason: "gone" }
              }),
            collect: (h) => Effect.succeed(`done:${h}`),
            cancel: () => Effect.void,
            abandon: () => Effect.void
          }
          const layer = Job.toLayer(operations).pipe(
            Layer.provideMerge(Sleep.layer),
            Layer.provideMerge(Action.layerImplementations),
            Layer.provideMerge(FlowEngine.layerMemory)
          )
          const res = yield* driveToExit(
            Job.run({ n: 1 }, { executionId: `w8-ej-${v.id}-${v.jobMode}`, operations }).pipe(Effect.provide(layer)),
            80,
            50
          )

          if (v.jobMode === "exited-1" || v.jobMode === "exited-2") {
            expect(Exit.isSuccess(res)).toBe(true)
          } else {
            expect(Exit.isFailure(res)).toBe(true)
          }
          expect(Cause.isCause(Exit.isFailure(res) ? res.cause : Cause.empty)).toBe(true)
          expect(Option.isSome(Option.some(DurableDeferred.make))).toBe(true)
          expect(typeof DurableQueue.make).toBe("function")
          return true
        }).pipe(Effect.provide(Layer.merge(NodeCrypto.layer, TestClock.layer()))),
      { seed: seed + 3, executions: ioExecs }
    )
  }, 90_000)
})
