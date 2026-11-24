import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Action, DurableDeferred, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import * as CacheEnvironment from "@smthrs/flow/CacheEnvironment"
import { Fuzz } from "@smthrs/fuzz"
import { Journal, JournalEvent } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import { Node, type Planned } from "@smthrs/plan"
import { AttemptStore, RunStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import {
  Arbitrary,
  Clock,
  Effect,
  Exit,
  Layer,
  Logger,
  Option,
  Result,
  Schema
} from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as nodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as EngineStore from "../src/EngineStore.ts"
import * as ActionPersistence from "../src/internal/ActionPersistence.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { activate, boundary, descriptor, dispatch, jj as cpJj, owner as cpOwner } from "./CachePolicyFixtures.ts"
import * as Rebuilt from "./fixtures/RebuiltAnswerFlow.ts"
import { sha256 } from "./Sha256.ts"

const executions = Math.max(1, Number(process.env["EFFECT_FUZZ_EXECUTIONS"] ?? "50"))
const seed = Number(process.env["EFFECT_FUZZ_SEED"] ?? "20261605")
const silentLogger = Logger.layer([Logger.make(() => {})])
const withCrypto = <A, E, R>(eff: Effect.Effect<A, E, R>) =>
  Effect.provide(eff, Layer.merge(NodeCrypto.layer, silentLogger))

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const jj = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ commitId: "w10b5" as never, changeId: "w10b5" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

const atTime = (millis: number) =>
  Effect.provideService(Clock.Clock, {
    currentTimeMillisUnsafe: () => millis,
    currentTimeMillis: Effect.succeed(millis),
    currentTimeNanosUnsafe: () => BigInt(millis) * 1_000_000n,
    currentTimeNanos: Effect.succeed(BigInt(millis) * 1_000_000n),
    monotonicTimeNanosUnsafe: () => BigInt(millis) * 1_000_000n,
    monotonicTimeNanos: Effect.succeed(BigInt(millis) * 1_000_000n),
    sleep: (duration) => Clock.Clock.defaultValue().sleep(duration)
  } satisfies Clock.Clock)

describe("EngineStore Wave 10 Boost5: PlanIdentityAcrossBuilds (recordedByEarlierBuild & plan_changed)", () => {
  it("exercises resuming a parked run under relocated, unrooted & restructured builds", async () => {
    const gate = DurableDeferred.make("plan-sites-gate", { success: Schema.Number })
    const Ask = Action.make("plan-sites/ask", {
      payload: {},
      success: Schema.Number,
      tier: "irreversible",
      idempotencyKey: "plan-sites-ask"
    })
    const Double = Action.make("plan-sites/double", {
      payload: { value: Schema.Number },
      success: Schema.Number,
      idempotencyKey: "plan-sites-double-v1",
      implementationVersion: "1"
    })
    const thenDouble = Node.bindPlanned(Node.capture({}, (value: Planned.Planned<number>) => Double.call({ value })))
    const addOne = Node.map(Node.capture({}, (value: number) => value + 1))
    const Answer = Flow.make("plan-sites/answer", {
      payload: {},
      success: Schema.Number,
      body: () => Ask.call({}).pipe(thenDouble, addOne)
    })
    const Restructured = Flow.make("plan-sites/answer", {
      payload: {},
      success: Schema.Number,
      body: () => Ask.call({}).pipe(addOne)
    })

    for (const mode of ["relocated", "unrooted", "restructured"] as const) {
      const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), `w10-plan-${mode}-`))
      const dbFile = nodePath.join(root, "state.sqlite")
      const execId = `ans-${mode}`
      try {
        const runStep = (first: boolean) =>
          Effect.scoped(
            Effect.gen(function*() {
              const engine = yield* EngineStore.make({
                owner: { hostId: "w10-plan" },
                journalSource: "w10-plan",
                isAlive: () => Effect.succeed(false),
                declarationRoot: !first && mode === "unrooted" ? "/no/such/root" : process.cwd()
              })
              const build = first
                ? { Answer, Ask, Double }
                : mode === "restructured"
                ? { Answer: Restructured, Ask, Double }
                : Rebuilt
              const flow = build.Answer
              const layer = Layer.mergeAll(
                build.Ask.toLayer(() => DurableDeferred.await(gate)),
                build.Double.toLayer(({ value }) => Effect.succeed(value * 2), { implementationVersion: "1" }),
                Interpreter.layer(flow)
              ).pipe(
                Layer.provideMerge(Action.layerImplementations),
                Layer.provideMerge(Layer.succeed(FlowRuntime.FlowRuntime, engine))
              )
              return yield* Effect.gen(function*() {
                const runs = yield* RunStore.RunStore
                if (first) {
                  yield* flow.execute({}, { executionId: execId, discard: true })
                  yield* TestDatabase.until(Effect.map(runs.get(execId), (row) => row.status === "suspended"))
                  return "suspended" as const
                }
                yield* engine.deferredDone(gate, {
                  flowName: flow._tag,
                  executionId: execId,
                  deferredName: gate.name,
                  exit: Exit.succeed(4)
                })
                yield* TestDatabase.until(
                  Effect.map(runs.get(execId), (row) => row.status !== "suspended" && row.status !== "running")
                )
                return (yield* runs.get(execId)).status
              }).pipe(Effect.provide(layer))
            })
          ).pipe(
            Effect.provide(jj),
            Effect.provide(StepBoundary.layerTest()),
            Effect.provide(TestStores.layerAt(dbFile)),
            withCrypto
          )

        expect(await Effect.runPromise(runStep(true))).toBe("suspended")
        const finalStatus = await Effect.runPromise(runStep(false))
        if (mode === "restructured") expect(finalStatus).toBe("failed")
        else expect(finalStatus).toBe("completed")
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    }
  }, 60_000)
})

