/**
 * Rerun a test a fixed number of times and report whether it is flaky.
 *
 * Port of the 0.x `flake-hunter.jsx`. A runner agent reruns the command
 * `runs` times (default 5), each attempt told the previous outcome. The runs
 * are packed into evidence, and only divergent evidence, some passes and some
 * failures, goes to the analyst agent. Consistent evidence gets a static
 * report with no model call.
 *
 * 0.x's `<Loop until={results.length >= maxRuns}>` always ran `maxRuns` times; here the plan unrolls exactly `runs` attempts.
 * 0.x gave the agents `bash`, `read` and `grep` tools; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`).
 */
import * as AgentAction from "@smthrs/agent/AgentAction";
import { type Action, Flow } from "@smthrs/flow";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
/** One attempt's result, as the runner reports it. */
export declare const RunResult: Schema.Struct<{
    readonly attempt: Schema.Number;
    readonly outcome: Schema.Literals<readonly ["pass", "fail"]>;
    readonly exitCode: Schema.Number;
    readonly durationMs: Schema.Number;
    readonly stdout: Schema.String;
    readonly stderr: Schema.String;
    readonly signature: Schema.String;
}>;
/** Every attempt, collated. `divergent` is true when the runs both passed and failed. */
export declare const Evidence: Schema.Struct<{
    readonly totalRuns: Schema.Number;
    readonly passes: Schema.Number;
    readonly failures: Schema.Number;
    readonly uniqueSignatures: Schema.$Array<Schema.String>;
    readonly divergent: Schema.Boolean;
    readonly runs: Schema.$Array<Schema.Struct<{
        readonly attempt: Schema.Number;
        readonly outcome: Schema.Literals<readonly ["pass", "fail"]>;
        readonly signature: Schema.String;
        readonly durationMs: Schema.Number;
    }>>;
}>;
/** The flakiness report the flow settles with. */
export declare const Report: Schema.Struct<{
    readonly classification: Schema.Literals<readonly ["flaky", "consistent-pass", "consistent-fail"]>;
    readonly confidence: Schema.Number;
    readonly flakeRate: Schema.Number;
    readonly rootCauseCandidates: Schema.$Array<Schema.String>;
    readonly recommendation: Schema.String;
    readonly summary: Schema.String;
}>;
/** One attempt: run the command and report what happened. */
export declare const RunTest: AgentAction.AgentAction<"examples/FlakeHunter/Run", Schema.Struct<{
    command: Schema.String;
    attempt: Schema.Number;
    maxRuns: Schema.Number;
    previousOutcome: Schema.String;
}>, Schema.Struct<{
    readonly attempt: Schema.Number;
    readonly outcome: Schema.Literals<readonly ["pass", "fail"]>;
    readonly exitCode: Schema.Number;
    readonly durationMs: Schema.Number;
    readonly stdout: Schema.String;
    readonly stderr: Schema.String;
    readonly signature: Schema.String;
}>>;
/** The analyst, asked only when the runs diverged. */
export declare const Analyze: AgentAction.AgentAction<"examples/FlakeHunter/Analyze", Schema.Struct<{
    command: Schema.String;
    evidence: Schema.Struct<{
        readonly totalRuns: Schema.Number;
        readonly passes: Schema.Number;
        readonly failures: Schema.Number;
        readonly uniqueSignatures: Schema.$Array<Schema.String>;
        readonly divergent: Schema.Boolean;
        readonly runs: Schema.$Array<Schema.Struct<{
            readonly attempt: Schema.Number;
            readonly outcome: Schema.Literals<readonly ["pass", "fail"]>;
            readonly signature: Schema.String;
            readonly durationMs: Schema.Number;
        }>>;
    }>;
}>, Schema.Struct<{
    readonly classification: Schema.Literals<readonly ["flaky", "consistent-pass", "consistent-fail"]>;
    readonly confidence: Schema.Number;
    readonly flakeRate: Schema.Number;
    readonly rootCauseCandidates: Schema.$Array<Schema.String>;
    readonly recommendation: Schema.String;
    readonly summary: Schema.String;
}>>;
type Requirements = Action.Requirement<"examples/FlakeHunter/Run" | "examples/FlakeHunter/Analyze">;
/** The flow. `runs` is real at plan time, so it sets how many attempts the plan holds. */
export declare const FlakeHunter: Flow.Flow<"examples/FlakeHunter", Schema.Struct<{
    command: Schema.String;
    runs: Schema.optional<Schema.Int>;
}>, Schema.Struct<{
    readonly classification: Schema.Literals<readonly ["flaky", "consistent-pass", "consistent-fail"]>;
    readonly confidence: Schema.Number;
    readonly flakeRate: Schema.Number;
    readonly rootCauseCandidates: Schema.$Array<Schema.String>;
    readonly recommendation: Schema.String;
    readonly summary: Schema.String;
}>, Schema.Union<readonly [typeof import("@smthrs/harness/StructuredOutput").StructuredOutputFailure, typeof import("../../src/Seat.vibe").SeatUnresolved, typeof import("../../src/Seat.vibe").SeatUnrouted, typeof import("../../src/Budget.js").BudgetExceeded, typeof import("../../src/Budget.js").Skipped, typeof import("@smthrs/harness/HarnessError").HarnessError, typeof import("@smthrs/plugin/PluginError").PluginError]>, Requirements>;
/** Every step the flow calls. */
export declare const layer: Layer.Layer<Action.Requirement<"examples/FlakeHunter/Analyze"> | Action.Requirement<"examples/FlakeHunter/Run">, never, import("../../src/Agent.js").Agent | import("../../src/Budget.js").Budget | import("@smthrs/crypto/Crypto").Crypto | import("@smthrs/model/Evaluator").Evaluator | import("@smthrs/flow/FlowRuntime").FlowRuntime | AgentAction.Host | import("../../src/QuotaPolicy.vibe").QuotaClassifier | import("@smthrs/harness/Sandbox").Sandbox | import("../../src/SeatResolver.js").SeatResolver | import("@smthrs/harness/Steering").Source>;
export {};
