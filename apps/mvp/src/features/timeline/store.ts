import { revisionOf } from "./identity"
import { Collection, LiveQuery } from "@smthrs/effect-tanstack-db"
import { Deferred, Effect, Metric, Schema, Scope, Semaphore, Stream } from "effect"
import type { FlowDispatch } from "../../flows/dispatch"
import type { Message } from "../chat/schema"

export { revisionOf } from "./identity"

export const Summary = Schema.Struct({ id: Schema.String, revision: Schema.String, summary: Schema.String })
export type Summary = typeof Summary.Type
export const summaryQuery = (rows: Collection.Collection<Summary, string>) => LiveQuery.make(q => q.from({ summary: rows.tanstack }))
export const summaryRemovals = Metric.counter("smithers_timeline_summary_removals")
/** Lanes stopped by a failure every later summary would repeat ({@link STOPPING_FAILURES}). */
export const summaryStops = Metric.counter("smithers_timeline_summary_stops")
export const makeSummaries = Effect.gen(function* () {
  return yield* Collection.persisted({ id: "timeline-summaries", schema: Summary, getKey: row => row.id, schemaVersion: 1 })
})

/** How many summaries run at once on this device: few, so the engine stays free for what the person asked. */
export const SUMMARIES_AT_ONCE = 2

/**
 * Why a summary failed in a way every later entry would fail too, so the tab starts no more until the app opens again:
 * the role has no model (`unconfigured`), or the model couldn't answer after the durable step's own retries
 * (`unavailable`: an outage, a refused key, or credit or quota that ran out). A rejected output (`invalid`) or a
 * policy refusal (`refused`) belongs to one entry, so later entries still run.
 */
export const STOPPING_FAILURES: ReadonlyArray<string> = ["unconfigured", "unavailable"]

/**
 * What every conversation the tab follows shares: the summaries' turns on the engine, the entries waiting for or
 * holding one, and whether a summary failed in a way that stops them all ({@link STOPPING_FAILURES}).
 */
export interface Lane {
  readonly permits: Semaphore.Semaphore
  readonly pending: Set<string>
  readonly stopped: Deferred.Deferred<void>
  /**
   * Stops every follower on the lane for the failure `code` ({@link STOPPING_FAILURES}), recorded once however many
   * summaries fail that way: `timeline.summary.stopped` and {@link summaryStops}. Uninterruptible: stopping ends the
   * window's stream, whose scope holds the fiber that stops it.
   */
  readonly stop: (code: string) => Effect.Effect<void>
}

/** A tab's lane: made once, shared by its home and branch conversations. */
export const makeLane: Effect.Effect<Lane> = Effect.gen(function* () {
  const stopped = yield* Deferred.make<void>()
  const stop = (code: string) =>
    Effect.uninterruptible(Effect.gen(function* () {
      if (!(yield* Deferred.succeed(stopped, undefined))) return
      yield* Effect.logWarning("timeline.summary.stopped").pipe(Effect.annotateLogs({ code }))
      yield* Metric.update(summaryStops, 1)
    }))
  return { permits: yield* Semaphore.make(SUMMARIES_AT_ONCE), pending: new Set<string>(), stopped, stop }
})

/** A row of the conversation's window, as far as a summary reads it: chat's `latest` query gives these. */
export interface Shown {
  readonly id: string
  readonly role: string
  readonly status: string
  readonly text: string
}

/** The conversation's window: the messages the rail shows, as they enter, change and leave it. */
export interface Window {
  readonly changes: (options?: { readonly initial?: boolean }) => Stream.Stream<ReadonlyArray<Collection.Change<Shown>>>
}

