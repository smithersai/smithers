// @ts-nocheck
/**
 * <FeedbackPulse> — Watch customer feedback streams, extract pain points and sentiment,
 * then route notable themes to Slack/Jira/reports.
 *
 * Shape: feedback intake → sentiment/theme extractor → notifier/ticketer.
 */
import { Sequence } from "smithers-orchestrator";
import { createExampleSmithers } from "./_example-kit";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { read, bash, grep } from "smithers-orchestrator/tools";
import { z } from "zod";
import IntakePrompt from "./prompts/feedback-pulse/intake.mdx";
import ExtractPrompt from "./prompts/feedback-pulse/extract.mdx";
import NotifyPrompt from "./prompts/feedback-pulse/notify.mdx";

const feedbackItemSchema = z.object({
  id: z.string(),
  source: z.enum(["support", "survey", "social", "in-app", "email", "other"]),
  text: z.string(),
  author: z.string().optional(),
  timestamp: z.string(),
});

const intakeSchema = z.object({
  items: z.array(feedbackItemSchema),
  totalCount: z.number(),
  dateRange: z.object({
    from: z.string(),
    to: z.string(),
  }),
  summary: z.string(),
});

const extractionSchema = z.object({
  sentimentBreakdown: z.object({
    positive: z.number(),
    neutral: z.number(),
    negative: z.number(),
  }),
  themes: z.array(
    z.object({
      name: z.string(),
      count: z.number(),
      sentiment: z.enum(["positive", "neutral", "negative", "mixed"]),
      representativeQuotes: z.array(z.string()),
    })
  ),
  painPoints: z.array(
    z.object({
      description: z.string(),
      severity: z.enum(["low", "medium", "high", "critical"]),
      frequency: z.number(),
      sources: z.array(z.string()),
    })
  ),
  notableInsights: z.array(z.string()),
  summary: z.string(),
});

const notificationSchema = z.object({
  slackMessages: z.array(
    z.object({
      channel: z.string(),
      message: z.string(),
      priority: z.enum(["normal", "high", "urgent"]),
    })
  ),
  jiraTickets: z.array(
    z.object({
      project: z.string(),
      issueType: z.enum(["bug", "improvement", "task"]),
      title: z.string(),
      description: z.string(),
      priority: z.enum(["low", "medium", "high", "critical"]),
      labels: z.array(z.string()),
    })
  ),
  reportSummary: z.object({
    title: z.string(),
    highlights: z.array(z.string()),
    actionItems: z.array(z.string()),
  }),
  summary: z.string(),
});

const { Workflow, Task, smithers, outputs } = createExampleSmithers({
  intake: intakeSchema,
  extraction: extractionSchema,
  notification: notificationSchema,
});

const extractorAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, bash, grep },
  instructions: `You are a customer feedback analyst. Given a batch of feedback items,
identify recurring themes and pain points, classify sentiment for each item,
and surface the most actionable insights. Be specific about severity and frequency.`,
});

const notifierAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, bash, grep },
  instructions: `You are a feedback routing specialist. Given extracted themes and pain points,
decide which deserve a Slack alert, which warrant a Jira ticket, and compose a digest
report. Critical pain points should always create urgent Slack messages and Jira tickets.`,
});

export default smithers((ctx) => {
  const intake = ctx.outputMaybe("intake", { nodeId: "intake" });
  const extraction = ctx.outputMaybe("extraction", { nodeId: "extract" });

  return (
    <Workflow name="feedback-pulse">
      <Sequence>
        {/* Stage 1: Ingest and normalize raw feedback from all sources */}
        <Task id="intake" output={outputs.intake}>
          <IntakePrompt
            feedback={ctx.input.feedback ?? []}
            sources={ctx.input.sources ?? []}
            dateRange={ctx.input.dateRange ?? {}}
          />
        </Task>

        {/* Stage 2: Extract sentiment, themes, and pain points */}
        <Task id="extract" output={outputs.extraction} agent={extractorAgent}>
          <ExtractPrompt
            items={intake?.items ?? []}
            totalCount={intake?.totalCount ?? 0}
          />
        </Task>

        {/* Stage 3: Route notable themes to Slack, Jira, and reports */}
        <Task id="notify" output={outputs.notification} agent={notifierAgent}>
          <NotifyPrompt
            themes={extraction?.themes ?? []}
            painPoints={extraction?.painPoints ?? []}
            sentimentBreakdown={extraction?.sentimentBreakdown ?? {}}
            notableInsights={extraction?.notableInsights ?? []}
          />
        </Task>
      </Sequence>
    </Workflow>
  );
});
