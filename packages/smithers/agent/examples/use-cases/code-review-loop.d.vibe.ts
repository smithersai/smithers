/**
 * Review a directory, describe fixes, and review again until approval or three rounds.
 *
 * Port of the 0.x `code-review-loop.jsx`. Each round a reviewer agent reviews
 * the directory, told the issues the previous round raised. An approval ends
 * the loop; otherwise a fixer agent describes the fixes, and the next round
 * reviews again. A summary reports how many reviews ran.
 *
 * 0.x's `<Ralph maxIterations={3}>` is the planned recursion `17-review-loop.ts` uses. `ReviewLoop` does not fit: it has a produce step 0.x lacks, and its reviewer reads the revision, not the previous review's issues.
 * 0.x's fix prompt spelled out its JSON shape; `AgentAction` renders and enforces the output schema instead.
 * 0.x gave the agents `read`, `grep` and `bash` tools; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`).
 */
import * as AgentAction from "@smthrs/agent/AgentAction";
import { type Action, Flow } from "@smthrs/flow";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
/** How many reviews one run may spend. */
export declare const maxIterations = 3;
/** The reviewer's verdict. */
export declare const Review: Schema.Struct<{
    readonly approved: Schema.Boolean;
    readonly feedback: Schema.String;
    readonly issues: Schema.optional<Schema.$Array<Schema.String>>;
}>;
/** The fixes the fixer describes. It changes no files. */
export declare const Fix: Schema.Struct<{
    readonly filesChanged: Schema.$Array<Schema.String>;
    readonly changesSummary: Schema.String;
}>;
/** What the flow settles with. */
export declare const Output: Schema.Struct<{
    readonly finalSummary: Schema.String;
    readonly totalIterations: Schema.Number;
}>;
/** One review of the directory. */
export declare const ReviewCode: AgentAction.AgentAction<"examples/CodeReviewLoop/Review", Schema.Struct<{
    directory: Schema.String;
    focus: Schema.String;
    previousIssues: Schema.optional<Schema.$Array<Schema.String>>;
}>, Schema.Struct<{
    readonly approved: Schema.Boolean;
    readonly feedback: Schema.String;
    readonly issues: Schema.optional<Schema.$Array<Schema.String>>;
}>>;
/** Describes the fixes a rejected review asks for. */
export declare const FixCode: AgentAction.AgentAction<"examples/CodeReviewLoop/Fix", Schema.Struct<{
    directory: Schema.String;
    feedback: Schema.String;
    issues: Schema.optional<Schema.$Array<Schema.String>>;
}>, Schema.Struct<{
    readonly filesChanged: Schema.$Array<Schema.String>;
    readonly changesSummary: Schema.String;
}>>;
type Requirements = Action.Requirement<"examples/CodeReviewLoop/Review" | "examples/CodeReviewLoop/Fix">;
/** The bounded review loop. */
export declare const CodeReviewLoop: Flow.Flow<"examples/CodeReviewLoop", Schema.Struct<{
    directory: Schema.String;
    focus: Schema.String;
}>, Schema.Struct<{
    readonly finalSummary: Schema.String;
    readonly totalIterations: Schema.Number;
}>, Schema.Union<readonly [typeof import("@smthrs/harness/StructuredOutput").StructuredOutputFailure, typeof import("../../src/Seat.vibe").SeatUnresolved, typeof import("../../src/Seat.vibe").SeatUnrouted, typeof import("../../src/Budget.js").BudgetExceeded, typeof import("../../src/Budget.js").Skipped, typeof import("@smthrs/harness/HarnessError").HarnessError, typeof import("@smthrs/plugin/PluginError").PluginError]>, Requirements>;
/** Every step the flow calls. */
export declare const layer: Layer.Layer<Action.Requirement<"examples/CodeReviewLoop/Fix"> | Action.Requirement<"examples/CodeReviewLoop/Review">, never, import("../../src/Agent.js").Agent | import("../../src/Budget.js").Budget | import("@smthrs/crypto/Crypto").Crypto | import("@smthrs/model/Evaluator").Evaluator | import("@smthrs/flow/FlowRuntime").FlowRuntime | AgentAction.Host | import("../../src/QuotaPolicy.vibe").QuotaClassifier | import("@smthrs/harness/Sandbox").Sandbox | import("../../src/SeatResolver.js").SeatResolver | import("@smthrs/harness/Steering").Source>;
export {};
