import { Effect, Metric, Stream } from "effect"
import type { SyncEvent } from "./messagesShardRows"

/** Conversation/composer availability after shape failures, through the app's existing telemetry runtime. */
export const loads = Metric.counter("smithers_web_chat_loads", { incremental: true })

/** Observe the shape's own retry policy; a recovery requires its rows to be applied, not merely an HTTP response. */
export const observeLoad = (messages: { readonly sync: Stream.Stream<SyncEvent>; readonly applied: Stream.Stream<void> }) =>
  Effect.gen(function* () {
    let failed = false
    const record = (outcome: "failed" | "recovered", status: number) => Effect.forEach(
      ["conversation", "composer"] as const,
      (surface) => Effect.gen(function* () {
        const fields = { shape: "chat.messages", surface, status, outcome }
        yield* Metric.update(Metric.withAttributes(loads, { ...fields, status: String(status) }), 1)
        yield* Effect.logWithLevel(outcome === "failed" ? "Warn" : "Info")(outcome === "failed" ? "chat load failed" : "chat load recovered").pipe(
          Effect.annotateLogs(fields),
        )
      }).pipe(Effect.withSpan("chat.load", { attributes: { surface, outcome, status, shape: "chat.messages" } })),
      { discard: true },
    )
    const events = Stream.merge(messages.sync, Stream.map(messages.applied, () => ({ _tag: "Applied" as const })))
    yield* events.pipe(Stream.runForEach((event) => Effect.gen(function* () {
      if (event._tag === "Failed" || event._tag === "Stopped") {
        if (!failed) {
          failed = true
          yield* record("failed", (event._tag === "Failed" ? event.status : event.error.status) ?? 0)
        }
      } else if (event._tag === "Applied" && failed) {
        failed = false
        yield* record("recovered", 200)
      }
    })))
  })
