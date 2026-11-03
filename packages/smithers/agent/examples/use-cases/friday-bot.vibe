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
import * as AgentAction from "@smthrs/agent/AgentAction"
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import type * as Planned from "@smthrs/plan/Planned"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const seat = "anthropic:claude-sonnet-5-5"

/** The reporting period. */
export const ScheduleContext = Schema.Struct({
  periodLabel: Schema.String.annotate({ description: "e.g. 'Week of 2026-03-23' or '2026-03-28'" }),
  isWeekly: Schema.Boolean,
  cutoffISO: Schema.String.annotate({ description: "ISO-8601 timestamp for the lookback window" })
})

/** GitHub activity since the cutoff. */
export const GithubDigest = Schema.Struct({
  mergedPRs: Schema.Number,
  openPRs: Schema.Number,
  notableCommits: Schema.Array(Schema.String),
  stalePRs: Schema.Array(Schema.Struct({ number: Schema.Number, title: Schema.String, author: Schema.String }))
})

/** Linear activity since the cutoff. */
export const LinearDigest = Schema.Struct({
  completedIssues: Schema.Number,
  inProgressIssues: Schema.Number,
  blockedIssues: Schema.Array(Schema.Struct({ id: Schema.String, title: Schema.String, blocker: Schema.String })),
  topLabels: Schema.Array(Schema.String)
})

/** Slack activity since the cutoff. */
export const SlackDigest = Schema.Struct({
  activeThreads: Schema.Number,
  topTopics: Schema.Array(Schema.String),
  unresolvedQuestions: Schema.Array(Schema.Struct({ channel: Schema.String, question: Schema.String }))
})

/** The team update. */
export const Summary = Schema.Struct({
  headline: Schema.String.annotate({ description: "One-sentence team status" }),
  highlights: Schema.Array(Schema.String),
  actionItems: Schema.Array(Schema.Struct({
    action: Schema.String,
    owner: Schema.optional(Schema.String),
    priority: Schema.Literals(["high", "medium", "low"])
  })),
  risks: Schema.Array(Schema.String),
  metrics: Schema.Struct({ prsShipped: Schema.Number, issuesClosed: Schema.Number, blockers: Schema.Number })
})

/** Where the update went. The flow settles with it. */
export const PublishResult = Schema.Struct({
  destination: Schema.String,
  messageId: Schema.optional(Schema.String),
  success: Schema.Boolean
})

/** Collector inputs: the period the scheduler chose. */
const window = { cutoff: Schema.String, periodLabel: Schema.String }

/** Decides the reporting period. */
export const Schedule = AgentAction.make("examples/FridayBot/Schedule", {
  payload: { timezone: Schema.String, forceWeekly: Schema.Boolean },
  output: ScheduleContext,
  seat,
  system: [
    `You determine the current reporting period. Figure out if today
is Friday (weekly) or another day (daily) and compute the lookback cutoff.`
  ],
  prompt: ({ forceWeekly, timezone }) =>
    `Determine the reporting period.\n\nTimezone: ${timezone}\nForce weekly: ${forceWeekly}`
})

/** Collects GitHub activity. */
export const CollectGithub = AgentAction.make("examples/FridayBot/CollectGithub", {
  payload: { repo: Schema.String, ...window },
  output: GithubDigest,
  seat,
  system: [
    `You collect GitHub activity for the reporting period. Use the
GitHub CLI (gh) or API to gather merged PRs, open PRs, notable commits, and
stale PRs. Be precise with counts.`
  ],
  prompt: ({ cutoff, periodLabel, repo }) =>
    `Collect GitHub activity for ${periodLabel}.\n\nRepository: ${repo}\nSince: ${cutoff}`
})

/** Collects Linear activity. */
export const CollectLinear = AgentAction.make("examples/FridayBot/CollectLinear", {
  payload: { teamId: Schema.String, ...window },
  output: LinearDigest,
  seat,
  system: [
    `You collect Linear project-tracking data for the reporting period.
Gather completed issues, in-progress work, blockers, and top labels.`
  ],
  prompt: ({ cutoff, periodLabel, teamId }) =>
    `Collect Linear activity for ${periodLabel}.\n\nTeam: ${teamId}\nSince: ${cutoff}`
})

