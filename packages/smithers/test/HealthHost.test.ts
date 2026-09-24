import { Control, Health } from "@smthrs/control"
import type { RunSummary } from "@smthrs/control/ControlSchema"
import * as TestControl from "@smthrs/control/test/TestControl"
import { Journal, JournalEvent } from "@smthrs/journal"
import { Deferred, Effect, Fiber, Stream } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import * as HealthHost from "../src/internal/HealthHost.ts"

const summaries: ReadonlyArray<RunSummary> = Array.from({ length: 4 }, (_, index) => ({
  runId: `health-${index}`,
  flowId: "checked",
  status: "accepted",
  createdAt: 0,
  updatedAt: 0
}))
const source = (control: Control.Service): Control.Service => ({
  ...control,
  list: (request) =>
    request._tag !== "runs" ? control.list(request) : Effect.succeed({
      _tag: "runs",
      items: summaries.filter((run) =>
        (request.filters?.runId === undefined || request.filters.runId === run.runId) &&
        (request.filters?.status === undefined || request.filters.status === run.status)
      )
    }),
  watch: () => Stream.empty
})

describe("native health producer lifetime", () => {
  it("retries discovery after a failed scan and observes newly discovered runs", async () => {
    await Effect.runPromise(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        const control = source(yield* Control.Control)
        const failed = yield* Deferred.make<void>()
        const recorded = yield* Deferred.make<void>()
        let attempts = 0
        const flaky: Control.Service = {
          ...control,
          list: (request) =>
            Effect.gen(function*() {
              attempts += 1
              if (attempts === 1) {
                yield* Deferred.succeed(failed, undefined)
                return yield* Effect.die("temporary discovery failure")
              }
              return yield* control.list(request)
            })
        }
        const observedJournal = {
          ...journal,
          emitDurableUnfenced: (input: JournalEvent.Input) =>
            journal.emitDurableUnfenced(input).pipe(
              Effect.tap(() =>
                input.eventType === Health.statusObservedEventType
                  ? Deferred.succeed(recorded, undefined)
                  : Effect.void
              )
            )
        }
        const fiber = yield* Effect.scoped(
          HealthHost.watch(Health.makeRegistry({ limits: { maxSubjects: 1 } })).pipe(
            Effect.provideService(Control.Control, flaky),
            Effect.provideService(Journal.Journal, observedJournal)
          )
        ).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Deferred.await(failed)
        yield* TestClock.adjust(5_000)
        yield* Deferred.await(recorded)
        expect(attempts).toBeGreaterThan(1)
        const page = yield* journal.entries({ runId: JournalEvent.RunId.make("health-0"), limit: 10 })
        expect(page.entries.some((entry) => entry.eventType === Health.statusObservedEventType)).toBe(true)
        yield* Fiber.interrupt(fiber)
      }).pipe(Effect.provide(TestControl.layer()), Effect.scoped, Effect.provide(TestClock.layer()))
    )
  })

  it("releases a failed observation so the next scan can retry the same subject", async () => {
    await Effect.runPromise(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        const original = source(yield* Control.Control)
        const control: Control.Service = {
          ...original,
          list: (request) =>
            original.list(request).pipe(Effect.map((result) =>
              result._tag === "runs"
                ? { ...result, items: result.items.filter((run) => run.runId === "health-0") }
                : result
            ))
        }
        const failed = yield* Deferred.make<void>()
        const recorded = yield* Deferred.make<void>()
        let observations = 0
        const flakyJournal = {
          ...journal,
          emitDurableUnfenced: (input: JournalEvent.Input) =>
            Effect.gen(function*() {
              if (input.eventType === Health.statusObservedEventType) {
                observations += 1
                if (observations === 1) {
                  yield* Deferred.succeed(failed, undefined)
                  return yield* Effect.die("temporary journal failure")
                }
              }
              const result = yield* journal.emitDurableUnfenced(input)
              if (input.eventType === Health.statusObservedEventType) yield* Deferred.succeed(recorded, undefined)
              return result
            })
        }
        const fiber = yield* Effect.scoped(
          HealthHost.watch(Health.makeRegistry({ limits: { maxSubjects: 1 } })).pipe(
            Effect.provideService(Control.Control, control),
            Effect.provideService(Journal.Journal, flakyJournal)
          )
        ).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Deferred.await(failed)
        yield* TestClock.adjust(5_000)
        yield* Deferred.await(recorded)
        expect(observations).toBeGreaterThan(1)
        const page = yield* journal.entries({ runId: JournalEvent.RunId.make("health-0"), limit: 10 })
        expect(page.entries.some((entry) => entry.eventType === Health.statusObservedEventType)).toBe(true)
        yield* Fiber.interrupt(fiber)
      }).pipe(Effect.provide(TestControl.layer()), Effect.scoped, Effect.provide(TestClock.layer()))
    )
  })

  it("does not alarm on an ordinary minute of silent work under production defaults", async () => {
    await Effect.runPromise(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        const control = source(yield* Control.Control)
        const registry = Health.makeRegistry({ limits: { maxSubjects: 1 } })
        expect(registry.resolve("checked").policy.stallAfterMs).toBe(120_000)
        const fiber = yield* Effect.scoped(
          HealthHost.watch(registry).pipe(Effect.provideService(Control.Control, control))
        )
          .pipe(Effect.forkChild({ startImmediately: true }))
        yield* TestClock.adjust(60_000)
        const page = yield* journal.entries({ runId: JournalEvent.RunId.make("health-0"), limit: 100 })
        const statuses = page.entries.filter((entry) => entry.eventType === Health.statusObservedEventType)
        expect(statuses.length).toBeGreaterThan(1)
        expect(statuses.every((entry) => (entry.payload as { health: string }).health === "healthy")).toBe(true)
        yield* Fiber.interrupt(fiber)
      }).pipe(Effect.provide(TestControl.layer()), Effect.scoped, Effect.provide(TestClock.layer()))
    )
  })
  it("enforces shared subject and probe admission and interrupts checks on host teardown", async () => {
    let inFlight = 0
    let finalized = 0
    await Effect.runPromise(
      Effect.gen(function*() {
        const began = yield* Deferred.make<void>()
        const registry = Health.makeRegistry({
          limits: { maxSubjects: 3, maxConcurrentProbes: 2 },
          checkers: [{
            id: "bounded",
            probe: () =>
              Effect.gen(function*() {
                inFlight += 1
                if (inFlight === 2) yield* Deferred.succeed(began, undefined)
                return yield* Effect.never
              }).pipe(Effect.ensuring(Effect.sync(() => {
                finalized += 1
                inFlight -= 1
              })))
          }],
          bindings: { checked: { checkerId: "bounded" } }
        })
        const control = source(yield* Control.Control)
        const fiber = yield* Effect.scoped(
          HealthHost.watch(registry).pipe(Effect.provideService(Control.Control, control))
        ).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Deferred.await(began)
        expect(inFlight).toBe(2)
        yield* Fiber.interrupt(fiber)
        expect(inFlight).toBe(0)
        expect(finalized).toBe(2)
      }).pipe(Effect.provide(TestControl.layer()), Effect.scoped)
    )
  })
  it("executes trusted configured callbacks and persists status in the host journal", async () => {
    await Effect.runPromise(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        const control = source(yield* Control.Control)
        const recorded = yield* Deferred.make<void>()
        const observedJournal = {
          ...journal,
          emitDurableUnfenced: (input: JournalEvent.Input) =>
            journal.emitDurableUnfenced(input).pipe(
              Effect.tap(() =>
                input.eventType === Health.statusObservedEventType ? Deferred.succeed(recorded, undefined) : Effect.void
              )
            )
        }
        const registry = Health.makeRegistry({
          limits: { maxSubjects: 1 },
          checkers: [{
            id: "semantic",
            probe: () => Effect.succeed({ activity: "needs-input", reason: "prompt-detected" })
          }],
          bindings: { checked: { checkerId: "semantic" } }
        })
        const fiber = yield* Effect.scoped(
          HealthHost.watch(registry).pipe(
            Effect.provideService(Control.Control, control),
            Effect.provideService(Journal.Journal, observedJournal)
          )
        ).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Deferred.await(recorded)
        const page = yield* journal.entries({ runId: JournalEvent.RunId.make("health-0"), limit: 10 })
        expect(
          page.entries.find((entry) => entry.eventType === Health.statusObservedEventType)?.payload
        ).toMatchObject({
          subjectId: "run:health-0",
          checkerId: "semantic",
          activity: "needs-input",
          attention: "needs-input"
        })
        yield* Fiber.interrupt(fiber)
      }).pipe(Effect.provide(TestControl.layer()), Effect.scoped)
    )
  })
})
