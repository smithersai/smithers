/**
 * Plan the evidence a compliance framework needs, fetch and normalize it in parallel, and assemble a review packet.
 *
 * Port of the 0.x `compliance-evidence-collector.jsx`. A planning agent lists
 * the controls in scope and the sources to query for each. A fetcher agent
 * collects raw evidence from every control and source pair, at most
 * `maxConcurrency` (default 5) at a time with a `timeoutMs` (default 60 s)
 * bound each, and a failed fetch drops only its own evidence. Once every fetch
 * has settled, a normalizer agent extracts a finding from each evidence item
 * at the same bound, and a packet agent assembles per-control verdicts.
 *
 * 0.x re-rendered its tree once the plan and then the evidence landed; here each fan-out runs in a `.child()` flow whose body plans over the real list.
 * `MapReduce` does not fit: its reducer sees only the shards and their results, not the framework and plan the packet reads, and 0.x normalizes only after every fetch has settled.
 * 0.x gave the agents `read`, `write`, `bash` and `grep` tools; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`).
 */
import * as AgentAction from "@smthrs/agent/AgentAction";
import { Flow } from "@smthrs/flow";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
/** One control in scope and the sources that evidence it. */
export declare const PlannedControl: Schema.Struct<{
    readonly controlId: Schema.String;
    readonly description: Schema.String;
    readonly sources: Schema.$Array<Schema.Struct<{
        readonly sourceId: Schema.String;
        readonly endpoint: Schema.String;
        readonly preferredMethod: Schema.Literals<readonly ["api", "mcp", "browser"]>;
    }>>;
}>;
/** The collection plan. */
export declare const Plan: Schema.Struct<{
    readonly controls: Schema.$Array<Schema.Struct<{
        readonly controlId: Schema.String;
        readonly description: Schema.String;
        readonly sources: Schema.$Array<Schema.Struct<{
            readonly sourceId: Schema.String;
            readonly endpoint: Schema.String;
            readonly preferredMethod: Schema.Literals<readonly ["api", "mcp", "browser"]>;
        }>>;
    }>>;
    readonly totalSources: Schema.Number;
}>;
/** Raw evidence from one source for one control. */
export declare const EvidenceItem: Schema.Struct<{
    readonly sourceId: Schema.String;
    readonly controlId: Schema.String;
    readonly title: Schema.String;
    readonly rawPayload: Schema.String;
    readonly fetchedAt: Schema.String;
    readonly method: Schema.Literals<readonly ["api", "mcp", "browser"]>;
    readonly status: Schema.Literals<readonly ["collected", "partial", "failed"]>;
}>;
/** One structured finding. */
export declare const Normalized: Schema.Struct<{
    readonly controlId: Schema.String;
    readonly sourceId: Schema.String;
    readonly finding: Schema.String;
    readonly compliant: Schema.Boolean;
    readonly severity: Schema.optional<Schema.Literals<readonly ["info", "low", "medium", "high", "critical"]>>;
    readonly extractedFields: Schema.optional<Schema.$Record<Schema.String, Schema.String>>;
}>;
/** The review packet the flow settles with. */
export declare const Packet: Schema.Struct<{
    readonly framework: Schema.String;
    readonly generatedAt: Schema.String;
    readonly controlCount: Schema.Number;
    readonly compliantCount: Schema.Number;
    readonly nonCompliantCount: Schema.Number;
    readonly findings: Schema.$Array<Schema.Struct<{
        readonly controlId: Schema.String;
        readonly status: Schema.Literals<readonly ["compliant", "non-compliant", "insufficient-evidence"]>;
        readonly evidence: Schema.$Array<Schema.String>;
        readonly recommendation: Schema.optional<Schema.String>;
    }>>;
    readonly summary: Schema.String;
}>;
/** Plans which controls and sources to collect. */
export declare const PlanCollection: AgentAction.AgentAction<"examples/ComplianceEvidenceCollector/Plan", Schema.Struct<{
    framework: Schema.String;
    scope: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
    controls: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
}>, Schema.Struct<{
    readonly controls: Schema.$Array<Schema.Struct<{
        readonly controlId: Schema.String;
        readonly description: Schema.String;
        readonly sources: Schema.$Array<Schema.Struct<{
            readonly sourceId: Schema.String;
            readonly endpoint: Schema.String;
            readonly preferredMethod: Schema.Literals<readonly ["api", "mcp", "browser"]>;
        }>>;
    }>>;
    readonly totalSources: Schema.Number;
}>>;
/** Collects raw evidence from one source. */
export declare const Fetch: AgentAction.AgentAction<"examples/ComplianceEvidenceCollector/Fetch", Schema.Struct<{
    controlId: Schema.String;
    sourceId: Schema.String;
    endpoint: Schema.String;
    method: Schema.Literals<readonly ["api", "mcp", "browser"]>;
    timeoutMs: Schema.Int;
}>, Schema.Struct<{
    readonly sourceId: Schema.String;
    readonly controlId: Schema.String;
    readonly title: Schema.String;
    readonly rawPayload: Schema.String;
    readonly fetchedAt: Schema.String;
    readonly method: Schema.Literals<readonly ["api", "mcp", "browser"]>;
    readonly status: Schema.Literals<readonly ["collected", "partial", "failed"]>;
}>>;
/** Extracts a finding from one evidence item. */
export declare const Normalize: AgentAction.AgentAction<"examples/ComplianceEvidenceCollector/Normalize", Schema.Struct<{
    controlId: Schema.String;
    sourceId: Schema.String;
    rawPayload: Schema.String;
    method: Schema.Literals<readonly ["api", "mcp", "browser"]>;
}>, Schema.Struct<{
    readonly controlId: Schema.String;
    readonly sourceId: Schema.String;
    readonly finding: Schema.String;
    readonly compliant: Schema.Boolean;
    readonly severity: Schema.optional<Schema.Literals<readonly ["info", "low", "medium", "high", "critical"]>>;
    readonly extractedFields: Schema.optional<Schema.$Record<Schema.String, Schema.String>>;
}>>;
/** Assembles the review packet. */
export declare const AssemblePacket: AgentAction.AgentAction<"examples/ComplianceEvidenceCollector/Packet", Schema.Struct<{
    framework: Schema.String;
    findings: Schema.$Array<Schema.Struct<{
        readonly controlId: Schema.String;
        readonly sourceId: Schema.String;
        readonly finding: Schema.String;
        readonly compliant: Schema.Boolean;
        readonly severity: Schema.optional<Schema.Literals<readonly ["info", "low", "medium", "high", "critical"]>>;
        readonly extractedFields: Schema.optional<Schema.$Record<Schema.String, Schema.String>>;
    }>>;
    controls: Schema.$Array<Schema.Struct<{
        readonly controlId: Schema.String;
        readonly description: Schema.String;
        readonly sources: Schema.$Array<Schema.Struct<{
            readonly sourceId: Schema.String;
            readonly endpoint: Schema.String;
            readonly preferredMethod: Schema.Literals<readonly ["api", "mcp", "browser"]>;
        }>>;
    }>>;
}>, Schema.Struct<{
    readonly framework: Schema.String;
    readonly generatedAt: Schema.String;
    readonly controlCount: Schema.Number;
    readonly compliantCount: Schema.Number;
    readonly nonCompliantCount: Schema.Number;
    readonly findings: Schema.$Array<Schema.Struct<{
        readonly controlId: Schema.String;
        readonly status: Schema.Literals<readonly ["compliant", "non-compliant", "insufficient-evidence"]>;
        readonly evidence: Schema.$Array<Schema.String>;
        readonly recommendation: Schema.optional<Schema.String>;
    }>>;
    readonly summary: Schema.String;
}>>;
/**
 * Fetches every control and source pair in the plan. It runs as a child
 * execution, so its payload is the real plan when its body plans the fan-out.
 */