/** Collects Slack activity. */
export const CollectSlack = AgentAction.make("examples/FridayBot/CollectSlack", {
  payload: { channels: Schema.Array(Schema.String), ...window },
  output: SlackDigest,
  seat,
  system: [
    `You collect Slack activity highlights. Identify active threads,
trending topics, and unresolved questions from key channels.`
  ],
  prompt: ({ channels, cutoff, periodLabel }) =>
    `Collect Slack activity for ${periodLabel}.\n\nChannels: ${JSON.stringify(channels)}\nSince: ${cutoff}`
})

/** Turns the three digests into the update. */
export const Summarize = AgentAction.make("examples/FridayBot/Summarize", {
  payload: {
    periodLabel: Schema.String,
    isWeekly: Schema.Boolean,
    github: GithubDigest,
    linear: LinearDigest,
    slack: SlackDigest
  },
  output: Summary,
  seat,
  system: [
    `You synthesize data from GitHub, Linear, and Slack into a concise
team digest. Prioritize actionable insights — blockers, risks, and wins. Keep
the headline punchy and the action items specific.`
  ],
  prompt: ({ github, isWeekly, linear, periodLabel, slack }) =>
    `Summarize the ${isWeekly ? "weekly" : "daily"} activity for ${periodLabel}.\n\nGitHub: ${
      JSON.stringify(github)
    }\nLinear: ${JSON.stringify(linear)}\nSlack: ${JSON.stringify(slack)}`
})

/** Delivers the update. */
export const Publish = AgentAction.make("examples/FridayBot/Publish", {
  payload: { destination: Schema.String, channel: Schema.String, summary: Summary },
  output: PublishResult,
  seat,
  system: [
    `You publish the final summary to the configured destination
(Slack channel, email, Notion page, etc.). Confirm delivery and return
the message ID if available.`
  ],
  prompt: ({ channel, destination, summary }) =>
    `Publish this summary.\n\nDestination: ${destination}\nChannel: ${channel}\nSummary: ${JSON.stringify(summary)}`
})

/** The flow: schedule, collect in parallel, summarize, publish. */
export const FridayBot = Flow.make("examples/FridayBot", {
  payload: {
    timezone: Schema.optional(Schema.String),
    forceWeekly: Schema.optional(Schema.Boolean),
    repo: Schema.optional(Schema.String),
    linearTeamId: Schema.optional(Schema.String),
    slackChannels: Schema.optional(Schema.Array(Schema.String)),
    publishTo: Schema.optional(Schema.String),
    slackChannel: Schema.optional(Schema.String)
  },
  success: PublishResult,
  error: AgentAction.AgentFailure,
  body: ({
    forceWeekly = false,
    linearTeamId = "",
    publishTo = "slack",
    repo = "",
    slackChannel = "#team-updates",
    slackChannels = [],
    timezone = "America/Los_Angeles"
  }) =>
    Node.bindPlanned(
      Schedule.call({ timezone, forceWeekly }),
      (schedule: Planned.Planned<typeof ScheduleContext.Type>) => {
        const period = { cutoff: schedule.cutoffISO, periodLabel: schedule.periodLabel }
        // 0.x's `<Parallel maxConcurrency={3}>` over three collectors runs all three at once.
        const collected = Node.all({
          github: CollectGithub.call({ repo, ...period }),
          linear: CollectLinear.call({ teamId: linearTeamId, ...period }),
          slack: CollectSlack.call({ channels: slackChannels, ...period })
        })
        return Node.bindPlanned(collected, (digests) =>
          Node.bindPlanned(
            Summarize.call({
              periodLabel: schedule.periodLabel,
              isWeekly: schedule.isWeekly,
              github: digests.github,
              linear: digests.linear,
              slack: digests.slack
            }),
            (summary: Planned.Planned<typeof Summary.Type>) =>
              Publish.call({ destination: publishTo, channel: slackChannel, summary })
          ))
      }
    )
})

/** Every step the flow calls. */
export const layer = Layer.mergeAll(
  Schedule.layer,
  CollectGithub.layer,
  CollectLinear.layer,
  CollectSlack.layer,
  Summarize.layer,
  Publish.layer
)
