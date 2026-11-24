/**
 * Alert policy: run conditions that have lasted too long, turned into durable,
 * coalesced, delivered-once notifications.
 *
 * A notification queue answers "tell this run something". An alert answers the
 * question nobody is around to ask: a run has been waiting for an approval for
 * an hour, and the person who could grant it does not know. The two are the
 * same machinery, since an alert is admitted as a coalesced system event, and
 * they differ only in who decides to write one.
 *
 * ## Journal time, not wall time
 *
 * A condition's clock starts at the journal entry that opened it, which makes
 * the decision replayable: the same journal produces the same alerts, whatever
 * process reads it and whenever. A restart re-derives every open condition
 * from the entries rather than from a timer it lost.
 *
 * ## Delivered at least once
 *
 * The admission is idempotent on the notification id, so re-admitting the same
 * alert writes nothing new, and `flows.alerts.delivered` is journaled AFTER
 * the sink accepted the page and is checked before the sink is called again.
 * That ordering is deliberate and it is the reason the guarantee is
 * at-least-once rather than exactly-once: a process that dies between the
 * accepted send and the delivery record has paged, left no evidence of it, and
 * will page again on the next tick. Recording the delivery first turns the
 * same crash into a page nobody ever receives, which for an alert is the worse
 * failure.
 *
 * So the sink owns the last mile: {@link SinkService.deliver} MUST be
 * idempotent on {@link alertId}, which is stable for the life of one condition
 * and reaches the sink on every alert it is handed. A sink that fails journals
 * `flows.alerts.failed` once per failure code and the alert is retried on the
 * next tick, because a refused page is not a delivered page.
 *
 * Two failures are not retried on the next tick. A sink that says another
 * attempt would be refused the same way, with `retryable: false` on its
 * {@link AlertError}, has that page recorded as refused for good, and no later
 * tick sends it. A sink that names a wait, with `retryAfterMillis`, is left
 * alone until the wait has passed. Both are read back from the journal, so a
 * restart does not forget them. A repeat of the page and a condition that
 * re-opens are pages of their own, and each is tried once.
 *
 * ## What a full queue costs
 *
 * The queue can refuse the admission when a run already holds its capacity of
 * pending notifications. The person is paged all the same: the alert comes
 * back in {@link Tick.refused}, the refusal is journaled, and the sink is
 * called, so the alert is in {@link Tick.delivered} or {@link Tick.failed} as
 * well. A run that has stopped draining its inbox is the run the alert exists
 * for, so the page never waits on the run reading its own copy. Once the page
 * is delivered the alert is not admitted again, and the run's inbox does not
 * hold it.
 *
 * ## Conditions are data
 *
 * A condition is a payload field with a value: `status` is `waiting-approval`,
 * `health` is `stalled`. Those are the fields control-plane entries and monitor
 * beats already carry, so a deployment that journals a different vocabulary
 * supplies its own detectors instead of a fork of this module.
 *
 * ## Acknowledged, or paged again
 *
 * An alert pages once. A rule with a `repeatMs` pages again every that long
 * while the condition stays open, until a person takes it with
 * {@link RuntimeService.acknowledge}. {@link RuntimeService.standing} lists
 * what a run has open and who took it.
 *
 * ## Raising one from a step
 *
 * A flow step that checks something outside the run calls {@link report} with
 * what it saw. The report is one more journal entry and the probe one more
 * condition, built by {@link probes}, so a probe that keeps failing pages once
 * and an `ok` report clears it.
 *
 * @since 0.1.0
 */

export {
  acknowledgedEventType,
  type Alert,
  alertId,
  coalescingKey,
  conditions,
  decide,
  defaultDetectors,
  deliveredEventType,
  Detector,
  failedEventType,
  maxSummaryLength,
  type Open,
  Policy,
  Rule,
  Severity
} from "./AlertPolicy.ts"
export { probeDetector, probeEventType, probes, ProbeState, Report, report } from "./AlertProbe.ts"
export { AlertRuntime, layer, type RuntimeService, type Standing, type Tick } from "./AlertRuntime.ts"
export { AlertError, FailureCode, layerNoop, Sink, type SinkService } from "./AlertSink.ts"
export { type ChannelsSinkOptions, layerChannels, messageOf } from "./layerChannels.ts"
export { defaultWebhookTimeout, layerWebhook, layerWebhookClient } from "./layerWebhook.ts"
