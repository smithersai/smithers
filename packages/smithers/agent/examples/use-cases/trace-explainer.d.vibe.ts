/**
 * Read run traces and explain where time, tokens or failures accumulated.
 *
 * Port of the 0.x `trace-explainer.jsx`. An analyzer agent ingests the traces
 * at `traceFile`, else `traceDir`, else `.`, and normalizes their spans; the
 * same agent finds the bottleneck, hot path and token hogs in those spans; a
 * report step turns that analysis into an optimization report. The steps run
 * in sequence, and any failure fails the run.
 *
 * 0.x declared the report step with a prompt but no agent, so it could not produce its row; here an agent writes it, as that prompt asks.
 * 0.x's prompts were placeholders that dumped their props; these are minimal prompts over the same props.
 * 0.x gave the analyzer `read`, `grep` and `bash` tools; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`). A host can hand it a run's spans from `smthrs runs logs --format json` or the OTLP export of `10-telemetry-export.ts`.
 */
import * as AgentAction from "@smthrs/agent/AgentAction";
import { Flow } from "@smthrs/flow";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
/** One normalized span. */
export declare const Span: Schema.Struct<{
    readonly name: Schema.String;
    readonly durationMs: Schema.Number;
    readonly tokenCount: Schema.optional<Schema.Number>;
    readonly failed: Schema.Boolean;
    readonly error: Schema.optional<Schema.String>;
    readonly children: Schema.optional<Schema.$Array<Schema.String>>;
}>;
/** Every span the traces hold, with their totals. */
export declare const Ingested: Schema.Struct<{
    readonly spans: Schema.$Array<Schema.Struct<{
        readonly name: Schema.String;
        readonly durationMs: Schema.Number;
        readonly tokenCount: Schema.optional<Schema.Number>;
        readonly failed: Schema.Boolean;
        readonly error: Schema.optional<Schema.String>;
        readonly children: Schema.optional<Schema.$Array<Schema.String>>;
    }>>;
    readonly totalDurationMs: Schema.Number;
    readonly totalTokens: Schema.Number;
    readonly failedSpanCount: Schema.Number;
}>;
/** Where the trace spent its time and tokens. */
export declare const Analysis: Schema.Struct<{
    readonly bottleneck: Schema.Struct<{
        readonly spanName: Schema.String;
        readonly reason: Schema.Literals<readonly ["latency", "tokens", "failure", "retry-storm"]>;
        readonly impact: Schema.String;
    }>;
    readonly hotPath: Schema.$Array<Schema.String>;
    readonly failureSummary: Schema.NullOr<Schema.String>;
    readonly tokenHogs: Schema.$Array<Schema.Struct<{
        readonly spanName: Schema.String;
        readonly tokenCount: Schema.Number;
        readonly percentOfTotal: Schema.Number;
    }>>;
}>;
/** The optimization report the flow settles with. */
export declare const Report: Schema.Struct<{
    readonly title: Schema.String;
    readonly bottleneckExplanation: Schema.String;
    readonly optimizations: Schema.$Array<Schema.Struct<{
        readonly target: Schema.String;
        readonly suggestion: Schema.String;
        readonly estimatedSaving: Schema.String;
    }>>;
    readonly summary: Schema.String;
}>;
/** Reads the trace store and normalizes its spans. */
export declare const Ingest: AgentAction.AgentAction<"examples/TraceExplainer/Ingest", Schema.Struct<{
    source: Schema.String;
}>, Schema.Struct<{
    readonly spans: Schema.$Array<Schema.Struct<{
        readonly name: Schema.String;
        readonly durationMs: Schema.Number;
        readonly tokenCount: Schema.optional<Schema.Number>;
        readonly failed: Schema.Boolean;
        readonly error: Schema.optional<Schema.String>;
        readonly children: Schema.optional<Schema.$Array<Schema.String>>;
    }>>;
    readonly totalDurationMs: Schema.Number;
    readonly totalTokens: Schema.Number;
    readonly failedSpanCount: Schema.Number;
}>>;
/** Finds the bottleneck, hot path and token hogs. */
export declare const Analyze: AgentAction.AgentAction<"examples/TraceExplainer/Analyze", Schema.Struct<{
    spans: Schema.$Array<Schema.Struct<{
        readonly name: Schema.String;
        readonly durationMs: Schema.Number;
        readonly tokenCount: Schema.optional<Schema.Number>;
        readonly failed: Schema.Boolean;
        readonly error: Schema.optional<Schema.String>;
        readonly children: Schema.optional<Schema.$Array<Schema.String>>;
    }>>;
    totalDurationMs: Schema.Number;
    totalTokens: Schema.Number;
    failedSpanCount: Schema.Number;
}>, Schema.Struct<{
    readonly bottleneck: Schema.Struct<{
        readonly spanName: Schema.String;
        readonly reason: Schema.Literals<readonly ["latency", "tokens", "failure", "retry-storm"]>;
        readonly impact: Schema.String;
    }>;
    readonly hotPath: Schema.$Array<Schema.String>;
    readonly failureSummary: Schema.NullOr<Schema.String>;
    readonly tokenHogs: Schema.$Array<Schema.Struct<{
        readonly spanName: Schema.String;
        readonly tokenCount: Schema.Number;
        readonly percentOfTotal: Schema.Number;
    }>>;
}>>;
/** Turns the analysis into an optimization report. */
export declare const Explain: AgentAction.AgentAction<"examples/TraceExplainer/Report", Schema.Struct<{
    bottleneck: Schema.Struct<{
        readonly spanName: Schema.String;
        readonly reason: Schema.Literals<readonly ["latency", "tokens", "failure", "retry-storm"]>;
        readonly impact: Schema.String;
    }>;
    hotPath: Schema.$Array<Schema.String>;
    failureSummary: Schema.NullOr<Schema.String>;
    tokenHogs: Schema.$Array<Schema.Struct<{
        readonly spanName: Schema.String;
        readonly tokenCount: Schema.Number;
        readonly percentOfTotal: Schema.Number;
    }>>;
    totalDurationMs: Schema.Number;
    totalTokens: Schema.Number;
}>, Schema.Struct<{
    readonly title: Schema.String;
    readonly bottleneckExplanation: Schema.String;
    readonly optimizations: Schema.$Array<Schema.Struct<{
        readonly target: Schema.String;
        readonly suggestion: Schema.String;
        readonly estimatedSaving: Schema.String;
    }>>;
    readonly summary: Schema.String;
}>>;
/** The flow: ingest, analyze, report. */
export declare const TraceExplainer: Flow.Flow<"examples/TraceExplainer", Schema.Struct<{
    traceFile: Schema.optional<Schema.String>;
    traceDir: Schema.optional<Schema.String>;
}>, Schema.Struct<{
    readonly title: Schema.String;
    readonly bottleneckExplanation: Schema.String;
    readonly optimizations: Schema.$Array<Schema.Struct<{
        readonly target: Schema.String;
        readonly suggestion: Schema.String;
        readonly estimatedSaving: Schema.String;
    }>>;
    readonly summary: Schema.String;
}>, Schema.Union<readonly [typeof import("@smthrs/harness/StructuredOutput").StructuredOutputFailure, typeof import("../../src/Seat.vibe").SeatUnresolved, typeof import("../../src/Seat.vibe").SeatUnrouted, typeof import("../../src/Budget.js").BudgetExceeded, typeof import("../../src/Budget.js").Skipped, typeof import("@smthrs/harness/HarnessError").HarnessError, typeof import("@smthrs/plugin/PluginError").PluginError]>, import("@smthrs/flow/Action").Requirement<"examples/TraceExplainer/Analyze"> | import("@smthrs/flow/Action").Requirement<"examples/TraceExplainer/Ingest"> | import("@smthrs/flow/Action").Requirement<"examples/TraceExplainer/Report">>;
/** Every step the flow calls. */
export declare const layer: Layer.Layer<import("@smthrs/flow/Action").Requirement<"examples/TraceExplainer/Analyze"> | import("@smthrs/flow/Action").Requirement<"examples/TraceExplainer/Ingest"> | import("@smthrs/flow/Action").Requirement<"examples/TraceExplainer/Report">, never, import("../../src/Agent.js").Agent | import("../../src/Budget.js").Budget | import("@smthrs/crypto/Crypto").Crypto | import("@smthrs/model/Evaluator").Evaluator | import("@smthrs/flow/FlowRuntime").FlowRuntime | AgentAction.Host | import("../../src/QuotaPolicy.vibe").QuotaClassifier | import("@smthrs/harness/Sandbox").Sandbox | import("../../src/SeatResolver.js").SeatResolver | import("@smthrs/harness/Steering").Source>;
