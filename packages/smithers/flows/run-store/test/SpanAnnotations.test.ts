/**
 * Every `Effect.fn` span in this package carries identifying attributes:
 * `Effect.annotateCurrentSpan` runs at the top of each operation, so a trace
 * viewer can tell which run a span operated on without reading its SQL.
 */
import { DurableWriter } from "@smthrs/database"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Effect, Fiber, Layer, Metric, Tracer } from "effect"
import { TestClock } from "effect/testing"
import type * as SqlClient from "effect/unstable/sql/SqlClient"
import { describe, expect, it } from "vitest"
import { AttemptStore } from "../src/AttemptStore.ts"
import * as AttemptStoreLive from "../src/AttemptStore.ts"
import * as Migrations from "../src/Migrations.ts"
import { RunStore } from "../src/RunStore.ts"
import * as RunStoreLive from "../src/RunStore.ts"

const migrated = <A, E>(
  effect: Effect.Effect<A, E, DurableWriter.DurableWriter | SqlClient.SqlClient | RunStore | AttemptStore>
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(Layer.merge(RunStoreLive.layer, AttemptStoreLive.layer)),
      Effect.provide(Migrations.layer),
      Effect.provide(TestDatabase.layer),
      Effect.provide(TestClock.layer()),
      Effect.provideService(Metric.MetricRegistry, new Map())
    )
  )

