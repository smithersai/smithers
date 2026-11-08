/**
 * Classify incoming alerts against prior incidents and known-noise rules so only novel or high-risk alerts page a person.
 *
 * Port of the 0.x `alert-suppressor.jsx`. Duplicate alerts are dropped while a
 * context agent looks up recent incidents and noise rules for the whole batch.
 * A classifier agent gives each unique alert a verdict: escalate, suppress or
 * observe. A dispatcher agent pages the escalated alerts, files tickets for
 * the observed ones and drops the suppressed ones, and a summary counts the
 * outcomes. Nothing branches or loops.
 *
 * 0.x's `dedupe` step had no agent and only a placeholder prompt; here it is a pure dedupe on the real payload that keeps the first alert per source, message and labels.
 * 0.x's prompts were placeholders that printed their props; these prompts carry the same props.
 * 0.x gave the agents `bash`, `read` and `grep` tools; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`).
 */
import * as AgentAction from "@smthrs/agent/AgentAction"
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import type * as Planned from "@smthrs/plan/Planned"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const seat = "anthropic:claude-sonnet-5-5"

const Severity = Schema.Literals(["critical", "high", "medium", "low"])

/** One incoming alert. */
export const Alert = Schema.Struct({
  id: Schema.String.annotate({ description: "Unique alert identifier" }),
  source: Schema.String.annotate({ description: "Monitoring system that fired the alert" }),
  severity: Severity.annotate({ description: "Raw severity from source" }),
  message: Schema.String.annotate({ description: "Alert message body" }),
  timestamp: Schema.String.annotate({ description: "ISO-8601 timestamp" }),
  labels: Schema.String.annotate({ description: "JSON-encoded key-value labels attached to the alert" })
})

/** The batch after deduplication. */
export const DedupeResult = Schema.Struct({
  uniqueAlerts: Schema.Array(Alert).annotate({ description: "Alerts after deduplication" }),
  suppressedCount: Schema.Number.annotate({ description: "Number of alerts dropped as duplicates" }),
  suppressedIds: Schema.Array(Schema.String).annotate({ description: "IDs of suppressed duplicate alerts" })
})

/** Recent incidents and noise rules the classifier weighs alerts against. */
export const IncidentContext = Schema.Struct({
  recentIncidents: Schema.Array(Schema.Struct({
    id: Schema.String,
    title: Schema.String,
    status: Schema.Literals(["open", "mitigated", "resolved"]),
    relatedAlertPatterns: Schema.Array(Schema.String)
  })).annotate({ description: "Active or recent incidents that may correlate" }),
  noiseRules: Schema.Array(Schema.Struct({
    pattern: Schema.String.annotate({ description: "Regex or substring pattern to match" }),
    reason: Schema.String.annotate({ description: "Why this pattern is considered noise" }),
    expiresAt: Schema.optional(Schema.String.annotate({ description: "When this rule expires" }))
  })).annotate({ description: "Known-noise suppression rules" })
})

/** One verdict per unique alert. */
export const Classification = Schema.Struct({
  classifications: Schema.Array(Schema.Struct({
    alertId: Schema.String,
    verdict: Schema.Literals(["escalate", "suppress", "observe"]).annotate({
      description: "Whether to page, suppress, or watch"
    }),
    confidence: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })).annotate({
      description: "Model confidence in the verdict"
    }),
    matchedNoiseRule: Schema.optional(
      Schema.String.annotate({ description: "Noise rule pattern that matched, if any" })
    ),
    matchedIncidentId: Schema.optional(
      Schema.String.annotate({ description: "Existing incident this correlates with" })
    ),
    reasoning: Schema.String.annotate({ description: "Why this verdict was chosen" }),
    riskLevel: Severity.annotate({ description: "Assessed risk after context" })
  }))
})

/** What the dispatcher did. */
export const SinkResult = Schema.Struct({
  paged: Schema.Array(Schema.Struct({
    alertId: Schema.String,
    channel: Schema.String.annotate({ description: "PagerDuty, Slack, etc." }),
    ticketUrl: Schema.optional(Schema.String)
  })).annotate({ description: "Alerts that were paged out" }),
  ticketed: Schema.Array(Schema.Struct({ alertId: Schema.String, ticketUrl: Schema.String })).annotate({
    description: "Alerts filed as tickets for later review"
  }),
  dropped: Schema.Array(Schema.String).annotate({ description: "Alert IDs silently suppressed" })
})

/** The counts the flow settles with. */
export const Output = Schema.Struct({
  totalReceived: Schema.Number,
  suppressed: Schema.Number,
  escalated: Schema.Number,
  ticketed: Schema.Number,
  observed: Schema.Number,
  summary: Schema.String
})

type Alert = typeof Alert.Type
type DedupeResult = typeof DedupeResult.Type

/** Looks up recent incidents and noise rules for the batch. */
export const LookUpContext = AgentAction.make("examples/AlertSuppressor/Context", {
  payload: { alerts: Schema.Array(Alert), noiseRules: Schema.Array(Schema.Json), incidentSource: Schema.String },
  output: IncidentContext,
  seat,
  system: [
    `You are an incident-context retriever. Given a set of alerts, look up
recent incidents and active noise-suppression rules from the configured sources.
Return structured context so the classifier can make informed decisions.`
  ],
  prompt: ({ alerts, incidentSource, noiseRules }) =>
    `Look up incident context for these alerts.\n\nIncident source: ${incidentSource}\nAlerts: ${
      JSON.stringify(alerts)
    }\nConfigured noise rules: ${JSON.stringify(noiseRules)}`
})

