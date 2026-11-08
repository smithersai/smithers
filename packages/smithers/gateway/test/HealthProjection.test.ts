import { Control } from "@smthrs/control/Control"
import { PersistenceError } from "@smthrs/control/ControlError"
import { ControlRuntime } from "@smthrs/control/ControlRuntime"
import type { ControlEvent, RunSummary } from "@smthrs/control/ControlSchema"
import * as Health from "@smthrs/control/Health"
import * as Monitor from "@smthrs/control/Monitor"
import * as TestControl from "@smthrs/control/test/TestControl"
import { Deferred, Effect, Fiber, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import * as GatewayProjection from "../src/GatewayProjection.ts"
import * as Projections from "../src/Projections.ts"
import { driverFence, emit, stack } from "./GatewayStack.ts"

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

const launch = Effect.gen(function*() {
  const control = yield* Control
  const runtime = yield* ControlRuntime
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
  const fence = yield* driverFence(accepted.runId)
  yield* runtime.writeStatus(accepted.runId, fence, "running")
  return yield* runtime.getRun(accepted.runId)
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

  it("ignores bookkeeping as progress and classifies a reading without stored base health", () => {
    const { baseHealth: _baseHealth, ...observation } = reading(summary)
    const observed = event(1, observation)
    const beat = { ...observed, sequence: 2, kind: Monitor.beatEventType, payload: {} }
    expect(GatewayProjection.statusRollup(summary, [observed, beat], 0)).toMatchObject({
      activity: "working",
      health: "healthy",
      freshness: "fresh"
    })
    expect(GatewayProjection.statusRollup(summary, [observed, { ...beat, kind: "control.agent.turn-opened" }], 0))
      .toMatchObject({ activity: "unknown", health: "unknown", freshness: "stale" })
  })

  it("compacts durable observations without replacing newer evidence or losing resume positions", async () => {
    await Effect.runPromise(
      Effect.gen(function*() {
        const run = yield* launch
        const projections = yield* Projections.Projections
        const selector = { _tag: "run-summary" as const, runId: run.runId }
        const initial = yield* projections.snapshot(selector)
        const observation = reading(run, { evidenceSeq: initial.cursor.value })
        yield* emit(run.runId, Health.statusObservedEventType, observation)
        const first = yield* projections.snapshot(selector)
        expect(first.rows[0]?.statusRollup).toMatchObject({ activity: "working", freshness: "fresh" })

        yield* emit(run.runId, Health.statusObservedEventType, { report: "invalid" })
        yield* emit(run.runId, Health.statusObservedEventType, { ...observation, outcome: "discarded" })
        yield* emit(run.runId, Health.statusObservedEventType, { ...observation, evidenceSeq: 0 })
        yield* emit(run.runId, Monitor.beatEventType, {})
        const ignored = yield* projections.snapshot(selector)
        expect(ignored.rows[0]?.statusRollup).toEqual(first.rows[0]?.statusRollup)
        expect(ignored.cursor.value).toBeGreaterThan(first.cursor.value)

        yield* emit(run.runId, Health.statusObservedEventType, { ...observation, report: { activity: "idle" } })
        const latest = yield* projections.snapshot(selector)
        expect(latest.rows[0]?.statusRollup).toMatchObject({
          activity: "idle",
          freshness: "fresh",
          provenance: { evidenceSeq: observation.evidenceSeq, version: latest.cursor.value }
        })
        // The ignored beat still issued a real cursor; resume must recover it
        // from SQLite even though the bounded fold no longer retains it.
        const frames = yield* projections.subscribe(selector, ignored.cursor).pipe(Stream.take(1), Stream.runCollect)
        expect(frames).toEqual([{
          _tag: "delta",
          selector,
          cursor: latest.cursor,
          delta: latest.rows
        }])
        const invalid = yield* Effect.flip(
          projections.subscribe(selector, { ...ignored.cursor, offset: 1 }).pipe(
            Stream.runCollect
          )
        )
        expect(invalid.code).toBe("malformed_request")
      }).pipe(Effect.provide(stack()), Effect.scoped, Effect.provide(TestClock.layer()))
    )
  })

  it.each([1, 2])(
    "rejects foreign-subject evidenceSeq=%s throughout served SQLite reads and resume",
    async (evidenceSeq) => {
      await Effect.runPromise(
        Effect.gen(function*() {
          const run = yield* launch
          const control = yield* Control
          const projections = yield* Projections.Projections
          const selector = { _tag: "run-summary" as const, runId: run.runId }
          const observation = reading(run, { evidenceSeq: 1 })
          yield* emit(run.runId, Health.statusObservedEventType, observation)
          const first = yield* projections.snapshot(selector)
          expect(first.cursor.value).toBe(2)
          expect(first.rows[0]?.statusRollup).toMatchObject({
            activity: "working",
            freshness: "fresh",
            provenance: { evidenceSeq: 1, version: 2 }
          })

          // A schema-valid foreign subject must not enter precedence or retention,
          // even when it copies the current incarnation and claims stronger evidence.
          yield* emit(run.runId, Health.statusObservedEventType, {
            ...observation,
            subjectId: "run:foreign",
            evidenceSeq,
            report: { activity: "idle" }
          })
          const foreign = yield* projections.snapshot(selector)
          yield* emit(run.runId, Health.statusObservedEventType, {
            ...observation,
            evidenceSeq: 0,
            report: { activity: "idle" }
          })
          const weaker = yield* projections.snapshot(selector)
          const workspace = yield* projections.snapshot({ _tag: "workspace-runs" })
          const recreated = yield* Projections.make(control)
          const freshService = yield* recreated.snapshot(selector)
          const durable = yield* control.watch({ runId: run.runId, follow: false }).pipe(Stream.runCollect)
          expect(durable.filter((item) => item.kind === Health.statusObservedEventType)).toHaveLength(3)
          const expected = [3, 4].map((value) => {
            const rollup = GatewayProjection.statusRollup(run, durable.filter((item) => item.sequence <= value), 0)
            expect(rollup).toEqual(first.rows[0]?.statusRollup)
            return { cursor: { ...first.cursor, value }, rows: [{ ...first.rows[0]!, statusRollup: rollup }] }
          })
          const resumed = yield* projections.subscribe(selector, first.cursor).pipe(
            Stream.filter((frame) => frame._tag === "delta"),
            Stream.take(2),
            Stream.runCollect
          )
          expect.soft(foreign).toEqual({ selector, ...expected[0] })
          expect.soft(weaker).toEqual({ selector, ...expected[1] })
          expect.soft(workspace.rows).toEqual(expected[1]!.rows)
          expect.soft(freshService).toEqual({ selector, ...expected[1] })
          for (const [index, snapshot] of expected.entries()) {
            expect.soft(resumed[index]).toEqual({
              _tag: "delta",
              selector,
              cursor: snapshot.cursor,
              delta: snapshot.rows
            })
          }

          // The discarded subject still issued cursor 3. Rebuild it from SQLite
          // and allow a later legitimate equal-evidence observation to advance.
          yield* emit(run.runId, Health.statusObservedEventType, {
            ...observation,
            report: { activity: "needs-input", reason: "awaiting-reply" }
          })
          const latest = yield* projections.snapshot(selector)
          expect.soft(latest.rows[0]?.statusRollup).toMatchObject({
            activity: "needs-input",
            freshness: "fresh",
            provenance: { evidenceSeq: 1, version: 5 }
          })
          const fromForeign = yield* projections.subscribe(selector, foreign.cursor).pipe(
            Stream.filter((frame) => frame._tag === "delta"),
            Stream.take(2),
            Stream.runCollect
          )
          expect.soft(fromForeign).toEqual([
            { _tag: "delta", selector, cursor: expected[1]!.cursor, delta: expected[1]!.rows },
            { _tag: "delta", selector, cursor: latest.cursor, delta: latest.rows }
          ])
        }).pipe(Effect.provide(stack()), Effect.scoped, Effect.provide(TestClock.layer()))
      )
    }
  )

  it.each(["run-summary", "workspace-runs"] as const)(
    "ignores foreign-subject collisions during live %s compaction",
    async (projection) => {
      await Effect.runPromise(
        Effect.gen(function*() {
          const run = yield* launch
          const control = yield* Control
          const observation = reading(run, { evidenceSeq: 1 })
          yield* emit(run.runId, Health.statusObservedEventType, observation)
          const snapshotEnded = yield* Deferred.make<void>()
          const replayReady = yield* Deferred.make<void>()
          const replayRead = yield* Deferred.make<void>()
          const projections = yield* Projections.make({
            ...control,
            watch: (filter) =>
              filter.follow
                ? Stream.unwrap(Effect.as(Deferred.await(replayReady), control.watch(filter))).pipe(
                  Stream.tap((item) => item.sequence === 4 ? Deferred.succeed(replayRead, undefined) : Effect.void)
                )
                : control.watch(filter)
          })
          const selector = projection === "run-summary"
            ? { _tag: projection, runId: run.runId }
            : { _tag: projection }
          const following = yield* Effect.forkChild(
            projections.subscribe(selector).pipe(
              Stream.tap((frame) =>
                frame._tag === "snapshot-end" ? Deferred.succeed(snapshotEnded, undefined) : Effect.void
              ),
              Stream.filter((frame) => frame._tag === "delta"),
              Stream.take(projection === "run-summary" ? 2 : 1),
              Stream.runCollect
            )
          )
          yield* Deferred.await(snapshotEnded)
          yield* emit(run.runId, Health.statusObservedEventType, {
            ...observation,
            subjectId: "run:foreign",
            report: { activity: "idle" }
          })
          yield* emit(run.runId, Health.statusObservedEventType, { ...observation, evidenceSeq: 0 })
          const durable = yield* control.watch({ runId: run.runId, follow: false }).pipe(Stream.runCollect)
          const listed = yield* control.list({ _tag: "runs", filters: { runId: run.runId } })
          if (listed._tag !== "runs") return yield* Effect.die("run listing missing")
          yield* Deferred.succeed(replayReady, undefined)
          yield* Deferred.await(replayRead)
          if (projection === "workspace-runs") yield* TestClock.adjust(50)
          const frames = yield* Fiber.join(following)
          const expected = GatewayProjection.runSummary(listed.items[0]!, durable, 50)
          expect(expected.statusRollup).toMatchObject({
            activity: "working",
            freshness: "fresh",
            provenance: { evidenceSeq: 1, version: 2 }
          })
          expect(frames).toEqual((projection === "run-summary" ? [3, 4] : [0]).map((value) => ({
            _tag: "delta",
            selector,
            cursor: { selector, projection, runId: projection === "run-summary" ? run.runId : null, value, offset: 0 },
            delta: [expected]
          })))
        }).pipe(Effect.provide(stack()), Effect.scoped, Effect.provide(TestClock.layer()))
      )
    }
  )

  it("bounds retained incarnations while the raw durable journal keeps every observation", async () => {
    await Effect.runPromise(
      Effect.gen(function*() {
        const run = yield* launch
        const control = yield* Control
        const projections = yield* Projections.Projections
        const selector = { _tag: "run-summary" as const, runId: run.runId }
        const initial = yield* projections.snapshot(selector)
        // Eighteen distinct owners exceed the wire byte budget if retained
        // together. Only the current owner's reading may color the row.
        for (let index = 0; index < 18; index += 1) {
          yield* emit(
            run.runId,
            Health.statusObservedEventType,
            reading(run, {
              incarnation: `former-owner-${index}`,
              monitorId: "m".repeat(240_000),
              evidenceSeq: initial.cursor.value
            })
          )
        }
        yield* emit(run.runId, Health.statusObservedEventType, reading(run, { evidenceSeq: initial.cursor.value }))
        const snapshot = yield* projections.snapshot(selector)
        expect(snapshot.rows[0]?.statusRollup).toMatchObject({
          activity: "working",
          freshness: "fresh",
          provenance: { incarnation: Health.runIncarnation(run), version: snapshot.cursor.value }
        })
        const durable = yield* control.watch({ runId: run.runId, follow: false }).pipe(Stream.runCollect)
        expect(durable.filter((item) => item.kind === Health.statusObservedEventType)).toHaveLength(19)
        // The raw journal used to be unreadable at this size. It now answers a
        // bounded page whose events are clipped to the per-event budget.
        const page = yield* projections.snapshot({ _tag: "run-events", runId: run.runId })
        expect(page.rows.length).toBeGreaterThan(0)
        for (const row of page.rows) {
          expect(new TextEncoder().encode(JSON.stringify(row)).byteLength)
            .toBeLessThanOrEqual(Projections.maxEventBytes)
        }
      }).pipe(Effect.provide(stack()), Effect.scoped, Effect.provide(TestClock.layer()))
    )
  })
  it("replays a compacted cursor without letting late weaker evidence replace its reading", async () => {
    await Effect.runPromise(
      Effect.gen(function*() {
        const run = yield* launch
        const projections = yield* Projections.Projections
        const selector = { _tag: "run-summary" as const, runId: run.runId }
        const initial = yield* projections.snapshot(selector)
        const observation = reading(run, { evidenceSeq: initial.cursor.value })
        yield* emit(run.runId, Health.statusObservedEventType, observation)
        const first = yield* projections.snapshot(selector)
        yield* emit(run.runId, Health.statusObservedEventType, {
          ...observation,
          evidenceSeq: 0,
          report: { activity: "idle" }
        })
        const weaker = yield* projections.snapshot(selector)
        expect(weaker.rows).toEqual(first.rows)
        yield* emit(run.runId, Health.statusObservedEventType, {
          ...observation,
          report: { activity: "needs-input", reason: "awaiting-reply" }
        })
        const latest = yield* projections.snapshot(selector)
        const frames = yield* projections.subscribe(selector, first.cursor).pipe(
          Stream.filter((frame) => frame._tag === "delta"),
          Stream.take(2),
          Stream.runCollect
        )
        expect(frames).toEqual([
          { _tag: "delta", selector, cursor: weaker.cursor, delta: first.rows },
          { _tag: "delta", selector, cursor: latest.cursor, delta: latest.rows }
        ])
      }).pipe(Effect.provide(stack()), Effect.scoped, Effect.provide(TestClock.layer()))
    )
  })

  it.each(["snapshot", "resume"] as const)(
    "preserves current-first evidence through former-incarnation eviction in %s",
    async (mode) => {
      await Effect.runPromise(
        Effect.gen(function*() {
          const run = yield* launch
          const control = yield* Control
          const projections = yield* Projections.Projections
          const selector = { _tag: "run-summary" as const, runId: run.runId }
          const initial = yield* projections.snapshot(selector)
          const observation = reading(run, { evidenceSeq: initial.cursor.value })
          yield* emit(run.runId, Health.statusObservedEventType, observation)
          const first = yield* projections.snapshot(selector)
          expect(first.cursor.value).toBe(2)
          expect(first.rows[0]?.statusRollup).toMatchObject({
            activity: "working",
            freshness: "fresh",
            provenance: { evidenceSeq: 1, version: 2 }
          })

          const snapshots = []
          // Publish the authoritative reading BEFORE enough late former owners
          // to evict it under FIFO retention, then weaker and equal evidence.
          const readings = [
            ...Array.from({ length: 16 }, (_, index) => ({ ...observation, incarnation: `former-owner-${index}` })),
            { ...observation, evidenceSeq: 0, report: { activity: "idle" as const } },
            { ...observation, report: { activity: "needs-input" as const, reason: "awaiting-reply" as const } }
          ]
          for (const next of readings) {
            yield* emit(run.runId, Health.statusObservedEventType, next)
            if (mode === "snapshot") snapshots.push(yield* projections.snapshot(selector))
          }
          const durable = yield* control.watch({ runId: run.runId, follow: false }).pipe(Stream.runCollect)
          expect(durable.filter((item) => item.kind === Health.statusObservedEventType)).toHaveLength(19)
          const expected = readings.map((_, index) => {
            const value = first.cursor.value + index + 1
            const rollup = GatewayProjection.statusRollup(run, durable.filter((item) => item.sequence <= value), 0)
            if (index < 17) expect(rollup).toEqual(first.rows[0]?.statusRollup)
            else {
              expect(rollup).toMatchObject({
                activity: "needs-input",
                freshness: "fresh",
                provenance: { evidenceSeq: 1, version: 20 }
              })
            }
            return { cursor: { ...first.cursor, value }, rows: [{ ...first.rows[0]!, statusRollup: rollup }] }
          })
          if (mode === "snapshot") expect(snapshots).toEqual(expected.map((snapshot) => ({ selector, ...snapshot })))
          else {
            const frames = yield* projections.subscribe(selector, first.cursor).pipe(
              Stream.filter((frame) => frame._tag === "delta"),
              Stream.take(readings.length),
              Stream.runCollect
            )
            expect(frames).toEqual(
              expected.map(({ cursor, rows }) => ({ _tag: "delta", selector, cursor, delta: rows }))
            )
          }
        }).pipe(Effect.provide(stack()), Effect.scoped, Effect.provide(TestClock.layer()))
      )
    }
  )

  it.each(["run-summary", "workspace-runs"] as const)(
    "protects the refreshed incarnation during live %s compaction",
    async (projection) => {
      await Effect.runPromise(
        Effect.gen(function*() {
          const run = yield* launch
          const control = yield* Control
          const runtime = yield* ControlRuntime
          yield* emit(run.runId, Health.statusObservedEventType, reading(run, { evidenceSeq: 1 }))
          const snapshotEnded = yield* Deferred.make<void>()
          const replayReady = yield* Deferred.make<void>()
          const replayRead = yield* Deferred.make<void>()
          const projections = yield* Projections.make({
            ...control,
            // Hold real durable follow replay until the ownership point changes
            // and the adversarial batch is fully committed. No successful read is mocked.
            watch: (filter) =>
              filter.follow
                ? Stream.unwrap(Effect.as(Deferred.await(replayReady), control.watch(filter))).pipe(
                  Stream.tap((item) => item.sequence === 20 ? Deferred.succeed(replayRead, undefined) : Effect.void)
                )
                : control.watch(filter)
          })
          const selector = projection === "run-summary"
            ? { _tag: projection, runId: run.runId }
            : { _tag: projection }
          const following = yield* Effect.forkChild(
            projections.subscribe(selector).pipe(
              Stream.tap((frame) =>
                frame._tag === "snapshot-end" ? Deferred.succeed(snapshotEnded, undefined) : Effect.void
              ),
              Stream.filter((frame) => frame._tag === "delta"),
              Stream.filter((frame) => projection === "workspace-runs" || frame.cursor.value === 20),
              Stream.take(1),
              Stream.runCollect
            )
          )
          yield* Deferred.await(snapshotEnded)
          yield* TestClock.adjust(1)
          yield* runtime.writeStatus(run.runId, yield* driverFence(run.runId), "running")
          const listed = yield* control.list({ _tag: "runs", filters: { runId: run.runId } })
          if (listed._tag !== "runs") return yield* Effect.die("run listing missing")
          const fresh = listed.items[0]!
          expect(Health.runIncarnation(fresh)).not.toBe(Health.runIncarnation(run))
          const observation = reading(fresh, { evidenceSeq: 1, observedAt: 1, expiresAt: 1001 })
          yield* emit(run.runId, Health.statusObservedEventType, observation)
          for (let index = 0; index < 16; index += 1) {
            yield* emit(run.runId, Health.statusObservedEventType, {
              ...observation,
              incarnation: `former-owner-${index}`
            })
          }
          yield* emit(run.runId, Health.statusObservedEventType, { ...observation, evidenceSeq: 0 })
          const durable = yield* control.watch({ runId: run.runId, follow: false }).pipe(Stream.runCollect)
          expect(durable.at(-1)?.sequence).toBe(20)
          yield* Deferred.succeed(replayReady, undefined)
          yield* Deferred.await(replayRead)
          if (projection === "workspace-runs") yield* TestClock.adjust(50)
          const frames = yield* Fiber.join(following)
          expect(frames).toHaveLength(1)
          const expected = GatewayProjection.runSummary(fresh, durable, 51)
          expect(expected.statusRollup).toMatchObject({
            activity: "working",
            freshness: "fresh",
            provenance: { incarnation: Health.runIncarnation(fresh), evidenceSeq: 1, version: 3 }
          })
          expect(frames[0]?.delta).toEqual([expected])
        }).pipe(Effect.provide(stack()), Effect.scoped, Effect.provide(TestClock.layer()))
      )
    }
  )

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
        // Raw event history pages instead of refusing: one bounded page, and a
        // cursor that reaches the next one.
        const eventsSelector = { _tag: "run-events" as const, runId: summary.runId }
        const page = yield* projections.snapshot(eventsSelector)
        expect(page.rows).toHaveLength(Projections.maxEventsPerPage)
        expect(page.cursor.value).toBe(Projections.maxEventsPerPage)
        const next = yield* projections.snapshot(eventsSelector, page.cursor)
        expect(next.rows).toHaveLength(Projections.maxEventsPerPage)
        expect(next.cursor.value).toBe(2 * Projections.maxEventsPerPage)
      }).pipe(Effect.provide(TestControl.layer()), Effect.scoped, Effect.provide(TestClock.layer()))
    )
  })
  it("refuses unissued compacted cursor offsets and reports durable cursor verification failures", async () => {
    await Effect.runPromise(
      Effect.gen(function*() {
        const run = yield* launch
        const control = yield* Control
        const projections = yield* Projections.Projections
        const selector = { _tag: "run-summary" as const, runId: run.runId }
        yield* emit(run.runId, Health.statusObservedEventType, reading(run))
        const first = yield* projections.snapshot(selector)
        yield* emit(run.runId, Health.statusObservedEventType, reading(run))
        const failure = yield* Effect.flip(
          projections.subscribe(selector, { ...first.cursor, offset: 1 }).pipe(
            Stream.runCollect
          )
        )
        expect(failure.code).toBe("malformed_request")
        expect(failure.message).toContain("was not issued")
        const zeroOffset = yield* Effect.flip(
          projections.subscribe(selector, { ...first.cursor, value: 0, offset: 1 })
            .pipe(Stream.runCollect)
        )
        expect(zeroOffset.code).toBe("malformed_request")
        expect(zeroOffset.message).toContain("was not issued")

        // Inject only the read failure; successful reads still use the real durable adapter.
        const faulty = yield* Projections.make({
          ...control,
          watch: (filter) =>
            !filter.follow && filter.afterSequence !== undefined
              ? Stream.fail(new PersistenceError({ operation: "watch", message: "private cursor storage details" }))
              : control.watch(filter)
        })
        const unavailable = yield* Effect.flip(faulty.subscribe(selector, first.cursor).pipe(Stream.runCollect))
        expect(unavailable.code).toBe("run_unavailable")
        expect(unavailable.message).toBe("Checking the projection cursor failed")
        expect(JSON.stringify(unavailable)).not.toContain("private cursor storage details")
      }).pipe(Effect.provide(stack()), Effect.scoped, Effect.provide(TestClock.layer()))
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
