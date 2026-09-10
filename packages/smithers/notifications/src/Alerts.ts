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
 * ## What a refusal costs
 *
 * The queue can refuse the admission when a run already holds its capacity of
 * pending notifications. A tick that is refused pages nobody: the alert comes
 * back in {@link Tick.refused}, the refusal is journaled, and the next tick
 * tries again once a boundary has drained. Calling the sink anyway would page
 * about an alert the run will never see.
 *
 * ## Conditions are data
 *
 * A condition is a payload field with a value: `status` is `waiting-approval`,
 * `health` is `stalled`. Those are the fields control-plane entries and monitor
 * beats already carry, so a deployment that journals a different vocabulary
 * supplies its own detectors instead of a fork of this module.
 *
 * @since 0.1.0
 */

export {
  type Alert,
  alertId,
  coalescingKey,
  conditions,
  decide,
  defaultDetectors,
  deliveredEventType,
  Detector,
  failedEventType,
  type Open,
  Policy,
  Rule,
  Severity
} from "./AlertPolicy.ts"
export { AlertRuntime, layer, type RuntimeService, type Tick } from "./AlertRuntime.ts"
export { AlertError, FailureCode, layerNoop, Sink, type SinkService } from "./AlertSink.ts"
export { defaultWebhookTimeout, layerWebhook } from "./layerWebhook.ts"
