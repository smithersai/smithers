/**
 * The journal-backed alert runtime: one tick per run.
 *
 * A tick folds the run's journal into the conditions it leaves open, decides
 * which have outlived their delay, admits each one as a coalesced system
 * event, pages the sink, and journals what the sink did with it. The fold is
 * retained per run, so a tick costs the entries committed since the previous
 * one rather than the run's whole journal.
 *
 * The rules it enforces are `./AlertPolicy.ts` and the channel it pages over
 * is `./AlertSink.ts`; neither knows this module exists.
 *
 * @since 1.0.0
 */

import { Journal, JournalEvent } from "@smthrs/journal"
import { Clock, Context, Effect, HashMap, HashSet, Layer, Option, Result, Schema } from "effect"
import {
  acknowledgedEventType,
  type Alert,
  alertId,
  coalescingKey,
  decide,
  deliveredEventType,
  detectorsOf,
  failedEventType,
  observe,
  type Opened,
  payloadRecord,
  Policy,
  recordSourceId
} from "./AlertPolicy.ts"
import { FailureCode, Sink } from "./AlertSink.ts"
import * as FoldCache from "./internal/foldCache.ts"
import type * as NotificationModel from "./Notification.ts"
import { NotificationError, NotificationQueue } from "./NotificationQueue.ts"

/**
 * What one tick decided.
 *
 * @category models
 * @since 0.1.0
 */
export interface Tick {
  /** Alerts raised and delivered on this tick. */
  readonly delivered: ReadonlyArray<Alert>
  /** Alerts the sink refused on this tick. They are retried on the next one. */
  readonly failed: ReadonlyArray<Alert>
  /**
   * Alerts the notification queue refused because the run is at capacity. The
   * sink was not called for them, and they are retried on the next tick.
   */
  readonly refused: ReadonlyArray<Alert>
  /**
   * Alerts that were not delivered again: this page had already been
   * delivered, or somebody acknowledged the alert.
   */
  readonly suppressed: ReadonlyArray<Alert>
}

/**
 * One alert a run has now, and what has happened to it.
 *
 * `raised` has outlived its delay and no sink has taken it yet. `delivered`
 * reached the sink at least once. `acknowledged` was taken by a person, who
 * is named in `acknowledgedBy`, and is not paged about again.
 *
 * @category models
 * @since 1.0.0
 */
export interface Standing {
  /** The alert's id, without a repeat's ending: what {@link RuntimeService.acknowledge} takes. */
  readonly alertId: string
  readonly alert: Alert
  readonly state: "raised" | "delivered" | "acknowledged"
  readonly acknowledgedBy?: string | undefined
}

/**
 * The alert runtime: one tick per run.
 *
 * @category services
 * @since 0.1.0
 */
export interface RuntimeService {
  /**
   * Reads one run's journal and pages about whatever has waited too long.
   *
   * The two failures stay apart because they mean different things to an
   * operator. A `JournalError` is the alerter's own record channel failing: it
   * read no entries, or it could not write the delivery record. A
   * `NotificationError` is the notification queue rejecting the alert outright,
   * which is a producer or storage fault rather than a full queue. Neither is
   * a sink failure: a refused page is journaled as `flows.alerts.failed` and
   * retried on the next tick, and it comes back in {@link Tick.failed}. A queue
   * at capacity is not a failure either; it comes back in {@link Tick.refused}.
   */
  readonly tick: (runId: string) => Effect.Effect<Tick, Journal.JournalError | NotificationError>
  /**
   * Records that `by` has taken the alert `alertId` on `runId`.
   *
   * Answers `true` once the acknowledgement is journaled, and again for every
   * repeat of the same acknowledgement. Answers `false`, and writes nothing,
   * when no open condition on the run has that id: the condition cleared, or
   * the id names a repeat or another run's alert. From then on a tick neither
   * pages nor repeats the alert. A condition that clears and re-opens is a new
   * alert, and nobody has acknowledged that one.
   */
  readonly acknowledge: (runId: string, alertId: string, by: string) => Effect.Effect<boolean, Journal.JournalError>
  /**
   * The alerts a run has now: every open condition past its delay, with
   * whether it was delivered and who acknowledged it.
   */
  readonly standing: (runId: string) => Effect.Effect<ReadonlyArray<Standing>, Journal.JournalError>
}

/**
 * The {@link RuntimeService} tag.
 *
 * @category services
 * @since 0.1.0
 */
export class AlertRuntime extends Context.Service<AlertRuntime, RuntimeService>()(
  "/notifications/AlertRuntime"
) {}

