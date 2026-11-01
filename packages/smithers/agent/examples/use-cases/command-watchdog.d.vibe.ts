/**
 * Rerun a command and escalate only when its exit code, output or timing becomes notable.
 *
 * Port of the 0.x `command-watchdog.jsx`. Each round a runner agent runs the
 * command, told the previous round's exit code and duration, and a detector
 * agent compares that run with the one before against a duration threshold
 * (default 25%). A notable round ends the loop and a reporter agent writes the
 * escalation report; after `maxRuns` quiet rounds (default 5) the flow settles
 * with a static steady report.
 *
 * 0.x's `<Loop until={notable} maxIterations={maxRuns}>` is unrolled from the payload bound, as in `flake-hunter`.
 * `DriftDetector` does not fit: its baseline is a fixed literal, while 0.x compares each run with the run before it.
 * 0.x ran its rounds back to back with no scheduler, and so does this port; a host schedules the flow itself, for example with an `@smthrs/triggers` `Cron` trigger.
 * 0.x's prompts were placeholders that dumped their props; these are minimal prompts over the same props.
 * 0.x gave the agents `bash`, `read` and `grep` tools; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`).
 */
import * as AgentAction from "@smthrs/agent/AgentAction";
import { type Action, Flow } from "@smthrs/flow";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
/** One run of the command, as the runner reports it. */
export declare const RunResult: Schema.Struct<{
    readonly exitCode: Schema.Number;
    readonly durationMs: Schema.Number;
    readonly outputSignature: Schema.String;
    readonly stdoutTail: Schema.String;
    readonly iterationNum: Schema.Number;
}>;
/** The detector's verdict on one run. */
export declare const Notability: Schema.Struct<{
    readonly notable: Schema.Boolean;
    readonly reasons: Schema.$Array<Schema.String>;
    readonly exitCodeChanged: Schema.Boolean;
    readonly durationDeltaPercent: Schema.Number;
    readonly signatureChanged: Schema.Boolean;
    readonly diffSummary: Schema.String;
}>;
/** The report the flow settles with. */
export declare const Report: Schema.Struct<{
    readonly status: Schema.Literals<readonly ["steady", "escalated"]>;
    readonly anomalies: Schema.$Array<Schema.String>;
    readonly runCount: Schema.Number;
    readonly summary: Schema.String;
}>;
/** Runs the command once. */
export declare const RunCommand: AgentAction.AgentAction<"examples/CommandWatchdog/Run", Schema.Struct<{
    command: Schema.String;
    iteration: Schema.Number;
    previousDurationMs: Schema.optional<Schema.Number>;
    previousExitCode: Schema.optional<Schema.Number>;
}>, Schema.Struct<{
    readonly exitCode: Schema.Number;
    readonly durationMs: Schema.Number;
    readonly outputSignature: Schema.String;
    readonly stdoutTail: Schema.String;
    readonly iterationNum: Schema.Number;
}>>;
/** Compares the latest run with the one before it. */
export declare const Detect: AgentAction.AgentAction<"examples/CommandWatchdog/Detect", Schema.Struct<{
    command: Schema.String;
    iteration: Schema.Number;
    thresholdPercent: Schema.Number;
    current: Schema.Struct<{
        readonly exitCode: Schema.Number;
        readonly durationMs: Schema.Number;
        readonly outputSignature: Schema.String;
        readonly stdoutTail: Schema.String;
        readonly iterationNum: Schema.Number;
    }>;
    previous: Schema.optional<Schema.Struct<{
        readonly exitCode: Schema.Number;
        readonly durationMs: Schema.Number;
        readonly outputSignature: Schema.String;
        readonly stdoutTail: Schema.String;
        readonly iterationNum: Schema.Number;
    }>>;
}>, Schema.Struct<{
    readonly notable: Schema.Boolean;
    readonly reasons: Schema.$Array<Schema.String>;
    readonly exitCodeChanged: Schema.Boolean;
    readonly durationDeltaPercent: Schema.Number;
    readonly signatureChanged: Schema.Boolean;
    readonly diffSummary: Schema.String;
}>>;
/** Writes the escalation report once a run is notable. */
export declare const Escalate: AgentAction.AgentAction<"examples/CommandWatchdog/Report", Schema.Struct<{
    command: Schema.String;
    notable: Schema.Boolean;
    reasons: Schema.$Array<Schema.String>;
    runs: Schema.$Array<Schema.Struct<{
        readonly exitCode: Schema.Number;
        readonly durationMs: Schema.Number;
        readonly outputSignature: Schema.String;
        readonly stdoutTail: Schema.String;
        readonly iterationNum: Schema.Number;
    }>>;
    diffSummary: Schema.String;
}>, Schema.Struct<{
    readonly status: Schema.Literals<readonly ["steady", "escalated"]>;
    readonly anomalies: Schema.$Array<Schema.String>;
    readonly runCount: Schema.Number;
    readonly summary: Schema.String;
}>>;
type Requirements = Action.Requirement<"examples/CommandWatchdog/Run" | "examples/CommandWatchdog/Detect" | "examples/CommandWatchdog/Report">;
/** The flow. `maxRuns` is real at plan time, so it sets how many rounds the plan holds. */
export declare const CommandWatchdog: Flow.Flow<"examples/CommandWatchdog", Schema.Struct<{
    command: Schema.String;
    maxRuns: Schema.optional<Schema.Int>;
    thresholdPercent: Schema.optional<Schema.Number>;
}>, Schema.Struct<{
    readonly status: Schema.Literals<readonly ["steady", "escalated"]>;
    readonly anomalies: Schema.$Array<Schema.String>;
    readonly runCount: Schema.Number;
    readonly summary: Schema.String;
}>, Schema.Union<readonly [typeof import("@smthrs/harness/StructuredOutput").StructuredOutputFailure, typeof import("../../src/Seat.vibe").SeatUnresolved, typeof import("../../src/Seat.vibe").SeatUnrouted, typeof import("../../src/Budget.js").BudgetExceeded, typeof import("../../src/Budget.js").Skipped, typeof import("@smthrs/harness/HarnessError").HarnessError, typeof import("@smthrs/plugin/PluginError").PluginError]>, Requirements>;
/** Every step the flow calls. */
export declare const layer: Layer.Layer<Action.Requirement<"examples/CommandWatchdog/Detect"> | Action.Requirement<"examples/CommandWatchdog/Report"> | Action.Requirement<"examples/CommandWatchdog/Run">, never, import("../../src/Agent.js").Agent | import("../../src/Budget.js").Budget | import("@smthrs/crypto/Crypto").Crypto | import("@smthrs/model/Evaluator").Evaluator | import("@smthrs/flow/FlowRuntime").FlowRuntime | AgentAction.Host | import("../../src/QuotaPolicy.vibe").QuotaClassifier | import("@smthrs/harness/Sandbox").Sandbox | import("../../src/SeatResolver.js").SeatResolver | import("@smthrs/harness/Steering").Source>;
export {};
