import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Journal, JournalEvent } from "@smthrs/journal"
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import { Clock, Deferred, Effect, Fiber, Layer, Metric, PubSub, Stream } from "effect"
import { TestClock } from "effect/testing"
import { expect, it } from "vitest"
import { Control } from "../src/Control.vibe"
import { ControlRuntime } from "../src/ControlRuntime.vibe"
import * as ObservedClock from "./ObservedClock.ts"
import { live } from "./TestStack.ts"

for (const scenario of ["existing", "empty", "new", "race", "new-race"] as const) {
  it(`recovers a dropped final event in a quiet ${scenario} partition`, () => {
    const pageRead = Deferred.makeUnsafe<void>()
    const releasePage = Deferred.makeUnsafe<void>()
    const notifications = Deferred.makeUnsafe<PubSub.PubSub<JournalEvent.Entry>>()
    let holdPage = false
    const journal = Layer.effect(
      Journal.Journal,
      Effect.gen(function*() {
        const actual = yield* Journal.Journal
        const dropped = yield* PubSub.unbounded<JournalEvent.Entry>()
        // Fault injection: durable writes succeed, but the notification never reaches this reader.
        yield* Deferred.succeed(notifications, dropped)
        return Journal.make({
          ...actual,
          changes: PubSub.subscribe(dropped),
          entries: (options) =>
            Effect.gen(function*() {
              const page = yield* actual.entries(options)
              if (holdPage && options.limit === 1024) {
                holdPage = false
                yield* Deferred.succeed(pageRead, undefined)
                yield* Deferred.await(releasePage)
              }
              return page
            })
        })
      })
    ).pipe(Layer.provide(TestJournal.layer()), Layer.orDie)
    return Effect.runPromise(
      Effect.gen(function*() {
        const control = yield* Control
        const runtime = yield* ControlRuntime
        const storage = yield* Journal.Journal
        const { card } = yield* runtime.plan({ flowId: "system/test", input: {} })
        let partition = JournalEvent.RunId.make(`plan:${card.planId}`)
        const emit = (eventType: string) =>
          storage.emitDurableUnfenced(
            new JournalEvent.Input({
              runId: partition,
              sourceId: JournalEvent.SourceId.make("quiet-watch-test"),
              eventType,
              payload: null
            })
          )
        if (scenario !== "empty") yield* emit("control.test.initial")
        const initialSeen = Deferred.makeUnsafe<void>()
        const kinds: string[] = []
        const recovered = Metric.counter("smithers.control.watch.recovered_entries")
        const before = (yield* Metric.value(recovered)).count
        const observedClock = yield* ObservedClock.make
        const reader = yield* control.watch({}).pipe(
          Stream.runForEach((event) =>
            Effect.gen(function*() {
              kinds.push(event.kind)
              if (event.kind === "control.test.initial") yield* Deferred.succeed(initialSeen, undefined)
            })
          ),
          Effect.provideService(Clock.Clock, observedClock.clock),
          Effect.forkChild({ startImmediately: true })
        )
        if (scenario !== "empty") yield* Effect.raceFirst(Deferred.await(initialSeen), Fiber.join(reader))
        yield* TestDatabase.until(observedClock.scheduled(1000))
        if (scenario === "new" || scenario === "new-race") {
          const late = yield* runtime.plan({ flowId: "system/test", input: {} })
          partition = JournalEvent.RunId.make(`plan:${late.card.planId}`)
        }
        yield* emit("control.test.final")
        if (scenario === "new-race") yield* emit("control.test.prior")
        holdPage = scenario === "race" || scenario === "new-race"
        const adjusted = yield* TestClock.adjust("2 seconds").pipe(Effect.forkChild({ startImmediately: true }))
        if (scenario === "race" || scenario === "new-race") {
          yield* Deferred.await(pageRead)
          if (scenario === "new-race") yield* emit("control.test.live")
          const page = yield* storage.entries({
            runId: partition,
            after: JournalEvent.Seq.make(scenario === "race" ? 0 : 1),
            limit: 1
          })
          yield* PubSub.publish(yield* Deferred.await(notifications), page.entries[0]!)
          if (scenario === "race") {
            yield* TestDatabase.until(Effect.sync(() => kinds.includes("control.test.final")))
          } else {
            // Main's downstream marker keeps the live notice behind claimed history.
            expect(kinds).not.toContain("control.test.live")
          }
          yield* Deferred.succeed(releasePage, undefined)
          yield* TestDatabase.until(observedClock.scheduled(3000))
        }
        yield* TestDatabase.until(Effect.sync(() => kinds.includes("control.test.final")))
        if (scenario === "existing") {
          yield* TestDatabase.until(observedClock.scheduled(3000))
          yield* emit("control.test.next")
          const next = yield* TestClock.adjust("1 second").pipe(Effect.forkChild({ startImmediately: true }))
          yield* TestDatabase.until(Effect.sync(() => kinds.includes("control.test.next")))
          yield* Fiber.interrupt(next)
        }
        yield* Fiber.interrupt(reader)
        yield* Fiber.interrupt(adjusted)
        if (scenario === "new-race") {
          expect(kinds.slice().sort()).toEqual(
            ["control.test.initial", "control.test.final", "control.test.prior", "control.test.live"].sort()
          )
        } else {expect(kinds).toEqual(
            scenario === "empty" ? ["control.test.final"] : scenario === "existing"
              ? ["control.test.initial", "control.test.final", "control.test.next"]
              : ["control.test.initial", "control.test.final"]
          )}
        expect((yield* Metric.value(recovered)).count - before).toBe(
          scenario === "race" ? 0 : scenario === "existing" || scenario === "new-race" ? 2 : 1
        )
      }).pipe(Effect.provide(live({ journal })), Effect.scoped, Effect.provide(TestClock.layer()))
    )
  })
}