/** Gives each unique alert a verdict. */
export const Classify = AgentAction.make("examples/AlertSuppressor/Classify", {
  payload: {
    uniqueAlerts: Schema.Array(Alert),
    noiseRules: IncidentContext.fields.noiseRules,
    recentIncidents: IncidentContext.fields.recentIncidents
  },
  output: Classification,
  seat,
  system: [
    `You are an alert classifier. For each unique alert, decide whether to
escalate (page on-call), suppress (known noise or duplicate of open incident), or
observe (low risk, file a ticket). Cross-reference with recent incidents and noise rules.
Be conservative: when in doubt, escalate.`
  ],
  prompt: ({ noiseRules, recentIncidents, uniqueAlerts }) =>
    `Classify each unique alert.\n\nUnique alerts: ${JSON.stringify(uniqueAlerts)}\nNoise rules: ${
      JSON.stringify(noiseRules)
    }\nRecent incidents: ${JSON.stringify(recentIncidents)}`
})

/** Pages, tickets or drops each classified alert. */
export const Dispatch = AgentAction.make("examples/AlertSuppressor/Dispatch", {
  payload: {
    classifications: Classification.fields.classifications,
    pageChannel: Schema.String,
    ticketSystem: Schema.String
  },
  output: SinkResult,
  seat,
  system: [
    `You are an alert dispatcher. For escalated alerts, page the on-call via
the appropriate channel. For observed alerts, file a ticket. For suppressed alerts, log
and drop. Report every action taken.`
  ],
  prompt: ({ classifications, pageChannel, ticketSystem }) =>
    `Dispatch these verdicts.\n\nPage channel: ${pageChannel}\nTicket system: ${ticketSystem}\nClassifications: ${
      JSON.stringify(classifications)
    }`
})

/** Keeps the first alert per source, message and labels. */
const dedupe = (alerts: ReadonlyArray<Alert>): DedupeResult => {
  const seen = new Set<string>()
  const uniqueAlerts: Array<Alert> = []
  const suppressedIds: Array<string> = []
  for (const alert of alerts) {
    const key = JSON.stringify([alert.source, alert.message, alert.labels])
    if (seen.has(key)) {
      suppressedIds.push(alert.id)
    } else {
      seen.add(key)
      uniqueAlerts.push(alert)
    }
  }
  return { uniqueAlerts, suppressedCount: suppressedIds.length, suppressedIds }
}

/** Counts the outcomes. Pure, so it is a `Node.map`, not a step. */
const summarize = (
  { classification, deduped, pageChannel, received, sink }: {
    readonly received: number
    readonly deduped: DedupeResult
    readonly classification: typeof Classification.Type
    readonly sink: typeof SinkResult.Type
    readonly pageChannel: string
  }
): typeof Output.Type => ({
  totalReceived: received,
  suppressed: deduped.suppressedCount + sink.dropped.length,
  escalated: sink.paged.length,
  ticketed: sink.ticketed.length,
  observed: classification.classifications.filter((c) => c.verdict === "observe").length,
  summary: [
    `Received ${received} alerts.`,
    `Deduplicated ${deduped.suppressedCount} duplicates.`,
    `Escalated ${sink.paged.length} to ${pageChannel}.`,
    `Filed ${sink.ticketed.length} tickets.`,
    `Suppressed ${sink.dropped.length} as known noise.`
  ].join(" ")
})

/** The flow: dedupe and look up context, classify, dispatch, count. */
export const AlertSuppressor = Flow.make("examples/AlertSuppressor", {
  payload: {
    alerts: Schema.optional(Schema.Array(Alert)),
    noiseRules: Schema.optional(Schema.Array(Schema.Json)),
    incidentSource: Schema.optional(Schema.String),
    pageChannel: Schema.optional(Schema.String),
    ticketSystem: Schema.optional(Schema.String)
  },
  success: Output,
  error: AgentAction.AgentFailure,
  body: (
    { alerts = [], incidentSource = "opsgenie", noiseRules = [], pageChannel = "pagerduty", ticketSystem = "jira" }
  ) => {
    // The payload is real at plan time, so the dedupe runs here, beside the lookup.
    const deduped = dedupe(alerts)
    return Node.bindPlanned(
      LookUpContext.call({ alerts, noiseRules, incidentSource }),
      (context: Planned.Planned<typeof IncidentContext.Type>) =>
        Node.bindPlanned(
          Classify.call({
            uniqueAlerts: deduped.uniqueAlerts,
            noiseRules: context.noiseRules,
            recentIncidents: context.recentIncidents
          }),
          (classification: Planned.Planned<typeof Classification.Type>) =>
            Node.bindPlanned(
              Dispatch.call({ classifications: classification.classifications, pageChannel, ticketSystem }),
              (sink: Planned.Planned<typeof SinkResult.Type>) =>
                Node.map(
                  Node.succeed({ received: alerts.length, deduped, classification, sink, pageChannel }),
                  summarize
                )
            )
        )
    )
  }
})

/** Every step the flow calls. */
export const layer = Layer.mergeAll(LookUpContext.layer, Classify.layer, Dispatch.layer)
