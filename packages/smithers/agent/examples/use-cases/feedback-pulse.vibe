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
import * as AgentAction from "@smthrs/agent/AgentAction"
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import type * as Planned from "@smthrs/plan/Planned"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const seat = "anthropic:claude-sonnet-5-5"

const Severity = Schema.Literals(["low", "medium", "high", "critical"])

/** One normalized piece of feedback. */
export const FeedbackItem = Schema.Struct({
  id: Schema.String,
  source: Schema.Literals(["support", "survey", "social", "in-app", "email", "other"]),
  text: Schema.String,
  author: Schema.optional(Schema.String),
  timestamp: Schema.String
})

/** The normalized batch. */
export const Intake = Schema.Struct({
  items: Schema.Array(FeedbackItem),
  totalCount: Schema.Number,
  dateRange: Schema.Struct({ from: Schema.String, to: Schema.String }),
  summary: Schema.String
})

const SentimentBreakdown = Schema.Struct({ positive: Schema.Number, neutral: Schema.Number, negative: Schema.Number })

const Theme = Schema.Struct({
  name: Schema.String,
  count: Schema.Number,
  sentiment: Schema.Literals(["positive", "neutral", "negative", "mixed"]),
  representativeQuotes: Schema.Array(Schema.String)
})

const PainPoint = Schema.Struct({
  description: Schema.String,
  severity: Severity,
  frequency: Schema.Number,
  sources: Schema.Array(Schema.String)
})

/** What the analyst extracted. */
export const Extraction = Schema.Struct({
  sentimentBreakdown: SentimentBreakdown,
  themes: Schema.Array(Theme),
  painPoints: Schema.Array(PainPoint),
  notableInsights: Schema.Array(Schema.String),
  summary: Schema.String
})

/** The drafted alerts, tickets and digest the flow settles with. */
export const Notification = Schema.Struct({
  slackMessages: Schema.Array(Schema.Struct({
    channel: Schema.String,
    message: Schema.String,
    priority: Schema.Literals(["normal", "high", "urgent"])
  })),
  jiraTickets: Schema.Array(Schema.Struct({
    project: Schema.String,
    issueType: Schema.Literals(["bug", "improvement", "task"]),
    title: Schema.String,
    description: Schema.String,
    priority: Severity,
    labels: Schema.Array(Schema.String)
  })),
  reportSummary: Schema.Struct({
    title: Schema.String,
    highlights: Schema.Array(Schema.String),
    actionItems: Schema.Array(Schema.String)
  }),
  summary: Schema.String
})

/** Normalizes the raw feedback into items. */
export const NormalizeFeedback = AgentAction.make("examples/FeedbackPulse/Intake", {
  payload: { feedback: Schema.Array(Schema.Json), sources: Schema.Array(Schema.Json), dateRange: Schema.Json },
  output: Intake,
  seat,
  prompt: ({ dateRange, feedback, sources }) =>
    `Normalize this raw customer feedback into feedback items.\n\nFeedback: ${JSON.stringify(feedback)}\nSources: ${
      JSON.stringify(sources)
    }\nDate range: ${JSON.stringify(dateRange)}`
})

/** Extracts sentiment, themes and pain points. */
export const ExtractThemes = AgentAction.make("examples/FeedbackPulse/Extract", {
  payload: { items: Schema.Array(FeedbackItem), totalCount: Schema.Number },
  output: Extraction,
  seat,
  system: [
    `You are a customer feedback analyst. Given a batch of feedback items,
identify recurring themes and pain points, classify sentiment for each item,
and surface the most actionable insights. Be specific about severity and frequency.`
  ],
  prompt: ({ items, totalCount }) =>
    `Extract the themes and pain points in this feedback.\n\nTotal count: ${totalCount}\nItems: ${
      JSON.stringify(items)
    }`
})

/** Drafts the Slack messages, Jira tickets and digest. */
export const DraftNotifications = AgentAction.make("examples/FeedbackPulse/Notify", {
  payload: {
    themes: Schema.Array(Theme),
    painPoints: Schema.Array(PainPoint),
    sentimentBreakdown: SentimentBreakdown,
    notableInsights: Schema.Array(Schema.String)
  },
  output: Notification,
  seat,
  system: [
    `You are a feedback routing specialist. Given extracted themes and pain points,
decide which deserve a Slack alert, which warrant a Jira ticket, and compose a digest
report. Critical pain points should always create urgent Slack messages and Jira tickets.`
  ],
  prompt: ({ notableInsights, painPoints, sentimentBreakdown, themes }) =>
    `Route these feedback findings.\n\nThemes: ${JSON.stringify(themes)}\nPain points: ${
      JSON.stringify(painPoints)
    }\nSentiment: ${JSON.stringify(sentimentBreakdown)}\nNotable insights: ${JSON.stringify(notableInsights)}`
})

/** The flow: intake, extract, notify. */
export const FeedbackPulse = Flow.make("examples/FeedbackPulse", {
  payload: {
    feedback: Schema.optional(Schema.Array(Schema.Json)),
    sources: Schema.optional(Schema.Array(Schema.Json)),
    dateRange: Schema.optional(Schema.Json)
  },
  success: Notification,
  error: AgentAction.AgentFailure,
  body: ({ dateRange = {}, feedback = [], sources = [] }) =>
    Node.bindPlanned(
      NormalizeFeedback.call({ feedback, sources, dateRange }),
      (intake: Planned.Planned<typeof Intake.Type>) =>
        Node.bindPlanned(
          ExtractThemes.call({ items: intake.items, totalCount: intake.totalCount }),
          (extraction: Planned.Planned<typeof Extraction.Type>) =>
            DraftNotifications.call({
              themes: extraction.themes,
              painPoints: extraction.painPoints,
              sentimentBreakdown: extraction.sentimentBreakdown,
              notableInsights: extraction.notableInsights
            })
        )
    )
})

/** Every step the flow calls. */
export const layer = Layer.mergeAll(NormalizeFeedback.layer, ExtractThemes.layer, DraftNotifications.layer)