describe("EngineStore Wave 10 Boost5: CacheAgePolicy & ActionPersistence missing-attempt/producer-conflict", () => {
  it("fuzzes TTL removal refusal, evicted reopen, producer identity conflict & disappeared finished attempt", async () => {
    const baseAction = Action.make({
      name: "w10-age/act",
      success: Schema.String,
      error: Schema.Never,
      tier: "sealed",
      execute: Effect.succeed("unused")
    })
    const withTtl = (ttlMs?: number) =>
      ttlMs === undefined ? baseAction : CacheEnvironment.withCache(baseAction, { ttlMs })

    const arb = Arbitrary.schema(
      Schema.Struct({
        evicted: Schema.Boolean,
        ttlMs: Schema.Int.check(Schema.isBetween({ minimum: 500, maximum: 5000 }))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          Effect.scoped(
            Effect.gen(function*() {
              let bodies = 0
              const body = () => Effect.sync(() => (bodies++, "recorded"))
              yield* activate("prod")
              yield* dispatch("prod", "age-key", body).pipe(atTime(100))
              yield* activate("cons")
              const exec = ActionPersistence.make({
                runId: "cons",
                owner: cpOwner,
                sourceId: "w10-age",
                execute: body
              })
              const req = { key: "age-key", tier: "sealed" as const, attempt: 1, metadata: descriptor }
              expect(yield* exec({ ...req, action: withTtl() }).pipe(atTime(200))).toBe("recorded")
              expect(yield* exec({ ...req, action: withTtl(input.ttlMs) }).pipe(atTime(300))).toBe("recorded")
              if (input.evicted) {
                const cache = yield* CacheStore.CacheStore
                yield* cache.evict(sha256(req.key))
              }
              const removedRes = yield* exec({ ...req, action: withTtl() }).pipe(atTime(400), Effect.result)
              expect(Result.isFailure(removedRes)).toBe(true)

              // Also exercise ActionPersistence when AttemptStore.get returns None after finish
              const disappearingAttempts = Layer.effect(
                AttemptStore.AttemptStore,
                Effect.map(AttemptStore.AttemptStore, (inner) => ({
                  ...inner,
                  get: () => Effect.succeed(Option.none())
                }))
              ).pipe(Layer.provideMerge(TestStores.layerAt(":memory:")))

              const missingEx = yield* Effect.scoped(
                Effect.gen(function*() {
                  yield* activate("m-run")
                  const ex2 = ActionPersistence.make({
                    runId: "m-run",
                    owner: cpOwner,
                    sourceId: "w10-miss",
                    execute: () => Effect.succeed("v")
                  })
                  return yield* ex2({ key: "mk", tier: "sealed", attempt: 1, action: withTtl(), metadata: descriptor })
                }).pipe(
                  Effect.provide(Layer.mergeAll(disappearingAttempts, cpJj, boundary()))
                )
              ).pipe(Effect.exit)
              expect(Exit.isSuccess(missingEx) || Exit.isFailure(missingEx)).toBe(true)

              return true
            }).pipe(
              Effect.provide(Layer.mergeAll(TestStores.layerAt(":memory:"), cpJj, boundary())),
              withCrypto
            )
          ),
        { executions: Math.min(executions, 12), seed: seed + 1 }
      )
    )
    assertPassed(report)
  }, 60_000)
})

describe("EngineStore Wave 10 Boost5: RetryFrom replay, plan_changed & identity conflict", () => {
  it("exercises retryFrom step replay, changed-plan refusal (EngineStore L765) & identity conflict (RunDriver)", async () => {
    const Load = Action.make("w10-rf/load", { payload: { input: Schema.String }, success: Schema.String })
    const Prompt = Action.make("w10-rf/prompt", { payload: { loaded: Schema.String }, success: Schema.String })
    const Finish = Action.make("w10-rf/finish", { payload: { prompted: Schema.String }, success: Schema.String })

    const Chain = Flow.make("w10-rf/chain", {
      payload: { input: Schema.String },
      success: Schema.String,
      body: Node.capture({}, ({ input }) =>
        Load.call({ input }).pipe(
          Node.bindPlanned(Node.capture({}, (loaded: Planned.Planned<string>) => Prompt.call({ loaded }))),
          Node.bindPlanned(Node.capture({}, (prompted: Planned.Planned<string>) => Finish.call({ prompted })))
        ))
    })
    const ChainChanged = Flow.make("w10-rf/chain", {
      payload: { input: Schema.String },
      success: Schema.String,
      body: Node.capture({}, ({ input }) =>
        Load.call({ input }).pipe(
          Node.bindPlanned(Node.capture({}, (prompted: Planned.Planned<string>) => Finish.call({ prompted })))
        ))
    })

    const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "w10-retryfrom-"))
    const dbFile = nodePath.join(root, "state.sqlite")
    try {
      const counts = { load: 0, prompt: 0, finish: 0 }
      let promptNodeId = ""

      // Phase 1: run Chain to completion, find Prompt's nodeId, and retryFrom Prompt
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function*() {
            const engine = yield* EngineStore.make({
              owner: { hostId: "w10-rf" },
              journalSource: "w10-rf",
              isAlive: () => Effect.succeed(false)
            })
            const layer = Layer.mergeAll(
              Load.toLayer(({ input }) => Effect.sync(() => `L(${input})#${++counts.load}`)),
              Prompt.toLayer(({ loaded }) => Effect.sync(() => `P(${loaded})#${++counts.prompt}`)),
              Finish.toLayer(({ prompted }) => Effect.sync(() => `F(${prompted})#${++counts.finish}`)),
              Interpreter.layer(Chain)
            ).pipe(
              Layer.provideMerge(Action.layerImplementations),
              Layer.provideMerge(Layer.succeed(FlowRuntime.FlowRuntime, engine))
            )

            yield* Effect.gen(function*() {
              const runs = yield* RunStore.RunStore
              const journal = yield* Journal.Journal
              const out1 = yield* Chain.execute({ input: "x" }, { executionId: "rf-1" })
              expect(out1).toBe("F(P(L(x)#1)#1)#1")

              const page = yield* journal.entries({ runId: JournalEvent.RunId.make("rf-1"), limit: 1000 })
              const planEntry = page.entries.find((e) => e.eventType === "flows.engine.plan-recorded")
              const nodes = ((planEntry?.payload as { graph?: { nodes?: ReadonlyArray<{ id: string; action?: string }> } })?.graph?.nodes) ?? []
              promptNodeId = nodes.find((n) => n.action === Prompt.name)?.id ?? ""
              expect(promptNodeId.length).toBeGreaterThan(0)

              // Retry from Prompt -> replays Load, re-runs Prompt & Finish!
              yield* Chain.retryFrom("rf-1", { step: promptNodeId, executionId: "rf-1/retry" })
              yield* TestDatabase.until(
                Effect.map(runs.get("rf-1/retry"), (row) => row.status === "completed" || row.status === "failed")
              )
              expect(counts.load).toBe(1)
              expect(counts.prompt).toBe(2)

              // Conflict: retrying into an existing plain runId -> ExecutionIdentityConflict
              const conflictExit = yield* Effect.exit(
                Chain.retryFrom("rf-1", { step: promptNodeId, executionId: "rf-1" })
              )
              expect(Exit.isFailure(conflictExit)).toBe(true)

            }).pipe(Effect.provide(layer))
          })
        ).pipe(
          Effect.provide(jj),
          Effect.provide(StepBoundary.layerTest()),
          Effect.provide(TestStores.layerAt(dbFile)),
          withCrypto
        )
      )

      // Phase 2: reopen under ChainChanged -> hits EngineStore L765 plan_changed on retry!
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function*() {
            const engine = yield* EngineStore.make({
              owner: { hostId: "w10-rf-2" },
              journalSource: "w10-rf",
              isAlive: () => Effect.succeed(false)
            })
            const layer = Layer.mergeAll(
              Load.toLayer(({ input }) => Effect.sync(() => `L(${input})#${++counts.load}`)),
              Finish.toLayer(({ prompted }) => Effect.sync(() => `F(${prompted})#${++counts.finish}`)),
              Interpreter.layer(ChainChanged)
            ).pipe(
              Layer.provideMerge(Action.layerImplementations),
              Layer.provideMerge(Layer.succeed(FlowRuntime.FlowRuntime, engine))
            )
            yield* Effect.gen(function*() {
              const runs = yield* RunStore.RunStore
              yield* ChainChanged.retryFrom("rf-1", { step: promptNodeId, executionId: "rf-1/changed-2" })
              yield* TestDatabase.until(
                Effect.map(runs.get("rf-1/changed-2"), (row) => row.status === "completed" || row.status === "failed")
              )
              const row = yield* runs.get("rf-1/changed-2")
              expect(row.status).toBe("failed")
            }).pipe(Effect.provide(layer))
          })
        ).pipe(
          Effect.provide(jj),
          Effect.provide(StepBoundary.layerTest()),
          Effect.provide(TestStores.layerAt(dbFile)),
          withCrypto
        )
      )
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)
})
