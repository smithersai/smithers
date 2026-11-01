import { ANSWER_EXCERPT, QUESTION_EXCERPT, revisionOf } from "./identity"
import { exchangeUnits, phaseUnits, planOf, type PhaseRow } from "./marks"
import type { Collection } from "@smthrs/effect-tanstack-db"
import { Deferred, Duration, Effect, Metric, Semaphore, Stream, SubscriptionRef } from "effect"
import { codeOf } from "../../errorCode"
import type { FlowDispatch } from "../../flows/dispatch"
import type { Message } from "../chat/schema"
import { SegmentSpans, SummarizeEntry } from "./flow"

export { revisionOf } from "./identity"

/** Lanes stopped by a failure every later summary would repeat ({@link STOPPING_FAILURES}). */
export const summaryStops = Metric.counter("smithers_timeline_summary_stops")

/** How many summaries run at once on this device: few, so the engine stays free for what the person asked. */
export const SUMMARIES_AT_ONCE = 2

/**
 * Why a summary failed in a way every later entry would fail too, so the tab starts no more until the app opens again:
 * the role has no model (`unconfigured`), the model couldn't answer after the durable step's own retries
 * (`unavailable`: an outage or a refused key), the model ran out of credit (`credit`), or the person's summaries for the
 * day are spent (`capped`). A rejected output (`invalid`), a policy refusal (`refused`) or a summary someone else is making
 * (`taken`) belongs to one entry, so later entries still run.
 */
export const STOPPING_FAILURES: ReadonlyArray<string> = ["unconfigured", "unavailable", "capped", "credit", "server"]

/** Endings of a run that left its work free for a later run: its claim was released, or someone else's may have lapsed. */
const FREED: ReadonlyArray<string> = ["unavailable", "unconfigured", "capped", "credit", "server", "taken"]
const endedFree = (ended: { readonly _tag: "Done" | "Failed"; readonly value?: unknown; readonly error?: unknown }) =>
  ended._tag === "Done"
    ? (ended.value as { readonly outcome?: string }).outcome === "taken"
    : FREED.includes((ended.error as { readonly code: string }).code)
/** A run's retry on a later app open: never the same open, since the lane asks about each revision once. */
export const summaryRetry = { action: SummarizeEntry.name, when: endedFree }
/** The same for phases, where a rejected answer also frees its claim. */
export const phaseRetry = {
  action: SegmentSpans.name,
  when: (ended: Parameters<typeof endedFree>[0]) => endedFree(ended) || (ended.error as { readonly code?: string } | undefined)?.code === "invalid",
}

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
  /** Preventing causes, including entry-local failures, replayed for the notification follower. */
  readonly failures: Stream.Stream<string>
  readonly report: (code: string) => Effect.Effect<void>
  /**
   * Stops every follower on the lane for the failure `code` ({@link STOPPING_FAILURES}), recorded once however many
   * summaries fail that way: `timeline.summary.stopped` and {@link summaryStops}. Uninterruptible: stopping ends the
   * window's stream, whose scope holds the fiber that stops it.
   */
  readonly stop: (code: string) => Effect.Effect<void>
  /** Why it stopped, once it has: what the rail and the toast say (src/features/timeline/notice.ts). */
  readonly stoppedFor: () => string | undefined
}

