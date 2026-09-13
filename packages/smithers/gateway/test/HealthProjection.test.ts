import { Control } from "@smthrs/control/Control"
import type { ControlEvent, RunSummary } from "@smthrs/control/ControlSchema"
import * as Health from "@smthrs/control/Health"
import * as Monitor from "@smthrs/control/Monitor"
import * as TestControl from "@smthrs/control/test/TestControl"
import { Effect, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import * as GatewayProjection from "../src/GatewayProjection.ts"
import * as Projections from "../src/Projections.ts"
import { driverFence, stack } from "./GatewayStack.ts"

const summary: RunSummary = {
  runId: "health-run",
  flowId: "test",
  status: "running",
  createdAt: 0,
  updatedAt: 0,
  ownerId: "owner-one"
}
const reading = (run: RunSummary, overrides: Partial<Health.HealthObservation> = {}): Health.HealthObservation => ({
  subjectId: `run:${run.runId}`,
  state: run.status,
  checkerId: "semantic",
  monitorId: "one",
  incarnation: Health.runIncarnation(run),
  evidenceSeq: 0,
  observedAt: 0,
  expiresAt: 1000,
  durationMs: 0,
  outcome: "ok",
  baseHealth: "healthy",
  report: { activity: "working" },
  ...overrides
})
const event = (sequence: number, value: Health.HealthObservation): ControlEvent => ({
  runId: summary.runId,
  sequence,
  occurredAt: 0,
  kind: Health.statusObservedEventType,
  payload: Schema.encodeUnknownSync(Health.HealthObservation)(value) as ControlEvent["payload"]
})

describe("health through existing run projections", () => {
  it("preserves lifecycle without observations and expires a reading on the gateway clock", () => {
    expect(GatewayProjection.runSummary(summary, [], 0).statusRollup).toMatchObject({
      state: "running",
      activity: "unknown",
      freshness: "unobserved"
    })
    const events = [event(1, reading(summary))]
    expect(GatewayProjection.runSummary(summary, events, 999).statusRollup).toMatchObject({
      activity: "working",
      freshness: "fresh"
    })
    expect(GatewayProjection.runSummary(summary, events, 1000).statusRollup).toMatchObject({
      activity: "unknown",
      freshness: "stale"
    })
    expect(GatewayProjection.runSummary(summary, events, 1000)).toEqual(
      GatewayProjection.runSummary(summary, JSON.parse(JSON.stringify(events)), 1000)
    )
  })
  it("old-owner and malformed observations never color the current run", () => {
    const events = [event(1, reading(summary, { incarnation: "other-owner" })), {
      ...event(2, reading(summary)),
      payload: { report: "invalid" }
    }]
    expect(GatewayProjection.runSummary(summary, events, 0).statusRollup).toMatchObject({
      freshness: "unobserved",
      activity: "unknown"
    })
    expect(
      GatewayProjection.runSummary({ ...summary, status: "waiting-approval" }, [event(1, reading(summary))], 0)
        .statusRollup
    ).toMatchObject({ attention: "awaiting-approval", activity: "unknown" })
  })
  it("keeps summaries readable past 10,000 heartbeats and resumes a superseded issued cursor", async () => {
    await Effect.runPromise(
      Effect.gen(function*() {
        const control = yield* Control
        const events = Array.from({ length: 10_050 }, (_, index) => event(index + 1, reading(summary)))
        const source = {
          ...control,
          list: () => Effect.succeed({ _tag: "runs" as const, items: [summary] }),
          watch: (filter: Parameters<typeof control.watch>[0]) =>
            Stream.fromIterable(events.filter((item) => item.sequence > (filter.afterSequence ?? -1)))
        }
        const projections = yield* Projections.make(source)
        const selector = { _tag: "run-summary" as const, runId: summary.runId }
        const snapshot = yield* projections.snapshot(selector)
        expect(snapshot.rows).toHaveLength(1)
        expect(snapshot.rows[0]?.statusRollup?.provenance?.version).toBe(10_050)
        expect(snapshot.cursor.value).toBe(10_050)
        const resumed = yield* projections.subscribe(selector, { ...snapshot.cursor, value: 10_048 }).pipe(
          Stream.runCollect
        )
        expect(resumed.filter((frame) => frame._tag === "delta").map((frame) => frame.cursor.value)).toEqual([
          10_049,
          10_050
        ])
        // Raw event history retains its explicit resource boundary; only derived rows compact observations.
        expect((yield* Effect.flip(projections.snapshot({ _tag: "run-events", runId: summary.runId }))).code).toBe(
          "resource_limit"
        )
      }).pipe(Effect.provide(TestControl.layer()), Effect.scoped, Effect.provide(TestClock.layer()))
    )
  })
  it("runs a registered Effect checker and reads its real durable observation through the served projection", async () => {
    await Effect.runPromise(
      Effect.gen(function*() {
        const control = yield* Control
        const card = yield* control.plan({ flowId: "system/test", input: {} })
        yield* control.approve({ ...card.approval, idempotencyKey: "health-approve" })
        const accepted = yield* control.run({
          _tag: "Plan",
          planId: card.planId,
          digest: card.digest,
          envelope: card.envelope,
          idempotencyKey: "health-run"
        })
        if (accepted._tag !== "Accepted" || accepted.runId === undefined) return yield* Effect.die("run missing")
        const runId = accepted.runId
        yield* driverFence(runId)
        const healthCheck = Health.makeRegistry({
          checkers: [{ id: "semantic", probe: () => Effect.succeed({ activity: "working" }) }],
          bindings: { test: { checkerId: "semantic" } }
        }).resolve("test")
        yield* Monitor.run({ runId, healthCheck, intervalMs: 0, maxChecks: 1 })
        const projected = yield* (yield* Projections.Projections).snapshot({ _tag: "run-summary", runId })
        expect(projected.rows[0]?.statusRollup).toMatchObject({
          activity: "working",
          freshness: "fresh",
          provenance: { checkerId: "semantic" }
        })
      }).pipe(Effect.provide(stack()), Effect.scoped)
    )
  })
})
