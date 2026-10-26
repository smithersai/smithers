import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
/**
 * Usage metrics through the full durable composition (`@smthrs/flow`
 * `RunMetrics`): every run the engine admits and settles is counted by its
 * flow, outcome and code, the door and actor kind its starter named, and the
 * store's placement, with its duration, the wait before its first step, its
 * steps and retries and its durable waits, into the metric registry and the
 * loggers the caller provided. A run another run starts is door `flow` by the
 * same kind of actor. No payload, result or failure message reaches a metric
 * attribute or a log line.
 */
import { describe, expect, it } from "@effect/vitest"
import { FlowEngine } from "@smthrs/engine"
import { Action, DurableDeferred, Flow, type FlowRuntime, RetryPolicy, RunMetrics } from "@smthrs/flow"
import { Jj } from "@smthrs/kernel"
import { RunStore } from "@smthrs/run-store"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import type * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import * as Metric from "effect/Metric"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as EngineStore from "../src/EngineStore.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { withCrypto } from "./Sha256.ts"

const jj = Jj.make({
  snapshot: () => Effect.succeed({ commitId: "usage-snapshot" as never, changeId: "usage-snapshot" as never }),
  restore: () => Effect.void,
  diff: () => Effect.succeed(""),
  workspaceAdd: () => Effect.void,
  workspaceForget: () => Effect.void,
  status: () => Effect.succeed("")
})

const SENTINEL = "SENTINEL-usage-payload"

class Boom extends Schema.TaggedError<Boom>()("Usage/Boom", { detail: Schema.String }) {}

const Gated = Flow.make("Usage/Gated", {
  payload: { note: Schema.String },
  success: Schema.String,
  body: opaqueHandlerBody
})
const Child = Flow.make("Usage/Child", { payload: {}, success: Schema.String, body: opaqueHandlerBody })
const Fails = Flow.make("Usage/Fails", {
  payload: { note: Schema.String },
  success: Schema.String,
  error: Boom,
  body: opaqueHandlerBody
})
const Waits = Flow.make("Usage/Waits", { payload: {}, success: Schema.String, body: opaqueHandlerBody })

type Services =
  | Layer.Success<ReturnType<typeof TestStores.layer>>
  | StepBoundary.Service
  | DurableEngineState.DurableEngineState
  | Jj.Jj
  | Crypto.Crypto
  | Scope.Scope

type Line = ReturnType<typeof Logger.formatStructured.log>

/** Runs `body` over a durable engine placed in the browser, with a fresh registry and a log sink. */
const withEngine = <A, E>(
  body: (engine: FlowRuntime.FlowRuntime["Service"]) => Effect.Effect<A, E, Services>
) => {
  const lines: Array<Line> = []
  const sink = Logger.make((options) => {
    lines.push(Logger.formatStructured.log(options))
  })
  return withCrypto(
    Effect.scoped(
      Effect.gen(function*() {
        // The host asks for Info lines where it builds the engine, as the browser host does; a caller that starts a
        // run, such as the leader's request handler, never names a level.
        const engine = (yield* EngineStore.make({
          owner: { hostId: "usage-host" },
          journalSource: "usage-test",
          isAlive: () => Effect.succeed(false),
          placement: "browser"
        }).pipe(Effect.provide(RunMetrics.layerInfoLines))) as FlowRuntime.FlowRuntime["Service"]
        const value = yield* body(engine)
        return { value, snapshot: yield* Metric.snapshot, lines }
      }).pipe(
        Effect.provideService(DurableEngineState.DurableEngineState, DurableEngineState.makeMemory()),
        Effect.provideService(Jj.Jj, jj)
      )
    ).pipe(
      Effect.provide(StepBoundary.layerTest()),
      Effect.provide(TestStores.layer()),
      Effect.provide(Logger.layer([sink])),
      Effect.provideService(Metric.MetricRegistry, new Map())
    )
  )
}