const decodeRunId = Schema.decodeUnknownOption(JournalEvent.RunId)
const decodeSourceId = Schema.decodeUnknownOption(JournalEvent.SourceId)
const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

/** What every identifier the journal stores must be; a message names the rule, never the value. */
const identifierRule =
  `well-formed UTF-16, free of NUL, and at most ${JournalEvent.maxIdentifierLength} code units long`

/**
 * The longest outcome a tick records an alert under. An alert id that fits the
 * journal's identifier bound with this outcome fits it with every other.
 */
const longestOutcome = ["delivered", "refused", ...FailureCode.literals.map((code) => `failed/${code}`)]
  .reduce((longest, outcome) => outcome.length > longest.length ? outcome : longest)

/**
 * One run's folded alert history: the conditions still open, the alerts
 * already paged, and the sequence the fold stopped at.
 */
interface Watched {
  readonly open: ReadonlyMap<string, Opened>
  /**
   * The alerts already paged, as a persistent set: a tick adds a node and
   * leaves the fold the previous tick published untouched, where copying the
   * set would cost the run's whole delivery history on every tick.
   */
  readonly delivered: HashSet.HashSet<string>
  /** The alerts with at least one delivered page, by the id a person acknowledges. */
  readonly paged: HashSet.HashSet<string>
  /** Who acknowledged each alert, by the same id. */
  readonly acknowledged: HashMap.HashMap<string, string>
  readonly cursor: number | undefined
}

/** The id a person acknowledges an alert by: its first page's. */
const firstId = (alert: Pick<Alert, "coalescingKey" | "since">): string =>
  alertId({ coalescingKey: alert.coalescingKey, since: alert.since })

/** The same id, read back off a delivery record of any of the alert's pages. */
const firstIdOf = (pageId: string, reminder: unknown): string => {
  const ending = `:r${String(reminder)}`
  return typeof reminder === "number" && pageId.endsWith(ending) ? pageId.slice(0, -ending.length) : pageId
}

/** The longest name of an acknowledging person a record keeps. */
const maxAcknowledgerLength = 200

/**
 * How many runs one alert runtime keeps folded at a time. The retention policy
 * is scan-resistant, so a sweep of more runs than this reads journal tails for
 * all but a fixed handful of them.
 */
const maximumWatchedRuns = 64

const alertNotification = (alert: Alert): NotificationModel.Notification => ({
  _tag: "system-event",
  id: alertId(alert),
  targetLineageId: alert.runId,
  delivery: "queue",
  coalescingKey: alert.coalescingKey,
  provenance: {
    sourceRunId: alert.runId,
    sourceLineageId: alert.runId,
    sourceTurn: 0,
    sourceActor: "alerts"
  },
  payload: {
    condition: alert.condition,
    severity: alert.severity,
    since: alert.since,
    firedAt: alert.firedAt,
    ...(alert.reminder === undefined ? {} : { reminder: alert.reminder }),
    ...(alert.summary === undefined ? {} : { summary: alert.summary }),
    ...(alert.owner === undefined ? {} : { owner: alert.owner }),
    ...(alert.runbook === undefined ? {} : { runbook: alert.runbook })
  }
})

/**
 * The alert runtime over one policy.
 *
 * A tick reads the run's journal, derives the open conditions, decides which
 * have outlived their delay, and for each one that has not already been
 * delivered: admits a coalesced system event, sends it to the sink, and
 * journals the delivery. The admission comes first because it is idempotent
 * and the send is not: a crash between them costs a duplicate admission, which
 * the queue drops, while a crash between an accepted send and the delivery
 * record costs a duplicate PAGE, which is why {@link SinkService.deliver} is
 * required to dedupe on {@link alertId}.
 *
 * The policy is decoded when the layer is built, so a rule with an impossible
 * delay fails the composition by name instead of mis-paging at 3am.
 *
 * @param policy the rules to enforce
 * @category layers
 * @since 0.1.0
 */
