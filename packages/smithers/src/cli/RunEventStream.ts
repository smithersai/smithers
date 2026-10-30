/** Journal following is settled by committed coordination state, not an earlier engine observation. */
import { Control } from "@smthrs/control"
import { Effect, Stream } from "effect"

/**
 * Follows the injected Control service, preserving cursor and final drain ordering.
 * @since 1.0.0
 * @category constructors
 */
export const events = (runId: string, follow: boolean, afterSequence?: number) =>
  Stream.unwrap(Effect.gen(function*() {
    const control = yield* Control.Control
    let cursor = afterSequence
    const watch = (live: boolean) =>
      control.watch({
        runId,
        follow: live,
        ...(cursor === undefined ? {} : { afterSequence: cursor })
      })
    if (!follow) return watch(false)
    const terminal = Effect.gen(function*() {
      while (true) {
        const page = yield* control.list({ _tag: "runs", filters: { runId } })
        if (
          page._tag === "runs" &&
          page.items.some((run) => {
            // Engine cancellation can precede the control transaction that
            // commits its terminal event. Only that transaction ends a follow.
            const status = run.recordedStatus ?? run.status
            return run.runId === runId && (status === "completed" || status === "failed" || status === "cancelled")
          })
        ) return
        yield* Effect.sleep("250 millis")
      }
    })
    return watch(true).pipe(
      Stream.interruptWhen(terminal),
      Stream.tap((event) =>
        Effect.sync(() => {
          cursor = event.sequence
        })
      ),
      Stream.concat(Stream.unwrap(Effect.sync(() => watch(false))))
    )
  }))
