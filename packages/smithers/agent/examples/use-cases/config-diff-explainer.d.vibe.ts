/**
 * Turn env, Helm, Terraform and k8s diffs into a blast-radius and risk summary, then a review verdict.
 *
 * Port of the 0.x `config-diff-explainer.jsx`. A fetcher agent collects the
 * config diffs for a git range and classifies each file by kind and service.
 * An explainer agent rates the blast radius per system and an overall risk
 * level, and a review step turns that into approve, request-changes, or
 * comment against an auto-approve threshold. The steps run in sequence with no
 * branch.
 *
 * 0.x's fetcher was an agent that ran git itself, so the fetch stays an `AgentAction` rather than a deterministic `Action`.
 * 0.x gave `approve` no agent, so it persisted its prompt element as a static output that fails its schema; here it is a model step with no system prompt.
 * 0.x gave the agents `read`, `bash` and `grep` tools; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`).
 */
import * as AgentAction from "@smthrs/agent/AgentAction";
import { Flow } from "@smthrs/flow";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
/** One changed config file. */
export declare const ConfigFile: Schema.Struct<{
    readonly path: Schema.String;
    readonly kind: Schema.Literals<readonly ["helm", "terraform", "k8s", "env", "other"]>;
    readonly diff: Schema.String;
    readonly service: Schema.String;
}>;
/** The collected diffs. */
export declare const FetchedDiff: Schema.Struct<{
    readonly files: Schema.$Array<Schema.Struct<{
        readonly path: Schema.String;
        readonly kind: Schema.Literals<readonly ["helm", "terraform", "k8s", "env", "other"]>;
        readonly diff: Schema.String;
        readonly service: Schema.String;
    }>>;
    readonly totalChanges: Schema.Number;
    readonly summary: Schema.String;
}>;
/** The blast-radius analysis. */
export declare const Explanation: Schema.Struct<{
    readonly blastRadius: Schema.$Array<Schema.Struct<{
        readonly system: Schema.String;
        readonly impact: Schema.String;
        readonly severity: Schema.Literals<readonly ["low", "medium", "high", "critical"]>;
    }>>;
    readonly riskLevel: Schema.Literals<readonly ["low", "medium", "high", "critical"]>;
    readonly affectedSystems: Schema.$Array<Schema.String>;
    readonly rollbackNotes: Schema.String;
    readonly summary: Schema.String;
}>;
/** The review verdict. */
export declare const Review: Schema.Struct<{
    readonly action: Schema.Literals<readonly ["approve", "request-changes", "comment"]>;
    readonly comment: Schema.String;
    readonly summary: Schema.String;
}>;
/** What the flow settles with: the analysis and the verdict on it. */
export declare const Output: Schema.Struct<{
    readonly explanation: Schema.Struct<{
        readonly blastRadius: Schema.$Array<Schema.Struct<{
            readonly system: Schema.String;
            readonly impact: Schema.String;
            readonly severity: Schema.Literals<readonly ["low", "medium", "high", "critical"]>;
        }>>;
        readonly riskLevel: Schema.Literals<readonly ["low", "medium", "high", "critical"]>;
        readonly affectedSystems: Schema.$Array<Schema.String>;
        readonly rollbackNotes: Schema.String;
        readonly summary: Schema.String;
    }>;
    readonly review: Schema.Struct<{
        readonly action: Schema.Literals<readonly ["approve", "request-changes", "comment"]>;
        readonly comment: Schema.String;
        readonly summary: Schema.String;
    }>;
}>;
/** Collects and classifies the config diffs. */
export declare const FetchDiffs: AgentAction.AgentAction<"examples/ConfigDiffExplainer/FetchDiffs", Schema.Struct<{
    paths: Schema.$Array<Schema.String>;
    gitRef: Schema.String;
    filePatterns: Schema.$Array<Schema.String>;
}>, Schema.Struct<{
    readonly files: Schema.$Array<Schema.Struct<{
        readonly path: Schema.String;
        readonly kind: Schema.Literals<readonly ["helm", "terraform", "k8s", "env", "other"]>;
        readonly diff: Schema.String;
        readonly service: Schema.String;
    }>>;
    readonly totalChanges: Schema.Number;
    readonly summary: Schema.String;
}>>;
/** Rates the blast radius and overall risk. */
export declare const Explain: AgentAction.AgentAction<"examples/ConfigDiffExplainer/Explain", Schema.Struct<{
    files: Schema.$Array<Schema.Struct<{
        readonly path: Schema.String;
        readonly kind: Schema.Literals<readonly ["helm", "terraform", "k8s", "env", "other"]>;
        readonly diff: Schema.String;
        readonly service: Schema.String;
    }>>;
    totalChanges: Schema.Number;
    context: Schema.String;
}>, Schema.Struct<{
    readonly blastRadius: Schema.$Array<Schema.Struct<{
        readonly system: Schema.String;
        readonly impact: Schema.String;
        readonly severity: Schema.Literals<readonly ["low", "medium", "high", "critical"]>;
    }>>;
    readonly riskLevel: Schema.Literals<readonly ["low", "medium", "high", "critical"]>;
    readonly affectedSystems: Schema.$Array<Schema.String>;
    readonly rollbackNotes: Schema.String;
    readonly summary: Schema.String;
}>>;
/** Approves, requests changes, or comments. */
export declare const Approve: AgentAction.AgentAction<"examples/ConfigDiffExplainer/Approve", Schema.Struct<{
    riskLevel: Schema.Literals<readonly ["low", "medium", "high", "critical"]>;
    affectedSystems: Schema.$Array<Schema.String>;
    blastRadius: Schema.$Array<Schema.Struct<{
        readonly system: Schema.String;
        readonly impact: Schema.String;
        readonly severity: Schema.Literals<readonly ["low", "medium", "high", "critical"]>;
    }>>;
    summary: Schema.String;
    autoApproveThreshold: Schema.String;
}>, Schema.Struct<{
    readonly action: Schema.Literals<readonly ["approve", "request-changes", "comment"]>;
    readonly comment: Schema.String;
    readonly summary: Schema.String;
}>>;
/** The flow: fetch, explain, review. */
export declare const ConfigDiffExplainer: Flow.Flow<"examples/ConfigDiffExplainer", Schema.Struct<{
    paths: Schema.optional<Schema.$Array<Schema.String>>;
    gitRef: Schema.optional<Schema.String>;
    filePatterns: Schema.optional<Schema.$Array<Schema.String>>;
    context: Schema.optional<Schema.String>;
    autoApproveThreshold: Schema.optional<Schema.String>;
}>, Schema.Struct<{
    readonly explanation: Schema.Struct<{
        readonly blastRadius: Schema.$Array<Schema.Struct<{
            readonly system: Schema.String;
            readonly impact: Schema.String;
            readonly severity: Schema.Literals<readonly ["low", "medium", "high", "critical"]>;
        }>>;
        readonly riskLevel: Schema.Literals<readonly ["low", "medium", "high", "critical"]>;
        readonly affectedSystems: Schema.$Array<Schema.String>;
        readonly rollbackNotes: Schema.String;
        readonly summary: Schema.String;
    }>;
    readonly review: Schema.Struct<{
        readonly action: Schema.Literals<readonly ["approve", "request-changes", "comment"]>;
        readonly comment: Schema.String;
        readonly summary: Schema.String;
    }>;
}>, Schema.Union<readonly [typeof import("@smthrs/harness/StructuredOutput").StructuredOutputFailure, typeof import("../../src/Seat.vibe").SeatUnresolved, typeof import("../../src/Seat.vibe").SeatUnrouted, typeof import("../../src/Budget.js").BudgetExceeded, typeof import("../../src/Budget.js").Skipped, typeof import("@smthrs/harness/HarnessError").HarnessError, typeof import("@smthrs/plugin/PluginError").PluginError]>, import("@smthrs/flow/Action").Requirement<"examples/ConfigDiffExplainer/Approve"> | import("@smthrs/flow/Action").Requirement<"examples/ConfigDiffExplainer/Explain"> | import("@smthrs/flow/Action").Requirement<"examples/ConfigDiffExplainer/FetchDiffs">>;
/** Every step the flow calls. */
export declare const layer: Layer.Layer<import("@smthrs/flow/Action").Requirement<"examples/ConfigDiffExplainer/Approve"> | import("@smthrs/flow/Action").Requirement<"examples/ConfigDiffExplainer/Explain"> | import("@smthrs/flow/Action").Requirement<"examples/ConfigDiffExplainer/FetchDiffs">, never, import("../../src/Agent.js").Agent | import("../../src/Budget.js").Budget | import("@smthrs/crypto/Crypto").Crypto | import("@smthrs/model/Evaluator").Evaluator | import("@smthrs/flow/FlowRuntime").FlowRuntime | AgentAction.Host | import("../../src/QuotaPolicy.vibe").QuotaClassifier | import("@smthrs/harness/Sandbox").Sandbox | import("../../src/SeatResolver.js").SeatResolver | import("@smthrs/harness/Steering").Source>;
