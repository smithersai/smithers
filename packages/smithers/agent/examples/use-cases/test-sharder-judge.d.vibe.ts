/**
 * Pick the tests a change most likely breaks, run them in parallel shards, and judge the results.
 *
 * Port of the 0.x `test-sharder-judge.jsx`. A change analyzer agent reads the
 * diff, and a test selector agent picks the priority tests and the ones to
 * defer. A runner agent runs each priority test, four at a time by default,
 * and a failing or timed-out runner drops only its own result. An adjudicator
 * agent reads the results, the deferred tests and the risk level, and settles
 * on a verdict.
 *
 * 0.x re-rendered its tree once the selection landed; here the runners run in a `.child()` flow whose body plans over the real selection.
 * `MapReduce` does not fit: its reducer reads only the mapped rows, and 0.x's adjudicator also reads the selection's deferred tests and the analysis's risk level.
 * 0.x's prompts were placeholders that printed their props; these are minimal prompts over the same props.
 * 0.x gave the analyzer and selector `bash`, `grep` and `read` tools and the runner `bash` and `read`; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`).
 */
import * as AgentAction from "@smthrs/agent/AgentAction";
import { Flow } from "@smthrs/flow";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
/** The change analyzer's answer. */
export declare const Analysis: Schema.Struct<{
    readonly changedFiles: Schema.$Array<Schema.String>;
    readonly affectedModules: Schema.$Array<Schema.String>;
    readonly riskLevel: Schema.Literals<readonly ["low", "medium", "high"]>;
}>;
/** One test the selector wants run first. */
export declare const PriorityTest: Schema.Struct<{
    readonly file: Schema.String;
    readonly reason: Schema.String;
    readonly confidence: Schema.Number;
}>;
/** The selector's answer. */
export declare const Selection: Schema.Struct<{
    readonly priorityTests: Schema.$Array<Schema.Struct<{
        readonly file: Schema.String;
        readonly reason: Schema.String;
        readonly confidence: Schema.Number;
    }>>;
    readonly deferredTests: Schema.$Array<Schema.String>;
    readonly totalCandidates: Schema.Number;
}>;
/** What one runner reports. */
export declare const RunResult: Schema.Struct<{
    readonly testFile: Schema.String;
    readonly status: Schema.Literals<readonly ["pass", "fail", "error", "skipped"]>;
    readonly durationMs: Schema.Number;
    readonly errorMessage: Schema.optional<Schema.String>;
}>;
/** The verdict the flow settles with. */
export declare const Adjudication: Schema.Struct<{
    readonly verdict: Schema.Literals<readonly ["green", "yellow", "red"]>;
    readonly failedTests: Schema.$Array<Schema.String>;
    readonly deferredTests: Schema.$Array<Schema.String>;
    readonly shouldExpandRun: Schema.Boolean;
    readonly summary: Schema.String;
}>;
/** Reads the diff for changed files, affected modules and risk. */
export declare const AnalyzeChange: AgentAction.AgentAction<"examples/TestSharderJudge/Analyze", Schema.Struct<{
    diff: Schema.String;
    baseBranch: Schema.String;
}>, Schema.Struct<{
    readonly changedFiles: Schema.$Array<Schema.String>;
    readonly affectedModules: Schema.$Array<Schema.String>;
    readonly riskLevel: Schema.Literals<readonly ["low", "medium", "high"]>;
}>>;
/** Picks the highest-signal tests and defers the rest. */
export declare const SelectTests: AgentAction.AgentAction<"examples/TestSharderJudge/Select", Schema.Struct<{
    changedFiles: Schema.$Array<Schema.String>;
    affectedModules: Schema.$Array<Schema.String>;
    riskLevel: Schema.Literals<readonly ["low", "medium", "high"]>;
    testGlob: Schema.String;
}>, Schema.Struct<{
    readonly priorityTests: Schema.$Array<Schema.Struct<{
        readonly file: Schema.String;
        readonly reason: Schema.String;
        readonly confidence: Schema.Number;
    }>>;
    readonly deferredTests: Schema.$Array<Schema.String>;
    readonly totalCandidates: Schema.Number;
}>>;
/** Runs one test file. The run gives up after the payload's `timeoutMs`, as 0.x's task did. */
export declare const RunTest: AgentAction.AgentAction<"examples/TestSharderJudge/Run", Schema.Struct<{
    testFile: Schema.String;
    reason: Schema.String;
    runner: Schema.String;
    timeoutMs: Schema.Number;
}>, Schema.Struct<{
    readonly testFile: Schema.String;
    readonly status: Schema.Literals<readonly ["pass", "fail", "error", "skipped"]>;
    readonly durationMs: Schema.Number;
    readonly errorMessage: Schema.optional<Schema.String>;
}>>;
/** Judges the combined results. */
export declare const Adjudicate: AgentAction.AgentAction<"examples/TestSharderJudge/Adjudicate", Schema.Struct<{
    results: Schema.$Array<Schema.Struct<{
        readonly testFile: Schema.String;
        readonly status: Schema.Literals<readonly ["pass", "fail", "error", "skipped"]>;
        readonly durationMs: Schema.Number;
        readonly errorMessage: Schema.optional<Schema.String>;
    }>>;
    deferredTests: Schema.$Array<Schema.String>;
    riskLevel: Schema.Literals<readonly ["low", "medium", "high"]>;
}>, Schema.Struct<{
    readonly verdict: Schema.Literals<readonly ["green", "yellow", "red"]>;
    readonly failedTests: Schema.$Array<Schema.String>;
    readonly deferredTests: Schema.$Array<Schema.String>;
    readonly shouldExpandRun: Schema.Boolean;
    readonly summary: Schema.String;
}>>;
/**
 * Runs the selected tests. It runs as a child execution, so its payload is
 * real when its body plans, and it fans out over the tests the selector
 * actually picked.
 */
