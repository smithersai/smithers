/**
 * The engine-store hot-path metrics: scheduler admissions and node outcomes,
 * dispatch outcomes with latency, sandbox executions, materializations and
 * their conflicts, and the boundary-settlement classification — all landing
 * in the registry the caller provided, with the instrumented effect's exit
 * preserved byte-identically.
 */
import { Jj } from "@smthrs/kernel"
import { KeyMaterial, Plan } from "@smthrs/plan"
import { type Ownership, RunStore } from "@smthrs/run-store"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Metric from "effect/Metric"
import * as Tracer from "effect/Tracer"
import { describe, expect, it } from "vitest"
import * as EngineStoreMetrics from "../src/EngineStoreMetrics.ts"
import * as PlanScheduler from "../src/PlanScheduler.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import * as WorkspaceSandbox from "../src/WorkspaceSandbox.ts"
import { runPromise } from "./Sha256.ts"

const owner: Ownership.OwnerId = { hostId: "metrics-host", pid: 17, nonce: "metrics-process" }

const jjLayer = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ commitId: "metrics-snapshot" as never, changeId: "metrics-snapshot" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

const draft = (id: string): Plan.NodeDraft => ({
  id,
  material: {
    version: KeyMaterial.version,
    kind: "sealed",
    body: { action: id },
    inputs: [],
    layers: [],
    capabilities: []
  },
  effects: { reads: [], writes: [`${id}.out`], boundaryMode: "hard" }
})

const count = (metric: Metric.Metric<number, Metric.CounterState<number>>) =>
  Effect.map(Metric.value(metric), (state) => state.count)

const activate = (runId: string) =>
  Effect.gen(function*() {
    const runs = yield* RunStore.RunStore
    yield* runs.create(runId, "{}")
    const row = yield* runs.get(runId)
    const snapshot = { status: row.status, owner: row.owner, heartbeatAtMs: row.heartbeatAtMs }
    const claim = yield* runs.claim(runId, snapshot, owner, 1)
    /* v8 ignore next */
    if (claim._tag !== "Claimed") return yield* Effect.die(new Error("claim lost"))
    const activated = yield* runs.activate(runId, owner, claim.claimedAtMs, snapshot)
    /* v8 ignore next */
    if (activated._tag !== "Activated") return yield* Effect.die(new Error("activation lost"))
  })

