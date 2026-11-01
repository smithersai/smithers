/**
 * Triage every open issue in a GitHub repository into a board grouped by type.
 *
 * Port of the 0.x `github-issues.jsx`. One triager agent fetches the open
 * issues with the `gh` CLI and gives each a type, a priority and up to three
 * suggested labels in a single pass. A pure step then groups the issues into
 * four columns, bug, feature, question and chore, in that order.
 *
 * 0.x's header promised three parallel triage lanes, but its code ran one agent pass; the port keeps the code's single pass. `Kanban` does not fit: it moves each item through per-column steps that 0.x never had.
 * 0.x gave the triager a `bash` tool for `gh`; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`).
 */
import * as AgentAction from "@smthrs/agent/AgentAction";
import { Flow } from "@smthrs/flow";
import * as Schema from "effect/Schema";
/** The board's columns, in the order 0.x built them. */
export declare const types: readonly ["bug", "feature", "question", "chore"];
/** One triaged issue. */
export declare const Issue: Schema.Struct<{
    readonly number: Schema.Number;
    readonly title: Schema.String;
    readonly type: Schema.Literals<readonly ["bug", "feature", "question", "chore"]>;
    readonly priority: Schema.Literals<readonly ["P0", "P1", "P2", "P3"]>;
    readonly suggestedLabels: Schema.$Array<Schema.String>;
}>;
/** The triager's answer: every open issue, triaged. */
export declare const Triaged: Schema.Struct<{
    readonly repo: Schema.String;
    readonly issues: Schema.$Array<Schema.Struct<{
        readonly number: Schema.Number;
        readonly title: Schema.String;
        readonly type: Schema.Literals<readonly ["bug", "feature", "question", "chore"]>;
        readonly priority: Schema.Literals<readonly ["P0", "P1", "P2", "P3"]>;
        readonly suggestedLabels: Schema.$Array<Schema.String>;
    }>>;
}>;
/** The board the flow settles with. */
export declare const Board: Schema.Struct<{
    readonly repo: Schema.String;
    readonly total: Schema.Number;
    readonly columns: Schema.$Array<Schema.Struct<{
        readonly name: Schema.String;
        readonly cards: Schema.$Array<Schema.Struct<{
            readonly number: Schema.Number;
            readonly title: Schema.String;
            readonly priority: Schema.String;
        }>>;
    }>>;
}>;
/** Fetches and triages every open issue in one pass. */
export declare const TriageIssues: AgentAction.AgentAction<"examples/GitHubIssues/Triage", Schema.Struct<{
    repo: Schema.String;
}>, Schema.Struct<{
    readonly repo: Schema.String;
    readonly issues: Schema.$Array<Schema.Struct<{
        readonly number: Schema.Number;
        readonly title: Schema.String;
        readonly type: Schema.Literals<readonly ["bug", "feature", "question", "chore"]>;
        readonly priority: Schema.Literals<readonly ["P0", "P1", "P2", "P3"]>;
        readonly suggestedLabels: Schema.$Array<Schema.String>;
    }>>;
}>>;
/** The flow: triage every open issue, then build the board. */
export declare const GitHubIssues: Flow.Flow<"examples/GitHubIssues", Schema.Struct<{
    repo: Schema.optional<Schema.String>;
}>, Schema.Struct<{
    readonly repo: Schema.String;
    readonly total: Schema.Number;
    readonly columns: Schema.$Array<Schema.Struct<{
        readonly name: Schema.String;
        readonly cards: Schema.$Array<Schema.Struct<{
            readonly number: Schema.Number;
            readonly title: Schema.String;
            readonly priority: Schema.String;
        }>>;
    }>>;
}>, Schema.Union<readonly [typeof import("@smthrs/harness/StructuredOutput").StructuredOutputFailure, typeof import("../../src/Seat.vibe").SeatUnresolved, typeof import("../../src/Seat.vibe").SeatUnrouted, typeof import("../../src/Budget.js").BudgetExceeded, typeof import("../../src/Budget.js").Skipped, typeof import("@smthrs/harness/HarnessError").HarnessError, typeof import("@smthrs/plugin/PluginError").PluginError]>, import("@smthrs/flow/Action").Requirement<"examples/GitHubIssues/Triage">>;
/** Every step the flow calls. */
export declare const layer: import("effect/Layer").Layer<import("@smthrs/flow/Action").Requirement<"examples/GitHubIssues/Triage">, never, import("../../src/Agent.js").Agent | import("../../src/Budget.js").Budget | import("@smthrs/crypto/Crypto").Crypto | import("@smthrs/model/Evaluator").Evaluator | import("@smthrs/flow/FlowRuntime").FlowRuntime | AgentAction.Host | import("../../src/QuotaPolicy.vibe").QuotaClassifier | import("@smthrs/harness/Sandbox").Sandbox | import("../../src/SeatResolver.js").SeatResolver | import("@smthrs/harness/Steering").Source>;
