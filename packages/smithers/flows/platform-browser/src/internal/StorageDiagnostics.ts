/**
 * Content-free SQLite initialization boundaries for the browser host.
 * @since 1.0.0
 */

import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Metric from "effect/Metric"

/** Bounded native classifications; arbitrary error names and messages may contain user content. */
const names = new Set([
  "SecurityError",
  "NotAllowedError",
  "InvalidStateError",
  "NoModificationAllowedError",
  "QuotaExceededError",
  "NotSupportedError",
  "NotFoundError",
  "UnknownError",
  "TypeError",
  "Error",
  "CompileError",
  "LinkError",
  "RuntimeError"
])

/**
 * SQLite initialization stages, by stage and outcome.
 * @category metrics
 * @since 1.0.0
 */
export const openings = Metric.counter("smithers_browser_sqlite_openings", { incremental: true })

/**
 * Report the storage boundary before SqlError hides its native reason. Never record paths or SQL.
 * @category observability
 * @since 1.0.0
 */
export const observe = <A, E, R>(stage: "build" | "opfs" | "database" | "journal", effect: Effect.Effect<A, E, R>) => {
  const record = (outcome: "opening" | "ready" | "failed" | "interrupted", error?: unknown) =>
    Effect.gen(function*() {
      const native = (error as { readonly reason?: { readonly cause?: unknown } } | undefined)?.reason?.cause ?? error
      const name = (native as { readonly name?: unknown } | undefined)?.name
      const fields = {
        stage,
        outcome,
        ...(outcome === "failed"
          ? { "error.type": typeof name === "string" && names.has(name) ? name : "unknown" }
          : {})
      }
      yield* Metric.update(Metric.withAttributes(openings, { stage, outcome }), 1)
      yield* Effect.logInfo("browser.sqlite.open").pipe(Effect.annotateLogs(fields))
      yield* Effect.annotateCurrentSpan(fields)
    })
  return Effect.uninterruptibleMask((restore) =>
    record("opening").pipe(
      // The diagnostic span receives only a value, never the caller's original
      // failure. Exporters otherwise serialize its message, name and stack.
      Effect.andThen(Effect.exit(restore(effect))),
      Effect.tap((exit) =>
        Exit.isSuccess(exit) ?
          record("ready")
          : Cause.hasInterruptsOnly(exit.cause) ?
          record("interrupted")
          : record("failed", Cause.squash(exit.cause))
      ),
      Effect.withSpan("browser.sqlite.open", { attributes: { stage } }),
      Effect.flatMap((exit) => Exit.isSuccess(exit) ? Effect.succeed(exit.value) : Effect.failCause(exit.cause))
    )
  )
}
