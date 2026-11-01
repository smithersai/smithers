/**
 * Classify a support ticket, retrieve knowledge, draft a reply, and escalate only risky or uncertain tickets.
 *
 * Port of the 0.x `support-deflector.jsx`. A classifier agent labels the
 * ticket's category, sentiment, confidence and risk; a retrieval agent finds
 * articles for it; a drafting agent writes the reply. The ticket is escalated
 * when the classifier asks to, the risk is high, its confidence is under 60,
 * article coverage is under 40, or draft confidence is under 50. An escalated
 * ticket goes to an escalation agent and settles `escalated`; any other settles
 * `deflected` with no further model call.
 *
 * 0.x's `outcome-*` tasks were static values, so here they are pure `Node.map`s.
 * 0.x's prompts were placeholders that printed their props; these are minimal prompts over the same props.
 * 0.x gave the agents `read`, `grep` and `bash` tools; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`).
 */
import * as AgentAction from "@smthrs/agent/AgentAction";
import { Flow } from "@smthrs/flow";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
/** The classifier's labels. */
export declare const Classification: Schema.Struct<{
    readonly category: Schema.Literals<readonly ["billing", "bug", "how-to", "account", "feature-request", "outage"]>;
    readonly sentiment: Schema.Literals<readonly ["positive", "neutral", "frustrated", "angry"]>;
    readonly confidence: Schema.Number;
    readonly riskLevel: Schema.Literals<readonly ["low", "medium", "high"]>;
    readonly escalate: Schema.Boolean;
    readonly reasoning: Schema.String;
}>;
/** The articles retrieval found, and how well they cover the ticket. */
export declare const Knowledge: Schema.Struct<{
    readonly articles: Schema.$Array<Schema.Struct<{
        readonly title: Schema.String;
        readonly relevance: Schema.Number;
        readonly snippet: Schema.String;
        readonly source: Schema.String;
    }>>;
    readonly coverageScore: Schema.Number;
}>;
/** The drafted reply. */
export declare const Draft: Schema.Struct<{
    readonly subject: Schema.String;
    readonly body: Schema.String;
    readonly tone: Schema.Literals<readonly ["empathetic", "professional", "technical"]>;
    readonly suggestedActions: Schema.$Array<Schema.String>;
    readonly confidenceInDraft: Schema.Number;
}>;
/** The package handed to a person. */
export declare const Escalation: Schema.Struct<{
    readonly reason: Schema.String;
    readonly priority: Schema.Literals<readonly ["urgent", "high", "normal"]>;
    readonly assignTo: Schema.String;
    readonly context: Schema.String;
}>;
/** What the flow settles with. */
export declare const Outcome: Schema.Struct<{
    readonly status: Schema.Literals<readonly ["deflected", "escalated"]>;
    readonly ticketId: Schema.String;
    readonly summary: Schema.String;
}>;
/** Labels the ticket. */
export declare const Classify: AgentAction.AgentAction<"examples/SupportDeflector/Classify", Schema.Struct<{
    subject: Schema.String;
    body: Schema.String;
    customer: Schema.String;
}>, Schema.Struct<{
    readonly category: Schema.Literals<readonly ["billing", "bug", "how-to", "account", "feature-request", "outage"]>;
    readonly sentiment: Schema.Literals<readonly ["positive", "neutral", "frustrated", "angry"]>;
    readonly confidence: Schema.Number;
    readonly riskLevel: Schema.Literals<readonly ["low", "medium", "high"]>;
    readonly escalate: Schema.Boolean;
    readonly reasoning: Schema.String;
}>>;
/** Finds articles for the classified ticket. */
export declare const Retrieve: AgentAction.AgentAction<"examples/SupportDeflector/Retrieve", Schema.Struct<{
    category: Schema.String;
    reasoning: Schema.String;
    subject: Schema.String;
}>, Schema.Struct<{
    readonly articles: Schema.$Array<Schema.Struct<{
        readonly title: Schema.String;
        readonly relevance: Schema.Number;
        readonly snippet: Schema.String;
        readonly source: Schema.String;
    }>>;
    readonly coverageScore: Schema.Number;
}>>;
/** Drafts the reply from the labels and the articles. */
export declare const DraftReply: AgentAction.AgentAction<"examples/SupportDeflector/DraftReply", Schema.Struct<{
    category: Schema.String;
    sentiment: Schema.String;
    articles: Schema.$Array<Schema.Struct<{
        readonly title: Schema.String;
        readonly relevance: Schema.Number;
        readonly snippet: Schema.String;
        readonly source: Schema.String;
    }>>;
    subject: Schema.String;
    body: Schema.String;
}>, Schema.Struct<{
    readonly subject: Schema.String;
    readonly body: Schema.String;
    readonly tone: Schema.Literals<readonly ["empathetic", "professional", "technical"]>;
    readonly suggestedActions: Schema.$Array<Schema.String>;
    readonly confidenceInDraft: Schema.Number;
}>>;
/** Prepares the escalation package. */
export declare const Escalate: AgentAction.AgentAction<"examples/SupportDeflector/Escalate", Schema.Struct<{
    ticketId: Schema.String;
    category: Schema.String;
    riskLevel: Schema.String;
    sentiment: Schema.String;
    reasoning: Schema.String;
    draftConfidence: Schema.Number;
    coverageScore: Schema.Number;
}>, Schema.Struct<{
    readonly reason: Schema.String;
    readonly priority: Schema.Literals<readonly ["urgent", "high", "normal"]>;
    readonly assignTo: Schema.String;
    readonly context: Schema.String;
}>>;
/** The flow: classify, retrieve, draft, then escalate or deflect. */
export declare const SupportDeflector: Flow.Flow<"examples/SupportDeflector", Schema.Struct<{
    ticket: Schema.optional<Schema.Struct<{
        readonly id: Schema.optional<Schema.String>;
        readonly subject: Schema.optional<Schema.String>;
        readonly body: Schema.optional<Schema.String>;
        readonly customer: Schema.optional<Schema.String>;
    }>>;
}>, Schema.Struct<{
    readonly status: Schema.Literals<readonly ["deflected", "escalated"]>;
    readonly ticketId: Schema.String;
    readonly summary: Schema.String;
}>, Schema.Union<readonly [typeof import("@smthrs/harness/StructuredOutput").StructuredOutputFailure, typeof import("../../src/Seat.vibe").SeatUnresolved, typeof import("../../src/Seat.vibe").SeatUnrouted, typeof import("../../src/Budget.js").BudgetExceeded, typeof import("../../src/Budget.js").Skipped, typeof import("@smthrs/harness/HarnessError").HarnessError, typeof import("@smthrs/plugin/PluginError").PluginError]>, import("@smthrs/flow/Action").Requirement<"examples/SupportDeflector/Classify"> | import("@smthrs/flow/Action").Requirement<"examples/SupportDeflector/DraftReply"> | import("@smthrs/flow/Action").Requirement<"examples/SupportDeflector/Escalate"> | import("@smthrs/flow/Action").Requirement<"examples/SupportDeflector/Retrieve">>;
/** Every step the flow calls. */
export declare const layer: Layer.Layer<import("@smthrs/flow/Action").Requirement<"examples/SupportDeflector/Classify"> | import("@smthrs/flow/Action").Requirement<"examples/SupportDeflector/DraftReply"> | import("@smthrs/flow/Action").Requirement<"examples/SupportDeflector/Escalate"> | import("@smthrs/flow/Action").Requirement<"examples/SupportDeflector/Retrieve">, never, import("../../src/Agent.js").Agent | import("../../src/Budget.js").Budget | import("@smthrs/crypto/Crypto").Crypto | import("@smthrs/model/Evaluator").Evaluator | import("@smthrs/flow/FlowRuntime").FlowRuntime | AgentAction.Host | import("../../src/QuotaPolicy.vibe").QuotaClassifier | import("@smthrs/harness/Sandbox").Sandbox | import("../../src/SeatResolver.js").SeatResolver | import("@smthrs/harness/Steering").Source>;
