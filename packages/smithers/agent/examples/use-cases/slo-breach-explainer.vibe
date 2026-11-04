/**
 * Pull traces, logs and change history for a tripped SLO alarm in parallel and explain the likely causal chain.
 *
 * Port of the 0.x `slo-breach-explainer.jsx`. The alarm is the payload. Three
 * agents fetch context for its service and window at once: a trace fetcher
 * finds the bottleneck span, a log analyst counts and ranks the errors, and a
 * change investigator names the most suspicious deploy or config change. Once
 * all three answer, an incident analyst writes the incident note. Nothing
 * branches or loops.
 *
 * 0.x parsed the alarm in an agentless `trigger` step; here the payload schema validates it before any step runs.
 * 0.x's `<Parallel maxConcurrency={3}>` over three tasks is `Node.all`.
 * 0.x's prompts were placeholders that printed their props; these prompts carry the same props.
 * 0.x gave the agents `bash`, `grep` and `read` tools; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`).
 */
import * as AgentAction from "@smthrs/agent/AgentAction"
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import type * as Planned from "@smthrs/plan/Planned"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const seat = "anthropic:claude-sonnet-5-5"

/** The alarm that tripped. */
export const Alarm = Schema.Struct({
  service: Schema.String.annotate({ description: "Service that breached its SLO" }),
  sloName: Schema.String.annotate({ description: "Name of the SLO, e.g. p99-latency or error-rate" }),
  threshold: Schema.String.annotate({ description: "SLO threshold, e.g. '200ms' or '0.1%'" }),
  observed: Schema.String.annotate({ description: "Observed value that triggered the alarm" }),
  window: Schema.String.annotate({ description: "Time window of the breach, e.g. '2026-03-28T14:00Z/PT1H'" })
})

/** What the trace fetcher found. */
export const TraceContext = Schema.Struct({
  topSpans: Schema.Array(Schema.Struct({
    traceId: Schema.String,
    spanName: Schema.String,
    durationMs: Schema.Number,
    status: Schema.Literals(["ok", "error", "timeout"]),
    attributes: Schema.Record(Schema.String, Schema.String)
  })),
  bottleneck: Schema.String.annotate({ description: "Identified slow or failing span" }),
  sampleTraceId: Schema.String.annotate({ description: "Representative trace ID for deep-dive" })
})

/** What the log analyst found. */
export const LogContext = Schema.Struct({
  errorCount: Schema.Number,
  topErrors: Schema.Array(Schema.Struct({
    message: Schema.String,
    count: Schema.Number,
    firstSeen: Schema.String,
    lastSeen: Schema.String
  })),
  anomalies: Schema.Array(Schema.String).annotate({ description: "Log patterns that deviate from the baseline" })
})

/** What the change investigator found. */
export const ChangeContext = Schema.Struct({
  recentDeploys: Schema.Array(Schema.Struct({
    version: Schema.String,
    deployedAt: Schema.String,
    author: Schema.String,
    description: Schema.String
  })),
  configChanges: Schema.Array(Schema.Struct({
    key: Schema.String,
    oldValue: Schema.String,
    newValue: Schema.String,
    changedAt: Schema.String
  })),
  suspectChange: Schema.String.annotate({ description: "Most likely change correlated with the breach" })
})

/** The incident note the flow settles with. */
export const IncidentNote = Schema.Struct({
  title: Schema.String.annotate({ description: "Short incident title for the note" }),
  severity: Schema.Literals(["critical", "high", "medium", "low"]),
  causalChain: Schema.Array(Schema.String).annotate({
    description: "Ordered list of events forming the causal chain"
  }),
  rootCause: Schema.String.annotate({ description: "Most likely root cause" }),
  impactSummary: Schema.String.annotate({ description: "User/business impact description" }),
  mitigation: Schema.String.annotate({ description: "Recommended immediate mitigation" }),
  followUps: Schema.Array(Schema.String).annotate({ description: "Longer-term follow-up actions" }),
  summary: Schema.String.annotate({ description: "One-paragraph narrative suitable for an incident channel" })
})

