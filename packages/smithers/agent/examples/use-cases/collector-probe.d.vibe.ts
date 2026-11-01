/**
 * Probe an agent endpoint, aggregate its timing, cost and quality, and report while those drift.
 *
 * Port of the 0.x `collector-probe.jsx`. Each round an agent invokes the
 * endpoint and records the call's telemetry, a collector agent aggregates
 * every call so far, and an anomaly agent compares the aggregates with the
 * baselines. The loop goes on while drift persists and stops at the first
 * round without it or after `maxIterations` (default 5); a static report then
 * counts drift events and lists the alerts.
 *
 * 0.x declared the invocation step with a prompt but no agent, so it could not produce its row; here an agent makes the call and reports its telemetry, as that prompt asks.
 * 0.x's `<Loop until={noMoreDrift} maxIterations>` is unrolled from the payload bound, as in `flake-hunter`. `Sidecar` and `DriftDetector` do not fit: 0.x runs no shadow call, and each round compares running aggregates rather than one capture.
 * 0.x's prompts were placeholders that dumped their props; these are minimal prompts over the same props.
 * 0.x gave the agents `read`, `bash` and `grep` tools; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`).
 */
import * as AgentAction from "@smthrs/agent/AgentAction";
import { type Action, Flow } from "@smthrs/flow";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
/** The values drift is measured against. */
export declare const Baselines: Schema.Struct<{
    readonly quality: Schema.Number;
    readonly costUsd: Schema.Number;
    readonly latencyMs: Schema.Number;
}>;
/** The telemetry of one probed call. */
export declare const Invocation: Schema.Struct<{
    readonly callId: Schema.String;
    readonly model: Schema.String;
    readonly inputTokens: Schema.Number;
    readonly outputTokens: Schema.Number;
    readonly latencyMs: Schema.Number;
    readonly costUsd: Schema.Number;
    readonly qualityScore: Schema.Number;
    readonly timestamp: Schema.String;
    readonly metadata: Schema.optional<Schema.$Record<Schema.String, Schema.String>>;
}>;
/** Running statistics over every call so far. */
export declare const Aggregates: Schema.Struct<{
    readonly meanLatencyMs: Schema.Number;
    readonly p95LatencyMs: Schema.Number;
    readonly meanCostUsd: Schema.Number;
    readonly meanQuality: Schema.Number;
    readonly totalInvocations: Schema.Number;
}>;
/** The collector's aggregation. */
export declare const Collection: Schema.Struct<{
    readonly samples: Schema.$Array<Schema.Struct<{
        readonly callId: Schema.String;
        readonly latencyMs: Schema.Number;
        readonly costUsd: Schema.Number;
        readonly qualityScore: Schema.Number;
    }>>;
    readonly aggregates: Schema.Struct<{
        readonly meanLatencyMs: Schema.Number;
        readonly p95LatencyMs: Schema.Number;
        readonly meanCostUsd: Schema.Number;
        readonly meanQuality: Schema.Number;
        readonly totalInvocations: Schema.Number;
    }>;
    readonly summary: Schema.String;
}>;
/** The anomaly detector's verdict on one round. */
export declare const Anomaly: Schema.Struct<{
    readonly driftDetected: Schema.Boolean;
    readonly anomalies: Schema.$Array<Schema.Struct<{
        readonly metric: Schema.Literals<readonly ["quality", "cost", "latency"]>;
        readonly direction: Schema.Literals<readonly ["up", "down"]>;
        readonly deltaPercent: Schema.Number;
        readonly baselineValue: Schema.Number;
        readonly currentValue: Schema.Number;
        readonly severity: Schema.Literals<readonly ["info", "warning", "critical"]>;
    }>>;
    readonly shouldAlert: Schema.Boolean;
    readonly summary: Schema.String;
}>;
/** The report the flow settles with. */
export declare const Report: Schema.Struct<{
    readonly overallStatus: Schema.Literals<readonly ["healthy", "degraded", "critical"]>;
    readonly totalInvocations: Schema.Number;
    readonly iterationsRun: Schema.Number;
    readonly anomaliesDetected: Schema.Number;
    readonly alerts: Schema.$Array<Schema.Struct<{
        readonly metric: Schema.String;
        readonly message: Schema.String;
        readonly severity: Schema.Literals<readonly ["info", "warning", "critical"]>;
    }>>;
    readonly recommendations: Schema.$Array<Schema.String>;
    readonly summary: Schema.String;
}>;
/** Invokes the endpoint once and records the call's telemetry. */
export declare const Invoke: AgentAction.AgentAction<"examples/CollectorProbe/Invoke", Schema.Struct<{
    endpoint: Schema.String;
    payload: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
    baselines: Schema.Struct<{
        readonly quality: Schema.Number;
        readonly costUsd: Schema.Number;
        readonly latencyMs: Schema.Number;
    }>;
    iteration: Schema.Number;
}>, Schema.Struct<{
    readonly callId: Schema.String;
    readonly model: Schema.String;
    readonly inputTokens: Schema.Number;
    readonly outputTokens: Schema.Number;
    readonly latencyMs: Schema.Number;
    readonly costUsd: Schema.Number;
    readonly qualityScore: Schema.Number;
    readonly timestamp: Schema.String;
    readonly metadata: Schema.optional<Schema.$Record<Schema.String, Schema.String>>;
}>>;
/** Aggregates every call so far. */
export declare const Collect: AgentAction.AgentAction<"examples/CollectorProbe/Collect", Schema.Struct<{
    invocations: Schema.$Array<Schema.Struct<{
        readonly callId: Schema.String;
        readonly model: Schema.String;
        readonly inputTokens: Schema.Number;
        readonly outputTokens: Schema.Number;
        readonly latencyMs: Schema.Number;
        readonly costUsd: Schema.Number;
        readonly qualityScore: Schema.Number;
        readonly timestamp: Schema.String;
        readonly metadata: Schema.optional<Schema.$Record<Schema.String, Schema.String>>;
    }>>;
    previousAggregates: Schema.NullOr<Schema.Struct<{
        readonly meanLatencyMs: Schema.Number;
        readonly p95LatencyMs: Schema.Number;
        readonly meanCostUsd: Schema.Number;
        readonly meanQuality: Schema.Number;
        readonly totalInvocations: Schema.Number;
    }>>;
}>, Schema.Struct<{
    readonly samples: Schema.$Array<Schema.Struct<{
        readonly callId: Schema.String;
        readonly latencyMs: Schema.Number;
        readonly costUsd: Schema.Number;
        readonly qualityScore: Schema.Number;
    }>>;
    readonly aggregates: Schema.Struct<{
        readonly meanLatencyMs: Schema.Number;
        readonly p95LatencyMs: Schema.Number;
        readonly meanCostUsd: Schema.Number;
        readonly meanQuality: Schema.Number;
        readonly totalInvocations: Schema.Number;
    }>;
    readonly summary: Schema.String;
}>>;
/** Compares the aggregates with the baselines. */
export declare const Detect: AgentAction.AgentAction<"examples/CollectorProbe/Anomaly", Schema.Struct<{
    aggregates: Schema.Struct<{
        readonly meanLatencyMs: Schema.Number;
        readonly p95LatencyMs: Schema.Number;
        readonly meanCostUsd: Schema.Number;
        readonly meanQuality: Schema.Number;
        readonly totalInvocations: Schema.Number;
    }>;
    baselines: Schema.Struct<{
        readonly quality: Schema.Number;
        readonly costUsd: Schema.Number;
        readonly latencyMs: Schema.Number;
    }>;
    previousAnomalies: Schema.$Array<Schema.Struct<{
        readonly driftDetected: Schema.Boolean;
        readonly anomalies: Schema.$Array<Schema.Struct<{
            readonly metric: Schema.Literals<readonly ["quality", "cost", "latency"]>;
            readonly direction: Schema.Literals<readonly ["up", "down"]>;
            readonly deltaPercent: Schema.Number;
            readonly baselineValue: Schema.Number;
            readonly currentValue: Schema.Number;
            readonly severity: Schema.Literals<readonly ["info", "warning", "critical"]>;
        }>>;
        readonly shouldAlert: Schema.Boolean;
        readonly summary: Schema.String;
    }>>;
}>, Schema.Struct<{
    readonly driftDetected: Schema.Boolean;
    readonly anomalies: Schema.$Array<Schema.Struct<{
        readonly metric: Schema.Literals<readonly ["quality", "cost", "latency"]>;
        readonly direction: Schema.Literals<readonly ["up", "down"]>;
        readonly deltaPercent: Schema.Number;
        readonly baselineValue: Schema.Number;
        readonly currentValue: Schema.Number;
        readonly severity: Schema.Literals<readonly ["info", "warning", "critical"]>;
    }>>;
    readonly shouldAlert: Schema.Boolean;
    readonly summary: Schema.String;
}>>;
type Requirements = Action.Requirement<"examples/CollectorProbe/Invoke" | "examples/CollectorProbe/Collect" | "examples/CollectorProbe/Anomaly">;
/** The flow. `maxIterations` is real at plan time, so it sets how many rounds the plan holds. */
export declare const CollectorProbe: Flow.Flow<"examples/CollectorProbe", Schema.Struct<{
    endpoint: Schema.String;
    payload: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
    baselines: Schema.optional<Schema.Struct<{
        readonly quality: Schema.Number;
        readonly costUsd: Schema.Number;
        readonly latencyMs: Schema.Number;
    }>>;
    maxIterations: Schema.optional<Schema.Int>;
}>, Schema.Struct<{
    readonly overallStatus: Schema.Literals<readonly ["healthy", "degraded", "critical"]>;
    readonly totalInvocations: Schema.Number;
    readonly iterationsRun: Schema.Number;
    readonly anomaliesDetected: Schema.Number;
    readonly alerts: Schema.$Array<Schema.Struct<{
        readonly metric: Schema.String;
        readonly message: Schema.String;
        readonly severity: Schema.Literals<readonly ["info", "warning", "critical"]>;
    }>>;
    readonly recommendations: Schema.$Array<Schema.String>;
    readonly summary: Schema.String;
}>, Schema.Union<readonly [typeof import("@smthrs/harness/StructuredOutput").StructuredOutputFailure, typeof import("../../src/Seat.vibe").SeatUnresolved, typeof import("../../src/Seat.vibe").SeatUnrouted, typeof import("../../src/Budget.js").BudgetExceeded, typeof import("../../src/Budget.js").Skipped, typeof import("@smthrs/harness/HarnessError").HarnessError, typeof import("@smthrs/plugin/PluginError").PluginError]>, Requirements>;
/** Every step the flow calls. */
export declare const layer: Layer.Layer<Action.Requirement<"examples/CollectorProbe/Anomaly"> | Action.Requirement<"examples/CollectorProbe/Collect"> | Action.Requirement<"examples/CollectorProbe/Invoke">, never, import("../../src/Agent.js").Agent | import("../../src/Budget.js").Budget | import("@smthrs/crypto/Crypto").Crypto | import("@smthrs/model/Evaluator").Evaluator | import("@smthrs/flow/FlowRuntime").FlowRuntime | AgentAction.Host | import("../../src/QuotaPolicy.vibe").QuotaClassifier | import("@smthrs/harness/Sandbox").Sandbox | import("../../src/SeatResolver.js").SeatResolver | import("@smthrs/harness/Steering").Source>;
export {};
