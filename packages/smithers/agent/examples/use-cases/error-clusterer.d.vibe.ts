/**
 * Group recurring errors into clusters and keep a remediation knowledge base current.
 *
 * Port of the 0.x `error-clusterer.jsx`. An ingester agent reads errors from
 * the given sources and fingerprints each one; the flow groups them by
 * fingerprint, largest cluster first; an explainer agent gives each cluster a
 * root cause, remediation and severity; and an updater agent writes them to
 * the knowledge base and returns the remediation table. The steps run in
 * sequence, and any failure fails the run.
 *
 * 0.x's knowledge base is files the updater writes under `kbPath`, and so is this port's; it does not move them into `@smthrs/memory` facts.
 * 0.x's prompts were placeholders that dumped their props; these are minimal prompts over the same props.
 * 0.x gave the agents `bash`, `read`, `grep` and `write` tools; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`).
 */
import * as AgentAction from "@smthrs/agent/AgentAction";
import { Flow } from "@smthrs/flow";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
/** One normalized error. */
export declare const ErrorEntry: Schema.Struct<{
    readonly id: Schema.String;
    readonly source: Schema.Literals<readonly ["ci", "api", "runtime"]>;
    readonly message: Schema.String;
    readonly stackTrace: Schema.optional<Schema.String>;
    readonly timestamp: Schema.String;
    readonly fingerprint: Schema.String;
}>;
/** What the ingester read. */
export declare const Ingested: Schema.Struct<{
    readonly errors: Schema.$Array<Schema.Struct<{
        readonly id: Schema.String;
        readonly source: Schema.Literals<readonly ["ci", "api", "runtime"]>;
        readonly message: Schema.String;
        readonly stackTrace: Schema.optional<Schema.String>;
        readonly timestamp: Schema.String;
        readonly fingerprint: Schema.String;
    }>>;
    readonly totalIngested: Schema.Number;
    readonly sources: Schema.$Record<Schema.Literals<readonly ["ci", "api", "runtime"]>, Schema.Number>;
}>;
/** Every error sharing one fingerprint. */
export declare const Cluster: Schema.Struct<{
    readonly clusterId: Schema.String;
    readonly fingerprint: Schema.String;
    readonly representative: Schema.String;
    readonly count: Schema.Number;
    readonly source: Schema.Literals<readonly ["ci", "api", "runtime"]>;
    readonly errorIds: Schema.$Array<Schema.String>;
    readonly firstSeen: Schema.String;
    readonly lastSeen: Schema.String;
}>;
/** The clusters, largest first. */
export declare const Clusters: Schema.Struct<{
    readonly clusters: Schema.$Array<Schema.Struct<{
        readonly clusterId: Schema.String;
        readonly fingerprint: Schema.String;
        readonly representative: Schema.String;
        readonly count: Schema.Number;
        readonly source: Schema.Literals<readonly ["ci", "api", "runtime"]>;
        readonly errorIds: Schema.$Array<Schema.String>;
        readonly firstSeen: Schema.String;
        readonly lastSeen: Schema.String;
    }>>;
    readonly totalClusters: Schema.Number;
    readonly largestClusterSize: Schema.Number;
}>;
/** The explainer's analysis of every cluster. */
export declare const Explanations: Schema.Struct<{
    readonly explanations: Schema.$Array<Schema.Struct<{
        readonly clusterId: Schema.String;
        readonly fingerprint: Schema.String;
        readonly rootCause: Schema.String;
        readonly remediation: Schema.String;
        readonly severity: Schema.Literals<readonly ["critical", "high", "medium", "low"]>;
        readonly relatedDocs: Schema.optional<Schema.$Array<Schema.String>>;
        readonly suggestedOwner: Schema.optional<Schema.String>;
    }>>;
    readonly summary: Schema.String;
}>;
/** What the updater wrote, and the remediation table the flow settles with. */
export declare const KbUpdate: Schema.Struct<{
    readonly entriesWritten: Schema.Number;
    readonly ticketsCreated: Schema.$Array<Schema.String>;
    readonly kbPath: Schema.String;
    readonly remediationTable: Schema.$Array<Schema.Struct<{
        readonly fingerprint: Schema.String;
        readonly rootCause: Schema.String;
        readonly remediation: Schema.String;
        readonly severity: Schema.String;
        readonly occurrences: Schema.Number;
    }>>;
    readonly summary: Schema.String;
}>;
/** Reads and fingerprints the errors. */
export declare const Ingest: AgentAction.AgentAction<"examples/ErrorClusterer/Ingest", Schema.Struct<{
    sources: Schema.$Array<Schema.Literals<readonly ["ci", "api", "runtime"]>>;
    logPaths: Schema.$Array<Schema.String>;
    since: Schema.String;
}>, Schema.Struct<{
    readonly errors: Schema.$Array<Schema.Struct<{
        readonly id: Schema.String;
        readonly source: Schema.Literals<readonly ["ci", "api", "runtime"]>;
        readonly message: Schema.String;
        readonly stackTrace: Schema.optional<Schema.String>;
        readonly timestamp: Schema.String;
        readonly fingerprint: Schema.String;
    }>>;
    readonly totalIngested: Schema.Number;
    readonly sources: Schema.$Record<Schema.Literals<readonly ["ci", "api", "runtime"]>, Schema.Number>;
}>>;
/** Explains every cluster. */
export declare const Explain: AgentAction.AgentAction<"examples/ErrorClusterer/Explain", Schema.Struct<{
    clusters: Schema.$Array<Schema.Struct<{
        readonly clusterId: Schema.String;
        readonly fingerprint: Schema.String;
        readonly representative: Schema.String;
        readonly count: Schema.Number;
        readonly source: Schema.Literals<readonly ["ci", "api", "runtime"]>;
        readonly errorIds: Schema.$Array<Schema.String>;
        readonly firstSeen: Schema.String;
        readonly lastSeen: Schema.String;
    }>>;
    totalClusters: Schema.Number;
    kbPath: Schema.String;
}>, Schema.Struct<{
    readonly explanations: Schema.$Array<Schema.Struct<{
        readonly clusterId: Schema.String;
        readonly fingerprint: Schema.String;
        readonly rootCause: Schema.String;
        readonly remediation: Schema.String;
        readonly severity: Schema.Literals<readonly ["critical", "high", "medium", "low"]>;
        readonly relatedDocs: Schema.optional<Schema.$Array<Schema.String>>;
        readonly suggestedOwner: Schema.optional<Schema.String>;
    }>>;
    readonly summary: Schema.String;
}>>;
/** Writes the explanations to the knowledge base and opens tickets. */
export declare const Update: AgentAction.AgentAction<"examples/ErrorClusterer/Update", Schema.Struct<{
    explanations: Schema.$Array<Schema.Struct<{
        readonly clusterId: Schema.String;
        readonly fingerprint: Schema.String;
        readonly rootCause: Schema.String;
        readonly remediation: Schema.String;
        readonly severity: Schema.Literals<readonly ["critical", "high", "medium", "low"]>;
        readonly relatedDocs: Schema.optional<Schema.$Array<Schema.String>>;
        readonly suggestedOwner: Schema.optional<Schema.String>;
    }>>;
    kbPath: Schema.String;
    ticketPrefix: Schema.String;
    clusters: Schema.$Array<Schema.Struct<{
        readonly clusterId: Schema.String;
        readonly fingerprint: Schema.String;
        readonly representative: Schema.String;
        readonly count: Schema.Number;
        readonly source: Schema.Literals<readonly ["ci", "api", "runtime"]>;
        readonly errorIds: Schema.$Array<Schema.String>;
        readonly firstSeen: Schema.String;
        readonly lastSeen: Schema.String;
    }>>;
}>, Schema.Struct<{
    readonly entriesWritten: Schema.Number;
    readonly ticketsCreated: Schema.$Array<Schema.String>;
    readonly kbPath: Schema.String;
    readonly remediationTable: Schema.$Array<Schema.Struct<{
        readonly fingerprint: Schema.String;
        readonly rootCause: Schema.String;
        readonly remediation: Schema.String;
        readonly severity: Schema.String;
        readonly occurrences: Schema.Number;
    }>>;
    readonly summary: Schema.String;
}>>;
/** The flow: ingest, cluster, explain, update the knowledge base. */
export declare const ErrorClusterer: Flow.Flow<"examples/ErrorClusterer", Schema.Struct<{
    sources: Schema.optional<Schema.$Array<Schema.Literals<readonly ["ci", "api", "runtime"]>>>;
    logPaths: Schema.optional<Schema.$Array<Schema.String>>;
    since: Schema.optional<Schema.String>;
    kbPath: Schema.optional<Schema.String>;
    ticketPrefix: Schema.optional<Schema.String>;
}>, Schema.Struct<{
    readonly entriesWritten: Schema.Number;
    readonly ticketsCreated: Schema.$Array<Schema.String>;
    readonly kbPath: Schema.String;
    readonly remediationTable: Schema.$Array<Schema.Struct<{
        readonly fingerprint: Schema.String;
        readonly rootCause: Schema.String;
        readonly remediation: Schema.String;
        readonly severity: Schema.String;
        readonly occurrences: Schema.Number;
    }>>;
    readonly summary: Schema.String;
}>, Schema.Union<readonly [typeof import("@smthrs/harness/StructuredOutput").StructuredOutputFailure, typeof import("../../src/Seat.vibe").SeatUnresolved, typeof import("../../src/Seat.vibe").SeatUnrouted, typeof import("../../src/Budget.js").BudgetExceeded, typeof import("../../src/Budget.js").Skipped, typeof import("@smthrs/harness/HarnessError").HarnessError, typeof import("@smthrs/plugin/PluginError").PluginError]>, import("@smthrs/flow/Action").Requirement<"examples/ErrorClusterer/Explain"> | import("@smthrs/flow/Action").Requirement<"examples/ErrorClusterer/Ingest"> | import("@smthrs/flow/Action").Requirement<"examples/ErrorClusterer/Update">>;
/** Every step the flow calls. */
export declare const layer: Layer.Layer<import("@smthrs/flow/Action").Requirement<"examples/ErrorClusterer/Explain"> | import("@smthrs/flow/Action").Requirement<"examples/ErrorClusterer/Ingest"> | import("@smthrs/flow/Action").Requirement<"examples/ErrorClusterer/Update">, never, import("../../src/Agent.js").Agent | import("../../src/Budget.js").Budget | import("@smthrs/crypto/Crypto").Crypto | import("@smthrs/model/Evaluator").Evaluator | import("@smthrs/flow/FlowRuntime").FlowRuntime | AgentAction.Host | import("../../src/QuotaPolicy.vibe").QuotaClassifier | import("@smthrs/harness/Sandbox").Sandbox | import("../../src/SeatResolver.js").SeatResolver | import("@smthrs/harness/Steering").Source>;