/**
 * Summarizes each settled, nonempty ask and answer while the rail shows it: the rows of the conversation's `window`
 * (chat's `latest` query, which Load earlier widens), never every message the device holds. Opening a long
 * conversation starts at most a window's worth of `timeline/summarize` runs, not one per message ever written, which
 * kept a new device's engine and store busy for minutes (docs/features/timeline.md). Streaming chunks never launch
 * model calls. A result is kept only while `messages` still holds that entry unchanged. At most `SUMMARIES_AT_ONCE`
 * run at once across every conversation sharing `lane`, and an entry waiting for or holding a turn isn't queued again:
 * a window of fifty entries used to start fifty runs at once, which the engine woke all together after a reload, and
 * the branch's own flows waited behind them for 20 s (docs/features/timeline.md). Once a summary fails in a way every
 * later one would ({@link STOPPING_FAILURES}), every follower on the lane stops until the app opens again: on
 * smithers.sh on 2026-10-25, a provider refusing for credit was asked for every entry the window showed, 1,206 refused
 * calls in 50 minutes.
 */
export const followSummaries = (
  window: Window,
  messages: Collection.Collection<Message>,
  summaries: Collection.Collection<Summary, string>,
  dispatch: FlowDispatch["Service"],
  lane: Lane,
) => Effect.gen(function* () {
  const { stopped } = lane
  yield* summaries.restored.pipe(Effect.ignore)
  // Window removals include eviction; only the source collection establishes deletion.
  yield* messages.changes().pipe(
    Stream.flattenIterable,
    Stream.filter(change => change.type === "delete"),
    Stream.runForEach(change => Effect.gen(function* () {
      if ((yield* summaries.get(change.value.id))._tag === "None") return
      yield* (yield* summaries.delete(change.value.id)).persisted
      yield* Metric.update(summaryRemovals, 1)
      yield* Effect.logInfo("timeline.summary.deleted")
    }).pipe(Effect.withSpan("timeline.summary.delete"))),
    Effect.forkIn(yield* Scope.Scope, { startImmediately: true }),
  )
  // Once the lane stops, every follower's stream ends and interrupts the entries still waiting for a turn.
  /** Summarizes `row` at `revision` in its turn, unless the entry changed or left meanwhile. */
  const summarize = (row: Shown, revision: string) => lane.permits.withPermits(1)(Effect.gen(function* () {
    const waited = yield* messages.get(row.id)
    if (waited._tag === "None" || revisionOf(waited.value) !== revision) return
    const role = row.role as "user" | "assistant"
    const result = yield* dispatch.dispatch("timeline/summarize", { id: row.id, revision, role, text: row.text.slice(0, 8000) }, { door: "sync", executionId: `timeline-${revision}` })
    if (result._tag !== "Done") {
      if (!STOPPING_FAILURES.includes(result.error.code)) return
      if (result.error.code === "unconfigured") yield* Effect.logWarning("timeline.summary.unconfigured")
      // Once per lane: the first failure stops it; a turn that was already running may fail the same way after.
      yield* lane.stop(result.error.code)
      return
    }
    const current = yield* messages.get(row.id)
    if (current._tag === "None" || revisionOf(current.value) !== revision) return
    const value = { id: row.id, revision, summary: result.value.summary }
    if ((yield* summaries.get(row.id))._tag === "None") yield* summaries.insert(value)
    else yield* summaries.update(row.id, draft => { Object.assign(draft, value) })
  }))
  yield* Effect.scoped(window.changes({ initial: true }).pipe(
    Stream.flattenIterable,
    Stream.filter(change => change.type !== "delete" && (change.value.role === "user" || change.value.role === "assistant") && change.value.status === "done" && change.value.text.trim() !== ""),
    Stream.interruptWhen(Deferred.await(stopped)),
    Stream.runForEachWhile(change => Effect.gen(function* () {
      if (yield* Deferred.isDone(stopped)) return false
      yield* Effect.gen(function* () {
        const row = change.value
        const revision = revisionOf(row)
        const cached = yield* summaries.get(row.id)
        if (cached._tag === "Some" && cached.value.revision === revision) return
        if (lane.pending.has(revision)) return
        lane.pending.add(revision)
        yield* Effect.ensuring(summarize(row, revision), Effect.sync(() => lane.pending.delete(revision)))
      }).pipe(
        Effect.catch(() => Effect.logWarning("timeline.summary.unavailable")),
        Effect.catchDefect(() => Effect.logWarning("timeline.summary.defect")),
        Effect.forkScoped({ startImmediately: true }),
      )
      return true
    })),
  ))
})
