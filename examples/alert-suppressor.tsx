// @ts-nocheck
/**
 * <AlertSuppressor> — Classify incoming alerts against prior incidents and
 * known-noise rules, only escalating novel or high-risk alerts.
 *
 * Shape: alert stream → deduper/context lookup → classifier agent → page/ticket sink.
 */
import { createSmithers, Sequence, Parallel } from "smithers-orchestrator";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { bash, read, grep } from "smithers-orchestrator/tools";
import { z } from "zod";
import DedupePrompt from "./prompts/alert-suppressor/dedupe.mdx";
import ContextPrompt from "./prompts/alert-suppressor/context.mdx";
import ClassifyPrompt from "./prompts/alert-suppressor/classify.mdx";
import SinkPrompt from "./prompts/alert-suppressor/sink.mdx";

// --- Zod schemas ---

const alertSchema = z.object({
  id: z.string().describe("Unique alert identifier"),
  source: z.string().describe("Monitoring system that fired the alert"),
  severity: z.enum(["critical", "high", "medium", "low"]).describe("Raw severity from source"),
  message: z.string().describe("Alert message body"),
  timestamp: z.string().describe("ISO-8601 timestamp"),
  labels: z.record(z.string()).describe("Key-value labels attached to the alert"),
});

const dedupeResultSchema = z.object({
  uniqueAlerts: z.array(alertSchema).describe("Alerts after deduplication"),
  suppressedCount: z.number().describe("Number of alerts dropped as duplicates"),
  suppressedIds: z.array(z.string()).describe("IDs of suppressed duplicate alerts"),
});

const contextSchema = z.object({
  recentIncidents: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      status: z.enum(["open", "mitigated", "resolved"]),
      relatedAlertPatterns: z.array(z.string()),
    }),
  ).describe("Active or recent incidents that may correlate"),
  noiseRules: z.array(
    z.object({
      pattern: z.string().describe("Regex or substring pattern to match"),
      reason: z.string().describe("Why this pattern is considered noise"),
      expiresAt: z.string().optional().describe("When this rule expires"),
    }),
  ).describe("Known-noise suppression rules"),
});

const classificationSchema = z.object({
  classifications: z.array(
    z.object({
      alertId: z.string(),
      verdict: z.enum(["escalate", "suppress", "observe"]).describe("Whether to page, suppress, or watch"),
      confidence: z.number().min(0).max(1).describe("Model confidence in the verdict"),
      matchedNoiseRule: z.string().optional().describe("Noise rule pattern that matched, if any"),
      matchedIncidentId: z.string().optional().describe("Existing incident this correlates with"),
      reasoning: z.string().describe("Why this verdict was chosen"),
      riskLevel: z.enum(["critical", "high", "medium", "low"]).describe("Assessed risk after context"),
    }),
  ),
});

const sinkResultSchema = z.object({
  paged: z.array(
    z.object({
      alertId: z.string(),
      channel: z.string().describe("PagerDuty, Slack, etc."),
      ticketUrl: z.string().optional(),
    }),
  ).describe("Alerts that were paged out"),
  ticketed: z.array(
    z.object({
      alertId: z.string(),
      ticketUrl: z.string(),
    }),
  ).describe("Alerts filed as tickets for later review"),
  dropped: z.array(z.string()).describe("Alert IDs silently suppressed"),
});

const outputSchema = z.object({
  totalReceived: z.number(),
  suppressed: z.number(),
  escalated: z.number(),
  ticketed: z.number(),
  observed: z.number(),
  summary: z.string(),
});

// --- Smithers setup ---

const { Workflow, Task, smithers, outputs } = createSmithers({
  dedupeResult: dedupeResultSchema,
  context: contextSchema,
  classification: classificationSchema,
  sinkResult: sinkResultSchema,
  output: outputSchema,
});

// --- Agents ---

const contextAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { bash, read, grep },
  instructions: `You are an incident-context retriever. Given a set of alerts, look up
recent incidents and active noise-suppression rules from the configured sources.
Return structured context so the classifier can make informed decisions.`,
});

const classifierAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, grep },
  instructions: `You are an alert classifier. For each unique alert, decide whether to
escalate (page on-call), suppress (known noise or duplicate of open incident), or
observe (low risk, file a ticket). Cross-reference with recent incidents and noise rules.
Be conservative: when in doubt, escalate.`,
});

const sinkAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { bash },
  instructions: `You are an alert dispatcher. For escalated alerts, page the on-call via
the appropriate channel. For observed alerts, file a ticket. For suppressed alerts, log
and drop. Report every action taken.`,
});

// --- Workflow ---

export default smithers((ctx) => {
  const deduped = ctx.outputMaybe("dedupeResult", { nodeId: "dedupe" });
  const context = ctx.outputMaybe("context", { nodeId: "context-lookup" });
  const classification = ctx.outputMaybe("classification", { nodeId: "classify" });
  const sinkResult = ctx.outputMaybe("sinkResult", { nodeId: "dispatch" });

  const alerts = ctx.input.alerts ?? [];
  const noiseRules = ctx.input.noiseRules ?? [];

  return (
    <Workflow name="alert-suppressor">
      <Sequence>
        {/* 1. Deduplicate and fetch context in parallel */}
        <Parallel>
          <Task id="dedupe" output={outputs.dedupeResult}>
            <DedupePrompt alerts={alerts} />
          </Task>

          <Task id="context-lookup" output={outputs.context} agent={contextAgent}>
            <ContextPrompt
              alerts={alerts}
              noiseRules={noiseRules}
              incidentSource={ctx.input.incidentSource ?? "opsgenie"}
            />
          </Task>
        </Parallel>

        {/* 2. Classify each unique alert using incident context + noise rules */}
        <Task id="classify" output={outputs.classification} agent={classifierAgent}>
          <ClassifyPrompt
            uniqueAlerts={deduped?.uniqueAlerts ?? []}
            context={context}
            noiseRules={context?.noiseRules ?? []}
            recentIncidents={context?.recentIncidents ?? []}
          />
        </Task>

        {/* 3. Dispatch — page, ticket, or drop */}
        <Task id="dispatch" output={outputs.sinkResult} agent={sinkAgent}>
          <SinkPrompt
            classifications={classification?.classifications ?? []}
            pageChannel={ctx.input.pageChannel ?? "pagerduty"}
            ticketSystem={ctx.input.ticketSystem ?? "jira"}
          />
        </Task>

        {/* 4. Final summary */}
        <Task id="summary" output={outputs.output}>
          {{
            totalReceived: alerts.length,
            suppressed: (deduped?.suppressedCount ?? 0) + (sinkResult?.dropped?.length ?? 0),
            escalated: sinkResult?.paged?.length ?? 0,
            ticketed: sinkResult?.ticketed?.length ?? 0,
            observed: (classification?.classifications ?? []).filter(
              (c) => c.verdict === "observe",
            ).length,
            summary: [
              `Received ${alerts.length} alerts.`,
              `Deduplicated ${deduped?.suppressedCount ?? 0} duplicates.`,
              `Escalated ${sinkResult?.paged?.length ?? 0} to ${ctx.input.pageChannel ?? "pagerduty"}.`,
              `Filed ${sinkResult?.ticketed?.length ?? 0} tickets.`,
              `Suppressed ${sinkResult?.dropped?.length ?? 0} as known noise.`,
            ].join(" "),
          }}
        </Task>
      </Sequence>
    </Workflow>
  );
});