type Snapshot = ReadonlyArray<Metric.Metric.Snapshot>

/** Each series of `id`: its attributes and its count. */
const counts = (snapshot: Snapshot, id: string): ReadonlyArray<Readonly<Record<string, unknown>>> =>
  snapshot
    .filter((entry) => entry.id === id)
    .map((entry) => ({ ...entry.attributes, count: (entry.state as { readonly count: number }).count }))

/** Waits, on the real clock, until `condition` holds: the engine's retry timers and wakes run on it. */
const until = <E, R>(condition: Effect.Effect<boolean, E, R>) =>
  Effect.gen(function*() {
    while (!(yield* condition)) yield* Effect.sleep("5 millis")
  }).pipe(Effect.timeout("20 seconds"), Effect.orDie)

const untilStatus = (executionId: string, statuses: ReadonlyArray<RunStore.RunStatus>) =>
  Effect.flatMap(RunStore.RunStore, (store) =>
    until(
      store.get(executionId).pipe(
        Effect.map((row) => statuses.includes(row.status)),
        Effect.catch(() => Effect.succeed(false))
      )
    ))

describe("usage metrics", () => {
  it.live("count runs, steps, retries and waits by flow, door, actor and placement, and never the payload", () =>
    Effect.gen(function*() {
      const gate = DurableDeferred.make("usage-gate", { success: Schema.String })
      const forever = DurableDeferred.make("usage-forever", { success: Schema.String })
      let flakyRuns = 0
      const flaky = Action.make({
        name: "usage-flaky",
        success: Schema.String,
        error: Schema.String,
        tier: "sealed",
        retryPolicy: RetryPolicy.make({ initialMs: 1, factor: 1, maxMs: 1, maxAttempts: 3 }),
        execute: Effect.suspend(() => ++flakyRuns === 1 ? Effect.fail(`boom ${SENTINEL}`) : Effect.succeed("ok"))
      })
      const childStep = Action.make({
        name: "usage-child-step",
        success: Schema.String,
        execute: Effect.succeed("child")
      })
      const boom = Action.make({
        name: "usage-boom",
        success: Schema.String,
        error: Boom,
        execute: Effect.fail(new Boom({ detail: SENTINEL }))
      })

      const { value, snapshot, lines } = yield* withEngine((engine) =>
        Effect.gen(function*() {
          yield* engine.register(Child, () => childStep)
          yield* engine.register(Gated, () =>
            Effect.gen(function*() {
              yield* flaky
              const child = yield* Child.execute({}, { executionId: "usage-child" })
              const opened = yield* DurableDeferred.await(gate)
              return `${child}:${opened}`
            }).pipe(Effect.orDie))
          yield* engine.register(Fails, () => boom)
          yield* engine.register(Waits, () => DurableDeferred.await(forever))

          // A person's button starts the gated run; it retries a step, starts a child, and parks on the gate.
          const gated = yield* engine.execute(Gated, { executionId: "usage-gated", payload: { note: SENTINEL } }).pipe(
            RunMetrics.withOrigin({ door: "button", actor: "person" }),
            Effect.forkChild({ startImmediately: true })
          )
          yield* until(Effect.sync(() => flakyRuns >= 2))
          yield* untilStatus("usage-child", ["completed"])
          yield* untilStatus("usage-gated", ["suspended"])
          yield* engine.deferredDone(gate, {
            flowName: Gated._tag,
            executionId: "usage-gated",
            deferredName: gate.name,
            exit: Exit.succeed("open")
          })
          const answered = yield* Fiber.join(gated)

          // An API call starts one that fails with its declared error.
          const failed = yield* Effect.exit(
            engine.execute(Fails, { executionId: "usage-fails", payload: { note: SENTINEL } }).pipe(
              RunMetrics.withOrigin({ door: "api", actor: "app" })
            )
          )

          // An unlabelled start parks on a gate nobody opens, and is cancelled.
          yield* engine.execute(Waits, { executionId: "usage-waits", payload: {}, discard: true })
          yield* untilStatus("usage-waits", ["suspended"])
          // The row is visible before the driver's park receipt finishes.
          // Cancel only after the wait this test measures was recorded.
          yield* until(Metric.snapshot.pipe(Effect.map((snapshot) =>
            counts(snapshot, "flows_waits").some((series) => series.flow === "Usage/Waits")
          )))
          yield* engine.interrupt(Waits, "usage-waits")
          yield* untilStatus("usage-waits", ["cancelled"])

          // A run an earlier build admitted carries no origin: it settles as unknown, untimed.
          const store = yield* RunStore.RunStore
          yield* store.create(
            "usage-legacy",
            JSON.stringify({
              version: 1,
              flowName: Child._tag,
              payload: {},
              capabilityCeilings: yield* FlowEngine.requestedAuthority(Child)
            }),
            { lineageId: "usage-legacy", roundOrdinal: 0 }
          )
          const legacy = yield* engine.execute(Child, { executionId: "usage-legacy", payload: {} })
          return { answered, failed, legacy }
        })
      )

      expect(value.answered).toBe("child:open")
      expect(value.legacy).toBe("child")
      expect(Exit.isFailure(value.failed)).toBe(true)

      expect(counts(snapshot, "flows_runs_started")).toEqual(expect.arrayContaining([
        { flow: "Usage/Gated", door: "button", actor: "person", placement: "browser", count: 1 },
        { flow: "Usage/Child", door: "flow", actor: "person", placement: "browser", count: 1 },
        { flow: "Usage/Fails", door: "api", actor: "app", placement: "browser", count: 1 },
        { flow: "Usage/Waits", door: "unknown", actor: "unknown", placement: "browser", count: 1 }
      ]))
      expect(counts(snapshot, "flows_runs_started")).toHaveLength(4)
      expect(counts(snapshot, "flows_runs_settled")).toEqual(expect.arrayContaining([
        {
          flow: "Usage/Gated",
          door: "button",
          actor: "person",
          placement: "browser",
          outcome: "succeeded",
          code: "none",
          count: 1
        },
        {
          flow: "Usage/Child",
          door: "flow",
          actor: "person",
          placement: "browser",
          outcome: "succeeded",
          code: "none",
          count: 1
        },
        {
          flow: "Usage/Fails",
          door: "api",
          actor: "app",
          placement: "browser",
          outcome: "failed",
          code: "Usage/Boom",
          count: 1
        },
        {
          flow: "Usage/Waits",
          door: "unknown",
          actor: "unknown",
          placement: "browser",
          outcome: "cancelled",
          code: "cancelled",
          count: 1
        }
      ]))
      expect(counts(snapshot, "flows_runs_settled")).toContainEqual({
        flow: "Usage/Child",
        door: "unknown",
        actor: "unknown",
        placement: "browser",
        outcome: "succeeded",
        code: "none",
        count: 1
      })
      expect(counts(snapshot, "flows_runs_settled")).toHaveLength(5)
      // Admitted before this build, it was never counted as started, and its settlement has no duration.
      expect(counts(snapshot, "flows_runs_started")).not.toContainEqual(
        expect.objectContaining({ door: "unknown", flow: "Usage/Child" })
      )
      expect(lines.find((line) => line.annotations.executionId === "usage-legacy")?.annotations).not.toHaveProperty(
        "durationMs"
      )
      expect(counts(snapshot, "flows_run_duration_ms")).toEqual(expect.arrayContaining([
        { flow: "Usage/Gated", outcome: "succeeded", placement: "browser", count: 1 },
        { flow: "Usage/Fails", outcome: "failed", placement: "browser", count: 1 },
        { flow: "Usage/Waits", outcome: "cancelled", placement: "browser", count: 1 }
      ]))
      expect(counts(snapshot, "flows_run_first_step_ms")).toEqual(expect.arrayContaining([
        { flow: "Usage/Gated", placement: "browser", count: 1 },
        { flow: "Usage/Child", placement: "browser", count: 1 }
      ]))
      // The flaky step failed once and ran again: one retry, under the run's flow.
      expect(counts(snapshot, "flows_steps")).toEqual(expect.arrayContaining([
        { flow: "Usage/Gated", outcome: "failed", count: 1 },
        { flow: "Usage/Gated", outcome: "succeeded", count: 1 },
        { flow: "Usage/Child", outcome: "succeeded", count: 2 },
        { flow: "Usage/Fails", outcome: "failed", count: 1 }
      ]))
      expect(counts(snapshot, "flows_step_retries")).toEqual([{ flow: "Usage/Gated", count: 1 }])
      // Each failed attempt is one count and one Warn line by its code, never its message: the flaky step's string
      // failure has none, the declared failure is its tag.
      expect(counts(snapshot, "flows_step_failures")).toEqual(expect.arrayContaining([
        { flow: "Usage/Gated", code: "failed", count: 1 },
        { flow: "Usage/Fails", code: "Usage/Boom", count: 1 }
      ]))
      const stepFailures = lines.filter((line) => line.message === "flow.step.failed")
      expect(stepFailures.map((line) => [line.level, line.annotations.flow, line.annotations.code, line.annotations.attempt]))
        .toEqual(expect.arrayContaining([
          ["WARN", "Usage/Gated", "failed", 1],
          ["WARN", "Usage/Fails", "Usage/Boom", 1]
        ]))
      expect(stepFailures.every((line) => typeof line.annotations.runId === "string")).toBe(true)
      // The gate is a signal wait, parked once and ended once; the cancelled run parked and never resumed.
      expect(counts(snapshot, "flows_waits")).toEqual(expect.arrayContaining([
        { flow: "Usage/Gated", kind: "signal", count: 1 },
        { flow: "Usage/Waits", kind: "signal", count: 1 }
      ]))
      expect(counts(snapshot, "flows_wait_ms")).toEqual(expect.arrayContaining([
        { flow: "Usage/Gated", kind: "signal", count: 1 }
      ]))
      expect(counts(snapshot, "flows_wait_ms").filter((series) => series.flow === "Usage/Waits")).toEqual([])

      const usage = lines.filter((line) => line.message === "flow.run.started" || line.message === "flow.run.settled")
      expect(usage.map((line) => [line.message, line.annotations.flow, line.annotations.outcome ?? null])).toEqual(
        expect.arrayContaining([
          ["flow.run.started", "Usage/Gated", null],
          ["flow.run.settled", "Usage/Gated", "succeeded"],
          ["flow.run.settled", "Usage/Fails", "failed"],
          ["flow.run.settled", "Usage/Waits", "cancelled"]
        ])
      )
      const settledGated = usage.find((line) =>
        line.message === "flow.run.settled" && line.annotations.flow === "Usage/Gated"
      )
      expect(settledGated?.level).toBe("INFO")
      // Admission runs in the caller's fiber, yet writes at the level the engine's host chose.
      expect(
        usage.find((line) => line.message === "flow.run.started" && line.annotations.flow === "Usage/Gated")?.level
      ).toBe("INFO")
      expect(settledGated?.annotations).toMatchObject({
        executionId: "usage-gated",
        door: "button",
        placement: "browser"
      })
      expect(typeof settledGated?.annotations.durationMs).toBe("number")
      expect(
        usage.find((line) => line.annotations.flow === "Usage/Fails" && line.message === "flow.run.settled")?.level
      )
        .toBe("WARN")

      // No payload, result or failure message in any usage record.
      expect(JSON.stringify(usage)).not.toContain(SENTINEL)
      expect(JSON.stringify(snapshot.filter((entry) => entry.id.startsWith("flows_")).map((entry) => entry.attributes)))
        .not.toContain(SENTINEL)
    }))
})
