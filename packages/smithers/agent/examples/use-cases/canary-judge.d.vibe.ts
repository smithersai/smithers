/**
 * Compare stable and canary telemetry and issue a promote, hold or rollback verdict with its deploy command.
 *
 * Port of the 0.x `canary-judge.jsx`. One collector agent gathers the stable
 * and the canary stream's telemetry at once, over a window of `windowMinutes`
 * (default 15). A comparator agent computes the deltas and risk signals
 * against the given thresholds, and a judge agent decides promote, hold or
 * rollback. The last step turns the decision into the one `deployctl` command
 * and the channels to notify; it runs nothing.
 *
 * 0.x's `<Parallel maxConcurrency={2}>` over the two collections is `Node.all`.
 * 0.x's agentless `deploy` step is a pure `Node.map`: it only names the command, as 0.x did.
 * 0.x's prompts were placeholders that printed their props; these prompts carry the same props.
 * 0.x gave the agents `read`, `bash` and `grep` tools; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`).
 */
import * as AgentAction from "@smthrs/agent/AgentAction";
import { Flow } from "@smthrs/flow";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
/** One stream's telemetry. */
export declare const Telemetry: Schema.Struct<{
    readonly stream: Schema.Literals<readonly ["stable", "canary"]>;
    readonly latencyP50Ms: Schema.Number;
    readonly latencyP99Ms: Schema.Number;
    readonly errorRate: Schema.Number;
    readonly throughputRps: Schema.Number;
    readonly logAnomalies: Schema.$Array<Schema.String>;
    readonly traceWarnings: Schema.$Array<Schema.String>;
}>;
/** How the canary differs from stable. */
export declare const Comparison: Schema.Struct<{
    readonly latencyDelta: Schema.Struct<{
        readonly p50Pct: Schema.Number;
        readonly p99Pct: Schema.Number;
    }>;
    readonly errorRateDelta: Schema.Number;
    readonly throughputDelta: Schema.Number;
    readonly newAnomalies: Schema.$Array<Schema.String>;
    readonly riskSignals: Schema.$Array<Schema.Struct<{
        readonly signal: Schema.String;
        readonly severity: Schema.Literals<readonly ["critical", "high", "medium", "low"]>;
    }>>;
    readonly summary: Schema.String;
}>;
/** The judge's verdict. */
export declare const Verdict: Schema.Struct<{
    readonly decision: Schema.Literals<readonly ["promote", "hold", "rollback"]>;
    readonly confidence: Schema.Number;
    readonly reasons: Schema.$Array<Schema.String>;
    readonly conditions: Schema.$Array<Schema.String>;
    readonly summary: Schema.String;
}>;
/** The deploy action the flow settles with. */
export declare const DeployAction: Schema.Struct<{
    readonly action: Schema.Literals<readonly ["promote", "hold", "rollback"]>;
    readonly commands: Schema.$Array<Schema.String>;
    readonly notifyChannels: Schema.$Array<Schema.String>;
    readonly summary: Schema.String;
}>;
/** Gathers one stream's telemetry. Both streams use this one collector. */
export declare const Collect: AgentAction.AgentAction<"examples/CanaryJudge/Collect", Schema.Struct<{
    stream: Schema.Literals<readonly ["stable", "canary"]>;
    metricsEndpoint: Schema.String;
    logSource: Schema.String;
    traceStore: Schema.String;
    windowMinutes: Schema.Number;
}>, Schema.Struct<{
    readonly stream: Schema.Literals<readonly ["stable", "canary"]>;
    readonly latencyP50Ms: Schema.Number;
    readonly latencyP99Ms: Schema.Number;
    readonly errorRate: Schema.Number;
    readonly throughputRps: Schema.Number;
    readonly logAnomalies: Schema.$Array<Schema.String>;
    readonly traceWarnings: Schema.$Array<Schema.String>;
}>>;
/** Computes the deltas between the two streams. */
export declare const Compare: AgentAction.AgentAction<"examples/CanaryJudge/Compare", Schema.Struct<{
    stable: Schema.Struct<{
        readonly stream: Schema.Literals<readonly ["stable", "canary"]>;
        readonly latencyP50Ms: Schema.Number;
        readonly latencyP99Ms: Schema.Number;
        readonly errorRate: Schema.Number;
        readonly throughputRps: Schema.Number;
        readonly logAnomalies: Schema.$Array<Schema.String>;
        readonly traceWarnings: Schema.$Array<Schema.String>;
    }>;
    canary: Schema.Struct<{
        readonly stream: Schema.Literals<readonly ["stable", "canary"]>;
        readonly latencyP50Ms: Schema.Number;
        readonly latencyP99Ms: Schema.Number;
        readonly errorRate: Schema.Number;
        readonly throughputRps: Schema.Number;
        readonly logAnomalies: Schema.$Array<Schema.String>;
        readonly traceWarnings: Schema.$Array<Schema.String>;
    }>;
    thresholds: Schema.$Record<Schema.String, Schema.Codec<Schema.Json, Schema.Json, never, never>>;
}>, Schema.Struct<{
    readonly latencyDelta: Schema.Struct<{
        readonly p50Pct: Schema.Number;
        readonly p99Pct: Schema.Number;
    }>;
    readonly errorRateDelta: Schema.Number;
    readonly throughputDelta: Schema.Number;
    readonly newAnomalies: Schema.$Array<Schema.String>;
    readonly riskSignals: Schema.$Array<Schema.Struct<{
        readonly signal: Schema.String;
        readonly severity: Schema.Literals<readonly ["critical", "high", "medium", "low"]>;
    }>>;
    readonly summary: Schema.String;
}>>;
/** Decides promote, hold or rollback. */
export declare const Judge: AgentAction.AgentAction<"examples/CanaryJudge/Judge", Schema.Struct<{
    comparison: Schema.Struct<{
        readonly latencyDelta: Schema.Struct<{
            readonly p50Pct: Schema.Number;
            readonly p99Pct: Schema.Number;
        }>;
        readonly errorRateDelta: Schema.Number;
        readonly throughputDelta: Schema.Number;
        readonly newAnomalies: Schema.$Array<Schema.String>;
        readonly riskSignals: Schema.$Array<Schema.Struct<{
            readonly signal: Schema.String;
            readonly severity: Schema.Literals<readonly ["critical", "high", "medium", "low"]>;
        }>>;
        readonly summary: Schema.String;
    }>;
    riskSignals: Schema.$Array<Schema.Struct<{
        readonly signal: Schema.String;
        readonly severity: Schema.Literals<readonly ["critical", "high", "medium", "low"]>;
    }>>;
    deploymentId: Schema.String;
    serviceName: Schema.String;
}>, Schema.Struct<{
    readonly decision: Schema.Literals<readonly ["promote", "hold", "rollback"]>;
    readonly confidence: Schema.Number;
    readonly reasons: Schema.$Array<Schema.String>;
    readonly conditions: Schema.$Array<Schema.String>;
    readonly summary: Schema.String;
}>>;
/** The flow: collect both streams at once, compare, judge, name the command. */
export declare const CanaryJudge: Flow.Flow<"examples/CanaryJudge", Schema.Struct<{
    stableMetricsEndpoint: Schema.String;
    stableLogSource: Schema.String;
    stableTraceStore: Schema.String;
    canaryMetricsEndpoint: Schema.String;
    canaryLogSource: Schema.String;
    canaryTraceStore: Schema.String;
    windowMinutes: Schema.optional<Schema.Number>;
    thresholds: Schema.optional<Schema.$Record<Schema.String, Schema.Codec<Schema.Json, Schema.Json, never, never>>>;
    deploymentId: Schema.optional<Schema.String>;
    serviceName: Schema.optional<Schema.String>;
    notifyChannels: Schema.optional<Schema.$Array<Schema.String>>;
}>, Schema.Struct<{
    readonly action: Schema.Literals<readonly ["promote", "hold", "rollback"]>;
    readonly commands: Schema.$Array<Schema.String>;
    readonly notifyChannels: Schema.$Array<Schema.String>;
    readonly summary: Schema.String;
}>, Schema.Union<readonly [typeof import("@smthrs/harness/StructuredOutput").StructuredOutputFailure, typeof import("../../src/Seat.vibe").SeatUnresolved, typeof import("../../src/Seat.vibe").SeatUnrouted, typeof import("../../src/Budget.js").BudgetExceeded, typeof import("../../src/Budget.js").Skipped, typeof import("@smthrs/harness/HarnessError").HarnessError, typeof import("@smthrs/plugin/PluginError").PluginError]>, import("@smthrs/flow/Action").Requirement<"examples/CanaryJudge/Collect"> | import("@smthrs/flow/Action").Requirement<"examples/CanaryJudge/Compare"> | import("@smthrs/flow/Action").Requirement<"examples/CanaryJudge/Judge">>;
/** Every step the flow calls. */
export declare const layer: Layer.Layer<import("@smthrs/flow/Action").Requirement<"examples/CanaryJudge/Collect"> | import("@smthrs/flow/Action").Requirement<"examples/CanaryJudge/Compare"> | import("@smthrs/flow/Action").Requirement<"examples/CanaryJudge/Judge">, never, import("../../src/Agent.js").Agent | import("../../src/Budget.js").Budget | import("@smthrs/crypto/Crypto").Crypto | import("@smthrs/model/Evaluator").Evaluator | import("@smthrs/flow/FlowRuntime").FlowRuntime | AgentAction.Host | import("../../src/QuotaPolicy.vibe").QuotaClassifier | import("@smthrs/harness/Sandbox").Sandbox | import("../../src/SeatResolver.js").SeatResolver | import("@smthrs/harness/Steering").Source>;