describe("SpanAnnotations", () => {
  it("annotates RunStore operation spans with the run id", async () => {
    const spans: Array<Tracer.NativeSpan> = []
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options)
        spans.push(span)
        return span
      }
    })

    await migrated(
      Effect.gen(function*() {
        const store = yield* RunStore
        yield* store.create("run-span", "{}")
        yield* store.get("run-span")
      }).pipe(Effect.provideService(Tracer.Tracer, tracer))
    )

    const createSpan = spans.find((span) => span.name === "RunStore.create")
    expect(createSpan).toBeDefined()
    expect(createSpan!.attributes.get("runId")).toBe("run-span")
    const getSpan = spans.find((span) => span.name === "RunStore.get")
    expect(getSpan).toBeDefined()
    expect(getSpan!.attributes.get("runId")).toBe("run-span")
  })

  it("closes create, get, and requestCancel spans with an outcome", async () => {
    const spans: Array<Tracer.NativeSpan> = []
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options)
        spans.push(span)
        return span
      }
    })

    await migrated(
      Effect.gen(function*() {
        const store = yield* RunStore
        yield* store.create("run-exit", "{}")
        yield* store.get("run-exit")
        const cancel = yield* store.requestCancel("run-exit", 7)
        expect(cancel._tag).toBe("CancelRequested")
        yield* Effect.exit(store.get("run-exit-missing"))
      }).pipe(Effect.provideService(Tracer.Tracer, tracer))
    )

    const outcomes = spans
      .filter((span) => span.name.startsWith("RunStore."))
      .map((span) => [span.name, span.attributes.get("outcome")])
    expect(outcomes).toEqual([
      ["RunStore.create", "success"],
      ["RunStore.get", "success"],
      ["RunStore.requestCancel", "cancel_requested"],
      ["RunStore.get", "failure"]
    ])
  })

  it("closes an interrupted operation span with the interrupt outcome", async () => {
    const spans: Array<Tracer.NativeSpan> = []
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options)
        spans.push(span)
        return span
      }
    })
    // A writer that never completes parks `create` mid-operation, so the
    // interruption below lands while its span is still open.
    const hangingWriter = Layer.succeed(DurableWriter.DurableWriter)(
      DurableWriter.DurableWriter.of({ write: () => Effect.never })
    )

    await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* RunStore
        const fiber = yield* store.create("run-interrupted", "{}").pipe(
          Effect.forkChild({ startImmediately: true })
        )
        yield* Effect.yieldNow
        yield* Fiber.interrupt(fiber)
      }).pipe(
        Effect.provideService(Tracer.Tracer, tracer),
        Effect.provide(RunStoreLive.layer.pipe(Layer.provide(hangingWriter))),
        Effect.provide(Migrations.layer),
        Effect.provide(TestDatabase.layer),
        Effect.provide(TestClock.layer()),
        Effect.provideService(Metric.MetricRegistry, new Map())
      )
    )

    const created = spans.find((span) => span.name === "RunStore.create")
    expect(created).toBeDefined()
    expect(created!.attributes.get("outcome")).toBe("interrupt")
  })

  it("annotates domain outcomes and failures without replacing the operation exit", async () => {
    const spans: Array<Tracer.NativeSpan> = []
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options)
        spans.push(span)
        return span
      }
    })
    const owner = { hostId: "span-host", pid: 1, nonce: "span-nonce" }

    const failure = await migrated(
      Effect.gen(function*() {
        const store = yield* RunStore
        yield* store.create("run-outcome", "{}")
        const outcome = yield* store.claimAndOwn(
          "run-outcome",
          { status: "pending", owner: null, heartbeatAtMs: null },
          owner,
          1
        )
        expect(outcome._tag).toBe("Activated")
        return yield* Effect.exit(store.transitionOwned("run-outcome", owner, "completed", "not-json"))
      }).pipe(Effect.provideService(Tracer.Tracer, tracer))
    )

    expect(failure._tag).toBe("Failure")
    expect(spans.find((span) => span.name === "RunStore.claimAndOwn")!.attributes.get("outcome")).toBe("activated")
    expect(spans.find((span) => span.name === "RunStore.transitionOwned")!.attributes.get("outcome")).toBe("failure")
  })

  it("annotates every AttemptStore span with the attempt identity, the owner host, and an outcome", async () => {
    const spans: Array<Tracer.NativeSpan> = []
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options)
        spans.push(span)
        return span
      }
    })
    const owner = { hostId: "attempt-host", pid: 1, nonce: "attempt-nonce" }
    const id = { runId: "run-attempt-span", stepKeyDigest: "step-digest", attempt: 1 }

    await migrated(
      Effect.gen(function*() {
        const runs = yield* RunStore
        const attempts = yield* AttemptStore
        yield* runs.create(id.runId, "{}")
        const owned = yield* runs.claimAndOwn(
          id.runId,
          { status: "pending", owner: null, heartbeatAtMs: null },
          owner,
          1
        )
        expect(owned._tag).toBe("Activated")
        const put = yield* attempts.put({ ...id, state: "running", startedAtMs: 1, meta: {} }, owner)
        expect(put._tag).toBe("Inserted")
        const beat = yield* attempts.heartbeat(id.runId, id.stepKeyDigest, id.attempt, owner, 2)
        expect(beat._tag).toBe("Updated")
        const patched = yield* attempts.patch(id, { meta: { note: "span" } }, owner)
        expect(patched._tag).toBe("Patched")
        const finished = yield* attempts.finish({ ...id, state: "completed", finishedAtMs: 3 }, owner)
        expect(finished._tag).toBe("Finished")
        yield* attempts.get(id)
        // A terminal state on `finish` is required, so `running` fails before any write.
        const failure = yield* Effect.exit(attempts.finish({ ...id, state: "running", finishedAtMs: 4 }, owner))
        expect(failure._tag).toBe("Failure")
      }).pipe(Effect.provideService(Tracer.Tracer, tracer))
    )

    const attributes = spans
      .filter((span) => span.name.startsWith("AttemptStore."))
      .map((span) => [span.name, Object.fromEntries(span.attributes)])
    const identity = { runId: id.runId, stepKeyDigest: id.stepKeyDigest, attempt: id.attempt }
    expect(attributes).toEqual([
      ["AttemptStore.put", { ...identity, ownerHostId: owner.hostId, outcome: "inserted" }],
      ["AttemptStore.heartbeat", { ...identity, ownerHostId: owner.hostId, outcome: "updated" }],
      ["AttemptStore.patch", { ...identity, ownerHostId: owner.hostId, outcome: "patched" }],
      ["AttemptStore.finish", { ...identity, ownerHostId: owner.hostId, outcome: "finished" }],
      ["AttemptStore.get", { ...identity, outcome: "success" }],
      ["AttemptStore.finish", { ...identity, ownerHostId: owner.hostId, outcome: "failure" }]
    ])
  })

  it("annotates acknowledgeCancel with the run id, the owner host, and an outcome", async () => {
    const spans: Array<Tracer.NativeSpan> = []
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options)
        spans.push(span)
        return span
      }
    })
    const owner = { hostId: "ack-host", pid: 1, nonce: "ack-nonce" }

    await migrated(
      Effect.gen(function*() {
        const runs = yield* RunStore
        yield* runs.create("run-ack", "{}")
        const owned = yield* runs.claimAndOwn(
          "run-ack",
          { status: "pending", owner: null, heartbeatAtMs: null },
          owner,
          1
        )
        expect(owned._tag).toBe("Activated")
        const cancel = yield* runs.requestCancel("run-ack", 2)
        expect(cancel._tag).toBe("CancelRequested")
        const acknowledged = yield* runs.acknowledgeCancel("run-ack", owner, 3)
        expect(acknowledged).toBe(true)
        const stranger = yield* runs.acknowledgeCancel("run-ack", { ...owner, nonce: "other" }, 4)
        expect(stranger).toBe(false)
        const failure = yield* Effect.exit(runs.acknowledgeCancel("run-ack", owner, -1))
        expect(failure._tag).toBe("Failure")
      }).pipe(Effect.provideService(Tracer.Tracer, tracer))
    )

    const attributes = spans
      .filter((span) => span.name === "RunStore.acknowledgeCancel")
      .map((span) => Object.fromEntries(span.attributes))
    expect(attributes).toEqual([
      { runId: "run-ack", ownerHostId: owner.hostId, outcome: "success" },
      { runId: "run-ack", ownerHostId: owner.hostId, outcome: "success" },
      { runId: "run-ack", ownerHostId: owner.hostId, outcome: "failure" }
    ])
  })
})
