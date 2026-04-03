// @ts-nocheck
/**
 * <RansomwareIsolationCoordinator> — Coordinate ransomware-response steps
 * (isolate, notify, capture evidence) with approval checkpoints.
 *
 * Shape: detector → containment tools → approval/operator → reporting agent.
 */
import { Sequence } from "smithers-orchestrator";
import { createExampleSmithers } from "./_example-kit";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { bash } from "smithers-orchestrator/tools";
import { z } from "zod";
import DetectPrompt from "./prompts/ransomware-isolation-coordinator/detect.mdx";
import ContainPrompt from "./prompts/ransomware-isolation-coordinator/contain.mdx";
import ReportPrompt from "./prompts/ransomware-isolation-coordinator/report.mdx";

const detectionSchema = z.object({
  hostId: z.string(),
  indicators: z.array(z.string()),
  severity: z.enum(["low", "medium", "high", "critical"]),
  isolateRecommended: z.boolean(),
});

const containmentSchema = z.object({
  hostId: z.string(),
  networkIsolated: z.boolean(),
  evidenceSnapshotUrl: z.string(),
  notifiedChannels: z.array(z.string()),
});

const approvalSchema = z.object({
  approved: z.boolean(),
  approvedBy: z.string(),
  note: z.string(),
});

const reportSchema = z.object({
  incidentId: z.string(),
  timeline: z.array(z.string()),
  containmentStatus: z.enum(["contained", "monitoring", "escalated"]),
  summary: z.string(),
});

const { Workflow, Task, Approval, Branch, smithers, outputs } = createExampleSmithers({
  detection: detectionSchema,
  containment: containmentSchema,
  approval: approvalSchema,
  report: reportSchema,
});

const detector = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { bash },
  instructions: `You are a ransomware detection specialist. Analyse host telemetry,
EDR alerts, and file-system signals to determine if ransomware activity is present.
Return structured indicators and a severity assessment.`,
});

const containmentAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { bash },
  instructions: `You are a containment operator. When directed, isolate the target host
from the network, capture a forensic evidence snapshot, and notify the appropriate
incident-response channels. Use the provided tools to execute each step.`,
});

const reportingAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { bash },
  instructions: `You are an incident reporter. Compile all detection and containment
data into a concise incident report with a timeline, containment status, and summary.`,
});

export default smithers((ctx) => {
  const detection = ctx.outputMaybe("detection", { nodeId: "detect" });
  const approval = ctx.outputMaybe("approval", { nodeId: "approve-containment" });
  const containment = ctx.outputMaybe("containment", { nodeId: "contain" });

  return (
    <Workflow name="ransomware-isolation-coordinator">
      <Sequence>
        {/* Step 1 — Detect ransomware indicators */}
        <Task id="detect" output={outputs.detection} agent={detector} timeoutMs={60_000}>
          <DetectPrompt
            host={ctx.input.host ?? "unknown"}
            evidence={ctx.input.evidence ?? []}
          />
        </Task>

        {/* Step 2 — Gate on operator approval before containment */}
        <Branch
          if={detection?.isolateRecommended ?? false}
          then={
            <Approval
              id="approve-containment"
              output={outputs.approval}
              request={{
                title: `Isolate host ${detection?.hostId ?? "unknown"}`,
                summary: `Severity: ${detection?.severity ?? "unknown"}. Indicators: ${(detection?.indicators ?? []).join(", ")}`,
              }}
            />
          }
          else={null}
        />

        {/* Step 3 — Execute containment if approved */}
        <Branch
          if={!!(detection?.isolateRecommended && approval?.approved)}
          then={
            <Task id="contain" output={outputs.containment} agent={containmentAgent} timeoutMs={120_000}>
              <ContainPrompt
                hostId={detection?.hostId ?? "unknown"}
                severity={detection?.severity ?? "unknown"}
                approvedBy={approval?.approvedBy ?? "operator"}
              />
            </Task>
          }
          else={null}
        />

        {/* Step 4 — Compile incident report */}
        <Task id="report" output={outputs.report} agent={reportingAgent} timeoutMs={60_000}>
          <ReportPrompt
            hostId={detection?.hostId ?? "unknown"}
            indicators={detection?.indicators ?? []}
            severity={detection?.severity ?? "unknown"}
            contained={containment?.networkIsolated ?? false}
            evidenceUrl={containment?.evidenceSnapshotUrl ?? "N/A"}
            notifiedChannels={containment?.notifiedChannels ?? []}
          />
        </Task>
      </Sequence>
    </Workflow>
  );
});
