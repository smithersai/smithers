/**
 * Retry a step within a budget, letting a policy agent decide each retry, and escalate when it gives up.
 *
 * Port of the 0.x `retry-budget-manager.jsx`. A step runner agent runs the
 * step and classifies any failure. After a failure a policy controller agent
 * decides the backoff, the budget left, any route override and whether to
 * escalate; the next attempt is told its decision and the previous error. The
 * loop stops when the step succeeds, when the policy reports no budget left or
 * asks to escalate, or after `budget` attempts (default 5). Unless the step
 * succeeded, an escalation agent assesses the run. A report counts the
 * attempts.
 *
 * 0.x's `<Loop maxIterations={budget}>` is unrolled from the payload's budget, and each policy decision branches to the next attempt or to the escalation.
 * 0.x never waited out the policy's `backoffMs`, and neither does this port.
 * The policy controller stays an agent as in 0.x: `RetryPolicy.decide` and `Escalation` would replace its judgment with a fixed ladder, and `Budget` meters model spend, not attempts.
 * 0.x's prompts were placeholders that printed their props; these are minimal prompts over the same props.
 * 0.x gave the agents `bash`, `read`, `grep` and `write` tools; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`).
 */
import * as AgentAction from "@smthrs/agent/AgentAction";
import { type Action, Flow } from "@smthrs/flow";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
/** One attempt at the step. */
export declare const StepResult: Schema.Struct<{
    readonly stepName: Schema.String;
    readonly success: Schema.Boolean;
    readonly failureClass: Schema.optional<Schema.Literals<readonly ["transient", "persistent", "quota", "timeout", "unknown"]>>;
    readonly errorMessage: Schema.optional<Schema.String>;
    readonly latencyMs: Schema.Number;
    readonly attempt: Schema.Number;
}>;
/** The policy controller's decision after a failed attempt. */
export declare const PolicyDecision: Schema.Struct<{
    readonly shouldRetry: Schema.Boolean;
    readonly backoffMs: Schema.Number;
    readonly budgetRemaining: Schema.Number;
    readonly budgetSpent: Schema.Number;
    readonly reasoning: Schema.String;
    readonly routeOverride: Schema.optional<Schema.String>;
    readonly escalate: Schema.Boolean;
}>;
/** The escalation agent's assessment. */
export declare const Escalation: Schema.Struct<{
    readonly severity: Schema.Literals<readonly ["low", "medium", "high", "critical"]>;
    readonly recommendation: Schema.Literals<readonly ["retry-with-approval", "skip-step", "abort-workflow", "fallback-route"]>;
    readonly summary: Schema.String;
    readonly budgetAnalysis: Schema.String;
    readonly failureBreakdown: Schema.$Array<Schema.Struct<{
        readonly failureClass: Schema.Literals<readonly ["transient", "persistent", "quota", "timeout", "unknown"]>;
        readonly count: Schema.Number;
        readonly percentage: Schema.Number;
    }>>;
}>;
/** The report the flow settles with. */
export declare const Report: Schema.Struct<{
    readonly totalAttempts: Schema.Number;
    readonly successfulSteps: Schema.Number;
    readonly failedSteps: Schema.Number;
    readonly budgetUsed: Schema.Number;
    readonly budgetTotal: Schema.Number;
    readonly escalated: Schema.Boolean;
    readonly summary: Schema.String;
}>;
/** Runs the step once and classifies a failure. */
export declare const RunStep: AgentAction.AgentAction<"examples/RetryBudgetManager/Step", Schema.Struct<{
    stepName: Schema.String;
    command: Schema.String;
    attempt: Schema.Number;
    budgetTotal: Schema.Number;
    budgetRemaining: Schema.Number;
    routeOverride: Schema.optional<Schema.String>;
    previousError: Schema.optional<Schema.String>;
}>, Schema.Struct<{
    readonly stepName: Schema.String;
    readonly success: Schema.Boolean;
    readonly failureClass: Schema.optional<Schema.Literals<readonly ["transient", "persistent", "quota", "timeout", "unknown"]>>;
    readonly errorMessage: Schema.optional<Schema.String>;
    readonly latencyMs: Schema.Number;
    readonly attempt: Schema.Number;
}>>;
/** Decides whether a failed attempt is worth retrying. */
export declare const DecidePolicy: AgentAction.AgentAction<"examples/RetryBudgetManager/Policy", Schema.Struct<{
    stepResult: Schema.Struct<{
        readonly stepName: Schema.String;
        readonly success: Schema.Boolean;
        readonly failureClass: Schema.optional<Schema.Literals<readonly ["transient", "persistent", "quota", "timeout", "unknown"]>>;
        readonly errorMessage: Schema.optional<Schema.String>;
        readonly latencyMs: Schema.Number;
        readonly attempt: Schema.Number;
    }>;
    attempt: Schema.Number;
    budgetTotal: Schema.Number;
    budgetSpent: Schema.Number;
    history: Schema.$Array<Schema.Struct<{
        readonly stepName: Schema.String;
        readonly success: Schema.Boolean;
        readonly failureClass: Schema.optional<Schema.Literals<readonly ["transient", "persistent", "quota", "timeout", "unknown"]>>;
        readonly errorMessage: Schema.optional<Schema.String>;
        readonly latencyMs: Schema.Number;
        readonly attempt: Schema.Number;
    }>>;
}>, Schema.Struct<{
    readonly shouldRetry: Schema.Boolean;
    readonly backoffMs: Schema.Number;
    readonly budgetRemaining: Schema.Number;
    readonly budgetSpent: Schema.Number;
    readonly reasoning: Schema.String;
    readonly routeOverride: Schema.optional<Schema.String>;
    readonly escalate: Schema.Boolean;
}>>;
/** Assesses a run that did not succeed. */
export declare const Escalate: AgentAction.AgentAction<"examples/RetryBudgetManager/Escalation", Schema.Struct<{
    stepName: Schema.String;
    stepResults: Schema.$Array<Schema.Struct<{
        readonly stepName: Schema.String;
        readonly success: Schema.Boolean;
        readonly failureClass: Schema.optional<Schema.Literals<readonly ["transient", "persistent", "quota", "timeout", "unknown"]>>;
        readonly errorMessage: Schema.optional<Schema.String>;
        readonly latencyMs: Schema.Number;
        readonly attempt: Schema.Number;
    }>>;
    policies: Schema.$Array<Schema.Struct<{
        readonly shouldRetry: Schema.Boolean;
        readonly backoffMs: Schema.Number;
        readonly budgetRemaining: Schema.Number;
        readonly budgetSpent: Schema.Number;
        readonly reasoning: Schema.String;
        readonly routeOverride: Schema.optional<Schema.String>;
        readonly escalate: Schema.Boolean;
    }>>;
    budgetTotal: Schema.Number;
    budgetUsed: Schema.Number;
}>, Schema.Struct<{
    readonly severity: Schema.Literals<readonly ["low", "medium", "high", "critical"]>;
    readonly recommendation: Schema.Literals<readonly ["retry-with-approval", "skip-step", "abort-workflow", "fallback-route"]>;
    readonly summary: Schema.String;
    readonly budgetAnalysis: Schema.String;
    readonly failureBreakdown: Schema.$Array<Schema.Struct<{
        readonly failureClass: Schema.Literals<readonly ["transient", "persistent", "quota", "timeout", "unknown"]>;
        readonly count: Schema.Number;
        readonly percentage: Schema.Number;
    }>>;
}>>;
type Requirements = Action.Requirement<"examples/RetryBudgetManager/Step" | "examples/RetryBudgetManager/Policy" | "examples/RetryBudgetManager/Escalation">;
/** The flow. `budget` is real at plan time, so it sets how many attempts the plan holds. */
export declare const RetryBudgetManager: Flow.Flow<"examples/RetryBudgetManager", Schema.Struct<{
    command: Schema.String;
    stepName: Schema.optional<Schema.String>;
    budget: Schema.optional<Schema.Int>;
}>, Schema.Struct<{
    readonly totalAttempts: Schema.Number;
    readonly successfulSteps: Schema.Number;
    readonly failedSteps: Schema.Number;
    readonly budgetUsed: Schema.Number;
    readonly budgetTotal: Schema.Number;
    readonly escalated: Schema.Boolean;
    readonly summary: Schema.String;
}>, Schema.Union<readonly [typeof import("@smthrs/harness/StructuredOutput").StructuredOutputFailure, typeof import("../../src/Seat.vibe").SeatUnresolved, typeof import("../../src/Seat.vibe").SeatUnrouted, typeof import("../../src/Budget.js").BudgetExceeded, typeof import("../../src/Budget.js").Skipped, typeof import("@smthrs/harness/HarnessError").HarnessError, typeof import("@smthrs/plugin/PluginError").PluginError]>, Requirements>;
/** Every step the flow calls. */
export declare const layer: Layer.Layer<Action.Requirement<"examples/RetryBudgetManager/Escalation"> | Action.Requirement<"examples/RetryBudgetManager/Policy"> | Action.Requirement<"examples/RetryBudgetManager/Step">, never, import("../../src/Agent.js").Agent | import("../../src/Budget.js").Budget | import("@smthrs/crypto/Crypto").Crypto | import("@smthrs/model/Evaluator").Evaluator | import("@smthrs/flow/FlowRuntime").FlowRuntime | AgentAction.Host | import("../../src/QuotaPolicy.vibe").QuotaClassifier | import("@smthrs/harness/Sandbox").Sandbox | import("../../src/SeatResolver.js").SeatResolver | import("@smthrs/harness/Steering").Source>;
export {};
