/**
 * Enrich a security alert with external and internal context, then file a case with a severity and first actions.
 *
 * Port of the 0.x `threat-intel-enricher.jsx`. An ingest step normalizes the
 * raw alert into typed indicators. External enrichment (threat feeds, CVEs)
 * and internal enrichment (assets, activity, prior incidents) run in parallel
 * on those indicators, an analyst agent turns the alert and both enrichments
 * into a severity and a first-action list, and a case step files the record.
 *
 * 0.x's `<Parallel maxConcurrency={2}>` around the two enrichments is a `Node.all` of both.
 * 0.x gave `ingest` and `case` no agent, so it persisted their prompt element as a static output that fails their schemas; here each is a model step with no system prompt.
 * 0.x gave the agents `read`, `bash` and `grep` tools; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`).
 */
import * as AgentAction from "@smthrs/agent/AgentAction"
import { type Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import type * as Planned from "@smthrs/plan/Planned"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const seat = "anthropic:claude-sonnet-5-5"

const Severity = Schema.Literals(["low", "medium", "high", "critical"])

/** One indicator of compromise. */
export const Indicator = Schema.Struct({
  type: Schema.Literals(["ip", "domain", "hash", "email", "url", "other"]),
  value: Schema.String
})

/** The alert, normalized. */
export const IngestedAlert = Schema.Struct({
  alertId: Schema.String,
  source: Schema.String,
  indicators: Schema.Array(Indicator),
  rawDescription: Schema.String,
  timestamp: Schema.String,
  summary: Schema.String
})

/** What threat feeds and CVE databases say about the indicators. */
export const ExternalEnrichment = Schema.Struct({
  indicators: Schema.Array(Schema.Struct({
    value: Schema.String,
    threatFeeds: Schema.Array(Schema.String),
    knownMalicious: Schema.Boolean,
    firstSeen: Schema.optional(Schema.String),
    tags: Schema.Array(Schema.String)
  })),
  cveMatches: Schema.Array(Schema.Struct({
    id: Schema.String,
    severity: Schema.String,
    description: Schema.String
  })),
  summary: Schema.String
})

/** What the CMDB, logs and incident history say about the indicators. */
export const InternalEnrichment = Schema.Struct({
  affectedAssets: Schema.Array(Schema.Struct({
    hostname: Schema.String,
    service: Schema.String,
    environment: Schema.Literals(["production", "staging", "development"]),
    owner: Schema.String
  })),
  recentActivity: Schema.Array(Schema.Struct({
    timestamp: Schema.String,
    event: Schema.String,
    relevance: Schema.Literals(["low", "medium", "high"])
  })),
  priorIncidents: Schema.Array(Schema.String),
  summary: Schema.String
})

/** The analyst's verdict. */
export const AnalystVerdict = Schema.Struct({
  severity: Severity,
  confidence: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  attackVector: Schema.String,
  threatActor: Schema.optional(Schema.String),
  firstActions: Schema.Array(Schema.String),
  narrative: Schema.String,
  summary: Schema.String
})

/** The case the flow settles with. */
export const CaseRecord = Schema.Struct({
  caseId: Schema.String,
  severity: Severity,
  title: Schema.String,
  assignee: Schema.String,
  firstActions: Schema.Array(Schema.String),
  enrichmentSummary: Schema.String,
  status: Schema.Literals(["open", "triaged", "investigating", "resolved"]),
  summary: Schema.String
})

/** Normalizes the raw alert. */
export const Ingest = AgentAction.make("examples/ThreatIntelEnricher/Ingest", {
  payload: { alert: Schema.Json, source: Schema.String },
  output: IngestedAlert,
  seat,
  prompt: ({ alert, source }) =>
    `Ingest and normalize this security alert. Extract every indicator.\n\nSource: ${source}\nAlert: ${
      JSON.stringify(alert)
    }`
})

/** Queries external threat intelligence for the indicators. */
export const ExternalEnrich = AgentAction.make("examples/ThreatIntelEnricher/ExternalEnrich", {
  payload: { alertId: Schema.String, indicators: Schema.Array(Indicator) },
  output: ExternalEnrichment,
  seat,
  system: [
    `You are a threat intelligence enrichment specialist. Given a set of indicators,
query external threat feeds, CVE databases, and reputation services. Return structured
enrichment data including known-malicious flags, threat-feed matches, and relevant CVEs.`
  ],
  prompt: ({ alertId, indicators }) =>
    `Enrich the indicators of alert ${alertId} from external sources.\n\nIndicators: ${JSON.stringify(indicators)}`
})

/** Gathers internal context for the indicators. */
export const InternalEnrich = AgentAction.make("examples/ThreatIntelEnricher/InternalEnrich", {
  payload: { indicators: Schema.Array(Indicator), rawDescription: Schema.String },
  output: InternalEnrichment,
  seat,
  system: [
    `You are an internal security context gatherer. Given alert indicators,
look up affected assets in the CMDB, pull recent authentication and network logs,
and find any prior incidents involving the same indicators or assets.`
  ],
  prompt: ({ indicators, rawDescription }) =>
    `Gather internal context for this alert.\n\nDescription: ${rawDescription}\nIndicators: ${
      JSON.stringify(indicators)
    }`
})

/** Turns the alert and both enrichments into a verdict. */
export const Analyst = AgentAction.make("examples/ThreatIntelEnricher/Analyst", {
  payload: { alert: IngestedAlert, externalEnrichment: ExternalEnrichment, internalEnrichment: InternalEnrichment },
  output: AnalystVerdict,
  seat,
  system: [
    `You are a senior security analyst. Given ingested alert data plus external
and internal enrichment, determine the recommended severity, identify the likely attack vector,
and produce a prioritized list of first-response actions. Be specific and actionable.`
  ],
  prompt: ({ alert, externalEnrichment, internalEnrichment }) =>
    `Assess this alert.\n\nAlert: ${JSON.stringify(alert)}\nExternal: ${
      JSON.stringify(externalEnrichment)
    }\nInternal: ${JSON.stringify(internalEnrichment)}`
})

/** Files the verdict as a case. */
export const Case = AgentAction.make("examples/ThreatIntelEnricher/Case", {
  payload: {
    alertId: Schema.String,
    severity: Severity,
    narrative: Schema.String,
    firstActions: Schema.Array(Schema.String),
    affectedAssets: InternalEnrichment.fields.affectedAssets
  },
  output: CaseRecord,
  seat,
  prompt: ({ affectedAssets, alertId, firstActions, narrative, severity }) =>
    `File a case in the case management system for alert ${alertId}.\n\nSeverity: ${severity}\nNarrative: ${narrative}\nFirst actions: ${
      JSON.stringify(firstActions)
    }\nAffected assets: ${JSON.stringify(affectedAssets)}`
})

type Requirements = Action.Requirement<
  `examples/ThreatIntelEnricher/${"Ingest" | "ExternalEnrich" | "InternalEnrich" | "Analyst" | "Case"}`
>

/** Enrich in parallel, assess, file. */
const enrich = (
  alert: Planned.Planned<typeof IngestedAlert.Type>
): Node.Node<typeof CaseRecord.Type, AgentAction.AgentFailure, Requirements> =>
  Node.bindPlanned(
    Node.all({
      external: ExternalEnrich.call({ alertId: alert.alertId, indicators: alert.indicators }),
      internal: InternalEnrich.call({ indicators: alert.indicators, rawDescription: alert.rawDescription })
    }),
    (enrichment) =>
      Node.bindPlanned(
        Analyst.call({
          alert,
          externalEnrichment: enrichment.external,
          internalEnrichment: enrichment.internal
        }),
        (verdict) =>
          Case.call({
            alertId: alert.alertId,
            severity: verdict.severity,
            narrative: verdict.narrative,
            firstActions: verdict.firstActions,
            affectedAssets: enrichment.internal.affectedAssets
          })
      )
  )

/** The flow: ingest, enrich in parallel, assess, file. */
export const ThreatIntelEnricher = Flow.make("examples/ThreatIntelEnricher", {
  payload: { alert: Schema.optional(Schema.Json), source: Schema.optional(Schema.String) },
  success: CaseRecord,
  error: AgentAction.AgentFailure,
  body: ({ alert = {}, source = "unknown" }) => Node.bindPlanned(Ingest.call({ alert, source }), enrich)
})

/** Every step the flow calls. */
export const layer = Layer.mergeAll(
  Ingest.layer,
  ExternalEnrich.layer,
  InternalEnrich.layer,
  Analyst.layer,
  Case.layer
)