/** Finds the slowest and most error-prone spans in the breach window. */
export const FetchTraces = AgentAction.make("examples/SloBreachExplainer/Traces", {
  payload: { service: Schema.String, window: Schema.String, sloName: Schema.String },
  output: TraceContext,
  seat,
  system: [
    `You are a distributed-tracing specialist. Query trace backends to find
the slowest and most error-prone spans within the breach window. Identify the bottleneck
span and pick a representative trace ID for follow-up investigation.`
  ],
  prompt: ({ service, sloName, window }) =>
    `Fetch traces for the breach.\n\nService: ${service}\nWindow: ${window}\nSLO: ${sloName}`
})

/** Counts and ranks the service's errors in the breach window. */
export const FetchLogs = AgentAction.make("examples/SloBreachExplainer/Logs", {
  payload: { service: Schema.String, window: Schema.String, observed: Schema.String },
  output: LogContext,
  seat,
  system: [
    `You are a log analyst. Search logs for the affected service within the breach
window. Count errors, surface the top error messages, and flag any anomalous patterns that
deviate from the service's normal baseline.`
  ],
  prompt: ({ observed, service, window }) =>
    `Fetch logs for the breach.\n\nService: ${service}\nWindow: ${window}\nObserved: ${observed}`
})

/** Looks up deploys, config changes and flag flips around the breach. */
export const FetchChanges = AgentAction.make("examples/SloBreachExplainer/Changes", {
  payload: { service: Schema.String, window: Schema.String },
  output: ChangeContext,
  seat,
  system: [
    `You are a change-tracking investigator. Look up recent deployments, config
changes, and feature-flag flips for the affected service around the breach window. Identify
the single most suspicious change that correlates with the SLO violation.`
  ],
  prompt: ({ service, window }) => `Fetch change history for the breach.\n\nService: ${service}\nWindow: ${window}`
})

/** Weaves the three contexts into an incident note. */
export const Synthesize = AgentAction.make("examples/SloBreachExplainer/Synthesis", {
  payload: { alarm: Alarm, traces: TraceContext, logs: LogContext, changes: ChangeContext },
  output: IncidentNote,
  seat,
  system: [
    `You are an incident analyst. Given trace context, log context, and change
history, construct a clear causal chain explaining why the SLO was breached. Be specific
about the root cause, quantify impact, and recommend both immediate mitigation and follow-ups.
Write the summary as a concise paragraph suitable for posting in an incident Slack channel.`
  ],
  prompt: ({ alarm, changes, logs, traces }) =>
    `Explain this SLO breach.\n\nAlarm: ${JSON.stringify(alarm)}\nTraces: ${JSON.stringify(traces)}\nLogs: ${
      JSON.stringify(logs)
    }\nChanges: ${JSON.stringify(changes)}`
})

type Context = {
  readonly traces: typeof TraceContext.Type
  readonly logs: typeof LogContext.Type
  readonly changes: typeof ChangeContext.Type
}

/** The flow: fetch the three contexts at once, then explain. */
export const SloBreachExplainer = Flow.make("examples/SloBreachExplainer", {
  payload: Alarm,
  success: IncidentNote,
  error: AgentAction.AgentFailure,
  body: (alarm) =>
    Node.bindPlanned(
      Node.all({
        traces: FetchTraces.call({ service: alarm.service, window: alarm.window, sloName: alarm.sloName }),
        logs: FetchLogs.call({ service: alarm.service, window: alarm.window, observed: alarm.observed }),
        changes: FetchChanges.call({ service: alarm.service, window: alarm.window })
      }),
      (context: Planned.Planned<Context>) =>
        Synthesize.call({ alarm, traces: context.traces, logs: context.logs, changes: context.changes })
    )
})

/** Every step the flow calls. */
export const layer = Layer.mergeAll(FetchTraces.layer, FetchLogs.layer, FetchChanges.layer, Synthesize.layer)
