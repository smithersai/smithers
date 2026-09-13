import { Deferred, Effect, Fiber, Stream } from "effect"
import { describe, expect, it } from "vitest"
import { Control } from "../src/Control.ts"
import { ControlRuntime } from "../src/ControlRuntime.ts"
import * as Health from "../src/Health.ts"
import * as Monitor from "../src/Monitor.ts"
import { durable, type DurableStack } from "./DurableStack.ts"

const run = <A, E>(body: Effect.Effect<A, E, DurableStack>) =>
  Effect.runPromise(body.pipe(Effect.provide(durable()), Effect.scoped, Effect.orDie))
const start = Effect.gen(function*() {
  const control = yield* Control
  const card = yield* control.plan({ flowId: "system/test", input: {} })
  yield* control.approve({ ...card.approval, idempotencyKey: "health-approve" })
  const receipt = yield* control.run({
    _tag: "Plan",
    planId: card.planId,
    digest: card.digest,
    envelope: card.envelope,
    idempotencyKey: "health-run"
  })
  if (receipt._tag !== "Accepted" || receipt.runId === undefined) return yield* Effect.die("run not accepted")
  yield* (yield* ControlRuntime).resume(receipt.runId)
  return receipt.runId
})

describe("configured Monitor over the durable control journal", () => {
  it("journals semantic observations before beats and never counts its own observations as progress", async () => {
    await run(Effect.gen(function*() {
      const runId = yield* start
      const report = yield* Monitor.run({
        runId,
        healthCheck: Health.makeRegistry().resolve("system/test"),
        intervalMs: 0,
        maxChecks: 3,
        stallBeats: 1
      })
      const events = yield* (yield* Control).watch({ runId, follow: false }).pipe(Stream.runCollect)
      expect(report.beats.map((beat) => beat.health)).toEqual(["healthy", "stalled", "stalled"])
      expect(new Set(report.beats.map((beat) => beat.sequence)).size).toBe(1)
      const observation = events.findIndex((event) => event.kind === Health.statusObservedEventType)
      const beat = events.findIndex((event) => event.kind === Monitor.beatEventType)
      expect(observation).toBeGreaterThanOrEqual(0)
      expect(observation).toBeLessThan(beat)
      expect(events[observation]?.payload).toMatchObject({
        subjectId: `run:${runId}`,
        activity: "unknown",
        outcome: "ok"
      })
    }))
  })
  it("coalesces unchanged checks and retains bounded reports in the production mode", async () => {
    await run(Effect.gen(function*() {
      const runId = yield* start
      const report = yield* Monitor.run({
        runId,
        healthCheck: Health.makeRegistry().resolve("system/test"),
        intervalMs: 0,
        maxChecks: 30,
        stallBeats: 100,
        recordBeats: false,
        retainBeats: 1
      })
      const events = yield* (yield* Control).watch({ runId, follow: false }).pipe(Stream.runCollect)
      expect(events.filter((event) => event.kind === Health.statusObservedEventType)).toHaveLength(1)
      expect(events.some((event) => event.kind === Monitor.beatEventType)).toBe(false)
      expect(report.beats).toHaveLength(1)
      expect(report.beats[0]?.beat).toBe(29)
    }))
  })
  it("discards a late result after authoritative cancellation", async () => {
    await run(Effect.gen(function*() {
      const runId = yield* start
      const began = yield* Deferred.make<void>()
      const finish = yield* Deferred.make<void>()
      const healthCheck = Health.makeRegistry({
        checkers: [{
          id: "delayed",
          probe: () =>
            Deferred.succeed(began, undefined).pipe(
              Effect.andThen(Deferred.await(finish)),
              Effect.as({ activity: "working" as const })
            )
        }],
        bindings: { flow: { checkerId: "delayed" } }
      }).resolve("flow")
      const fiber = yield* Monitor.run({ runId, healthCheck, intervalMs: 0, maxChecks: 1 }).pipe(
        Effect.forkChild({ startImmediately: true })
      )
      yield* Deferred.await(began)
      yield* (yield* Control).cancel({ runId, reason: "test", idempotencyKey: "cancel-during-check" })
      yield* Deferred.succeed(finish, undefined)
      yield* Fiber.join(fiber)
      const events = yield* (yield* Control).watch({ runId, follow: false }).pipe(Stream.runCollect)
      const recorded = events.find((event) => event.kind === Health.statusObservedEventType)
      expect(recorded?.payload).toMatchObject({ outcome: "discarded", reason: "owner-changed" })
      expect(recorded?.payload).not.toHaveProperty("report")
      expect((yield* (yield* ControlRuntime).getRun(runId)).status).toBe("cancelled")
    }))
  })
  it("explicit working contributes observational progress without changing legacy remedy authority", async () => {
    await run(Effect.gen(function*() {
      const runId = yield* start
      const healthCheck = Health.makeRegistry({
        checkers: [{ id: "semantic", probe: () => Effect.succeed({ activity: "working" }) }],
        bindings: { flow: { checkerId: "semantic" } }
      }).resolve("flow")
      const report = yield* Monitor.run({
        runId,
        healthCheck,
        intervalMs: 0,
        maxChecks: 3,
        stallBeats: 1,
        recordBeats: false
      })
      const events = yield* (yield* Control).watch({ runId, follow: false }).pipe(Stream.runCollect)
      expect(report.health).toBe("stalled")
      expect(
        events.filter((event) => event.kind === Health.statusObservedEventType).every((event) =>
          typeof event.payload === "object" && event.payload !== null && "health" in event.payload &&
          event.payload.health === "healthy"
        )
      ).toBe(true)
      expect((yield* (yield* ControlRuntime).getRun(runId)).status).toBe("accepted")
    }))
  })
  it.each(["quota", "timer", "event"])("classifies a known %s wait without a stall", (waitingReason) => {
    expect(
      Monitor.classify({
        summary: { runId: "one", flowId: "test", status: "parked", waitingReason, createdAt: 0, updatedAt: 0 },
        events: [],
        beatsWithoutProgress: 999,
        stallBeats: 1
      })
    ).toBe("healthy")
  })
})
