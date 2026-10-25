/**
 * The step log capture's loss paths, each driven by an injected journal: a
 * full queue, a lossy channel that drops, a write that fails or dies, a
 * journal that never answers, a record logged after the body exited, and a
 * body that fails, dies or is interrupted.
 */
import { describe, expect, it } from "@effect/vitest"
import { Journal, type JournalEvent, TelemetryLog } from "@smthrs/journal"
import * as Cause from "effect/Cause"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Logger from "effect/Logger"
import * as Metric from "effect/Metric"
import * as Option from "effect/Option"
import * as References from "effect/References"
import * as EngineStoreMetrics from "../src/EngineStoreMetrics.ts"
import * as StepLogCapture from "../src/internal/StepLogCapture.ts"
import * as StepLogs from "../src/StepLogs.ts"

const attribution: StepLogCapture.Attribution = { runId: "capture-run", stepKeyDigest: "c".repeat(64), attempt: 3 }

/** A journal whose lossy channel answers with `answer`, recording each record it is handed. */
const journalOf = (answer: (index: number) => Effect.Effect<Journal.EmitReceipt, Journal.JournalError>) => {
  const handed: Array<TelemetryLog.Log> = []
  const service = Journal.makeNoop({
    emitLossy: (input: JournalEvent.Input) =>
      Effect.suspend(() => {
        handed.push(input.payload as TelemetryLog.Log)
        return answer(handed.length - 1)
      })
  })
  return { handed, service }
}

const accepted = (index: number): Effect.Effect<Journal.EmitReceipt> =>
  Effect.succeed({ _tag: "Accepted", seq: index as JournalEvent.Seq, sourceSeq: index as JournalEvent.SourceSeq })

const messages = (records: ReadonlyArray<TelemetryLog.Log>) => records.map((record) => record.message)

const counted = (outcome: keyof typeof EngineStoreMetrics.stepLog) =>
  Metric.value(EngineStoreMetrics.stepLog[outcome]).pipe(Effect.map((state) => state.count))

