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
import * as AgentAction from "@smthrs/agent/AgentAction";
import { type Action, Flow } from "@smthrs/flow";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
/** One indicator of compromise. */
export declare const Indicator: Schema.Struct<{
    readonly type: Schema.Literals<readonly ["ip", "domain", "hash", "email", "url", "other"]>;
    readonly value: Schema.String;
}>;
/** The alert, normalized. */
export declare const IngestedAlert: Schema.Struct<{
    readonly alertId: Schema.String;
    readonly source: Schema.String;
    readonly indicators: Schema.$Array<Schema.Struct<{
        readonly type: Schema.Literals<readonly ["ip", "domain", "hash", "email", "url", "other"]>;
        readonly value: Schema.String;
    }>>;
    readonly rawDescription: Schema.String;
    readonly timestamp: Schema.String;
    readonly summary: Schema.String;
}>;
/** What threat feeds and CVE databases say about the indicators. */
export declare const ExternalEnrichment: Schema.Struct<{
    readonly indicators: Schema.$Array<Schema.Struct<{
        readonly value: Schema.String;
        readonly threatFeeds: Schema.$Array<Schema.String>;
        readonly knownMalicious: Schema.Boolean;
        readonly firstSeen: Schema.optional<Schema.String>;
        readonly tags: Schema.$Array<Schema.String>;
    }>>;
    readonly cveMatches: Schema.$Array<Schema.Struct<{
        readonly id: Schema.String;
        readonly severity: Schema.String;
        readonly description: Schema.String;
    }>>;
    readonly summary: Schema.String;
}>;
/** What the CMDB, logs and incident history say about the indicators. */
export declare const InternalEnrichment: Schema.Struct<{
    readonly affectedAssets: Schema.$Array<Schema.Struct<{
        readonly hostname: Schema.String;
        readonly service: Schema.String;
        readonly environment: Schema.Literals<readonly ["production", "staging", "development"]>;
        readonly owner: Schema.String;
    }>>;
    readonly recentActivity: Schema.$Array<Schema.Struct<{
        readonly timestamp: Schema.String;
        readonly event: Schema.String;
        readonly relevance: Schema.Literals<readonly ["low", "medium", "high"]>;
    }>>;
    readonly priorIncidents: Schema.$Array<Schema.String>;
    readonly summary: Schema.String;
}>;
/** The analyst's verdict. */
export declare const AnalystVerdict: Schema.Struct<{
    readonly severity: Schema.Literals<readonly ["low", "medium", "high", "critical"]>;
    readonly confidence: Schema.Number;
    readonly attackVector: Schema.String;
    readonly threatActor: Schema.optional<Schema.String>;
    readonly firstActions: Schema.$Array<Schema.String>;
    readonly narrative: Schema.String;
    readonly summary: Schema.String;
}>;
/** The case the flow settles with. */
export declare const CaseRecord: Schema.Struct<{
    readonly caseId: Schema.String;
    readonly severity: Schema.Literals<readonly ["low", "medium", "high", "critical"]>;
    readonly title: Schema.String;
    readonly assignee: Schema.String;
    readonly firstActions: Schema.$Array<Schema.String>;
    readonly enrichmentSummary: Schema.String;
    readonly status: Schema.Literals<readonly ["open", "triaged", "investigating", "resolved"]>;
    readonly summary: Schema.String;
}>;
/** Normalizes the raw alert. */
export declare const Ingest: AgentAction.AgentAction<"examples/ThreatIntelEnricher/Ingest", Schema.Struct<{
    alert: Schema.Codec<Schema.Json, Schema.Json, never, never>;
    source: Schema.String;
}>, Schema.Struct<{
    readonly alertId: Schema.String;
    readonly source: Schema.String;
    readonly indicators: Schema.$Array<Schema.Struct<{
        readonly type: Schema.Literals<readonly ["ip", "domain", "hash", "email", "url", "other"]>;
        readonly value: Schema.String;
    }>>;
    readonly rawDescription: Schema.String;
    readonly timestamp: Schema.String;
    readonly summary: Schema.String;
}>>;
/** Queries external threat intelligence for the indicators. */
export declare const ExternalEnrich: AgentAction.AgentAction<"examples/ThreatIntelEnricher/ExternalEnrich", Schema.Struct<{
    alertId: Schema.String;
    indicators: Schema.$Array<Schema.Struct<{
        readonly type: Schema.Literals<readonly ["ip", "domain", "hash", "email", "url", "other"]>;
        readonly value: Schema.String;
    }>>;
}>, Schema.Struct<{
    readonly indicators: Schema.$Array<Schema.Struct<{
        readonly value: Schema.String;
        readonly threatFeeds: Schema.$Array<Schema.String>;
        readonly knownMalicious: Schema.Boolean;
        readonly firstSeen: Schema.optional<Schema.String>;
        readonly tags: Schema.$Array<Schema.String>;
    }>>;
    readonly cveMatches: Schema.$Array<Schema.Struct<{
        readonly id: Schema.String;
        readonly severity: Schema.String;
        readonly description: Schema.String;
    }>>;
    readonly summary: Schema.String;
}>>;
/** Gathers internal context for the indicators. */
export declare const InternalEnrich: AgentAction.AgentAction<"examples/ThreatIntelEnricher/InternalEnrich", Schema.Struct<{
    indicators: Schema.$Array<Schema.Struct<{
        readonly type: Schema.Literals<readonly ["ip", "domain", "hash", "email", "url", "other"]>;
        readonly value: Schema.String;
    }>>;
    rawDescription: Schema.String;
}>, Schema.Struct<{
    readonly affectedAssets: Schema.$Array<Schema.Struct<{
        readonly hostname: Schema.String;
        readonly service: Schema.String;
        readonly environment: Schema.Literals<readonly ["production", "staging", "development"]>;
        readonly owner: Schema.String;
    }>>;
    readonly recentActivity: Schema.$Array<Schema.Struct<{
        readonly timestamp: Schema.String;
        readonly event: Schema.String;
        readonly relevance: Schema.Literals<readonly ["low", "medium", "high"]>;
    }>>;
    readonly priorIncidents: Schema.$Array<Schema.String>;
    readonly summary: Schema.String;
}>>;
/** Turns the alert and both enrichments into a verdict. */
export declare const Analyst: AgentAction.AgentAction<"examples/ThreatIntelEnricher/Analyst", Schema.Struct<{
    alert: Schema.Struct<{
        readonly alertId: Schema.String;
        readonly source: Schema.String;
        readonly indicators: Schema.$Array<Schema.Struct<{
            readonly type: Schema.Literals<readonly ["ip", "domain", "hash", "email", "url", "other"]>;
            readonly value: Schema.String;
        }>>;
        readonly rawDescription: Schema.String;
        readonly timestamp: Schema.String;
        readonly summary: Schema.String;
    }>;
    externalEnrichment: Schema.Struct<{
        readonly indicators: Schema.$Array<Schema.Struct<{
            readonly value: Schema.String;
            readonly threatFeeds: Schema.$Array<Schema.String>;
            readonly knownMalicious: Schema.Boolean;
            readonly firstSeen: Schema.optional<Schema.String>;
            readonly tags: Schema.$Array<Schema.String>;
        }>>;
        readonly cveMatches: Schema.$Array<Schema.Struct<{
            readonly id: Schema.String;
            readonly severity: Schema.String;
            readonly description: Schema.String;
        }>>;
        readonly summary: Schema.String;
    }>;
    internalEnrichment: Schema.Struct<{
        readonly affectedAssets: Schema.$Array<Schema.Struct<{
            readonly hostname: Schema.String;
            readonly service: Schema.String;
            readonly environment: Schema.Literals<readonly ["production", "staging", "development"]>;
            readonly owner: Schema.String;
        }>>;
        readonly recentActivity: Schema.$Array<Schema.Struct<{
            readonly timestamp: Schema.String;
            readonly event: Schema.String;
            readonly relevance: Schema.Literals<readonly ["low", "medium", "high"]>;
        }>>;
        readonly priorIncidents: Schema.$Array<Schema.String>;
        readonly summary: Schema.String;
    }>;
}>, Schema.Struct<{
    readonly severity: Schema.Literals<readonly ["low", "medium", "high", "critical"]>;
    readonly confidence: Schema.Number;
    readonly attackVector: Schema.String;
    readonly threatActor: Schema.optional<Schema.String>;
    readonly firstActions: Schema.$Array<Schema.String>;
    readonly narrative: Schema.String;
    readonly summary: Schema.String;
}>>;
/** Files the verdict as a case. */
export declare const Case: AgentAction.AgentAction<"examples/ThreatIntelEnricher/Case", Schema.Struct<{
    alertId: Schema.String;
    severity: Schema.Literals<readonly ["low", "medium", "high", "critical"]>;
    narrative: Schema.String;
    firstActions: Schema.$Array<Schema.String>;
    affectedAssets: Schema.$Array<Schema.Struct<{
        readonly hostname: Schema.String;
        readonly service: Schema.String;
        readonly environment: Schema.Literals<readonly ["production", "staging", "development"]>;
        readonly owner: Schema.String;
    }>>;
}>, Schema.Struct<{
    readonly caseId: Schema.String;
    readonly severity: Schema.Literals<readonly ["low", "medium", "high", "critical"]>;
    readonly title: Schema.String;
    readonly assignee: Schema.String;
    readonly firstActions: Schema.$Array<Schema.String>;
    readonly enrichmentSummary: Schema.String;
    readonly status: Schema.Literals<readonly ["open", "triaged", "investigating", "resolved"]>;
    readonly summary: Schema.String;
}>>;
type Requirements = Action.Requirement<`examples/ThreatIntelEnricher/${"Ingest" | "ExternalEnrich" | "InternalEnrich" | "Analyst" | "Case"}`>;
/** The flow: ingest, enrich in parallel, assess, file. */
export declare const ThreatIntelEnricher: Flow.Flow<"examples/ThreatIntelEnricher", Schema.Struct<{
    alert: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
    source: Schema.optional<Schema.String>;
}>, Schema.Struct<{
    readonly caseId: Schema.String;
    readonly severity: Schema.Literals<readonly ["low", "medium", "high", "critical"]>;
    readonly title: Schema.String;
    readonly assignee: Schema.String;
    readonly firstActions: Schema.$Array<Schema.String>;
    readonly enrichmentSummary: Schema.String;
    readonly status: Schema.Literals<readonly ["open", "triaged", "investigating", "resolved"]>;
    readonly summary: Schema.String;
}>, Schema.Union<readonly [typeof import("@smthrs/harness/StructuredOutput").StructuredOutputFailure, typeof import("../../src/Seat.vibe").SeatUnresolved, typeof import("../../src/Seat.vibe").SeatUnrouted, typeof import("../../src/Budget.js").BudgetExceeded, typeof import("../../src/Budget.js").Skipped, typeof import("@smthrs/harness/HarnessError").HarnessError, typeof import("@smthrs/plugin/PluginError").PluginError]>, Action.Requirement<"examples/ThreatIntelEnricher/Ingest"> | Requirements>;
/** Every step the flow calls. */
export declare const layer: Layer.Layer<Action.Requirement<"examples/ThreatIntelEnricher/Analyst"> | Action.Requirement<"examples/ThreatIntelEnricher/Case"> | Action.Requirement<"examples/ThreatIntelEnricher/ExternalEnrich"> | Action.Requirement<"examples/ThreatIntelEnricher/Ingest"> | Action.Requirement<"examples/ThreatIntelEnricher/InternalEnrich">, never, import("../../src/Agent.js").Agent | import("../../src/Budget.js").Budget | import("@smthrs/crypto/Crypto").Crypto | import("@smthrs/model/Evaluator").Evaluator | import("@smthrs/flow/FlowRuntime").FlowRuntime | AgentAction.Host | import("../../src/QuotaPolicy.vibe").QuotaClassifier | import("@smthrs/harness/Sandbox").Sandbox | import("../../src/SeatResolver.js").SeatResolver | import("@smthrs/harness/Steering").Source>;
export {};