export declare const FetchEvidence: Flow.Flow<"examples/ComplianceEvidenceCollector/FetchEvidence", Schema.Struct<{
    controls: Schema.$Array<Schema.Struct<{
        readonly controlId: Schema.String;
        readonly description: Schema.String;
        readonly sources: Schema.$Array<Schema.Struct<{
            readonly sourceId: Schema.String;
            readonly endpoint: Schema.String;
            readonly preferredMethod: Schema.Literals<readonly ["api", "mcp", "browser"]>;
        }>>;
    }>>;
    concurrency: Schema.Int;
    timeoutMs: Schema.Int;
}>, Schema.$Array<Schema.Struct<{
    readonly sourceId: Schema.String;
    readonly controlId: Schema.String;
    readonly title: Schema.String;
    readonly rawPayload: Schema.String;
    readonly fetchedAt: Schema.String;
    readonly method: Schema.Literals<readonly ["api", "mcp", "browser"]>;
    readonly status: Schema.Literals<readonly ["collected", "partial", "failed"]>;
}>>, Schema.Never, import("@smthrs/flow/Action").Requirement<"examples/ComplianceEvidenceCollector/Fetch">>;
/** Normalizes every collected evidence item, once all of them are in. */
export declare const NormalizeEvidence: Flow.Flow<"examples/ComplianceEvidenceCollector/NormalizeEvidence", Schema.Struct<{
    evidence: Schema.$Array<Schema.Struct<{
        readonly sourceId: Schema.String;
        readonly controlId: Schema.String;
        readonly title: Schema.String;
        readonly rawPayload: Schema.String;
        readonly fetchedAt: Schema.String;
        readonly method: Schema.Literals<readonly ["api", "mcp", "browser"]>;
        readonly status: Schema.Literals<readonly ["collected", "partial", "failed"]>;
    }>>;
    concurrency: Schema.Int;
}>, Schema.$Array<Schema.Struct<{
    readonly controlId: Schema.String;
    readonly sourceId: Schema.String;
    readonly finding: Schema.String;
    readonly compliant: Schema.Boolean;
    readonly severity: Schema.optional<Schema.Literals<readonly ["info", "low", "medium", "high", "critical"]>>;
    readonly extractedFields: Schema.optional<Schema.$Record<Schema.String, Schema.String>>;
}>>, Schema.Union<readonly [typeof import("@smthrs/harness/StructuredOutput").StructuredOutputFailure, typeof import("../../src/Seat.vibe").SeatUnresolved, typeof import("../../src/Seat.vibe").SeatUnrouted, typeof import("../../src/Budget.js").BudgetExceeded, typeof import("../../src/Budget.js").Skipped, typeof import("@smthrs/harness/HarnessError").HarnessError, typeof import("@smthrs/plugin/PluginError").PluginError]>, import("@smthrs/flow/Action").Requirement<"examples/ComplianceEvidenceCollector/Normalize">>;
/** The flow: plan, fetch, normalize, assemble. */
export declare const ComplianceEvidenceCollector: Flow.Flow<"examples/ComplianceEvidenceCollector", Schema.Struct<{
    framework: Schema.optional<Schema.String>;
    scope: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
    controls: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
    maxConcurrency: Schema.optional<Schema.Int>;
    timeoutMs: Schema.optional<Schema.Int>;
}>, Schema.Struct<{
    readonly framework: Schema.String;
    readonly generatedAt: Schema.String;
    readonly controlCount: Schema.Number;
    readonly compliantCount: Schema.Number;
    readonly nonCompliantCount: Schema.Number;
    readonly findings: Schema.$Array<Schema.Struct<{
        readonly controlId: Schema.String;
        readonly status: Schema.Literals<readonly ["compliant", "non-compliant", "insufficient-evidence"]>;
        readonly evidence: Schema.$Array<Schema.String>;
        readonly recommendation: Schema.optional<Schema.String>;
    }>>;
    readonly summary: Schema.String;
}>, Schema.Union<readonly [typeof import("@smthrs/harness/StructuredOutput").StructuredOutputFailure, typeof import("../../src/Seat.vibe").SeatUnresolved, typeof import("../../src/Seat.vibe").SeatUnrouted, typeof import("../../src/Budget.js").BudgetExceeded, typeof import("../../src/Budget.js").Skipped, typeof import("@smthrs/harness/HarnessError").HarnessError, typeof import("@smthrs/plugin/PluginError").PluginError]>, import("@smthrs/flow/Action").Requirement<"examples/ComplianceEvidenceCollector/Packet"> | import("@smthrs/flow/Action").Requirement<"examples/ComplianceEvidenceCollector/Plan">>;
/** Every step the flow calls, and the child flows it starts. */
export declare const layer: Layer.Layer<import("@smthrs/flow/Action").Requirement<"examples/ComplianceEvidenceCollector/Fetch"> | import("@smthrs/flow/Action").Requirement<"examples/ComplianceEvidenceCollector/Normalize"> | import("@smthrs/flow/Action").Requirement<"examples/ComplianceEvidenceCollector/Packet"> | import("@smthrs/flow/Action").Requirement<"examples/ComplianceEvidenceCollector/Plan">, never, import("../../src/Agent.js").Agent | import("../../src/Budget.js").Budget | import("@smthrs/crypto/Crypto").Crypto | import("@smthrs/model/Evaluator").Evaluator | import("@smthrs/flow/FlowRuntime").FlowRuntime | AgentAction.Host | import("@smthrs/flow/Action").Implementations | import("../../src/QuotaPolicy.vibe").QuotaClassifier | import("@smthrs/harness/Sandbox").Sandbox | import("../../src/SeatResolver.js").SeatResolver | import("@smthrs/harness/Steering").Source>;