export const layer = (
  policy: Policy
): Layer.Layer<AlertRuntime, never, Journal.Journal | NotificationQueue | Sink> =>
  Layer.effect(
    AlertRuntime,
    Effect.gen(function*() {
      const checked = yield* Effect.orDie(Schema.decodeUnknownEffect(Policy)(policy))
      const detectors = detectorsOf(checked)
      const journal = yield* Journal.Journal
      const queue = yield* NotificationQueue
      const sink = yield* Sink
      // Folded history per run, so a tick costs the entries committed since
      // the previous one rather than the run's whole journal.
      const watched = FoldCache.make<Watched>(maximumWatchedRuns)

      const observed = (runId: JournalEvent.RunId): Effect.Effect<Watched, Journal.JournalError> =>
        Effect.gen(function*() {
          const base: Watched = watched.get(runId) ??
            {
              open: new Map(),
              delivered: HashSet.empty(),
              paged: HashSet.empty(),
              acknowledged: HashMap.empty(),
              cursor: undefined
            }
          const fresh: Array<JournalEvent.Entry> = []
          let after = base.cursor === undefined ? undefined : JournalEvent.Seq.make(base.cursor)
          while (true) {
            const page = yield* journal.entries({ runId, ...(after === undefined ? {} : { after }), limit: 512 })
            fresh.push(...page.entries)
            if (!page.hasMore || page.entries.length === 0) break
            after = page.entries.at(-1)!.seq
          }
          if (fresh.length === 0) return base

          // `open` is bounded by the policy's rules, so it is copied; the
          // delivery history is not, so it grows by one persistent node.
          const open = new Map(base.open)
          let delivered = base.delivered
          let paged = base.paged
          let acknowledged = base.acknowledged
          let cursor = base.cursor
          for (const entry of fresh) {
            cursor = entry.seq
            const payload = payloadRecord(entry.payload)
            if (payload === undefined) continue
            if (entry.eventType === deliveredEventType) {
              const id = payload["alertId"]
              // Only a record under the source the alerter writes counts, so
              // another producer's delivered record cannot suppress a page.
              // The journal does not bind a source to a writer.
              if (typeof id === "string" && entry.sourceId === recordSourceId(id, "delivered")) {
                delivered = HashSet.add(delivered, id)
                paged = HashSet.add(paged, firstIdOf(id, payload["reminder"]))
              }
            }
            if (entry.eventType === acknowledgedEventType) {
              const id = payload["alertId"]
              const by = payload["by"]
              // Scoped to the alerter's source exactly as a delivery is.
              if (
                typeof id === "string" && typeof by === "string" &&
                entry.sourceId === recordSourceId(id, "acknowledged")
              ) {
                acknowledged = HashMap.set(acknowledged, id, by)
              }
            }
            observe(checked, detectors, entry, payload, open)
          }
          const next: Watched = { open, delivered, paged, acknowledged, cursor }
          // Published at commit, exactly as `NotificationQueue.load` publishes
          // its fold. A tick inside an enclosing transaction reads that
          // transaction's uncommitted rows, and caching them would outlive the
          // rollback that erased them: the run would page about a condition
          // durable history never held.
          yield* journal.whenCommitted(Effect.sync(() => watched.put(runId, next)))
          return next
        })

      const record = (
        eventType: string,
        alert: Alert,
        source: string,
        outcome: { readonly code?: string | undefined; readonly status?: number | undefined }
      ): Effect.Effect<void, Journal.JournalError> =>
        journal.emitDurableUnfenced(
          new JournalEvent.Input({
            runId: JournalEvent.RunId.make(alert.runId),
            sourceId: JournalEvent.SourceId.make(recordSourceId(alertId(alert), source)),
            sourceSeq: JournalEvent.SourceSeq.make(0),
            // One record per alert per outcome. Without an explicit identity
            // the journal allocates a new sequence on every attempt, and a
            // webhook that stays down appends a row per tick forever.
            dedupe: "identity",
            eventType,
            payload: {
              runId: alert.runId,
              condition: alert.condition,
              since: alert.since,
              severity: alert.severity,
              alertId: alertId(alert),
              ...(alert.reminder === undefined ? {} : { reminder: alert.reminder }),
              ...(outcome.code === undefined ? {} : { code: outcome.code }),
              ...(outcome.status === undefined ? {} : { status: outcome.status })
            }
          })
        ).pipe(Effect.asVoid)

      /** One run's fold, and the alerts its open conditions raise now. */
      const considered = Effect.fnUntraced(function*(runId: JournalEvent.RunId) {
        const history = yield* observed(runId)
        const now = yield* Clock.currentTimeMillis
        const open = Array.from(history.open, ([condition, opened]) => ({ runId, condition, ...opened }))
        return { history, raised: decide(checked, open, now) }
      })

      return AlertRuntime.of({
        acknowledge: Effect.fn("AlertRuntime.acknowledge")(function*(runId: string, id: string, by: string) {
          const history = yield* observed(JournalEvent.RunId.make(runId))
          const open = Array.from(history.open).some(([condition, opened]) =>
            firstId({ coalescingKey: coalescingKey(runId, condition), since: opened.since }) === id
          )
          if (!open) return false
          yield* journal.emitDurableUnfenced(
            new JournalEvent.Input({
              runId: JournalEvent.RunId.make(runId),
              sourceId: JournalEvent.SourceId.make(recordSourceId(id, "acknowledged")),
              sourceSeq: JournalEvent.SourceSeq.make(0),
              // The first acknowledgement stands. A second person saying the
              // same thing later is the same fact.
              dedupe: "identity",
              eventType: acknowledgedEventType,
              payload: { runId, alertId: id, by: by.slice(0, maxAcknowledgerLength) }
            })
          )
          return true
        }),
        standing: Effect.fn("AlertRuntime.standing")(function*(runId: string) {
          const { history, raised } = yield* considered(JournalEvent.RunId.make(runId))
          return raised.map((alert): Standing => {
            const id = firstId(alert)
            const by = HashMap.get(history.acknowledged, id)
            if (Option.isSome(by)) return { alertId: id, alert, state: "acknowledged", acknowledgedBy: by.value }
            return { alertId: id, alert, state: HashSet.has(history.paged, id) ? "delivered" : "raised" }
          })
        }),
        tick: Effect.fn("AlertRuntime.tick")(function*(rawRunId: string) {
          const runId = yield* Option.match(decodeRunId(rawRunId), {
            onNone: () =>
              new NotificationError({
                code: "notification_invalid",
                message: `A run id must be a journal identifier: non-empty, ${identifierRule}`,
                path: "runId"
              }),
            onSome: Effect.succeed
          })
          // A condition reaches encodeURIComponent while deciding the alert.
          // Validate before that walk so malformed UTF-16 is a typed refusal.
          for (const condition of Object.keys(checked.rules)) {
            if (loneSurrogate.test(condition)) {
              return yield* new NotificationError({
                code: "notification_invalid",
                message: `An alert condition must be well-formed UTF-16`,
                path: "condition"
              })
            }
          }
          const { history, raised } = yield* considered(runId)
          const delivered: Array<Alert> = []
          const failed: Array<Alert> = []
          const refused: Array<Alert> = []
          const suppressed: Array<Alert> = []
          for (const alert of raised) {
            if (
              HashMap.has(history.acknowledged, firstId(alert)) || HashSet.has(history.delivered, alertId(alert))
            ) {
              suppressed.push(alert)
              continue
            }
            // Every record this tick may write about the alert is keyed on its
            // id, which the percent-encoded run id and condition name make as
            // long as they like. An id the journal cannot store is refused
            // before the alert is admitted or paged, as a failure the caller
            // can read rather than a thrown constructor after the page went out.
            if (Option.isNone(decodeSourceId(recordSourceId(alertId(alert), longestOutcome)))) {
              return yield* new NotificationError({
                code: "notification_invalid",
                message:
                  `An alert id, built from the run id and the condition name, must form a journal identifier with the alerter's source prefix: ${identifierRule}`
              })
            }
            // Raised unchanged: a queue that rejects the admission outright is
            // not the journal failing, and calling it `sink_failed` would send
            // an operator looking at the webhook. The one exception is this
            // alert's own id admitted earlier with other content: the policy
            // that stamps severity, owner, runbook and `firedAt` changed
            // between a refused page and its retry. The run already holds the
            // alert, so the page still goes out, under the policy now in force.
            const receipt = yield* queue.admit(runId, alertNotification(alert)).pipe(
              Effect.catchIf(
                (error) => error.code === "notification_id_reused" && error.notificationId === alertId(alert),
                () => Effect.succeed(undefined)
              )
            )
            if (receipt?.decision === "rejected-full") {
              // The alert has nowhere durable to sit, so paging about it would
              // tell an operator about something the run will never read.
              yield* record(failedEventType, alert, "refused", { code: "notification_full" })
              refused.push(alert)
              continue
            }
            const outcome = yield* Effect.result(sink.deliver(alert))
            if (Result.isFailure(outcome)) {
              yield* record(failedEventType, alert, `failed/${outcome.failure.code}`, {
                code: outcome.failure.code,
                status: outcome.failure.status
              })
              failed.push(alert)
            } else {
              yield* record(deliveredEventType, alert, "delivered", {})
              delivered.push(alert)
            }
          }
          return { delivered, failed, refused, suppressed }
        })
      })
    })
  )