describe("StepLogCapture", () => {
  it.effect("drops and counts what a full queue cannot take", () =>
    Effect.gen(function*() {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const journal = journalOf((index) =>
        index === 0
          ? Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(accepted(0))
          )
          : accepted(index)
      )
      const before = yield* counted("DroppedQueue")
      yield* Effect.gen(function*() {
        yield* Effect.logInfo("first")
        // The drain now holds the first record inside the journal's write.
        yield* Deferred.await(entered)
        yield* Effect.logInfo("second")
        yield* Effect.logInfo("third")
        yield* Deferred.succeed(release, undefined)
      }).pipe(
        StepLogCapture.capture(journal.service, attribution),
        Effect.provideService(StepLogs.Limits, { ...StepLogs.defaultLimits, queue: 1 })
      )
      expect(messages(journal.handed)).toEqual([["first"], ["second"], ["Log lines dropped"]])
      expect(journal.handed[2]!.annotations).toEqual({
        runId: "capture-run",
        stepKeyDigest: "c".repeat(64),
        attempt: 3,
        code: StepLogs.droppedCode,
        dropped: 1
      })
      expect((yield* counted("DroppedQueue")) - before).toBe(1)
    }))

  it.effect("counts a record the journal's lossy channel drops", () =>
    Effect.gen(function*() {
      const journal = journalOf((index) =>
        index === 0
          ? Effect.succeed<Journal.EmitReceipt>({
            _tag: "Dropped",
            seq: 0 as JournalEvent.Seq,
            sourceSeq: 0 as JournalEvent.SourceSeq,
            policy: "drop-newest"
          })
          : accepted(index)
      )
      const before = yield* counted("DroppedJournal")
      yield* Effect.logInfo("refused").pipe(
        Effect.andThen(Effect.logInfo("kept")),
        StepLogCapture.capture(journal.service, attribution)
      )
      expect(messages(journal.handed)).toEqual([["refused"], ["kept"], ["Log lines dropped"]])
      expect(journal.handed[2]!.annotations.dropped).toBe(1)
      expect((yield* counted("DroppedJournal")) - before).toBe(1)
    }))

  it.effect("counts and reports a failed or dying journal write with a fixed code, and keeps draining", () =>
    Effect.gen(function*() {
      const journal = journalOf((index) =>
        index === 0
          ? Effect.fail(new Journal.JournalError({ code: "sink_failed", message: "token=sk-live-abcdefgh" }))
          : index === 1
          ? Effect.die(new Error("journal bug"))
          : accepted(index)
      )
      const warnings: Array<{ readonly message: unknown; readonly annotations: Readonly<Record<string, unknown>> }> = []
      const host = Logger.make<unknown, void>((options) => {
        if (options.logLevel === "Warn") {
          warnings.push({
            message: options.message,
            annotations: options.fiber.getRef(References.CurrentLogAnnotations)
          })
        }
      })
      const before = yield* counted("Failed")
      yield* Effect.logInfo("one").pipe(
        Effect.andThen(Effect.logInfo("two")),
        Effect.andThen(Effect.logInfo("three")),
        StepLogCapture.capture(journal.service, attribution),
        Effect.provideService(Logger.CurrentLoggers, new Set([host]))
      )
      expect(messages(journal.handed)).toEqual([["one"], ["two"], ["three"], ["Log lines dropped"]])
      expect(journal.handed[3]!.annotations.dropped).toBe(2)
      expect((yield* counted("Failed")) - before).toBe(2)
      expect(warnings.map((warning) => [warning.message, warning.annotations.code])).toEqual([
        [["A step log record could not be journaled"], "step_log_failed"],
        [["A step log record could not be journaled"], "step_log_failed"]
      ])
      expect(JSON.stringify(warnings)).not.toContain("sk-live")
    }))

  it.effect("counts a write the journal interrupts, and what it left queued", () =>
    Effect.gen(function*() {
      const journal = journalOf((index) => index === 0 ? Effect.interrupt : accepted(index))
      const before = yield* counted("DroppedFlush")
      const result = yield* Effect.logInfo("interrupted").pipe(
        Effect.andThen(Effect.logInfo("left queued")),
        Effect.as("returned"),
        StepLogCapture.capture(journal.service, attribution)
      )
      expect(result).toBe("returned")
      expect(messages(journal.handed)).toEqual([["interrupted"], ["Log lines dropped"]])
      expect(journal.handed[1]!.annotations.dropped).toBe(2)
      expect((yield* counted("DroppedFlush")) - before).toBe(2)
    }))

  it.live("stops waiting for a journal that never answers at the flush deadline", () =>
    Effect.gen(function*() {
      const journal = journalOf(() => Effect.never)
      const before = yield* counted("DroppedFlush")
      const result = yield* Effect.gen(function*() {
        yield* Effect.logInfo("in flight")
        yield* Effect.yieldNow
        yield* Effect.logInfo("stranded")
        return "returned"
      }).pipe(
        StepLogCapture.capture(journal.service, attribution),
        Effect.provideService(StepLogs.Limits, { ...StepLogs.defaultLimits, flush: "20 millis" }),
        Effect.timeoutOption("5 seconds")
      )
      expect(result).toEqual(Option.some("returned"))
      // The queued record is always counted; the one in flight is too when the deadline interrupts its write.
      const lost = (yield* counted("DroppedFlush")) - before
      // The summary was attempted too, and given up on at the same deadline.
      expect(messages(journal.handed)).toEqual([["in flight"], ["Log lines dropped"]])
      expect(lost).toBeGreaterThanOrEqual(1)
      expect(journal.handed[1]!.annotations.dropped).toBe(lost)
    }))

  it.live("drops and counts a record a fiber the body forked logs after the body exits", () =>
    Effect.gen(function*() {
      const journal = journalOf(accepted)
      const logged = yield* Deferred.make<void>()
      const before = yield* counted("DroppedQueue")
      yield* Effect.logInfo("body").pipe(
        Effect.andThen(
          Effect.forkDetach(
            Effect.sleep("20 millis").pipe(
              Effect.andThen(Effect.logInfo("late")),
              Effect.andThen(Deferred.succeed(logged, undefined))
            )
          )
        ),
        StepLogCapture.capture(journal.service, attribution)
      )
      yield* Deferred.await(logged)
      expect(messages(journal.handed)).toEqual([["body"]])
      expect((yield* counted("DroppedQueue")) - before).toBe(1)
    }))

  it.effect("flushes a failing, dying or interrupted body's records and leaves its exit unchanged", () =>
    Effect.gen(function*() {
      const failing = journalOf(accepted)
      const failed = yield* Effect.exit(
        Effect.logError("about to fail").pipe(
          Effect.andThen(Effect.fail("broke")),
          StepLogCapture.capture(failing.service, attribution)
        )
      )
      expect(Exit.isFailure(failed) && Cause.squash(failed.cause)).toBe("broke")
      expect(messages(failing.handed)).toEqual([["about to fail"]])

      const dying = journalOf(accepted)
      const died = yield* Effect.exit(
        Effect.logError("about to die").pipe(
          Effect.andThen(Effect.die("bug")),
          StepLogCapture.capture(dying.service, attribution)
        )
      )
      expect(Exit.isFailure(died) && Cause.hasDies(died.cause)).toBe(true)
      expect(messages(dying.handed)).toEqual([["about to die"]])

      const parked = journalOf(accepted)
      const started = yield* Deferred.make<void>()
      const fiber = yield* Effect.forkChild(
        Effect.logInfo("parking").pipe(
          Effect.andThen(Deferred.succeed(started, undefined)),
          Effect.andThen(Effect.never),
          StepLogCapture.capture(parked.service, attribution)
        )
      )
      yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)
      const interrupted = yield* Fiber.await(fiber)
      expect(Exit.isFailure(interrupted) && Cause.hasInterruptsOnly(interrupted.cause)).toBe(true)
      expect(messages(parked.handed)).toEqual([["parking"]])
    }))

  it.effect("journals nothing for a body that logs nothing, even with a journal that never answers", () =>
    Effect.gen(function*() {
      const journal = journalOf(() => Effect.never)
      expect(yield* Effect.succeed("quiet").pipe(StepLogCapture.capture(journal.service, attribution))).toBe("quiet")
      expect(journal.handed).toEqual([])
    }))

  it.effect("journals nothing through a logger set the body handed out, once its attempt is over", () =>
    Effect.gen(function*() {
      const journal = journalOf(accepted)
      // A layer built inside a body can keep the body's logger set and use it later, outside the attempt.
      const kept = yield* Effect.withFiber((fiber) => Effect.succeed(fiber.getRef(Logger.CurrentLoggers))).pipe(
        Effect.tap(() => Effect.logInfo("inside")),
        StepLogCapture.capture(journal.service, attribution)
      )
      yield* Effect.logInfo("outside").pipe(Effect.provideService(Logger.CurrentLoggers, kept))
      expect(messages(journal.handed)).toEqual([["inside"]])
    }))

  it.effect("reads an unusable queue size as one slot and an unusable record budget as off", () =>
    Effect.gen(function*() {
      const narrow = journalOf(accepted)
      yield* Effect.logInfo("kept").pipe(
        StepLogCapture.capture(narrow.service, attribution),
        Effect.provideService(StepLogs.Limits, { ...StepLogs.defaultLimits, queue: Number.NaN })
      )
      expect(messages(narrow.handed)).toEqual([["kept"]])
      const off = journalOf(accepted)
      yield* Effect.logInfo("ignored").pipe(
        StepLogCapture.capture(off.service, attribution),
        Effect.provideService(StepLogs.Limits, { ...StepLogs.defaultLimits, records: Number.NaN })
      )
      expect(off.handed).toEqual([])
    }))
})
