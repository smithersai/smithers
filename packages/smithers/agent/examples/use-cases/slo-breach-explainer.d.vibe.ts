/**
 * Pull traces, logs and change history for a tripped SLO alarm in parallel and explain the likely causal chain.
 *
 * Port of the 0.x `slo-breach-explainer.jsx`. The alarm is the payload. Three
 * agents fetch context for its service and window at once: a trace fetcher
 * finds the bottleneck span, a log analyst counts and ranks the errors, and a
 * change investigator names the most suspicious deploy or config change. Once
 * all three answer, an incident analyst writes the incident note. Nothing
 * branches or loops.
 *
 * 0.x parsed the alarm in an agentless `trigger` step; here the payload schema validates it before any step runs.
 * 0.x's `<Parallel maxConcurrency={3}>` over three tasks is `Node.all`.
 * 0.x's prompts were placeholders that printed their props; these prompts carry the same props.
 * 0.x gave the agents `bash`, `grep` and `read` tools; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`).
 */
import * as AgentAction from "@smthrs/agent/AgentAction";
import { Flow } from "@smthrs/flow";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
/** The alarm that tripped. */
export declare const Alarm: Schema.Struct<{
    readonly service: Schema.String;
    readonly sloName: Schema.String;
    readonly threshold: Schema.String;
    readonly observed: Schema.String;
    readonly window: Schema.String;
}>;
/** What the trace fetcher found. */
export declare const TraceContext: Schema.Struct<{
    readonly topSpans: Schema.$Array<Schema.Struct<{
        readonly traceId: Schema.String;
        readonly spanName: Schema.String;
        readonly durationMs: Schema.Number;
        readonly status: Schema.Literals<readonly ["ok", "error", "timeout"]>;
        readonly attributes: Schema.$Record<Schema.String, Schema.String>;
    }>>;
    readonly bottleneck: Schema.String;
    readonly sampleTraceId: Schema.String;
}>;
/** What the log analyst found. */
export declare const LogContext: Schema.Struct<{
    readonly errorCount: Schema.Number;
    readonly topErrors: Schema.$Array<Schema.Struct<{
        readonly message: Schema.String;
        readonly count: Schema.Number;
        readonly firstSeen: Schema.String;
        readonly lastSeen: Schema.String;
    }>>;
    readonly anomalies: Schema.$Array<Schema.String>;
}>;
/** What the change investigator found. */
export declare const ChangeContext: Schema.Struct<{
    readonly recentDeploys: Schema.$Array<Schema.Struct<{
        readonly version: Schema.String;
        readonly deployedAt: Schema.String;
        readonly author: Schema.String;
        readonly description: Schema.String;
    }>>;
    readonly configChanges: Schema.$Array<Schema.Struct<{
        readonly key: Schema.String;
        readonly oldValue: Schema.String;
        readonly newValue: Schema.String;
        readonly changedAt: Schema.String;
    }>>;
    readonly suspectChange: Schema.String;
}>;
/** The incident note the flow settles with. */
export declare const IncidentNote: Schema.Struct<{
    readonly title: Schema.String;
    readonly severity: Schema.Literals<readonly ["critical", "high", "medium", "low"]>;
    readonly causalChain: Schema.$Array<Schema.String>;
    readonly rootCause: Schema.String;
    readonly impactSummary: Schema.String;
    readonly mitigation: Schema.String;
    readonly followUps: Schema.$Array<Schema.String>;
    readonly summary: Schema.String;
}>;
/** Finds the slowest and most error-prone spans in the breach window. */
export declare const FetchTraces: AgentAction.AgentAction<"examples/SloBreachExplainer/Traces", Schema.Struct<{
    service: Schema.String;
    window: Schema.String;
    sloName: Schema.String;
}>, Schema.Struct<{
    readonly topSpans: Schema.$Array<Schema.Struct<{
        readonly traceId: Schema.String;
        readonly spanName: Schema.String;
        readonly durationMs: Schema.Number;
        readonly status: Schema.Literals<readonly ["ok", "error", "timeout"]>;
        readonly attributes: Schema.$Record<Schema.String, Schema.String>;
    }>>;
    readonly bottleneck: Schema.String;
    readonly sampleTraceId: Schema.String;
}>>;
/** Counts and ranks the service's errors in the breach window. */
export declare const FetchLogs: AgentAction.AgentAction<"examples/SloBreachExplainer/Logs", Schema.Struct<{
    service: Schema.String;
    window: Schema.String;
    observed: Schema.String;
}>, Schema.Struct<{
    readonly errorCount: Schema.Number;
    readonly topErrors: Schema.$Array<Schema.Struct<{
        readonly message: Schema.String;
        readonly count: Schema.Number;
        readonly firstSeen: Schema.String;
        readonly lastSeen: Schema.String;
    }>>;
    readonly anomalies: Schema.$Array<Schema.String>;
}>>;
/** Looks up deploys, config changes and flag flips around the breach. */
export declare const FetchChanges: AgentAction.AgentAction<"examples/SloBreachExplainer/Changes", Schema.Struct<{
    service: Schema.String;
    window: Schema.String;
}>, Schema.Struct<{
    readonly recentDeploys: Schema.$Array<Schema.Struct<{
        readonly version: Schema.String;
        readonly deployedAt: Schema.String;
        readonly author: Schema.String;
        readonly description: Schema.String;
    }>>;
    readonly configChanges: Schema.$Array<Schema.Struct<{
        readonly key: Schema.String;
        readonly oldValue: Schema.String;
        readonly newValue: Schema.String;
        readonly changedAt: Schema.String;
    }>>;
    readonly suspectChange: Schema.String;
}>>;
/** Weaves the three contexts into an incident note. */
export declare const Synthesize: AgentAction.AgentAction<"examples/SloBreachExplainer/Synthesis", Schema.Struct<{
    alarm: Schema.Struct<{
        readonly service: Schema.String;
        readonly sloName: Schema.String;
        readonly threshold: Schema.String;
        readonly observed: Schema.String;
        readonly window: Schema.String;
    }>;
    traces: Schema.Struct<{
        readonly topSpans: Schema.$Array<Schema.Struct<{
            readonly traceId: Schema.String;
            readonly spanName: Schema.String;
            readonly durationMs: Schema.Number;
            readonly status: Schema.Literals<readonly ["ok", "error", "timeout"]>;
            readonly attributes: Schema.$Record<Schema.String, Schema.String>;
        }>>;
        readonly bottleneck: Schema.String;
        readonly sampleTraceId: Schema.String;
    }>;
    logs: Schema.Struct<{
        readonly errorCount: Schema.Number;
        readonly topErrors: Schema.$Array<Schema.Struct<{
            readonly message: Schema.String;
            readonly count: Schema.Number;
            readonly firstSeen: Schema.String;
            readonly lastSeen: Schema.String;
        }>>;
        readonly anomalies: Schema.$Array<Schema.String>;
    }>;
    changes: Schema.Struct<{
        readonly recentDeploys: Schema.$Array<Schema.Struct<{
            readonly version: Schema.String;
            readonly deployedAt: Schema.String;
            readonly author: Schema.String;
            readonly description: Schema.String;
        }>>;
        readonly configChanges: Schema.$Array<Schema.Struct<{
            readonly key: Schema.String;
            readonly oldValue: Schema.String;
            readonly newValue: Schema.String;
            readonly changedAt: Schema.String;
        }>>;
        readonly suspectChange: Schema.String;
    }>;
}>, Schema.Struct<{
    readonly title: Schema.String;
    readonly severity: Schema.Literals<readonly ["critical", "high", "medium", "low"]>;
    readonly causalChain: Schema.$Array<Schema.String>;
    readonly rootCause: Schema.String;
    readonly impactSummary: Schema.String;
    readonly mitigation: Schema.String;
    readonly followUps: Schema.$Array<Schema.String>;
    readonly summary: Schema.String;
}>>;
/** The flow: fetch the three contexts at once, then explain. */
export declare const SloBreachExplainer: Flow.Flow<"examples/SloBreachExplainer", Schema.Struct<{
    readonly service: Schema.String;
    readonly sloName: Schema.String;
    readonly threshold: Schema.String;
    readonly observed: Schema.String;
    readonly window: Schema.String;
}>, Schema.Struct<{
    readonly title: Schema.String;
    readonly severity: Schema.Literals<readonly ["critical", "high", "medium", "low"]>;
    readonly causalChain: Schema.$Array<Schema.String>;
    readonly rootCause: Schema.String;
    readonly impactSummary: Schema.String;
    readonly mitigation: Schema.String;
    readonly followUps: Schema.$Array<Schema.String>;
    readonly summary: Schema.String;
}>, Schema.Union<readonly [typeof import("@smthrs/harness/StructuredOutput").StructuredOutputFailure, typeof import("../../src/Seat.vibe").SeatUnresolved, typeof import("../../src/Seat.vibe").SeatUnrouted, typeof import("../../src/Budget.js").BudgetExceeded, typeof import("../../src/Budget.js").Skipped, typeof import("@smthrs/harness/HarnessError").HarnessError, typeof import("@smthrs/plugin/PluginError").PluginError]>, import("@smthrs/flow/Action").Requirement<"examples/SloBreachExplainer/Changes"> | import("@smthrs/flow/Action").Requirement<"examples/SloBreachExplainer/Logs"> | import("@smthrs/flow/Action").Requirement<"examples/SloBreachExplainer/Synthesis"> | import("@smthrs/flow/Action").Requirement<"examples/SloBreachExplainer/Traces">>;
/** Every step the flow calls. */
export declare const layer: Layer.Layer<import("@smthrs/flow/Action").Requirement<"examples/SloBreachExplainer/Changes"> | import("@smthrs/flow/Action").Requirement<"examples/SloBreachExplainer/Logs"> | import("@smthrs/flow/Action").Requirement<"examples/SloBreachExplainer/Synthesis"> | import("@smthrs/flow/Action").Requirement<"examples/SloBreachExplainer/Traces">, never, import("../../src/Agent.js").Agent | import("../../src/Budget.js").Budget | import("@smthrs/crypto/Crypto").Crypto | import("@smthrs/model/Evaluator").Evaluator | import("@smthrs/flow/FlowRuntime").FlowRuntime | AgentAction.Host | import("../../src/QuotaPolicy.vibe").QuotaClassifier | import("@smthrs/harness/Sandbox").Sandbox | import("../../src/SeatResolver.js").SeatResolver | import("@smthrs/harness/Steering").Source>;
