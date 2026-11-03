/**
 * Journals what an action attempt's body logs to the attempt's run.
 *
 * One logger instance serves every attempt. It reads the attempt's sink from
 * the fiber, so a nested action's body writes to its own step and a log
 * outside any attempt reaches no sink. Adding it to the fiber's logger set is
 * idempotent, so nesting never journals a record twice. The sink's queue is
 * drained by a child fiber forked before the sink is installed: the drain's
 * own warnings go to the ambient loggers only and never feed back into it.
 *
 * Governing description: `../StepLogs.ts`.
 *
 * @since 1.0.0
 */

import { type Journal, JournalEvent, Redaction, TelemetryLog } from "@smthrs/journal"
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Logger from "effect/Logger"
import * as Metric from "effect/Metric"
import * as Queue from "effect/Queue"
import * as EngineStoreMetrics from "../EngineStoreMetrics.ts"
import * as StepLogs from "../StepLogs.ts"

/**
 * Which attempt a body's records belong to.
 *
 * @category models
 * @since 1.0.0
 */
export interface Attribution {
  readonly runId: string
  readonly stepKeyDigest: string
  readonly attempt: number
}

/** One running attempt's queue, bounds and tallies. */
interface Sink {
  readonly queue: Queue.Queue<TelemetryLog.Log, Cause.Done>
  readonly limits: StepLogs.Limits
  readonly annotations: Readonly<Record<string, unknown>>
  admitted: number
  dropped: number
}

/** The running attempt's sink; absent outside every attempt body. */
const CurrentSink = Context.Reference<Sink | undefined>("@smthrs/engine-store/internal/StepLogCapture/CurrentSink", {
  defaultValue: () => undefined
})

const drop = (sink: Sink, outcome: typeof EngineStoreMetrics.stepLog.DroppedQueue, context: Context.Context<never>) => {
  sink.dropped++
  outcome.updateUnsafe(1, context)
}

/**
 * The one step logger. Everything it does is synchronous and bounded: it
 * reads its sink, checks the record budget and the queue's room before it
 * builds anything, snapshots the record, and offers it without waiting.
 */
const stepLogger = Logger.make<unknown, void>((options) => {
  const sink = options.fiber.getRef(CurrentSink)
  if (sink === undefined) return
  if (sink.admitted >= sink.limits.records) {
    drop(sink, EngineStoreMetrics.stepLog.DroppedLimit, options.fiber.context)
  } else if (Queue.isFullUnsafe(sink.queue)) {
    drop(sink, EngineStoreMetrics.stepLog.DroppedQueue, options.fiber.context)
  } else if (
    Queue.offerUnsafe(
      sink.queue,
      TelemetryLog.snapshot(options, {
        maximumBytes: sink.limits.recordBytes,
        annotations: sink.annotations,
        rules: Redaction.diagnosticRules
      })
    )
  ) {
    sink.admitted++
  } else {
    // The queue ended: a fiber the body forked logged after the body exited.
    drop(sink, EngineStoreMetrics.stepLog.DroppedQueue, options.fiber.context)
  }
})

/** Writes one record to the run's journal on the lossy channel, counting what became of it. */
const journal = (target: Journal.Service, sink: Sink, runId: string, record: TelemetryLog.Log) =>
  Effect.suspend(() =>
    target.emitLossy(
      new JournalEvent.Input({
        runId: runId as JournalEvent.RunId,
        sourceId: StepLogs.sourceId as JournalEvent.SourceId,
        eventType: TelemetryLog.eventType,
        payload: record,
        meta: { version: 1, source: "/engine-store/step-log" }
      })
    )
  ).pipe(
    Effect.flatMap((receipt) =>
      receipt._tag === "Dropped"
        ? Effect.sync(() => {
          sink.dropped++
        }).pipe(Effect.andThen(Metric.update(EngineStoreMetrics.stepLog.DroppedJournal, 1)))
        : Metric.update(EngineStoreMetrics.stepLog.Journaled, 1)
    ),
    // Delivery is lossy: a failed write costs that record, is counted, and is
    // reported with a fixed code, never the record, and the drain goes on. An
    // interrupted write costs its record too, and stops the drain; the flush
    // counts what it left queued.
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause) ?
        Effect.sync(() => {
          sink.dropped++
        }).pipe(
          Effect.andThen(Metric.update(EngineStoreMetrics.stepLog.DroppedFlush, 1)),
          Effect.andThen(Effect.interrupt)
        ) :
        Effect.sync(() => {
          sink.dropped++
        }).pipe(
          Effect.andThen(Metric.update(EngineStoreMetrics.stepLog.Failed, 1)),
          Effect.andThen(
            Effect.logWarning("A step log record could not be journaled").pipe(
              Effect.annotateLogs({ code: "step_log_failed" })
            )
          )
        )
    )
  )

