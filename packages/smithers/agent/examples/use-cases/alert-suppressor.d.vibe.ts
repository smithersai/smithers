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
import * as AgentAction from "@smthrs/agent/AgentAction";
import { Flow } from "@smthrs/flow";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
/** One incoming alert. */
export declare const Alert: Schema.Struct<{
    readonly id: Schema.String;
    readonly source: Schema.String;
    readonly severity: Schema.Literals<readonly ["critical", "high", "medium", "low"]>;
    readonly message: Schema.String;
    readonly timestamp: Schema.String;
    readonly labels: Schema.String;
}>;
/** The batch after deduplication. */
export declare const DedupeResult: Schema.Struct<{
    readonly uniqueAlerts: Schema.$Array<Schema.Struct<{
        readonly id: Schema.String;
        readonly source: Schema.String;
        readonly severity: Schema.Literals<readonly ["critical", "high", "medium", "low"]>;
        readonly message: Schema.String;
        readonly timestamp: Schema.String;
        readonly labels: Schema.String;
    }>>;
    readonly suppressedCount: Schema.Number;
    readonly suppressedIds: Schema.$Array<Schema.String>;
}>;
/** Recent incidents and noise rules the classifier weighs alerts against. */
export declare const IncidentContext: Schema.Struct<{
    readonly recentIncidents: Schema.$Array<Schema.Struct<{
        readonly id: Schema.String;
        readonly title: Schema.String;
        readonly status: Schema.Literals<readonly ["open", "mitigated", "resolved"]>;
        readonly relatedAlertPatterns: Schema.$Array<Schema.String>;
    }>>;
    readonly noiseRules: Schema.$Array<Schema.Struct<{
        readonly pattern: Schema.String;
        readonly reason: Schema.String;
        readonly expiresAt: Schema.optional<Schema.String>;
    }>>;
}>;
/** One verdict per unique alert. */
export declare const Classification: Schema.Struct<{
    readonly classifications: Schema.$Array<Schema.Struct<{
        readonly alertId: Schema.String;
        readonly verdict: Schema.Literals<readonly ["escalate", "suppress", "observe"]>;
        readonly confidence: Schema.Number;
        readonly matchedNoiseRule: Schema.optional<Schema.String>;
        readonly matchedIncidentId: Schema.optional<Schema.String>;
        readonly reasoning: Schema.String;
        readonly riskLevel: Schema.Literals<readonly ["critical", "high", "medium", "low"]>;
    }>>;
}>;
/** What the dispatcher did. */
export declare const SinkResult: Schema.Struct<{
    readonly paged: Schema.$Array<Schema.Struct<{
        readonly alertId: Schema.String;
        readonly channel: Schema.String;
        readonly ticketUrl: Schema.optional<Schema.String>;
    }>>;
    readonly ticketed: Schema.$Array<Schema.Struct<{
        readonly alertId: Schema.String;
        readonly ticketUrl: Schema.String;
    }>>;
    readonly dropped: Schema.$Array<Schema.String>;
}>;
/** The counts the flow settles with. */
export declare const Output: Schema.Struct<{
    readonly totalReceived: Schema.Number;
    readonly suppressed: Schema.Number;
    readonly escalated: Schema.Number;
    readonly ticketed: Schema.Number;
    readonly observed: Schema.Number;
    readonly summary: Schema.String;
}>;
/** Looks up recent incidents and noise rules for the batch. */
export declare const LookUpContext: AgentAction.AgentAction<"examples/AlertSuppressor/Context", Schema.Struct<{
    alerts: Schema.$Array<Schema.Struct<{
        readonly id: Schema.String;
        readonly source: Schema.String;
        readonly severity: Schema.Literals<readonly ["critical", "high", "medium", "low"]>;
        readonly message: Schema.String;
        readonly timestamp: Schema.String;
        readonly labels: Schema.String;
    }>>;
    noiseRules: Schema.$Array<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
    incidentSource: Schema.String;
}>, Schema.Struct<{
    readonly recentIncidents: Schema.$Array<Schema.Struct<{
        readonly id: Schema.String;
        readonly title: Schema.String;
        readonly status: Schema.Literals<readonly ["open", "mitigated", "resolved"]>;
        readonly relatedAlertPatterns: Schema.$Array<Schema.String>;
    }>>;
    readonly noiseRules: Schema.$Array<Schema.Struct<{
        readonly pattern: Schema.String;
        readonly reason: Schema.String;
        readonly expiresAt: Schema.optional<Schema.String>;
    }>>;
}>>;
/** Gives each unique alert a verdict. */
export declare const Classify: AgentAction.AgentAction<"examples/AlertSuppressor/Classify", Schema.Struct<{
    uniqueAlerts: Schema.$Array<Schema.Struct<{
        readonly id: Schema.String;
        readonly source: Schema.String;
        readonly severity: Schema.Literals<readonly ["critical", "high", "medium", "low"]>;
        readonly message: Schema.String;
        readonly timestamp: Schema.String;
        readonly labels: Schema.String;
    }>>;
    noiseRules: Schema.$Array<Schema.Struct<{
        readonly pattern: Schema.String;
        readonly reason: Schema.String;
        readonly expiresAt: Schema.optional<Schema.String>;
    }>>;
    recentIncidents: Schema.$Array<Schema.Struct<{
        readonly id: Schema.String;
        readonly title: Schema.String;
        readonly status: Schema.Literals<readonly ["open", "mitigated", "resolved"]>;
        readonly relatedAlertPatterns: Schema.$Array<Schema.String>;
    }>>;
}>, Schema.Struct<{
    readonly classifications: Schema.$Array<Schema.Struct<{
        readonly alertId: Schema.String;
        readonly verdict: Schema.Literals<readonly ["escalate", "suppress", "observe"]>;
        readonly confidence: Schema.Number;
        readonly matchedNoiseRule: Schema.optional<Schema.String>;
        readonly matchedIncidentId: Schema.optional<Schema.String>;
        readonly reasoning: Schema.String;
        readonly riskLevel: Schema.Literals<readonly ["critical", "high", "medium", "low"]>;
    }>>;
}>>;
/** Pages, tickets or drops each classified alert. */
export declare const Dispatch: AgentAction.AgentAction<"examples/AlertSuppressor/Dispatch", Schema.Struct<{
    classifications: Schema.$Array<Schema.Struct<{
        readonly alertId: Schema.String;
        readonly verdict: Schema.Literals<readonly ["escalate", "suppress", "observe"]>;
        readonly confidence: Schema.Number;
        readonly matchedNoiseRule: Schema.optional<Schema.String>;
        readonly matchedIncidentId: Schema.optional<Schema.String>;
        readonly reasoning: Schema.String;
        readonly riskLevel: Schema.Literals<readonly ["critical", "high", "medium", "low"]>;
    }>>;
    pageChannel: Schema.String;
    ticketSystem: Schema.String;
}>, Schema.Struct<{
    readonly paged: Schema.$Array<Schema.Struct<{
        readonly alertId: Schema.String;
        readonly channel: Schema.String;
        readonly ticketUrl: Schema.optional<Schema.String>;
    }>>;
    readonly ticketed: Schema.$Array<Schema.Struct<{
        readonly alertId: Schema.String;
        readonly ticketUrl: Schema.String;
    }>>;
    readonly dropped: Schema.$Array<Schema.String>;
}>>;
/** The flow: dedupe and look up context, classify, dispatch, count. */
export declare const AlertSuppressor: Flow.Flow<"examples/AlertSuppressor", Schema.Struct<{
    alerts: Schema.optional<Schema.$Array<Schema.Struct<{
        readonly id: Schema.String;
        readonly source: Schema.String;
        readonly severity: Schema.Literals<readonly ["critical", "high", "medium", "low"]>;
        readonly message: Schema.String;
        readonly timestamp: Schema.String;
        readonly labels: Schema.String;
    }>>>;
    noiseRules: Schema.optional<Schema.$Array<Schema.Codec<Schema.Json, Schema.Json, never, never>>>;
    incidentSource: Schema.optional<Schema.String>;
    pageChannel: Schema.optional<Schema.String>;
    ticketSystem: Schema.optional<Schema.String>;
}>, Schema.Struct<{
    readonly totalReceived: Schema.Number;
    readonly suppressed: Schema.Number;
    readonly escalated: Schema.Number;
    readonly ticketed: Schema.Number;
    readonly observed: Schema.Number;
    readonly summary: Schema.String;
}>, Schema.Union<readonly [typeof import("@smthrs/harness/StructuredOutput").StructuredOutputFailure, typeof import("../../src/Seat.vibe").SeatUnresolved, typeof import("../../src/Seat.vibe").SeatUnrouted, typeof import("../../src/Budget.js").BudgetExceeded, typeof import("../../src/Budget.js").Skipped, typeof import("@smthrs/harness/HarnessError").HarnessError, typeof import("@smthrs/plugin/PluginError").PluginError]>, import("@smthrs/flow/Action").Requirement<"examples/AlertSuppressor/Classify"> | import("@smthrs/flow/Action").Requirement<"examples/AlertSuppressor/Context"> | import("@smthrs/flow/Action").Requirement<"examples/AlertSuppressor/Dispatch">>;
/** Every step the flow calls. */
export declare const layer: Layer.Layer<import("@smthrs/flow/Action").Requirement<"examples/AlertSuppressor/Classify"> | import("@smthrs/flow/Action").Requirement<"examples/AlertSuppressor/Context"> | import("@smthrs/flow/Action").Requirement<"examples/AlertSuppressor/Dispatch">, never, import("../../src/Agent.js").Agent | import("../../src/Budget.js").Budget | import("@smthrs/crypto/Crypto").Crypto | import("@smthrs/model/Evaluator").Evaluator | import("@smthrs/flow/FlowRuntime").FlowRuntime | AgentAction.Host | import("../../src/QuotaPolicy.vibe").QuotaClassifier | import("@smthrs/harness/Sandbox").Sandbox | import("../../src/SeatResolver.js").SeatResolver | import("@smthrs/harness/Steering").Source>;
