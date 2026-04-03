// @ts-nocheck
/**
 * <FridayBot> — Run on a schedule, gather context from systems, and produce
 * a structured weekly/daily summary or action list.
 *
 * Shape: scheduler → data collectors → summarizer → message sink.
 */
import { Sequence, Parallel } from "smithers-orchestrator";
import { createExampleSmithers } from "./_example-kit";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { read, bash, grep } from "smithers-orchestrator/tools";
import { z } from "zod";
import SchedulePrompt from "./prompts/friday-bot/schedule.mdx";
import CollectGithubPrompt from "./prompts/friday-bot/collect-github.mdx";
import CollectLinearPrompt from "./prompts/friday-bot/collect-linear.mdx";
import CollectSlackPrompt from "./prompts/friday-bot/collect-slack.mdx";
import SummarizePrompt from "./prompts/friday-bot/summarize.mdx";
import PublishPrompt from "./prompts/friday-bot/publish.mdx";

/* ── Zod schemas ─────────────────────────────────────────────────────── */

const scheduleContextSchema = z.object({
  periodLabel: z.string().describe("e.g. 'Week of 2026-03-23' or '2026-03-28'"),
  isWeekly: z.boolean(),
  cutoffISO: z.string().describe("ISO-8601 timestamp for the lookback window"),
});

const githubDigestSchema = z.object({
  mergedPRs: z.number(),
  openPRs: z.number(),
  notableCommits: z.array(z.string()),
  stalePRs: z.array(
    z.object({ number: z.number(), title: z.string(), author: z.string() })
  ),
});

const linearDigestSchema = z.object({
  completedIssues: z.number(),
  inProgressIssues: z.number(),
  blockedIssues: z.array(
    z.object({ id: z.string(), title: z.string(), blocker: z.string() })
  ),
  topLabels: z.array(z.string()),
});

const slackDigestSchema = z.object({
  activeThreads: z.number(),
  topTopics: z.array(z.string()),
  unresolvedQuestions: z.array(
    z.object({ channel: z.string(), question: z.string() })
  ),
});

const summarySchema = z.object({
  headline: z.string().describe("One-sentence team status"),
  highlights: z.array(z.string()),
  actionItems: z.array(
    z.object({
      action: z.string(),
      owner: z.string().optional(),
      priority: z.enum(["high", "medium", "low"]),
    })
  ),
  risks: z.array(z.string()),
  metrics: z.object({
    prsShipped: z.number(),
    issuesClosed: z.number(),
    blockers: z.number(),
  }),
});

const publishResultSchema = z.object({
  destination: z.string(),
  messageId: z.string().optional(),
  success: z.boolean(),
});

/* ── Smithers setup ──────────────────────────────────────────────────── */

const { Workflow, Task, smithers, outputs } = createExampleSmithers({
  scheduleContext: scheduleContextSchema,
  githubDigest: githubDigestSchema,
  linearDigest: linearDigestSchema,
  slackDigest: slackDigestSchema,
  summary: summarySchema,
  publishResult: publishResultSchema,
});

/* ── Agents ───────────────────────────────────────────────────────────── */

const scheduler = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { bash },
  instructions: `You determine the current reporting period. Figure out if today
is Friday (weekly) or another day (daily) and compute the lookback cutoff.`,
});

const githubCollector = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { bash, read, grep },
  instructions: `You collect GitHub activity for the reporting period. Use the
GitHub CLI (gh) or API to gather merged PRs, open PRs, notable commits, and
stale PRs. Be precise with counts.`,
});

const linearCollector = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { bash, grep },
  instructions: `You collect Linear project-tracking data for the reporting period.
Gather completed issues, in-progress work, blockers, and top labels.`,
});

const slackCollector = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { bash, grep },
  instructions: `You collect Slack activity highlights. Identify active threads,
trending topics, and unresolved questions from key channels.`,
});

const summarizer = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read },
  instructions: `You synthesize data from GitHub, Linear, and Slack into a concise
team digest. Prioritize actionable insights — blockers, risks, and wins. Keep
the headline punchy and the action items specific.`,
});

const publisher = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { bash, grep },
  instructions: `You publish the final summary to the configured destination
(Slack channel, email, Notion page, etc.). Confirm delivery and return
the message ID if available.`,
});

/* ── Workflow ──────────────────────────────────────────────────────────── */

export default smithers((ctx) => {
  const schedule = ctx.outputMaybe("scheduleContext", { nodeId: "schedule" });
  const github = ctx.outputMaybe("githubDigest", { nodeId: "collect-github" });
  const linear = ctx.outputMaybe("linearDigest", { nodeId: "collect-linear" });
  const slack = ctx.outputMaybe("slackDigest", { nodeId: "collect-slack" });
  const summary = ctx.outputMaybe("summary", { nodeId: "summarize" });

  return (
    <Workflow name="friday-bot">
      <Sequence>
        {/* Stage 1: Determine reporting period */}
        <Task id="schedule" output={outputs.scheduleContext} agent={scheduler}>
          <SchedulePrompt
            timezone={ctx.input.timezone ?? "America/Los_Angeles"}
            forceWeekly={ctx.input.forceWeekly ?? false}
          />
        </Task>

        {/* Stage 2: Collect data from systems in parallel */}
        <Parallel maxConcurrency={3}>
          <Task id="collect-github" output={outputs.githubDigest} agent={githubCollector}>
            <CollectGithubPrompt
              repo={ctx.input.repo ?? ""}
              cutoff={schedule?.cutoffISO ?? ""}
              periodLabel={schedule?.periodLabel ?? ""}
            />
          </Task>

          <Task id="collect-linear" output={outputs.linearDigest} agent={linearCollector}>
            <CollectLinearPrompt
              teamId={ctx.input.linearTeamId ?? ""}
              cutoff={schedule?.cutoffISO ?? ""}
              periodLabel={schedule?.periodLabel ?? ""}
            />
          </Task>

          <Task id="collect-slack" output={outputs.slackDigest} agent={slackCollector}>
            <CollectSlackPrompt
              channels={ctx.input.slackChannels ?? []}
              cutoff={schedule?.cutoffISO ?? ""}
              periodLabel={schedule?.periodLabel ?? ""}
            />
          </Task>
        </Parallel>

        {/* Stage 3: Summarize all collected data */}
        <Task id="summarize" output={outputs.summary} agent={summarizer}>
          <SummarizePrompt
            periodLabel={schedule?.periodLabel ?? ""}
            isWeekly={schedule?.isWeekly ?? false}
            github={github}
            linear={linear}
            slack={slack}
          />
        </Task>

        {/* Stage 4: Publish to message sink */}
        <Task id="publish" output={outputs.publishResult} agent={publisher}>
          <PublishPrompt
            destination={ctx.input.publishTo ?? "slack"}
            channel={ctx.input.slackChannel ?? "#team-updates"}
            summary={summary}
          />
        </Task>
      </Sequence>
    </Workflow>
  );
});
