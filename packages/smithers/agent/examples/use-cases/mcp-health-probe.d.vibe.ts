/**
 * Probe MCP servers each round and report only while availability or capabilities change materially.
 *
 * Port of the 0.x `mcp-health-probe.jsx`. Each round a scheduler agent rules
 * on the probe interval, a prober agent exercises every server (at most
 * `maxConcurrency` at a time, default 5) against its baseline capabilities,
 * and a checker agent compares every probe so far with the previous baseline.
 * A material change sends a reporter agent to write a report and starts the
 * next round; the first round without one ends the loop, as does
 * `maxIterations` (default 5).
 *
 * 0.x ran the probes whatever the scheduler's `shouldProbe` said, and so does this port.
 * 0.x's `<Loop until={noMaterialChange}>` is unrolled from the payload bound, and its `<Parallel maxConcurrency>` over the payload's servers is `Bounded.all`.
 * `DriftDetector` does not fit: 0.x's checker reads every probe of every round, not one capture against a fixed baseline.
 * 0.x returned no value of its own; this flow settles with the round count, the last check and every report written.
 * 0.x's prompts were placeholders that dumped their props; these are minimal prompts over the same props.
 * 0.x gave the agents `bash`, `read`, `grep` and `write` tools; in 1.0 tools, MCP servers included, are the host's registered flows (see `25-agent-tools-in-sandbox.ts`).
 */
