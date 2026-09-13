import { Control, Health } from "@smthrs/control"
import type { RunSummary } from "@smthrs/control/ControlSchema"
import * as TestControl from "@smthrs/control/test/TestControl"
import { Journal, JournalEvent } from "@smthrs/journal"
import { Deferred, Effect, Fiber, Stream } from "effect"
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
