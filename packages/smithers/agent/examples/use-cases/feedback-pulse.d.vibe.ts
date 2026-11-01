/**
 * Normalize a feedback batch, extract its themes and pain points, and draft alerts for the notable ones.
 *
 * Port of the 0.x `feedback-pulse.jsx`. Three steps run in sequence: an intake
 * step normalizes the raw feedback into items, an analyst agent extracts
 * sentiment, themes and pain points from them, and a routing agent drafts the
 * Slack messages, Jira tickets and digest report the notable ones deserve. The
 * drafts are the output; nothing is posted. There is no branch or loop.
 *
 * 0.x's `intake` task had a prompt but no agent, so it settled with the prompt element and only passed under mocks; here it is an agent step over the same props.
 * 0.x's prompts were placeholders that printed their props; these are minimal prompts over the same props.
 * 0.x gave the agents `read`, `bash` and `grep` tools; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`).
 */
import * as AgentAction from "@smthrs/agent/AgentAction";
import { Flow } from "@smthrs/flow";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
/** One normalized piece of feedback. */
export declare const FeedbackItem: Schema.Struct<{
    readonly id: Schema.String;
    readonly source: Schema.Literals<readonly ["support", "survey", "social", "in-app", "email", "other"]>;
    readonly text: Schema.String;
    readonly author: Schema.optional<Schema.String>;
    readonly timestamp: Schema.String;
}>;
/** The normalized batch. */
export declare const Intake: Schema.Struct<{
    readonly items: Schema.$Array<Schema.Struct<{
        readonly id: Schema.String;
        readonly source: Schema.Literals<readonly ["support", "survey", "social", "in-app", "email", "other"]>;
        readonly text: Schema.String;
        readonly author: Schema.optional<Schema.String>;
        readonly timestamp: Schema.String;
    }>>;
    readonly totalCount: Schema.Number;
    readonly dateRange: Schema.Struct<{
        readonly from: Schema.String;
        readonly to: Schema.String;
    }>;
    readonly summary: Schema.String;
}>;
/** What the analyst extracted. */
export declare const Extraction: Schema.Struct<{
    readonly sentimentBreakdown: Schema.Struct<{
        readonly positive: Schema.Number;
        readonly neutral: Schema.Number;
        readonly negative: Schema.Number;
    }>;
    readonly themes: Schema.$Array<Schema.Struct<{
        readonly name: Schema.String;
        readonly count: Schema.Number;
        readonly sentiment: Schema.Literals<readonly ["positive", "neutral", "negative", "mixed"]>;
        readonly representativeQuotes: Schema.$Array<Schema.String>;
    }>>;
    readonly painPoints: Schema.$Array<Schema.Struct<{
        readonly description: Schema.String;
        readonly severity: Schema.Literals<readonly ["low", "medium", "high", "critical"]>;
        readonly frequency: Schema.Number;
        readonly sources: Schema.$Array<Schema.String>;
    }>>;
    readonly notableInsights: Schema.$Array<Schema.String>;
    readonly summary: Schema.String;
}>;
/** The drafted alerts, tickets and digest the flow settles with. */
export declare const Notification: Schema.Struct<{
    readonly slackMessages: Schema.$Array<Schema.Struct<{
        readonly channel: Schema.String;
        readonly message: Schema.String;
        readonly priority: Schema.Literals<readonly ["normal", "high", "urgent"]>;
    }>>;
    readonly jiraTickets: Schema.$Array<Schema.Struct<{
        readonly project: Schema.String;
        readonly issueType: Schema.Literals<readonly ["bug", "improvement", "task"]>;
        readonly title: Schema.String;
        readonly description: Schema.String;
        readonly priority: Schema.Literals<readonly ["low", "medium", "high", "critical"]>;
        readonly labels: Schema.$Array<Schema.String>;
    }>>;
    readonly reportSummary: Schema.Struct<{
        readonly title: Schema.String;
        readonly highlights: Schema.$Array<Schema.String>;
        readonly actionItems: Schema.$Array<Schema.String>;
    }>;
    readonly summary: Schema.String;
}>;
/** Normalizes the raw feedback into items. */
export declare const NormalizeFeedback: AgentAction.AgentAction<"examples/FeedbackPulse/Intake", Schema.Struct<{
    feedback: Schema.$Array<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
    sources: Schema.$Array<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
    dateRange: Schema.Codec<Schema.Json, Schema.Json, never, never>;
}>, Schema.Struct<{
    readonly items: Schema.$Array<Schema.Struct<{
        readonly id: Schema.String;
        readonly source: Schema.Literals<readonly ["support", "survey", "social", "in-app", "email", "other"]>;
        readonly text: Schema.String;
        readonly author: Schema.optional<Schema.String>;
        readonly timestamp: Schema.String;
    }>>;
    readonly totalCount: Schema.Number;
    readonly dateRange: Schema.Struct<{
        readonly from: Schema.String;
        readonly to: Schema.String;
    }>;
    readonly summary: Schema.String;
}>>;
/** Extracts sentiment, themes and pain points. */
export declare const ExtractThemes: AgentAction.AgentAction<"examples/FeedbackPulse/Extract", Schema.Struct<{
    items: Schema.$Array<Schema.Struct<{
        readonly id: Schema.String;
        readonly source: Schema.Literals<readonly ["support", "survey", "social", "in-app", "email", "other"]>;
        readonly text: Schema.String;
        readonly author: Schema.optional<Schema.String>;
        readonly timestamp: Schema.String;
    }>>;
    totalCount: Schema.Number;
}>, Schema.Struct<{
    readonly sentimentBreakdown: Schema.Struct<{
        readonly positive: Schema.Number;
        readonly neutral: Schema.Number;
        readonly negative: Schema.Number;
    }>;
    readonly themes: Schema.$Array<Schema.Struct<{
        readonly name: Schema.String;
        readonly count: Schema.Number;
        readonly sentiment: Schema.Literals<readonly ["positive", "neutral", "negative", "mixed"]>;
        readonly representativeQuotes: Schema.$Array<Schema.String>;
    }>>;
    readonly painPoints: Schema.$Array<Schema.Struct<{
        readonly description: Schema.String;
        readonly severity: Schema.Literals<readonly ["low", "medium", "high", "critical"]>;
        readonly frequency: Schema.Number;
        readonly sources: Schema.$Array<Schema.String>;
    }>>;
    readonly notableInsights: Schema.$Array<Schema.String>;
    readonly summary: Schema.String;
}>>;
/** Drafts the Slack messages, Jira tickets and digest. */
export declare const DraftNotifications: AgentAction.AgentAction<"examples/FeedbackPulse/Notify", Schema.Struct<{
    themes: Schema.$Array<Schema.Struct<{
        readonly name: Schema.String;
        readonly count: Schema.Number;
        readonly sentiment: Schema.Literals<readonly ["positive", "neutral", "negative", "mixed"]>;
        readonly representativeQuotes: Schema.$Array<Schema.String>;
    }>>;
    painPoints: Schema.$Array<Schema.Struct<{
        readonly description: Schema.String;
        readonly severity: Schema.Literals<readonly ["low", "medium", "high", "critical"]>;
        readonly frequency: Schema.Number;
        readonly sources: Schema.$Array<Schema.String>;
    }>>;
    sentimentBreakdown: Schema.Struct<{
        readonly positive: Schema.Number;
        readonly neutral: Schema.Number;
        readonly negative: Schema.Number;
    }>;
    notableInsights: Schema.$Array<Schema.String>;
}>, Schema.Struct<{
    readonly slackMessages: Schema.$Array<Schema.Struct<{
        readonly channel: Schema.String;
        readonly message: Schema.String;
        readonly priority: Schema.Literals<readonly ["normal", "high", "urgent"]>;
    }>>;
    readonly jiraTickets: Schema.$Array<Schema.Struct<{
        readonly project: Schema.String;
        readonly issueType: Schema.Literals<readonly ["bug", "improvement", "task"]>;
        readonly title: Schema.String;
        readonly description: Schema.String;
        readonly priority: Schema.Literals<readonly ["low", "medium", "high", "critical"]>;
        readonly labels: Schema.$Array<Schema.String>;
    }>>;
    readonly reportSummary: Schema.Struct<{
        readonly title: Schema.String;
        readonly highlights: Schema.$Array<Schema.String>;
        readonly actionItems: Schema.$Array<Schema.String>;
    }>;
    readonly summary: Schema.String;
}>>;
/** The flow: intake, extract, notify. */
export declare const FeedbackPulse: Flow.Flow<"examples/FeedbackPulse", Schema.Struct<{
    feedback: Schema.optional<Schema.$Array<Schema.Codec<Schema.Json, Schema.Json, never, never>>>;
    sources: Schema.optional<Schema.$Array<Schema.Codec<Schema.Json, Schema.Json, never, never>>>;
    dateRange: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
}>, Schema.Struct<{
    readonly slackMessages: Schema.$Array<Schema.Struct<{
        readonly channel: Schema.String;
        readonly message: Schema.String;
        readonly priority: Schema.Literals<readonly ["normal", "high", "urgent"]>;
    }>>;
    readonly jiraTickets: Schema.$Array<Schema.Struct<{
        readonly project: Schema.String;
        readonly issueType: Schema.Literals<readonly ["bug", "improvement", "task"]>;
        readonly title: Schema.String;
        readonly description: Schema.String;
        readonly priority: Schema.Literals<readonly ["low", "medium", "high", "critical"]>;
        readonly labels: Schema.$Array<Schema.String>;
    }>>;
    readonly reportSummary: Schema.Struct<{
        readonly title: Schema.String;
        readonly highlights: Schema.$Array<Schema.String>;
        readonly actionItems: Schema.$Array<Schema.String>;
    }>;
    readonly summary: Schema.String;
}>, Schema.Union<readonly [typeof import("@smthrs/harness/StructuredOutput").StructuredOutputFailure, typeof import("../../src/Seat.vibe").SeatUnresolved, typeof import("../../src/Seat.vibe").SeatUnrouted, typeof import("../../src/Budget.js").BudgetExceeded, typeof import("../../src/Budget.js").Skipped, typeof import("@smthrs/harness/HarnessError").HarnessError, typeof import("@smthrs/plugin/PluginError").PluginError]>, import("@smthrs/flow/Action").Requirement<"examples/FeedbackPulse/Extract"> | import("@smthrs/flow/Action").Requirement<"examples/FeedbackPulse/Intake"> | import("@smthrs/flow/Action").Requirement<"examples/FeedbackPulse/Notify">>;
/** Every step the flow calls. */
export declare const layer: Layer.Layer<import("@smthrs/flow/Action").Requirement<"examples/FeedbackPulse/Extract"> | import("@smthrs/flow/Action").Requirement<"examples/FeedbackPulse/Intake"> | import("@smthrs/flow/Action").Requirement<"examples/FeedbackPulse/Notify">, never, import("../../src/Agent.js").Agent | import("../../src/Budget.js").Budget | import("@smthrs/crypto/Crypto").Crypto | import("@smthrs/model/Evaluator").Evaluator | import("@smthrs/flow/FlowRuntime").FlowRuntime | AgentAction.Host | import("../../src/QuotaPolicy.vibe").QuotaClassifier | import("@smthrs/harness/Sandbox").Sandbox | import("../../src/SeatResolver.js").SeatResolver | import("@smthrs/harness/Steering").Source>;