import * as AgentAction from "@smthrs/agent/AgentAction";
import { type Action, Flow } from "@smthrs/flow";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
/** The scheduler's ruling. */
export declare const ScheduleDecision: Schema.Struct<{
    readonly shouldProbe: Schema.Boolean;
    readonly reason: Schema.String;
    readonly intervalMs: Schema.Number;
}>;
/** One server's probe. */
export declare const ProbeResult: Schema.Struct<{
    readonly server: Schema.String;
    readonly healthy: Schema.Boolean;
    readonly latencyMs: Schema.Number;
    readonly capabilities: Schema.$Array<Schema.String>;
    readonly capabilityDrift: Schema.Boolean;
    readonly driftDetails: Schema.optional<Schema.String>;
    readonly error: Schema.optional<Schema.String>;
}>;
/** The checker's verdict on every probe so far. */
export declare const Check: Schema.Struct<{
    readonly materialChange: Schema.Boolean;
    readonly unhealthyServers: Schema.$Array<Schema.String>;
    readonly driftedServers: Schema.$Array<Schema.String>;
    readonly newIssues: Schema.$Array<Schema.String>;
    readonly resolvedIssues: Schema.$Array<Schema.String>;
}>;
/** One report the reporter wrote. */
export declare const Report: Schema.Struct<{
    readonly reported: Schema.Boolean;
    readonly summary: Schema.String;
    readonly details: Schema.String;
    readonly recommendations: Schema.$Array<Schema.String>;
}>;
/** What the flow settles with. */
export declare const Outcome: Schema.Struct<{
    readonly iterations: Schema.Number;
    readonly check: Schema.Struct<{
        readonly materialChange: Schema.Boolean;
        readonly unhealthyServers: Schema.$Array<Schema.String>;
        readonly driftedServers: Schema.$Array<Schema.String>;
        readonly newIssues: Schema.$Array<Schema.String>;
        readonly resolvedIssues: Schema.$Array<Schema.String>;
    }>;
    readonly reports: Schema.$Array<Schema.Struct<{
        readonly reported: Schema.Boolean;
        readonly summary: Schema.String;
        readonly details: Schema.String;
        readonly recommendations: Schema.$Array<Schema.String>;
    }>>;
}>;
/** Rules on whether the interval has passed. */
export declare const Schedule: AgentAction.AgentAction<"examples/McpHealthProbe/Schedule", Schema.Struct<{
    intervalMs: Schema.Number;
    lastRun: Schema.optional<Schema.String>;
    iteration: Schema.Number;
}>, Schema.Struct<{
    readonly shouldProbe: Schema.Boolean;
    readonly reason: Schema.String;
    readonly intervalMs: Schema.Number;
}>>;
/** Exercises one server. */
export declare const Probe: AgentAction.AgentAction<"examples/McpHealthProbe/Probe", Schema.Struct<{
    server: Schema.String;
    baselineCapabilities: Schema.$Array<Schema.String>;
    latencyThresholdMs: Schema.Number;
}>, Schema.Struct<{
    readonly server: Schema.String;
    readonly healthy: Schema.Boolean;
    readonly latencyMs: Schema.Number;
    readonly capabilities: Schema.$Array<Schema.String>;
    readonly capabilityDrift: Schema.Boolean;
    readonly driftDetails: Schema.optional<Schema.String>;
    readonly error: Schema.optional<Schema.String>;
}>>;
/** Compares every probe so far with the previous baseline. */
export declare const CheckResults: AgentAction.AgentAction<"examples/McpHealthProbe/Check", Schema.Struct<{
    probeResults: Schema.$Array<Schema.Struct<{
        readonly server: Schema.String;
        readonly healthy: Schema.Boolean;
        readonly latencyMs: Schema.Number;
        readonly capabilities: Schema.$Array<Schema.String>;
        readonly capabilityDrift: Schema.Boolean;
        readonly driftDetails: Schema.optional<Schema.String>;
        readonly error: Schema.optional<Schema.String>;
    }>>;
    previousBaseline: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
    latencyThresholdMs: Schema.Number;
}>, Schema.Struct<{
    readonly materialChange: Schema.Boolean;
    readonly unhealthyServers: Schema.$Array<Schema.String>;
    readonly driftedServers: Schema.$Array<Schema.String>;
    readonly newIssues: Schema.$Array<Schema.String>;
    readonly resolvedIssues: Schema.$Array<Schema.String>;
}>>;
/** Writes the report for a material change. */
export declare const Reporter: AgentAction.AgentAction<"examples/McpHealthProbe/Report", Schema.Struct<{
    check: Schema.Struct<{
        readonly materialChange: Schema.Boolean;
        readonly unhealthyServers: Schema.$Array<Schema.String>;
        readonly driftedServers: Schema.$Array<Schema.String>;
        readonly newIssues: Schema.$Array<Schema.String>;
        readonly resolvedIssues: Schema.$Array<Schema.String>;
    }>;
    probeResults: Schema.$Array<Schema.Struct<{
        readonly server: Schema.String;
        readonly healthy: Schema.Boolean;
        readonly latencyMs: Schema.Number;
        readonly capabilities: Schema.$Array<Schema.String>;
        readonly capabilityDrift: Schema.Boolean;
        readonly driftDetails: Schema.optional<Schema.String>;
        readonly error: Schema.optional<Schema.String>;
    }>>;
    outputPath: Schema.String;
    notifyChannel: Schema.optional<Schema.String>;
}>, Schema.Struct<{
    readonly reported: Schema.Boolean;
    readonly summary: Schema.String;
    readonly details: Schema.String;
    readonly recommendations: Schema.$Array<Schema.String>;
}>>;
type Requirements = Action.Requirement<"examples/McpHealthProbe/Schedule" | "examples/McpHealthProbe/Probe" | "examples/McpHealthProbe/Check" | "examples/McpHealthProbe/Report">;
/** The flow. `servers` and `maxIterations` are real at plan time, so they set the plan's width and depth. */
export declare const McpHealthProbe: Flow.Flow<"examples/McpHealthProbe", Schema.Struct<{
    servers: Schema.optional<Schema.$Array<Schema.String>>;
    maxIterations: Schema.optional<Schema.Int>;
    intervalMs: Schema.optional<Schema.Number>;
    lastRun: Schema.optional<Schema.String>;
    maxConcurrency: Schema.optional<Schema.Int>;
    baselines: Schema.optional<Schema.$Record<Schema.String, Schema.$Array<Schema.String>>>;
    latencyThresholdMs: Schema.optional<Schema.Number>;
    previousBaseline: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
    outputPath: Schema.optional<Schema.String>;
    notifyChannel: Schema.optional<Schema.String>;
}>, Schema.Struct<{
    readonly iterations: Schema.Number;
    readonly check: Schema.Struct<{
        readonly materialChange: Schema.Boolean;
        readonly unhealthyServers: Schema.$Array<Schema.String>;
        readonly driftedServers: Schema.$Array<Schema.String>;
        readonly newIssues: Schema.$Array<Schema.String>;
        readonly resolvedIssues: Schema.$Array<Schema.String>;
    }>;
    readonly reports: Schema.$Array<Schema.Struct<{
        readonly reported: Schema.Boolean;
        readonly summary: Schema.String;
        readonly details: Schema.String;
        readonly recommendations: Schema.$Array<Schema.String>;
    }>>;
}>, Schema.Union<readonly [typeof import("@smthrs/harness/StructuredOutput").StructuredOutputFailure, typeof import("../../src/Seat.vibe").SeatUnresolved, typeof import("../../src/Seat.vibe").SeatUnrouted, typeof import("../../src/Budget.js").BudgetExceeded, typeof import("../../src/Budget.js").Skipped, typeof import("@smthrs/harness/HarnessError").HarnessError, typeof import("@smthrs/plugin/PluginError").PluginError]>, Requirements>;
/** Every step the flow calls. */
export declare const layer: Layer.Layer<Action.Requirement<"examples/McpHealthProbe/Check"> | Action.Requirement<"examples/McpHealthProbe/Probe"> | Action.Requirement<"examples/McpHealthProbe/Report"> | Action.Requirement<"examples/McpHealthProbe/Schedule">, never, import("../../src/Agent.js").Agent | import("../../src/Budget.js").Budget | import("@smthrs/crypto/Crypto").Crypto | import("@smthrs/model/Evaluator").Evaluator | import("@smthrs/flow/FlowRuntime").FlowRuntime | AgentAction.Host | import("../../src/QuotaPolicy.vibe").QuotaClassifier | import("@smthrs/harness/Sandbox").Sandbox | import("../../src/SeatResolver.js").SeatResolver | import("@smthrs/harness/Steering").Source>;
export {};
