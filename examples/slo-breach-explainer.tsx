// @ts-nocheck
/**
 * <SLOBreachExplainer> — When latency/error/SLO alarms trip, pull traces, logs,
 * and change history then explain the likely causal chain.
 *
 * Pattern: metrics trigger → trace/log fetchers (parallel) → synthesis agent → incident note.
 * Use cases: SLO breach triage, incident root-cause summaries, on-call handoff notes.
 */
import { createSmithers, Sequence, Parallel } from "smithers-orchestrator";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { read, bash, grep } from "smithers-orchestrator/tools";
import { z } from "zod";
import TriggerPrompt from "./prompts/slo-breach-explainer/trigger.mdx";
import TracesPrompt from "./prompts/slo-breach-explainer/traces.mdx";
import LogsPrompt from "./prompts/slo-breach-explainer/logs.mdx";
import ChangesPrompt from "./prompts/slo-breach-explainer/changes.mdx";
import SynthesisPrompt from "./prompts/slo-breach-explainer/synthesis.mdx";

const alarmSchema = z.object({
  service: z.string().describe("Service that breached its SLO"),
  sloName: z.string().describe("Name of the SLO, e.g. p99-latency or error-rate"),
  threshold: z.string().describe("SLO threshold, e.g. '200ms' or '0.1%'"),
  observed: z.string().describe("Observed value that triggered the alarm"),
  window: z.string().describe("Time window of the breach, e.g. '2026-03-28T14:00Z/PT1H'"),
});

const traceContextSchema = z.object({
  topSpans: z.array(z.object({
    traceId: z.string(),
    spanName: z.string(),
    durationMs: z.number(),
    status: z.enum(["ok", "error", "timeout"]),
    attributes: z.record(z.string()),
  })),
  bottleneck: z.string().describe("Identified slow or failing span"),
  sampleTraceId: z.string().describe("Representative trace ID for deep-dive"),
});

const logContextSchema = z.object({
  errorCount: z.number(),
  topErrors: z.array(z.object({
    message: z.string(),
    count: z.number(),
    firstSeen: z.string(),
    lastSeen: z.string(),
  })),
  anomalies: z.array(z.string()).describe("Log patterns that deviate from the baseline"),
});

const changeContextSchema = z.object({
  recentDeploys: z.array(z.object({
    version: z.string(),
    deployedAt: z.string(),
    author: z.string(),
    description: z.string(),
  })),
  configChanges: z.array(z.object({
    key: z.string(),
    oldValue: z.string(),
    newValue: z.string(),
    changedAt: z.string(),
  })),
  suspectChange: z.string().describe("Most likely change correlated with the breach"),
});

const incidentNoteSchema = z.object({
  title: z.string().describe("Short incident title for the note"),
  severity: z.enum(["critical", "high", "medium", "low"]),
  causalChain: z.array(z.string()).describe("Ordered list of events forming the causal chain"),
  rootCause: z.string().describe("Most likely root cause"),
  impactSummary: z.string().describe("User/business impact description"),
  mitigation: z.string().describe("Recommended immediate mitigation"),
  followUps: z.array(z.string()).describe("Longer-term follow-up actions"),
  summary: z.string().describe("One-paragraph narrative suitable for an incident channel"),
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  alarm: alarmSchema,
  traces: traceContextSchema,
  logs: logContextSchema,
  changes: changeContextSchema,
  incidentNote: incidentNoteSchema,
});

const traceFetcher = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { bash, grep },
  instructions: `You are a distributed-tracing specialist. Query trace backends to find
the slowest and most error-prone spans within the breach window. Identify the bottleneck
span and pick a representative trace ID for follow-up investigation.`,
});

const logFetcher = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { bash, grep, read },
  instructions: `You are a log analyst. Search logs for the affected service within the breach
window. Count errors, surface the top error messages, and flag any anomalous patterns that
deviate from the service's normal baseline.`,
});

const changeFetcher = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { bash, read },
  instructions: `You are a change-tracking investigator. Look up recent deployments, config
changes, and feature-flag flips for the affected service around the breach window. Identify
the single most suspicious change that correlates with the SLO violation.`,
});

const synthesizer = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read },
  instructions: `You are an incident analyst. Given trace context, log context, and change
history, construct a clear causal chain explaining why the SLO was breached. Be specific
about the root cause, quantify impact, and recommend both immediate mitigation and follow-ups.
Write the summary as a concise paragraph suitable for posting in an incident Slack channel.`,
});

export default smithers((ctx) => {
  const alarm = ctx.outputMaybe("alarm", { nodeId: "trigger" });

  return (
    <Workflow name="slo-breach-explainer">
      <Sequence>
        {/* Phase 1: Parse and validate the incoming alarm */}
        <Task id="trigger" output={outputs.alarm}>
          <TriggerPrompt
            service={ctx.input.service}
            sloName={ctx.input.sloName}
            threshold={ctx.input.threshold}
            observed={ctx.input.observed}
            window={ctx.input.window}
          />
        </Task>

        {/* Phase 2: Fetch context in parallel — traces, logs, change history */}
        <Parallel maxConcurrency={3}>
          <Task id="traces" output={outputs.traces} agent={traceFetcher}>
            <TracesPrompt
              service={alarm?.service}
              window={alarm?.window}
              sloName={alarm?.sloName}
            />
          </Task>

          <Task id="logs" output={outputs.logs} agent={logFetcher}>
            <LogsPrompt
              service={alarm?.service}
              window={alarm?.window}
              observed={alarm?.observed}
            />
          </Task>

          <Task id="changes" output={outputs.changes} agent={changeFetcher}>
            <ChangesPrompt
              service={alarm?.service}
              window={alarm?.window}
            />
          </Task>
        </Parallel>

        {/* Phase 3: Synthesis agent — weave context into an incident note */}
        <Task id="incidentNote" output={outputs.incidentNote} agent={synthesizer}>
          <SynthesisPrompt
            alarm={ctx.outputs.alarm}
            traces={ctx.outputs.traces}
            logs={ctx.outputs.logs}
            changes={ctx.outputs.changes}
          />
        </Task>
      </Sequence>
    </Workflow>
  );
});
