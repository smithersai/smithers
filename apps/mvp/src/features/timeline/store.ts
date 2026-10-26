import { ANSWER_EXCERPT, QUESTION_EXCERPT, revisionOf, summaryReason } from "./identity"
import type { Collection } from "@smthrs/effect-tanstack-db"
import { Deferred, Effect, Metric, Semaphore, Stream } from "effect"
import { codeOf } from "../../errorCode"
import type { FlowDispatch } from "../../flows/dispatch"
import type { Message } from "../chat/schema"

export { revisionOf } from "./identity"

/** Lanes stopped by a failure every later summary would repeat ({@link STOPPING_FAILURES}). */
export const summaryStops = Metric.counter("smithers_timeline_summary_stops")

/** How many summaries run at once on this device: few, so the engine stays free for what the person asked. */
export const SUMMARIES_AT_ONCE = 2

/**
 * Why a summary failed in a way every later entry would fail too, so the tab starts no more until the app opens again:
 * the role has no model (`unconfigured`), the model couldn't answer after the durable step's own retries
 * (`unavailable`: an outage, a refused key, or credit or quota that ran out), or the person's summaries for the day are
 * spent (`capped`). A rejected output (`invalid`), a policy refusal (`refused`) or a summary someone else is making
 * (`taken`) belongs to one entry, so later entries still run.
 */
export const STOPPING_FAILURES: ReadonlyArray<string> = ["unconfigured", "unavailable", "capped"]

/**
 * What every conversation the tab follows shares: the summaries' turns on the engine, the entries waiting for or
 * holding one, the revisions it settled, and whether a summary failed in a way that stops them all
 * ({@link STOPPING_FAILURES}).
 */
export interface Lane {
  readonly permits: Semaphore.Semaphore
  readonly pending: Set<string>
  /** Revisions this tab asked about once, whatever the answer: it never asks again until the app opens again. */
  readonly settled: Set<string>
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
  return { permits: yield* Semaphore.make(SUMMARIES_AT_ONCE), pending: new Set<string>(), settled: new Set<string>(), stopped, stop }
})

/** A row of the conversation's window, as far as a summary reads it: chat's `latest` query gives these. */
export interface Shown {
  readonly id: string
  readonly role: string
  readonly status: string
  readonly text: string
  readonly questionId?: string | null | undefined
  /** The content identity the message's recorded summary was made from; "" or none while it has none. */
  readonly summaryRevision?: string | null | undefined
}

/** The conversation's window: the messages the rail shows, as they enter, change and leave it. */
export interface Window {
  readonly changes: (options?: { readonly initial?: boolean }) => Stream.Stream<ReadonlyArray<Collection.Change<Shown>>>
}

/**
 * Asks for the one model summary of each finished answer the rail shows that needs one (docs/features/timeline.md#cost):
 * longer than its free label says ({@link summaryReason}), and with no summary recorded on the message for its content.
 * Questions and short answers keep their free labels and cost nothing. The run claims the answer on the server before
 * any model call, so however many tabs, devices and people show it, the answer costs one call, and the summary syncs to
 * them all on the message; before this, on smithers.sh on 2026-10-25, every tab, device and fresh browser made its own,
 * and the same 15 messages were summarized again in every burst. Each revision is asked about once per tab; streaming
 * chunks never launch runs. At most `SUMMARIES_AT_ONCE` run at once across every conversation sharing `lane`. Once a
 * summary fails in a way every later one would ({@link STOPPING_FAILURES}), every follower on the lane stops until the
 * app opens again.
 */
export const followSummaries = (
  window: Window,
  messages: Collection.Collection<Message>,
  dispatch: FlowDispatch["Service"],
  lane: Lane,
) => Effect.gen(function* () {
  const { stopped } = lane
  /** Summarizes `row` at `revision` in its turn, unless the entry changed, left or got its summary meanwhile. */
  const summarize = (row: Shown, revision: string, reason: NonNullable<ReturnType<typeof summaryReason>>) =>
    lane.permits.withPermits(1)(Effect.gen(function* () {
      const waited = yield* messages.get(row.id)
      if (waited._tag === "None" || revisionOf(waited.value) !== revision || waited.value.summaryRevision === revision) return
      const asked = row.questionId ? yield* messages.get(row.questionId) : undefined
      const question = asked?._tag === "Some" ? asked.value.text.slice(0, QUESTION_EXCERPT) : undefined
      lane.settled.add(revision)
      const result = yield* dispatch.dispatch("timeline/summarize", {
        id: row.id, revision, role: "assistant", text: row.text.slice(0, ANSWER_EXCERPT), reason,
        ...(question === undefined ? {} : { question }),
      }, { door: "sync", executionId: `timeline-${revision}` })
      // A summary made here or elsewhere arrives with the message.
      if (result._tag === "Done" || !STOPPING_FAILURES.includes(result.error.code)) return
      if (result.error.code === "unconfigured") yield* Effect.logWarning("timeline.summary.unconfigured")
      // Once per lane: the first failure stops it; a turn that was already running may fail the same way after.
      yield* lane.stop(result.error.code)
    }))
  yield* Effect.scoped(window.changes({ initial: true }).pipe(
    Stream.flattenIterable,
    Stream.filter(change => change.type !== "delete" && change.value.role === "assistant" && change.value.status === "done" && change.value.text.trim() !== ""),
    Stream.interruptWhen(Deferred.await(stopped)),
    Stream.runForEachWhile(change => Effect.gen(function* () {
      if (yield* Deferred.isDone(stopped)) return false
      yield* Effect.gen(function* () {
        const row = change.value
        const revision = revisionOf(row)
        if (row.summaryRevision === revision) return
        const reason = summaryReason(row.text)
        if (reason === undefined || lane.pending.has(revision) || lane.settled.has(revision)) return
        lane.pending.add(revision)
        yield* Effect.ensuring(summarize(row, revision, reason), Effect.sync(() => lane.pending.delete(revision)))
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("timeline.summary.unavailable").pipe(
            Effect.annotateLogs({
              feature: "timeline",
              errorCode: codeOf(error),
              reason: error.reason,
            }),
          )
        ),
        Effect.catchDefect((defect) =>
          Effect.logWarning("timeline.summary.defect").pipe(
            Effect.annotateLogs({ feature: "timeline", errorCode: codeOf(defect) }),
          )
        ),
        Effect.forkScoped({ startImmediately: true }),
      )
      return true
    })),
  ))
})
