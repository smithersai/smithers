/**
 * Journal following is settled by committed coordination state, not an earlier engine observation.
 *
 * @since 1.0.0
 */

import { HostLiveness } from "@smthrs/platform-node"

import { Control, type ControlSchema } from "@smthrs/control"
import { Ownership } from "@smthrs/run-store"
import { Clock, Effect, Schema, Stream } from "effect"
import { hostname } from "node:os"
import * as CliError from "../CliError.ts"
import * as BoundedEvents from "../internal/BoundedEvents.ts"

const observer: Ownership.OwnerId = { hostId: hostname(), pid: process.pid, nonce: "cli-log-observer" }
const isTerminal = (status: ControlSchema.RunStatus) =>
  status === "completed" || status === "failed" || status === "cancelled"

/** A read may stop waiting for a writer only with positive local death evidence. */
const orphaned = (run: ControlSchema.RunSummary): Effect.Effect<boolean> => {
  const identity = run.ownerId ?? run.parkedBy
  if (identity === undefined) return Effect.succeed(false)
  try {
    const owner = Schema.decodeUnknownSync(Ownership.OwnerId)(JSON.parse(identity))
    // A foreign pid belongs to another process namespace. It proves nothing
    // here; unreadable/unknown owners likewise retain the committed-state wait.
    if (!Ownership.sameHostIncarnation(owner, observer)) return Effect.succeed(false)
    return Clock.currentTimeMillis.pipe(
      Effect.flatMap((nowMs) =>
        HostLiveness.sameHostPidProbe(owner, { claimant: observer, heartbeatAtMs: null, nowMs })
      ),
      Effect.map((alive) => !alive)
    )
  } catch {
    return Effect.succeed(false)
  }
}

/**
 * A whole-entry cursor resumes by sequence. A cursor inside an expansion keeps
 * its offset, so the entry's remaining members are not skipped.
 */
const resume = (cursor: ControlSchema.WatchCursor | undefined) =>
  cursor === undefined ? {} : cursor.offset === undefined ? { afterSequence: cursor.sequence } : { afterCursor: cursor }

/**
 * Follows the injected Control service, preserving cursor and final drain ordering.
 * @since 1.0.0
 * @category constructors
 */
export const events = (runId: string, follow: boolean, after?: ControlSchema.WatchCursor) =>
  Stream.unwrap(Effect.gen(function*() {
    const control = yield* Control.Control
    let count = 0
    let bytes = 0
    // Validate before either renderer sees an event. Only finite pulls own a
    // cumulative budget; following never retains or budgets earlier events.
    const bounded = <E>(stream: Stream.Stream<ControlSchema.ControlEvent, E>) =>
      Stream.mapEffect(stream, (event) =>
        Effect.suspend(() => {
          const size = BoundedEvents.encodedBytes(event)
          const excess = size > BoundedEvents.maximumEventBytes
            ? { limit: BoundedEvents.maximumEventBytes, unit: "bytes" as const }
            : !follow && count >= BoundedEvents.maximumEvents
            ? { limit: BoundedEvents.maximumEvents, unit: "events" as const }
            : !follow && bytes + size > BoundedEvents.maximumBytes
            ? { limit: BoundedEvents.maximumBytes, unit: "bytes" as const }
            : undefined
          if (excess !== undefined) {
            return Effect.fail(new CliError.ResourceLimitError({ operation: "logs", subject: runId, ...excess }))
          }
          if (!follow) {
            count++
            bytes += size
          }
          return Effect.succeed(event)
        }))
    let cursor = after
    const watch = (live: boolean) => control.watch({ runId, follow: live, ...resume(cursor) })
    if (!follow) return bounded(watch(false))
    const terminal = Effect.gen(function*() {
      while (true) {
        const page = yield* control.list({ _tag: "runs", filters: { runId } })
        if (page._tag === "runs") {
          for (const run of page.items) {
            if (run.runId !== runId) continue
            // A live writer still owes its terminal journal event. A proven
            // dead local writer cannot commit it: drain the durable journal
            // without writing a replacement event or taking ownership.
            if (isTerminal(run.recordedStatus ?? run.status)) return
            if (isTerminal(run.status) && (yield* orphaned(run))) return
          }
        }
        yield* Effect.sleep("250 millis")
      }
    })
    return bounded(
      watch(true).pipe(
        Stream.interruptWhen(terminal),
        Stream.tap((event) =>
          Effect.sync(() => {
            cursor = event.cursor ?? { sequence: event.sequence }
          })
        ),
        Stream.concat(Stream.unwrap(Effect.sync(() => watch(false))))
      )
    )
  }))
