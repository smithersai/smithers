/**
 * Collect a team's GitHub, Linear and Slack activity in parallel and publish one update.
 *
 * Port of the 0.x `friday-bot.jsx`. A scheduler agent decides the reporting
 * period: weekly on a Friday or when forced, otherwise daily, with a lookback
 * cutoff. Three collector agents, GitHub, Linear and Slack, run in parallel
 * from that cutoff. A summarizer agent turns the three digests into a
 * headline, action items, risks and metrics, and a publisher agent delivers
 * the summary to the configured destination.
 *
 * 0.x ran on whatever schedule its host gave it and let the scheduler agent pick the period; the port keeps that, so a weekly start is the host's trigger, not this flow's.
 * 0.x's `.mdx` prompts were placeholders that printed their props; the prompts here state the same props.
 * 0.x gave the agents `bash`, `read` and `grep` tools; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`).
 */
import * as AgentAction from "@smthrs/agent/AgentAction";
import { Flow } from "@smthrs/flow";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
/** The reporting period. */
export declare const ScheduleContext: Schema.Struct<{
    readonly periodLabel: Schema.String;
    readonly isWeekly: Schema.Boolean;
    readonly cutoffISO: Schema.String;
}>;
/** GitHub activity since the cutoff. */
export declare const GithubDigest: Schema.Struct<{
    readonly mergedPRs: Schema.Number;
    readonly openPRs: Schema.Number;
    readonly notableCommits: Schema.$Array<Schema.String>;
    readonly stalePRs: Schema.$Array<Schema.Struct<{
        readonly number: Schema.Number;
        readonly title: Schema.String;
        readonly author: Schema.String;
    }>>;
}>;
/** Linear activity since the cutoff. */
export declare const LinearDigest: Schema.Struct<{
    readonly completedIssues: Schema.Number;
    readonly inProgressIssues: Schema.Number;
    readonly blockedIssues: Schema.$Array<Schema.Struct<{
        readonly id: Schema.String;
        readonly title: Schema.String;
        readonly blocker: Schema.String;
    }>>;
    readonly topLabels: Schema.$Array<Schema.String>;
}>;
/** Slack activity since the cutoff. */
export declare const SlackDigest: Schema.Struct<{
    readonly activeThreads: Schema.Number;
    readonly topTopics: Schema.$Array<Schema.String>;
    readonly unresolvedQuestions: Schema.$Array<Schema.Struct<{
        readonly channel: Schema.String;
        readonly question: Schema.String;
    }>>;
}>;
/** The team update. */
export declare const Summary: Schema.Struct<{
    readonly headline: Schema.String;
    readonly highlights: Schema.$Array<Schema.String>;
    readonly actionItems: Schema.$Array<Schema.Struct<{
        readonly action: Schema.String;
        readonly owner: Schema.optional<Schema.String>;
        readonly priority: Schema.Literals<readonly ["high", "medium", "low"]>;
    }>>;
    readonly risks: Schema.$Array<Schema.String>;
    readonly metrics: Schema.Struct<{
        readonly prsShipped: Schema.Number;
        readonly issuesClosed: Schema.Number;
        readonly blockers: Schema.Number;
    }>;
}>;
/** Where the update went. The flow settles with it. */
export declare const PublishResult: Schema.Struct<{
    readonly destination: Schema.String;
    readonly messageId: Schema.optional<Schema.String>;
    readonly success: Schema.Boolean;
}>;
/** Decides the reporting period. */
export declare const Schedule: AgentAction.AgentAction<"examples/FridayBot/Schedule", Schema.Struct<{
    timezone: Schema.String;
    forceWeekly: Schema.Boolean;
}>, Schema.Struct<{
    readonly periodLabel: Schema.String;
    readonly isWeekly: Schema.Boolean;
    readonly cutoffISO: Schema.String;
}>>;
/** Collects GitHub activity. */
export declare const CollectGithub: AgentAction.AgentAction<"examples/FridayBot/CollectGithub", Schema.Struct<{
    cutoff: Schema.String;
    periodLabel: Schema.String;
    repo: Schema.String;
}>, Schema.Struct<{
    readonly mergedPRs: Schema.Number;
    readonly openPRs: Schema.Number;
    readonly notableCommits: Schema.$Array<Schema.String>;
    readonly stalePRs: Schema.$Array<Schema.Struct<{
        readonly number: Schema.Number;
        readonly title: Schema.String;
        readonly author: Schema.String;
    }>>;
}>>;
/** Collects Linear activity. */
export declare const CollectLinear: AgentAction.AgentAction<"examples/FridayBot/CollectLinear", Schema.Struct<{
    cutoff: Schema.String;
    periodLabel: Schema.String;
    teamId: Schema.String;
}>, Schema.Struct<{
    readonly completedIssues: Schema.Number;
    readonly inProgressIssues: Schema.Number;
    readonly blockedIssues: Schema.$Array<Schema.Struct<{
        readonly id: Schema.String;
        readonly title: Schema.String;
        readonly blocker: Schema.String;
    }>>;
    readonly topLabels: Schema.$Array<Schema.String>;
}>>;
/** Collects Slack activity. */
export declare const CollectSlack: AgentAction.AgentAction<"examples/FridayBot/CollectSlack", Schema.Struct<{
    cutoff: Schema.String;
    periodLabel: Schema.String;
    channels: Schema.$Array<Schema.String>;
}>, Schema.Struct<{
    readonly activeThreads: Schema.Number;
    readonly topTopics: Schema.$Array<Schema.String>;
    readonly unresolvedQuestions: Schema.$Array<Schema.Struct<{
        readonly channel: Schema.String;
        readonly question: Schema.String;
    }>>;
}>>;
/** Turns the three digests into the update. */
export declare const Summarize: AgentAction.AgentAction<"examples/FridayBot/Summarize", Schema.Struct<{
    periodLabel: Schema.String;
    isWeekly: Schema.Boolean;
    github: Schema.Struct<{
        readonly mergedPRs: Schema.Number;
        readonly openPRs: Schema.Number;
        readonly notableCommits: Schema.$Array<Schema.String>;
        readonly stalePRs: Schema.$Array<Schema.Struct<{
            readonly number: Schema.Number;
            readonly title: Schema.String;
            readonly author: Schema.String;
        }>>;
    }>;
    linear: Schema.Struct<{
        readonly completedIssues: Schema.Number;
        readonly inProgressIssues: Schema.Number;
        readonly blockedIssues: Schema.$Array<Schema.Struct<{
            readonly id: Schema.String;
            readonly title: Schema.String;
            readonly blocker: Schema.String;
        }>>;
        readonly topLabels: Schema.$Array<Schema.String>;
    }>;
    slack: Schema.Struct<{
        readonly activeThreads: Schema.Number;
        readonly topTopics: Schema.$Array<Schema.String>;
        readonly unresolvedQuestions: Schema.$Array<Schema.Struct<{
            readonly channel: Schema.String;
            readonly question: Schema.String;
        }>>;
    }>;
}>, Schema.Struct<{
    readonly headline: Schema.String;
    readonly highlights: Schema.$Array<Schema.String>;
    readonly actionItems: Schema.$Array<Schema.Struct<{
        readonly action: Schema.String;
        readonly owner: Schema.optional<Schema.String>;
        readonly priority: Schema.Literals<readonly ["high", "medium", "low"]>;
    }>>;
    readonly risks: Schema.$Array<Schema.String>;
    readonly metrics: Schema.Struct<{
        readonly prsShipped: Schema.Number;
        readonly issuesClosed: Schema.Number;
        readonly blockers: Schema.Number;
    }>;
}>>;
/** Delivers the update. */
export declare const Publish: AgentAction.AgentAction<"examples/FridayBot/Publish", Schema.Struct<{
    destination: Schema.String;
    channel: Schema.String;
    summary: Schema.Struct<{
        readonly headline: Schema.String;
        readonly highlights: Schema.$Array<Schema.String>;
        readonly actionItems: Schema.$Array<Schema.Struct<{
            readonly action: Schema.String;
            readonly owner: Schema.optional<Schema.String>;
            readonly priority: Schema.Literals<readonly ["high", "medium", "low"]>;
        }>>;
        readonly risks: Schema.$Array<Schema.String>;
        readonly metrics: Schema.Struct<{
            readonly prsShipped: Schema.Number;
            readonly issuesClosed: Schema.Number;
            readonly blockers: Schema.Number;
        }>;
    }>;
}>, Schema.Struct<{
    readonly destination: Schema.String;
    readonly messageId: Schema.optional<Schema.String>;
    readonly success: Schema.Boolean;
}>>;
/** The flow: schedule, collect in parallel, summarize, publish. */
export declare const FridayBot: Flow.Flow<"examples/FridayBot", Schema.Struct<{
    timezone: Schema.optional<Schema.String>;
    forceWeekly: Schema.optional<Schema.Boolean>;
    repo: Schema.optional<Schema.String>;
    linearTeamId: Schema.optional<Schema.String>;
    slackChannels: Schema.optional<Schema.$Array<Schema.String>>;
    publishTo: Schema.optional<Schema.String>;
    slackChannel: Schema.optional<Schema.String>;
}>, Schema.Struct<{
    readonly destination: Schema.String;
    readonly messageId: Schema.optional<Schema.String>;
    readonly success: Schema.Boolean;
}>, Schema.Union<readonly [typeof import("@smthrs/harness/StructuredOutput").StructuredOutputFailure, typeof import("../../src/Seat.vibe").SeatUnresolved, typeof import("../../src/Seat.vibe").SeatUnrouted, typeof import("../../src/Budget.js").BudgetExceeded, typeof import("../../src/Budget.js").Skipped, typeof import("@smthrs/harness/HarnessError").HarnessError, typeof import("@smthrs/plugin/PluginError").PluginError]>, import("@smthrs/flow/Action").Requirement<"examples/FridayBot/CollectGithub"> | import("@smthrs/flow/Action").Requirement<"examples/FridayBot/CollectLinear"> | import("@smthrs/flow/Action").Requirement<"examples/FridayBot/CollectSlack"> | import("@smthrs/flow/Action").Requirement<"examples/FridayBot/Publish"> | import("@smthrs/flow/Action").Requirement<"examples/FridayBot/Schedule"> | import("@smthrs/flow/Action").Requirement<"examples/FridayBot/Summarize">>;
/** Every step the flow calls. */
export declare const layer: Layer.Layer<import("@smthrs/flow/Action").Requirement<"examples/FridayBot/CollectGithub"> | import("@smthrs/flow/Action").Requirement<"examples/FridayBot/CollectLinear"> | import("@smthrs/flow/Action").Requirement<"examples/FridayBot/CollectSlack"> | import("@smthrs/flow/Action").Requirement<"examples/FridayBot/Publish"> | import("@smthrs/flow/Action").Requirement<"examples/FridayBot/Schedule"> | import("@smthrs/flow/Action").Requirement<"examples/FridayBot/Summarize">, never, import("../../src/Agent.js").Agent | import("../../src/Budget.js").Budget | import("@smthrs/crypto/Crypto").Crypto | import("@smthrs/model/Evaluator").Evaluator | import("@smthrs/flow/FlowRuntime").FlowRuntime | AgentAction.Host | import("../../src/QuotaPolicy.vibe").QuotaClassifier | import("@smthrs/harness/Sandbox").Sandbox | import("../../src/SeatResolver.js").SeatResolver | import("@smthrs/harness/Steering").Source>;
