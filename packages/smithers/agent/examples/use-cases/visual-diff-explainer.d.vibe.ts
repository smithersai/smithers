/**
 * Run the visual tests, pair each failure's screenshots, explain what changed, and report.
 *
 * Port of the 0.x `visual-diff-explainer.jsx`. Four agents run in sequence: a
 * runner executes the visual suite and lists the failed tests with their
 * baseline and current screenshot paths, a collector pairs and encodes each
 * failure's images, a vision analyst explains every pair in one call, and a
 * reporter ranks the findings by severity. There is no branch: a run with no
 * failures still asks every step.
 *
 * 0.x's prompts were placeholders that printed their props; these prompts state the same props.
 * 0.x gave the agents `bash`, `read` and `write` tools and the reporter wrote `outputFile`; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`), so the report carries its markdown.
 */
import * as AgentAction from "@smthrs/agent/AgentAction";
import { Flow } from "@smthrs/flow";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
/** The failed visual tests the runner found. */
export declare const FailedTests: Schema.Struct<{
    readonly tests: Schema.$Array<Schema.Struct<{
        readonly name: Schema.String;
        readonly suite: Schema.String;
        readonly baselinePath: Schema.String;
        readonly currentPath: Schema.String;
        readonly diffPercentage: Schema.Number;
    }>>;
    readonly totalFailed: Schema.Number;
    readonly runner: Schema.String;
}>;
/** Each failure's screenshots, encoded. */
export declare const ImagePairs: Schema.Struct<{
    readonly pairs: Schema.$Array<Schema.Struct<{
        readonly testName: Schema.String;
        readonly suite: Schema.String;
        readonly baselineImage: Schema.String;
        readonly currentImage: Schema.String;
        readonly diffPercentage: Schema.Number;
        readonly viewport: Schema.optional<Schema.String>;
    }>>;
}>;
/** What changed in each pair, and why. */
export declare const Analysis: Schema.Struct<{
    readonly findings: Schema.$Array<Schema.Struct<{
        readonly testName: Schema.String;
        readonly changedRegion: Schema.String;
        readonly changeType: Schema.Literals<readonly ["layout-shift", "color-change", "content-change", "visibility-toggle", "spacing", "typography", "z-index", "other"]>;
        readonly likelyCause: Schema.String;
        readonly severity: Schema.Literals<readonly ["critical", "major", "minor", "cosmetic"]>;
        readonly affectedComponents: Schema.$Array<Schema.String>;
        readonly summary: Schema.String;
    }>>;
}>;
/** The regression report the flow settles with. */
export declare const Report: Schema.Struct<{
    readonly title: Schema.String;
    readonly totalRegressions: Schema.Number;
    readonly criticalCount: Schema.Number;
    readonly findings: Schema.$Array<Schema.Struct<{
        readonly testName: Schema.String;
        readonly changedRegion: Schema.String;
        readonly changeType: Schema.String;
        readonly likelyCause: Schema.String;
        readonly severity: Schema.String;
        readonly summary: Schema.String;
    }>>;
    readonly recommendation: Schema.String;
    readonly markdown: Schema.String;
}>;
/** Runs the visual suite and lists its failures. */
export declare const RunTests: AgentAction.AgentAction<"examples/VisualDiffExplainer/RunTests", Schema.Struct<{
    testCommand: Schema.String;
    baselineDir: Schema.String;
    currentDir: Schema.String;
}>, Schema.Struct<{
    readonly tests: Schema.$Array<Schema.Struct<{
        readonly name: Schema.String;
        readonly suite: Schema.String;
        readonly baselinePath: Schema.String;
        readonly currentPath: Schema.String;
        readonly diffPercentage: Schema.Number;
    }>>;
    readonly totalFailed: Schema.Number;
    readonly runner: Schema.String;
}>>;
/** Pairs and encodes each failure's screenshots. */
export declare const CollectPairs: AgentAction.AgentAction<"examples/VisualDiffExplainer/CollectPairs", Schema.Struct<{
    tests: Schema.$Array<Schema.Struct<{
        readonly name: Schema.String;
        readonly suite: Schema.String;
        readonly baselinePath: Schema.String;
        readonly currentPath: Schema.String;
        readonly diffPercentage: Schema.Number;
    }>>;
    totalFailed: Schema.Number;
}>, Schema.Struct<{
    readonly pairs: Schema.$Array<Schema.Struct<{
        readonly testName: Schema.String;
        readonly suite: Schema.String;
        readonly baselineImage: Schema.String;
        readonly currentImage: Schema.String;
        readonly diffPercentage: Schema.Number;
        readonly viewport: Schema.optional<Schema.String>;
    }>>;
}>>;
/** Explains every pair in one call. */
export declare const AnalyzeDiff: AgentAction.AgentAction<"examples/VisualDiffExplainer/AnalyzeDiff", Schema.Struct<{
    pairs: Schema.$Array<Schema.Struct<{
        readonly testName: Schema.String;
        readonly suite: Schema.String;
        readonly baselineImage: Schema.String;
        readonly currentImage: Schema.String;
        readonly diffPercentage: Schema.Number;
        readonly viewport: Schema.optional<Schema.String>;
    }>>;
}>, Schema.Struct<{
    readonly findings: Schema.$Array<Schema.Struct<{
        readonly testName: Schema.String;
        readonly changedRegion: Schema.String;
        readonly changeType: Schema.Literals<readonly ["layout-shift", "color-change", "content-change", "visibility-toggle", "spacing", "typography", "z-index", "other"]>;
        readonly likelyCause: Schema.String;
        readonly severity: Schema.Literals<readonly ["critical", "major", "minor", "cosmetic"]>;
        readonly affectedComponents: Schema.$Array<Schema.String>;
        readonly summary: Schema.String;
    }>>;
}>>;
/** Writes the regression report. */
export declare const WriteReport: AgentAction.AgentAction<"examples/VisualDiffExplainer/Report", Schema.Struct<{
    findings: Schema.$Array<Schema.Struct<{
        readonly testName: Schema.String;
        readonly changedRegion: Schema.String;
        readonly changeType: Schema.Literals<readonly ["layout-shift", "color-change", "content-change", "visibility-toggle", "spacing", "typography", "z-index", "other"]>;
        readonly likelyCause: Schema.String;
        readonly severity: Schema.Literals<readonly ["critical", "major", "minor", "cosmetic"]>;
        readonly affectedComponents: Schema.$Array<Schema.String>;
        readonly summary: Schema.String;
    }>>;
    outputFile: Schema.String;
    repository: Schema.String;
}>, Schema.Struct<{
    readonly title: Schema.String;
    readonly totalRegressions: Schema.Number;
    readonly criticalCount: Schema.Number;
    readonly findings: Schema.$Array<Schema.Struct<{
        readonly testName: Schema.String;
        readonly changedRegion: Schema.String;
        readonly changeType: Schema.String;
        readonly likelyCause: Schema.String;
        readonly severity: Schema.String;
        readonly summary: Schema.String;
    }>>;
    readonly recommendation: Schema.String;
    readonly markdown: Schema.String;
}>>;
/** The pipeline: run, collect, analyze, report. */
export declare const VisualDiffExplainer: Flow.Flow<"examples/VisualDiffExplainer", Schema.Struct<{
    testCommand: Schema.optional<Schema.String>;
    baselineDir: Schema.optional<Schema.String>;
    currentDir: Schema.optional<Schema.String>;
    outputFile: Schema.optional<Schema.String>;
    repository: Schema.optional<Schema.String>;
}>, Schema.Struct<{
    readonly title: Schema.String;
    readonly totalRegressions: Schema.Number;
    readonly criticalCount: Schema.Number;
    readonly findings: Schema.$Array<Schema.Struct<{
        readonly testName: Schema.String;
        readonly changedRegion: Schema.String;
        readonly changeType: Schema.String;
        readonly likelyCause: Schema.String;
        readonly severity: Schema.String;
        readonly summary: Schema.String;
    }>>;
    readonly recommendation: Schema.String;
    readonly markdown: Schema.String;
}>, Schema.Union<readonly [typeof import("@smthrs/harness/StructuredOutput").StructuredOutputFailure, typeof import("../../src/Seat.vibe").SeatUnresolved, typeof import("../../src/Seat.vibe").SeatUnrouted, typeof import("../../src/Budget.js").BudgetExceeded, typeof import("../../src/Budget.js").Skipped, typeof import("@smthrs/harness/HarnessError").HarnessError, typeof import("@smthrs/plugin/PluginError").PluginError]>, import("@smthrs/flow/Action").Requirement<"examples/VisualDiffExplainer/AnalyzeDiff"> | import("@smthrs/flow/Action").Requirement<"examples/VisualDiffExplainer/CollectPairs"> | import("@smthrs/flow/Action").Requirement<"examples/VisualDiffExplainer/Report"> | import("@smthrs/flow/Action").Requirement<"examples/VisualDiffExplainer/RunTests">>;
/** Every step the flow calls. */
export declare const layer: Layer.Layer<import("@smthrs/flow/Action").Requirement<"examples/VisualDiffExplainer/AnalyzeDiff"> | import("@smthrs/flow/Action").Requirement<"examples/VisualDiffExplainer/CollectPairs"> | import("@smthrs/flow/Action").Requirement<"examples/VisualDiffExplainer/Report"> | import("@smthrs/flow/Action").Requirement<"examples/VisualDiffExplainer/RunTests">, never, import("../../src/Agent.js").Agent | import("../../src/Budget.js").Budget | import("@smthrs/crypto/Crypto").Crypto | import("@smthrs/model/Evaluator").Evaluator | import("@smthrs/flow/FlowRuntime").FlowRuntime | AgentAction.Host | import("../../src/QuotaPolicy.vibe").QuotaClassifier | import("@smthrs/harness/Sandbox").Sandbox | import("../../src/SeatResolver.js").SeatResolver | import("@smthrs/harness/Steering").Source>;