/** A tab's lane: made once, shared by its home and branch conversations. */
export const makeLane: Effect.Effect<Lane> = Effect.gen(function* () {
  const stopped = yield* Deferred.make<void>()
  const failures = yield* SubscriptionRef.make<ReadonlyArray<string>>([])
  const report = (code: string) => code === "taken" ? Effect.void : SubscriptionRef.update(failures, codes => codes.includes(code) ? codes : [...codes, code])
  let cause: string | undefined
  const stop = (code: string) =>
    Effect.uninterruptible(Effect.gen(function* () {
      yield* report(code)
      // Before the stop is seen: a follower reads why as soon as it wakes.
      if (cause === undefined) cause = code
      if (!(yield* Deferred.succeed(stopped, undefined))) return
      yield* Effect.logWarning("timeline.summary.stopped").pipe(Effect.annotateLogs({ code }))
      yield* Metric.update(summaryStops, 1)
    }))
  return { permits: yield* Semaphore.make(SUMMARIES_AT_ONCE), pending: new Set<string>(), settled: new Set<string>(), failures: SubscriptionRef.changes(failures).pipe(Stream.flattenIterable), report, stopped, stop, stoppedFor: () => cause }
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
  /** Everything in it, oldest first: what comes before a question. */
  readonly toArray?: Effect.Effect<ReadonlyArray<Shown>>
}

/**
 * Asks for the one model summary of each settled message the rail spans with no summary recorded for its content
 * (docs/features/timeline.md#cost), newest first, so a long conversation's latest work reads first. The run claims the
 * message on the server before any model call, so however many tabs, devices and people show it, it costs one call, and
 * the summary syncs to them all; before this, on smithers.sh on 2026-10-25, every tab, device and fresh browser made its
 * own, and the same 15 messages were summarized again in every burst. Each revision is asked about once per tab;
 * streaming chunks never launch runs. At most `SUMMARIES_AT_ONCE` run at once across every conversation sharing `lane`.
 * Once a summary fails in a way every later one would ({@link STOPPING_FAILURES}), every follower on the lane stops
 * until the app opens again.
 */
export const followSummaries = (
  window: Window,
  messages: Collection.Collection<Message>,
  dispatch: FlowDispatch["Service"],
  lane: Lane,
) => Effect.gen(function* () {
  const { stopped } = lane
  /** Summarizes `row` at `revision` in its turn, unless the entry changed, left or got its summary meanwhile. */
  const summarize = (row: Shown, revision: string) =>
    lane.permits.withPermits(1)(Effect.gen(function* () {
      const waited = yield* messages.get(row.id)
      if (waited._tag === "None" || revisionOf(waited.value) !== revision || waited.value.summaryRevision === revision) return
      const asked = row.questionId ? yield* messages.get(row.questionId) : undefined
      const shown = row.role === "user" && window.toArray !== undefined ? yield* window.toArray : []
      const before = shown[shown.findIndex(other => other.id === row.id) - 1]
      const question = (asked?._tag === "Some" ? asked.value.text : before?.text)?.slice(0, QUESTION_EXCERPT)
      lane.settled.add(revision)
      const asker = row.role === "user"
      const result = yield* dispatch.dispatch("timeline/summarize", {
        id: row.id, revision, role: asker ? "user" : "assistant", text: row.text.slice(0, ANSWER_EXCERPT), reason: asker ? "question" : "answer",
        ...(question === undefined ? {} : { question }),
      }, { door: "sync", executionId: `timeline-${revision}`, retry: summaryRetry })
      // A summary made here or elsewhere arrives with the message.
      if (result._tag === "Done") return
      yield* lane.report(result.error.code)
      if (!STOPPING_FAILURES.includes(result.error.code)) return
      if (result.error.code === "unconfigured") yield* Effect.logWarning("timeline.summary.unconfigured")
      // Once per lane: the first failure stops it; a turn that was already running may fail the same way after.
      yield* lane.stop(result.error.code)
    }))
  yield* Effect.scoped(window.changes({ initial: true }).pipe(
    Stream.map(changes => [...changes].reverse()),
    Stream.flattenIterable,
    Stream.filter(change => change.type !== "delete" && (change.value.role === "assistant" || change.value.role === "user") && change.value.status === "done" && change.value.text.trim() !== ""),
    Stream.interruptWhen(Deferred.await(stopped)),
    Stream.runForEachWhile(change => Effect.gen(function* () {
      if (yield* Deferred.isDone(stopped)) return false
      yield* Effect.gen(function* () {
        const row = change.value
        const revision = revisionOf(row)
        if (row.summaryRevision === revision) return
        if (lane.pending.has(revision) || lane.settled.has(revision)) return
        lane.pending.add(revision)
        yield* Effect.ensuring(summarize(row, revision), Effect.sync(() => lane.pending.delete(revision)))
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("timeline.summary.unavailable").pipe(
            Effect.annotateLogs({
              feature: "timeline",
              errorCode: codeOf(error),
              reason: error.reason,
            }),
            Effect.andThen(lane.report(`dispatch:${error.reason}`)),
          )
        ),
        Effect.catchDefect((defect) =>
          Effect.logWarning("timeline.summary.defect").pipe(
            Effect.annotateLogs({ feature: "timeline", errorCode: codeOf(defect) }),
            Effect.andThen(lane.report("defect")),
          )
        ),
        Effect.forkScoped({ startImmediately: true }),
      )
      return true
    })),
  ))
})

/** The whole conversation, as phases read it: chat's `everything` query gives these. */
export interface Everything {
  readonly toArray: Effect.Effect<ReadonlyArray<PhaseRow & { readonly arc?: string | null | undefined }>>
  readonly changes: Window["changes"]
}

/** How long a conversation stays quiet before phases look at it: it never reads a burst of syncing rows one by one. */
export const PHASES_SETTLE = Duration.seconds(3)

/**
 * Keeps a conversation's phases and arcs up to date (decision 0138): whenever it has settled, runs the next
 * segmentation that is due ({@link planOf}), one at a time, on the summaries' lane. Each plan is asked about once per
 * tab, the server's claim makes it one call for everyone, and a closed span is never read again.
 */
export const followPhases = (everything: Everything, dispatch: FlowDispatch["Service"], lane: Lane) =>
  Effect.scoped(everything.changes({ initial: true }).pipe(
    Stream.filter(changes => changes.some(change => change.value.status === "done" || change.value.status === "failed")),
    Stream.debounce(PHASES_SETTLE),
    Stream.interruptWhen(Deferred.await(lane.stopped)),
    Stream.runForEach(() => Effect.gen(function* () {
      const rows = yield* everything.toArray
      const plans = [planOf(exchangeUnits(rows), 1), planOf(phaseUnits(rows), 2)]
      for (const plan of plans) {
        if (plan === undefined || lane.settled.has(plan.revision)) continue
        lane.settled.add(plan.revision)
        const result = yield* lane.permits.withPermits(1)(dispatch.dispatch("timeline/phases", plan, { door: "sync", executionId: `timeline-${plan.revision}`, retry: phaseRetry }))
        if (result._tag === "Done") continue
        yield* lane.report(result.error.code)
        if (!STOPPING_FAILURES.includes(result.error.code)) continue
        yield* lane.stop(result.error.code)
      }
    }).pipe(
      Effect.catch(error => Effect.logWarning("timeline.summary.unavailable").pipe(
        Effect.annotateLogs({ feature: "timeline", errorCode: codeOf(error), reason: error.reason }), Effect.andThen(lane.report(`dispatch:${error.reason}`)),
      )),
      Effect.catchDefect(defect => Effect.logWarning("timeline.summary.defect").pipe(
        Effect.annotateLogs({ feature: "timeline", errorCode: codeOf(defect) }), Effect.andThen(lane.report("defect")),
      )),
    )),
  ))
