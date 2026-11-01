/**
 * Turn an issue or traceback into the smallest failing test before any fix is attempted.
 *
 * Port of the 0.x `failing-test-author.jsx`. An issue reader agent names the
 * component, the reproduction steps and the gap between expected and actual
 * behavior. A test author agent writes the smallest test that asserts the
 * expected behavior, and a run step runs it. The report marks the issue ready
 * for a fix only when the test failed; nothing in the flow attempts one.
 *
 * 0.x ran the test with an agent told to report the result; here the run is a deterministic `Action` a host implements with the repository's test runner, because the 1.0 completion brake refuses an agent's report of commands its run never recorded.
 * 0.x's `.mdx` prompts were placeholders that printed their props; the prompts here state the same props.
 * 0.x gave the agents `read`, `write` and `grep` tools; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`).
 */
import * as AgentAction from "@smthrs/agent/AgentAction";
import { Action, Flow } from "@smthrs/flow";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
/** The issue as the caller reports it. Every field is optional, as in 0.x. */
export declare const IssueReport: Schema.Struct<{
    readonly title: Schema.optional<Schema.String>;
    readonly traceback: Schema.optional<Schema.String>;
    readonly description: Schema.optional<Schema.String>;
    readonly endpoint: Schema.optional<Schema.String>;
}>;
/** What the issue reader found. */
export declare const Analysis: Schema.Struct<{
    readonly component: Schema.String;
    readonly reproSteps: Schema.$Array<Schema.String>;
    readonly expectedBehavior: Schema.String;
    readonly actualBehavior: Schema.String;
    readonly summary: Schema.String;
}>;
/** The test the author wrote. */
export declare const AuthoredTest: Schema.Struct<{
    readonly testPath: Schema.String;
    readonly testName: Schema.String;
    readonly assertion: Schema.String;
    readonly linesOfCode: Schema.Number;
    readonly summary: Schema.String;
}>;
/** What running the test showed. */
export declare const RunResult: Schema.Struct<{
    readonly testPath: Schema.String;
    readonly didFail: Schema.Boolean;
    readonly exitCode: Schema.Number;
    readonly errorOutput: Schema.String;
    readonly summary: Schema.String;
}>;
/** The handoff the flow settles with. */
export declare const Report: Schema.Struct<{
    readonly reproTestPath: Schema.String;
    readonly verified: Schema.Boolean;
    readonly readyForFix: Schema.Boolean;
    readonly summary: Schema.String;
}>;
/** Reads the issue and pins down what is broken. */
export declare const AnalyzeIssue: AgentAction.AgentAction<"examples/FailingTestAuthor/Analyze", Schema.Struct<{
    issue: Schema.Struct<{
        readonly title: Schema.optional<Schema.String>;
        readonly traceback: Schema.optional<Schema.String>;
        readonly description: Schema.optional<Schema.String>;
        readonly endpoint: Schema.optional<Schema.String>;
    }>;
}>, Schema.Struct<{
    readonly component: Schema.String;
    readonly reproSteps: Schema.$Array<Schema.String>;
    readonly expectedBehavior: Schema.String;
    readonly actualBehavior: Schema.String;
    readonly summary: Schema.String;
}>>;
/** Writes the smallest test that reproduces the bug. */
export declare const AuthorTest: AgentAction.AgentAction<"examples/FailingTestAuthor/Author", Schema.Struct<{
    component: Schema.String;
    reproSteps: Schema.$Array<Schema.String>;
    expectedBehavior: Schema.String;
    actualBehavior: Schema.String;
    testDir: Schema.String;
}>, Schema.Struct<{
    readonly testPath: Schema.String;
    readonly testName: Schema.String;
    readonly assertion: Schema.String;
    readonly linesOfCode: Schema.Number;
    readonly summary: Schema.String;
}>>;
/**
 * Runs `testCmd` on the new test file and reports whether it failed. A host
 * implements it with the repository's test runner; the tests implement it
 * with a deterministic layer.
 */
export declare const RunTest: Action.Declared<"examples/FailingTestAuthor/Run", Schema.Struct<{
    testPath: Schema.String;
    testCmd: Schema.String;
}>, Schema.Struct<{
    readonly testPath: Schema.String;
    readonly didFail: Schema.Boolean;
    readonly exitCode: Schema.Number;
    readonly errorOutput: Schema.String;
    readonly summary: Schema.String;
}>, Schema.Never, Action.Requirement<"examples/FailingTestAuthor/Run">>;
/** The flow: analyze, author, run, report. */
export declare const FailingTestAuthor: Flow.Flow<"examples/FailingTestAuthor", Schema.Struct<{
    issue: Schema.optional<Schema.Struct<{
        readonly title: Schema.optional<Schema.String>;
        readonly traceback: Schema.optional<Schema.String>;
        readonly description: Schema.optional<Schema.String>;
        readonly endpoint: Schema.optional<Schema.String>;
    }>>;
    testDir: Schema.optional<Schema.String>;
    testCmd: Schema.optional<Schema.String>;
}>, Schema.Struct<{
    readonly reproTestPath: Schema.String;
    readonly verified: Schema.Boolean;
    readonly readyForFix: Schema.Boolean;
    readonly summary: Schema.String;
}>, Schema.Union<readonly [typeof import("@smthrs/harness/StructuredOutput").StructuredOutputFailure, typeof import("../../src/Seat.vibe").SeatUnresolved, typeof import("../../src/Seat.vibe").SeatUnrouted, typeof import("../../src/Budget.js").BudgetExceeded, typeof import("../../src/Budget.js").Skipped, typeof import("@smthrs/harness/HarnessError").HarnessError, typeof import("@smthrs/plugin/PluginError").PluginError]>, Action.Requirement<"examples/FailingTestAuthor/Analyze"> | Action.Requirement<"examples/FailingTestAuthor/Author"> | Action.Requirement<"examples/FailingTestAuthor/Run">>;
/** Every agent step the flow calls. The host implements {@link RunTest}. */
export declare const layer: Layer.Layer<Action.Requirement<"examples/FailingTestAuthor/Analyze"> | Action.Requirement<"examples/FailingTestAuthor/Author">, never, import("../../src/Agent.js").Agent | import("../../src/Budget.js").Budget | import("@smthrs/crypto/Crypto").Crypto | import("@smthrs/model/Evaluator").Evaluator | import("@smthrs/flow/FlowRuntime").FlowRuntime | AgentAction.Host | import("../../src/QuotaPolicy.vibe").QuotaClassifier | import("@smthrs/harness/Sandbox").Sandbox | import("../../src/SeatResolver.js").SeatResolver | import("@smthrs/harness/Steering").Source>;