describe("EngineStoreMetrics", () => {
  it("counts scheduler rounds, node outcomes, dispatches, and boundary settlements", async () => {
    const spans: Array<Tracer.NativeSpan> = []
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options)
        spans.push(span)
        return span
      }
    })
    const plan = await runPromise(Plan.compile({
      planId: "plan-metrics",
      flow: "example/Metrics",
      nodes: [draft("left"), draft("right")]
    }))
    const executor: PlanScheduler.Executor = {
      execute: ({ node }) => Effect.succeed({ ran: node.id })
    }
    const program = Effect.gen(function*() {
      yield* activate("run-metrics")
      const service = PlanScheduler.make({ runId: "run-metrics", owner, sourceId: "scheduler/run-metrics" })
      const report = yield* service.run(plan)
      return {
        report,
        admissions: yield* count(EngineStoreMetrics.schedulerAdmissions),
        built: yield* count(EngineStoreMetrics.node.built),
        failed: yield* count(EngineStoreMetrics.node.failed),
        dispatched: yield* count(EngineStoreMetrics.dispatch.Success),
        settledClean: yield* count(EngineStoreMetrics.boundarySettlement.Clean),
        dispatchDurations: yield* Effect.map(
          Metric.value(EngineStoreMetrics.dispatchDuration),
          (state) => state.count
        ),
        schedulerDispatchDurations: yield* Effect.map(
          Metric.value(EngineStoreMetrics.schedulerDispatchDuration),
          (state) => state.count
        )
      }
    }).pipe(
      Effect.provide(Layer.mergeAll(
        StepBoundary.layerTest(),
        jjLayer,
        PlanScheduler.layerExecutor(executor)
      )),
      Effect.provide(TestStores.layer()),
      Effect.provideService(Tracer.Tracer, tracer),
      Effect.provideService(Metric.MetricRegistry, new Map())
    )

    const observed = await runPromise(program)
    expect(observed.report.settlements.map((settlement) => settlement.outcome)).toEqual(["built", "built"])
    // Both nodes are independent, so the initial admission pass launches
    // them together; the settlement-driven passes that follow admit nothing
    // and must not count.
    expect(observed.admissions).toBe(1)
    expect(observed.built).toBe(2)
    expect(observed.failed).toBe(0)
    expect(observed.dispatched).toBe(2)
    expect(observed.settledClean).toBe(2)
    expect(observed.dispatchDurations).toBe(2)
    expect(observed.schedulerDispatchDurations).toBe(2)

    const runSpan = spans.find((span) => span.name === "PlanScheduler.run")
    expect(runSpan?.attributes.get("runId")).toBe("run-metrics")
    expect(runSpan?.attributes.get("planId")).toBe("plan-metrics")
    expect(runSpan?.attributes.get("admissions")).toBe(1)
    expect(runSpan?.attributes.get("outcome")).toBe("success")

    const dispatchSpans = spans.filter((span) => span.name === "PlanScheduler.dispatch")
    expect(dispatchSpans).toHaveLength(2)
    expect(dispatchSpans.map((span) => span.attributes.get("nodeId")).sort()).toEqual(["left", "right"])
    expect(dispatchSpans.every((span) => span.attributes.get("outcome") === "built")).toBe(true)

    const persisted = spans.filter((span) => span.name === "ActionPersistence.execute")
    expect(persisted).toHaveLength(2)
    expect(persisted.every((span) => span.attributes.get("runId") === "run-metrics")).toBe(true)
    expect(persisted.every((span) => span.attributes.get("attempt") === 1)).toBe(true)
    expect(persisted.every((span) => span.attributes.get("tier") === "sealed")).toBe(true)
    expect(persisted.every((span) => span.attributes.get("outcome") === "success")).toBe(true)

    const boundary = spans.find((span) => span.name === "StepBoundary.prepare")
    expect(boundary?.attributes.get("runId")).toBe("run-metrics")
    expect(boundary?.attributes.get("stepKey")).toEqual(expect.any(String))
    expect(boundary?.attributes.get("attempt")).toBe(1)
  })

  it("classifies a settle-time host refusal as a refused boundary settlement", async () => {
    const plan = await runPromise(Plan.compile({
      planId: "plan-refused",
      flow: "example/Refused",
      nodes: [draft("only")]
    }))
    const executor: PlanScheduler.Executor = {
      execute: ({ node }) => Effect.succeed({ ran: node.id })
    }
    // Prepare succeeds so the dispatch reaches settlement; the settle itself
    // is the host refusal being classified.
    const refusingBoundary = Layer.succeed(
      StepBoundary.StepBoundary,
      StepBoundary.make({
        prepare: (descriptor) => Effect.succeed({ descriptor, readSnapshot: [] }),
        settle: () =>
          Effect.fail(
            new StepBoundary.UnsupportedBoundary({
              code: "unsupported_boundary",
              message: "the host cannot settle"
            })
          ),
        replayOutputs: () => Effect.void
      })
    )
    const program = Effect.gen(function*() {
      yield* activate("run-refused")
      const service = PlanScheduler.make({ runId: "run-refused", owner, sourceId: "scheduler/run-refused" })
      const report = yield* service.run(plan)
      return {
        report,
        refused: yield* count(EngineStoreMetrics.boundarySettlement.Refused)
      }
    }).pipe(
      Effect.provide(Layer.mergeAll(
        refusingBoundary,
        jjLayer,
        PlanScheduler.layerExecutor(executor)
      )),
      Effect.provide(TestStores.layer()),
      Effect.provideService(Metric.MetricRegistry, new Map())
    )

    const observed = await runPromise(program)
    expect(observed.report.settlements.map((settlement) => settlement.outcome)).toEqual(["failed"])
    expect(observed.refused).toBe(1)
  })

  it("counts sandbox executions, materializations, and copy-back conflicts", async () => {
    const program = Effect.gen(function*() {
      const sandbox = yield* WorkspaceSandbox.makeMemory({})
      const descriptor = {
        readSet: [],
        writeSet: ["out.txt"],
        boundaryMode: "hard" as const
      }
      const first = yield* sandbox.service.execute({
        descriptor,
        workflow: Effect.gen(function*() {
          const workspace = yield* WorkspaceSandbox.Workspace
          yield* workspace.writeFile("out.txt", new TextEncoder().encode("one"))
          return "first"
        })
      })
      const second = yield* sandbox.service.execute({
        descriptor,
        workflow: Effect.gen(function*() {
          const workspace = yield* WorkspaceSandbox.Workspace
          yield* workspace.writeFile("out.txt", new TextEncoder().encode("two"))
          return "second"
        })
      })
      /* v8 ignore next 3 */
      if (first._tag !== "Accepted" || second._tag !== "Accepted") {
        return yield* Effect.die(new Error("expected accepted executions"))
      }
      yield* sandbox.service.materialize(first)
      // The second transaction diffed against the pre-first base, so its
      // compare-and-set must refuse — that refusal is the conflict counter.
      const conflicted = yield* sandbox.service.materialize(second).pipe(Effect.exit)
      return {
        conflicted,
        executions: yield* count(EngineStoreMetrics.sandboxExecution.Success),
        materialized: yield* count(EngineStoreMetrics.materialization.Success),
        refused: yield* count(EngineStoreMetrics.materialization.Failure),
        conflicts: yield* count(EngineStoreMetrics.materializationConflicts)
      }
    }).pipe(Effect.provideService(Metric.MetricRegistry, new Map()))

    const observed = await runPromise(program)
    expect(Exit.isFailure(observed.conflicted)).toBe(true)
    expect(observed.executions).toBe(2)
    expect(observed.materialized).toBe(1)
    expect(observed.refused).toBe(1)
    expect(observed.conflicts).toBe(1)
  })

  it("observe preserves the instrumented effect's exit — value, cause, and interruption", async () => {
    const spans: Array<Tracer.NativeSpan> = []
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options)
        spans.push(span)
        return span
      }
    })
    const timer = Metric.timer("engine_store_metrics_test_duration")
    const counter = Metric.counter("engine_store_metrics_test_total")
    const views = {
      Success: Metric.withAttributes(counter, { outcome: "success" }),
      Failure: Metric.withAttributes(counter, { outcome: "failure" }),
      Interrupt: Metric.withAttributes(counter, { outcome: "interrupt" })
    }
    const observe = EngineStoreMetrics.observe({ timer, counter: views })
    const defect = new Error("boom")

    const program = Effect.gen(function*() {
      // Capture the four exits without a surrounding tracing frame so the
      // equality below isolates `observe` itself: no span may decorate the
      // cause being compared.
      const succeeded = yield* observe(Effect.succeed("value"))
      const failed = yield* observe(Effect.fail("typed")).pipe(Effect.exit)
      const died = yield* observe(Effect.die(defect)).pipe(Effect.exit)
      const interrupted = yield* observe(Effect.interrupt).pipe(Effect.exit)
      const observed = {
        succeeded,
        failed,
        died,
        interrupted,
        success: yield* count(views.Success),
        failure: yield* count(views.Failure),
        interrupt: yield* count(views.Interrupt),
        durations: yield* Effect.map(Metric.value(timer), (state) => state.count)
      }
      // A second set runs under spans solely to assert the attributes. Their
      // exits are intentionally discarded; the metric snapshot above remains
      // the exact four-operation assertion.
      yield* Effect.withSpan(observe(Effect.succeed("span")), "Observe.success").pipe(Effect.asVoid)
      yield* Effect.withSpan(observe(Effect.fail("span")), "Observe.failure").pipe(Effect.exit)
      yield* Effect.withSpan(observe(Effect.die("span")), "Observe.defect").pipe(Effect.exit)
      yield* Effect.withSpan(observe(Effect.interrupt), "Observe.interrupt").pipe(Effect.exit)
      return observed
    }).pipe(
      Effect.provideService(Tracer.Tracer, tracer),
      Effect.provideService(Metric.MetricRegistry, new Map())
    )

    const observed = await runPromise(program)
    expect(observed.succeeded).toBe("value")
    expect(observed.failed).toEqual(Exit.fail("typed"))
    // The original cause travels through untouched: the defect is the same
    // object, not a copy or a message.
    expect(Exit.isFailure(observed.died) && Cause.hasDies(observed.died.cause)).toBe(true)
    expect(Exit.isFailure(observed.interrupted) && Cause.hasInterruptsOnly(observed.interrupted.cause)).toBe(true)
    expect(observed.success).toBe(1)
    // The typed failure and the defect both classify as `failure`; only an
    // interrupt-only cause classifies as `interrupt`.
    expect(observed.failure).toBe(2)
    expect(observed.interrupt).toBe(1)
    expect(observed.durations).toBe(4)
    expect(spans.find((span) => span.name === "Observe.success")?.attributes.get("outcome")).toBe("success")
    expect(spans.find((span) => span.name === "Observe.failure")?.attributes.get("outcome")).toBe("failure")
    expect(spans.find((span) => span.name === "Observe.defect")?.attributes.get("outcome")).toBe("failure")
    expect(spans.find((span) => span.name === "Observe.interrupt")?.attributes.get("outcome")).toBe("interrupt")
  })
})
