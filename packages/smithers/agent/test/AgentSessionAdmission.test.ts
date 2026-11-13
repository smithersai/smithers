import { Journal, JournalEvent } from "@smthrs/journal"
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import { Deferred, Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { expect, it } from "vitest"
import { waitForRunning } from "../src/AgentSession.ts"

it("does not hammer a contended admission store while awaiting its committed running event", async () => {
  await Effect.runPromise(
    Effect.gen(function*() {
      const journal = yield* Journal.Journal
      const read = yield* Deferred.make<void>()
      let reads = 0
      let running = false
      const fiber = yield* waitForRunning(
        () =>
          Effect.gen(function*() {
            reads++
            if (reads === 2) yield* Deferred.succeed(read, undefined)
            return running ? "running" as const : "accepted" as const
          }),
        "admission-test",
        journal
      ).pipe(Effect.forkChild)
      yield* Deferred.await(read)
      yield* Effect.sleep("100 millis")
      expect(reads).toBe(2)
      for (
        const [runId, eventType, sequence] of [
          ["other-run", "control.run.running", 1],
          ["admission-test", "control.run.accepted", 2]
        ] as const
      ) {
        yield* journal.emitDurableUnfenced(
          new JournalEvent.Input({
            runId: JournalEvent.RunId.make(runId),
            sourceId: JournalEvent.SourceId.make("/test/ignored"),
            sourceSeq: JournalEvent.SourceSeq.make(sequence),
            eventType,
            payload: {}
          })
        )
      }
      yield* Effect.sleep("20 millis")
      expect(reads).toBe(2)
      running = true
      yield* journal.emitDurableUnfenced(
        new JournalEvent.Input({
          runId: JournalEvent.RunId.make("admission-test"),
          sourceId: JournalEvent.SourceId.make("/test/admission"),
          sourceSeq: JournalEvent.SourceSeq.make(0),
          eventType: "control.run.running",
          payload: {}
        })
      )
      expect(yield* Fiber.join(fiber)).toBe(true)
      expect(reads).toBe(3)
    }).pipe(Effect.scoped, Effect.provide(TestJournal.layer()))
  )
})

for (
  const status of ["running", "cancelled", "parked", "failed", "completed", "waiting-approval"] as const
) {
  it(`handles an already published ${status} row with one read`, async () => {
    let reads = 0
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        return yield* waitForRunning(
          () =>
            Effect.sync(() => {
              reads++
              return status
            }),
          "test",
          journal
        )
      }).pipe(Effect.provide(TestJournal.layer()))
    )
    expect(result).toBe(status === "running")
    expect(reads).toBe(1)
  })
}

it("propagates an unavailable admission store", async () => {
  const failure = await Effect.runPromise(
    Effect.gen(function*() {
      const journal = yield* Journal.Journal
      return yield* Effect.flip(waitForRunning(() => Effect.fail("unavailable"), "test", journal))
    }).pipe(Effect.provide(TestJournal.layer()))
  )
  expect(failure).toBe("unavailable")
})

it("interrupts an admission wait without another store read", async () => {
  await Effect.runPromise(
    Effect.gen(function*() {
      const journal = yield* Journal.Journal
      const read = yield* Deferred.make<void>()
      let reads = 0
      const fiber = yield* waitForRunning(
        () =>
          Effect.gen(function*() {
            reads++
            if (reads === 2) yield* Deferred.succeed(read, undefined)
            return "accepted" as const
          }),
        "test",
        journal
      ).pipe(Effect.forkChild)
      yield* Deferred.await(read)
      yield* Fiber.interrupt(fiber)
      expect((yield* Fiber.await(fiber))._tag).toBe("Failure")
      expect(reads).toBe(2)
    }).pipe(Effect.scoped, Effect.provide(TestJournal.layer()))
  )
})

for (
  const event of [
    "control.run.cancelled",
    "control.run.failed",
    "control.run.pending",
    "control.run.completed"
  ] as const
) {
  it(`does not admit after ${event}`, async () => {
    await Effect.runPromise(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        const read = yield* Deferred.make<void>()
        let reads = 0
        const fiber = yield* waitForRunning(
          () =>
            Effect.gen(function*() {
              reads++
              if (reads === 2) yield* Deferred.succeed(read, undefined)
              return reads <= 2 ? "accepted" as const : "failed" as const
            }),
          "test",
          journal
        ).pipe(Effect.forkChild)
        yield* Deferred.await(read)
        yield* journal.emitDurableUnfenced(
          new JournalEvent.Input({
            runId: JournalEvent.RunId.make("test"),
            sourceId: JournalEvent.SourceId.make("/test"),
            sourceSeq: JournalEvent.SourceSeq.make(0),
            eventType: event,
            payload: {}
          })
        )
        expect(yield* Fiber.join(fiber)).toBe(false)
        expect(reads).toBe(3)
      }).pipe(Effect.scoped, Effect.provide(TestJournal.layer()))
    )
  })
}

it("fails a missing admission at its deadline without retrying the store", async () => {
  await Effect.runPromise(
    Effect.gen(function*() {
      const journal = yield* Journal.Journal
      const read = yield* Deferred.make<void>()
      let reads = 0
      const fiber = yield* waitForRunning(
        () =>
          Effect.gen(function*() {
            reads++
            if (reads === 2) yield* Deferred.succeed(read, undefined)
            return "accepted" as const
          }),
        "test",
        journal
      ).pipe(Effect.flip, Effect.forkChild)
      yield* Deferred.await(read)
      yield* TestClock.adjust("61 seconds")
      expect(yield* Fiber.join(fiber)).toMatchObject({ code: "launch_failed", runId: "test" })
      expect(reads).toBe(2)
    }).pipe(Effect.scoped, Effect.provide(TestJournal.layer()), Effect.provide(TestClock.layer()))
  )
})

it("observes admission that commits between the initial read and subscription", async () => {
  let running = false
  let reads = 0
  const result = await Effect.runPromise(
    Effect.gen(function*() {
      const journal = yield* Journal.Journal
      return yield* waitForRunning(
        () =>
          Effect.sync(() => {
            reads++
            return running ? "running" as const : "accepted" as const
          }),
        "test",
        {
          changes: journal.changes.pipe(Effect.tap(() =>
            Effect.sync(() => {
              running = true
            })
          ))
        }
      )
    }).pipe(Effect.provide(TestJournal.layer()))
  )
  expect(result).toBe(true)
  expect(reads).toBe(2)
})

it("fails closed when the admission recheck becomes unavailable", async () => {
  let reads = 0
  const result = await Effect.runPromise(
    Effect.gen(function*() {
      const journal = yield* Journal.Journal
      return yield* waitForRunning(
        () =>
          Effect.suspend(() =>
            ++reads === 1
              ? Effect.succeed("accepted" as const)
              : Effect.fail("unavailable")
          ),
        "test",
        journal
      ).pipe(Effect.flip)
    }).pipe(Effect.provide(TestJournal.layer()))
  )
  expect(result).toBe("unavailable")
  expect(reads).toBe(2)
})
