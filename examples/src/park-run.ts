/** Observe a durable suspension and close its engine before inspecting a parked run. */
import { EventTypes } from "@smthrs/engine-store"
import { Journal, JournalEvent } from "@smthrs/journal"
import { RunStore } from "@smthrs/run-store"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"

const suspended = Schema.is(Schema.Struct({
  decision: Schema.Literal("transitioned"),
  status: Schema.Literal("suspended")
}))

/**
 * Run a new foreground execution in a private engine layer. The supplied layer
 * must construct the engine and its registrations; readers outside this helper
 * use storage-only layers, with no other engine driving the same run.
 *
 * The lossless journal stream observes the real SQLite transition, including
 * one committed before subscription. That observation may be delayed across a
 * retry, so stopping only the caller is insufficient: the coordinator owns its
 * drives separately. Close the caller first to stop retry admission, then close
 * the private engine and join every admitted drive's cleanup. Finally verify
 * the current durable suspension through the reader's still-open RunStore.
 * No durable cancellation is requested; a fresh engine can resume the run.
 */
export const parkRun = <A, E, R, ROut, E2, RIn>(
  executionId: string,
  execute: Effect.Effect<A, E, R>,
  runtime: Layer.Layer<ROut, E2, RIn>
) =>
  Effect.gen(function*() {
    yield* Effect.gen(function*() {
      const journal = yield* Journal.Journal
      const caller = yield* Effect.forkScoped(execute)
      yield* Effect.raceFirst(
        journal.stream({ runId: JournalEvent.RunId.make(executionId) }).pipe(
          Stream.filter(entry => entry.eventType === EventTypes.runDecision && suspended(entry.payload)),
          Stream.runHead
        ),
        Fiber.join(caller).pipe(Effect.andThen(Effect.die(new Error(`Run ${executionId} completed before parking`))))
      )
    }).pipe(Effect.scoped, Effect.provide(Layer.fresh(runtime)))
    const store = yield* RunStore.RunStore
    const row = yield* store.get(executionId)
    if (row.status !== "suspended" || row.cancelRequestedAtMs !== null) {
      return yield* Effect.die(new Error(`Run ${executionId} did not remain suspended after engine shutdown`))
    }
  })
