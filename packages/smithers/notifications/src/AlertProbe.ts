/**
 * Probe reports: how a flow step raises an alert.
 *
 * A run condition is something the control plane journals about a run. A probe
 * is a check a step makes about anything else: a site that lags its source, a
 * disk that is nearly full, a deploy that failed. The step reports what it
 * saw into the journal of the run that owns the problem, and the alert
 * runtime treats the report as one more condition: the first `failing` report
 * opens it, later ones leave its clock alone, and an `ok` report closes it.
 *
 * So a probe that fails every hour for a day pages once, and the page names
 * the hour it started.
 *
 * @since 1.0.0
 */

import { Journal, JournalEvent } from "@smthrs/journal"
import { Effect, Schema } from "effect"
import { type Detector, maxSummaryLength, type Policy, type Rule } from "./AlertPolicy.vibe"

/**
 * What a probe saw: the thing it checks is `failing`, or it is `ok`.
 *
 * @category models
 * @since 1.0.0
 */
export const ProbeState = Schema.Literals(["failing", "ok"])

/**
 * What a probe saw.
 *
 * @category models
 * @since 1.0.0
 */
export type ProbeState = typeof ProbeState.Type

/**
 * One probe result.
 *
 * `runId` is the run that owns the problem, which is the run whose inbox the
 * alert lands in and the stream the condition's clock is read from. It need
 * not be the run the reporting step belongs to: a scheduled probe starts a new
 * run on every occurrence, and reporting into one owning run is what makes
 * its repeated failures one condition.
 *
 * `summary` is one line a person reads in the page, such as how far behind the
 * site is. Only the first {@link maxSummaryLength} characters are kept.
 *
 * @category models
 * @since 1.0.0
 */
export const Report = Schema.Struct({
  runId: Schema.NonEmptyString,
  probe: Schema.NonEmptyString,
  state: ProbeState,
  summary: Schema.optional(Schema.String)
})

/**
 * One probe result.
 *
 * @category models
 * @since 1.0.0
 */
export type Report = typeof Report.Type

/**
 * A probe name as one event-type or source segment.
 *
 * `*` is encoded as well, because a detector reads an event type ending in
 * `.*` as a family, and a probe named `disk.*` would otherwise read every
 * `disk.<something>` probe's reports as its own.
 */
const segment = (probe: string): string => encodeURIComponent(probe).replaceAll("*", "%2A")

/**
 * The journal event type one probe's reports are recorded under.
 *
 * Each probe has its own, so two probes reporting into one run never close
 * each other's condition.
 *
 * @param probe the probe's name
 * @category getters
 * @since 1.0.0
 */
export const probeEventType = (probe: string): string => `flows.alerts.probe.${segment(probe)}`

/**
 * The detector that reads one probe's reports.
 *
 * @param probe the probe's name
 * @category constructors
 * @since 1.0.0
 */
export const probeDetector = (probe: string): Detector => ({
  field: "state",
  value: "failing",
  eventTypes: [probeEventType(probe)],
  summary: "summary"
})

/**
 * The rules and detectors for a set of probes, keyed by probe name.
 *
 * Spread the result into a policy. The condition an alert names is the
 * probe's name.
 *
 * @example
 * ```ts
 * import { Alerts } from "@smthrs/notifications"
 *
 * const policy: Alerts.Policy = {
 *   defaults: { owner: "oncall" },
 *   ...Alerts.probes({ "site-freshness": { afterMs: 0, severity: "critical" } })
 * }
 * ```
 *
 * @param rules what to do about each probe, and after how long
 * @category constructors
 * @since 1.0.0
 */
export const probes = (rules: Readonly<Record<string, Rule>>): Pick<Policy, "rules" | "detectors"> => ({
  rules,
  detectors: Object.fromEntries(Object.keys(rules).map((probe) => [probe, probeDetector(probe)]))
})

/**
 * Journals one probe result into the owning run.
 *
 * Call it from a flow step. Every report is one journal entry, and reporting
 * the same state again is harmless: it neither restarts the condition's clock
 * nor raises a second alert, so a step that retries may report twice.
 *
 * The report is checked first. An empty run id or probe name is a mistake in
 * the calling step, not a condition of the system, so it dies with the
 * schema's error instead of failing the step with something to retry.
 *
 * @param input the probe result
 * @category operations
 * @since 1.0.0
 */
export const report: (input: Report) => Effect.Effect<void, Journal.JournalError, Journal.Journal> = Effect.fn(
  "Alerts.report"
)(function*(input: Report) {
  const checked = yield* Effect.orDie(Schema.decodeUnknownEffect(Report)(input))
  const journal = yield* Journal.Journal
  yield* journal.emitDurableUnfenced(
    new JournalEvent.Input({
      runId: JournalEvent.RunId.make(checked.runId),
      sourceId: JournalEvent.SourceId.make(`/notifications/alerts/probe/${segment(checked.probe)}`),
      eventType: probeEventType(checked.probe),
      payload: {
        probe: checked.probe,
        state: checked.state,
        ...(checked.summary === undefined ? {} : { summary: checked.summary.slice(0, maxSummaryLength) })
      }
    })
  )
})