/** Forwards queued records until the queue ends and is empty, which `take` reports as `Done`. */
const drain = (target: Journal.Service, sink: Sink, runId: string) =>
  Effect.forever(Effect.flatMap(Queue.take(sink.queue), (record) => journal(target, sink, runId, record))).pipe(
    Effect.catchIf(Cause.isDone, () => Effect.void)
  )

/**
 * Ends the queue and waits, at most `flush`, for the drain to deliver what is
 * queued; what is still queued then is dropped and counted. An attempt that
 * dropped any record then journals one summary saying how many, waiting at
 * most `flush` again.
 *
 * This runs as the body's exit finalizer, so it is uninterruptible. The waits
 * still end on time: a timeout returns when its timer wins, and the fiber it
 * left behind is interrupted with the body's.
 */
const flush = (target: Journal.Service, sink: Sink, runId: string, worker: Fiber.Fiber<void>) =>
  Effect.gen(function*() {
    yield* Queue.end(sink.queue)
    // Most bodies log nothing: with nothing to deliver there is no wait and no timer.
    if (sink.admitted > 0) yield* Effect.timeoutOption(Fiber.await(worker), sink.limits.flush)
    yield* Fiber.interrupt(worker)
    const stranded = Queue.sizeUnsafe(sink.queue)
    if (stranded > 0) {
      sink.dropped += stranded
      yield* Metric.update(EngineStoreMetrics.stepLog.DroppedFlush, stranded)
    }
    if (sink.dropped === 0) return
    const fiberId = yield* Effect.withFiber((fiber) => Effect.succeed(fiber.id))
    const now = yield* Clock.currentTimeMillis
    const summary: TelemetryLog.Log = {
      version: 1,
      level: "Warn",
      message: ["Log lines dropped"],
      annotations: { ...sink.annotations, code: StepLogs.droppedCode, dropped: sink.dropped },
      cause: { version: 1, reasons: [] },
      fiberId,
      timestamp: new Date(now).toISOString()
    }
    yield* Effect.timeoutOption(journal(target, sink, runId, summary), sink.limits.flush)
  })

/**
 * Runs `body` with its log records journaled to `attribution`'s run, and its
 * log annotations carrying `stepKeyDigest`. The body's own exit is returned
 * unchanged: nothing here can fail it, delay it past the flush deadline, or
 * change its value.
 *
 * @category combinators
 * @since 1.0.0
 */
export const capture =
  (target: Journal.Service, attribution: Attribution) =>
  <A, E, R>(body: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.gen(function*() {
      const limits = yield* StepLogs.Limits
      const annotated = Effect.annotateLogs(body, { stepKeyDigest: attribution.stepKeyDigest })
      if (!(limits.records > 0)) return yield* annotated
      const sink: Sink = {
        queue: yield* Queue.bounded<TelemetryLog.Log, Cause.Done>(Math.max(1, Math.floor(limits.queue) || 1)),
        limits,
        annotations: {
          runId: attribution.runId,
          stepKeyDigest: attribution.stepKeyDigest,
          attempt: attribution.attempt
        },
        admitted: 0,
        dropped: 0
      }
      const worker = yield* Effect.forkChild(drain(target, sink, attribution.runId))
      return yield* Effect.withFiber((fiber) =>
        annotated.pipe(
          Effect.provideService(CurrentSink, sink),
          Effect.provideService(Logger.CurrentLoggers, new Set(fiber.getRef(Logger.CurrentLoggers)).add(stepLogger))
        )
      ).pipe(Effect.onExit(() => flush(target, sink, attribution.runId, worker)))
    })