export declare const RunShards: Flow.Flow<"examples/TestSharderJudge/RunShards", Schema.Struct<{
    tests: Schema.$Array<Schema.Struct<{
        readonly file: Schema.String;
        readonly reason: Schema.String;
        readonly confidence: Schema.Number;
    }>>;
    runner: Schema.String;
    timeoutMs: Schema.Number;
    concurrency: Schema.Int;
}>, Schema.$Array<Schema.Struct<{
    readonly testFile: Schema.String;
    readonly status: Schema.Literals<readonly ["pass", "fail", "error", "skipped"]>;
    readonly durationMs: Schema.Number;
    readonly errorMessage: Schema.optional<Schema.String>;
}>>, Schema.Never, import("@smthrs/flow/Action").Requirement<"examples/TestSharderJudge/Run">>;
/** The flow: analyze, select, run the shards, adjudicate. */
export declare const TestSharderJudge: Flow.Flow<"examples/TestSharderJudge", Schema.Struct<{
    diff: Schema.String;
    baseBranch: Schema.optional<Schema.String>;
    testGlob: Schema.optional<Schema.String>;
    runner: Schema.optional<Schema.String>;
    maxConcurrency: Schema.optional<Schema.Int>;
    timeoutMs: Schema.optional<Schema.Int>;
}>, Schema.Struct<{
    readonly verdict: Schema.Literals<readonly ["green", "yellow", "red"]>;
    readonly failedTests: Schema.$Array<Schema.String>;
    readonly deferredTests: Schema.$Array<Schema.String>;
    readonly shouldExpandRun: Schema.Boolean;
    readonly summary: Schema.String;
}>, Schema.Union<readonly [typeof import("@smthrs/harness/StructuredOutput").StructuredOutputFailure, typeof import("../../src/Seat.vibe").SeatUnresolved, typeof import("../../src/Seat.vibe").SeatUnrouted, typeof import("../../src/Budget.js").BudgetExceeded, typeof import("../../src/Budget.js").Skipped, typeof import("@smthrs/harness/HarnessError").HarnessError, typeof import("@smthrs/plugin/PluginError").PluginError]>, import("@smthrs/flow/Action").Requirement<"examples/TestSharderJudge/Adjudicate"> | import("@smthrs/flow/Action").Requirement<"examples/TestSharderJudge/Analyze"> | import("@smthrs/flow/Action").Requirement<"examples/TestSharderJudge/Select">>;
/** Every step the flow calls, and the child flow it starts. */
export declare const layer: Layer.Layer<import("@smthrs/flow/Action").Requirement<"examples/TestSharderJudge/Adjudicate"> | import("@smthrs/flow/Action").Requirement<"examples/TestSharderJudge/Analyze"> | import("@smthrs/flow/Action").Requirement<"examples/TestSharderJudge/Run"> | import("@smthrs/flow/Action").Requirement<"examples/TestSharderJudge/Select">, never, import("../../src/Agent.js").Agent | import("../../src/Budget.js").Budget | import("@smthrs/crypto/Crypto").Crypto | import("@smthrs/model/Evaluator").Evaluator | import("@smthrs/flow/FlowRuntime").FlowRuntime | AgentAction.Host | import("@smthrs/flow/Action").Implementations | import("../../src/QuotaPolicy.vibe").QuotaClassifier | import("@smthrs/harness/Sandbox").Sandbox | import("../../src/SeatResolver.js").SeatResolver | import("@smthrs/harness/Steering").Source>;
