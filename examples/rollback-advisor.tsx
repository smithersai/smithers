// @ts-nocheck
/**
 * <RollbackAdvisor> — Read failed deploy evidence and produce a rollback/mitigation
 * recommendation with optional approval before action.
 *
 * Pattern: Deploy event → evidence gatherer → advisor agent → approval gate → action.
 */
import { createSmithers, Sequence } from "smithers-orchestrator";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { bash, read, grep } from "smithers-orchestrator/tools";
import { z } from "zod";
import GatherEvidencePrompt from "./prompts/rollback-advisor/gather-evidence.mdx";
import AdvisePrompt from "./prompts/rollback-advisor/advise.mdx";

const evidenceSchema = z.object({
  deployment: z.string(),
  errorRate: z.number(),
  affectedEndpoints: z.array(z.string()),
  timeline: z.string(),
  severity: z.enum(["critical", "high", "medium", "low"]),
  rawFindings: z.string(),
});

const adviceSchema = z.object({
  shouldRollback: z.boolean(),
  reason: z.string(),
  mitigation: z.string(),
  rollbackSafe: z.boolean(),
  risks: z.array(z.string()),
});

const approvalSchema = z.object({
  approved: z.boolean(),
  note: z.string().nullable(),
  decidedBy: z.string().nullable(),
  decidedAt: z.string().nullable(),
});

const actionSchema = z.object({
  action: z.enum(["rollback", "mitigate", "observe"]),
  summary: z.string(),
  steps: z.array(z.string()),
});

const { Workflow, Task, Branch, Approval, smithers, outputs } = createSmithers({
  evidence: evidenceSchema,
  advice: adviceSchema,
  approval: approvalSchema,
  action: actionSchema,
});

const gatherer = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { bash, read, grep },
  instructions: `You are an incident evidence gatherer. Inspect logs, metrics, and recent
deployments to build a clear picture of what went wrong. Focus on error rates,
affected services, and the timeline of events.`,
});

const advisor = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { bash },
  instructions: `You are a deployment advisor. Given evidence of a failed deployment,
determine whether to rollback, mitigate in place, or observe. Consider data safety,
blast radius, and available mitigations. Be decisive and justify your recommendation.`,
});

export default smithers((ctx) => {
  const evidence = ctx.outputMaybe("evidence", { nodeId: "gather" });
  const advice = ctx.outputMaybe("advice", { nodeId: "advise" });
  const approval = ctx.outputMaybe("approval", { nodeId: "approve-rollback" });

  return (
    <Workflow name="rollback-advisor">
      <Sequence>
        <Task id="gather" output={outputs.evidence} agent={gatherer}>
          <GatherEvidencePrompt
            deployment={ctx.input.deployment ?? "unknown"}
            symptoms={(ctx.input.symptoms ?? []).join(", ")}
          />
        </Task>

        <Task id="advise" output={outputs.advice} agent={advisor}>
          <AdvisePrompt
            deployment={ctx.input.deployment ?? "unknown"}
            evidence={evidence?.rawFindings ?? "no evidence gathered"}
          />
        </Task>

        <Branch
          if={advice?.shouldRollback ?? false}
          then={
            <Approval
              id="approve-rollback"
              output={outputs.approval}
              request={{
                title: `Rollback ${ctx.input.deployment ?? "deployment"}`,
                summary: advice?.reason ?? "Rollback recommended",
              }}
            />
          }
          else={null}
        />

        <Task id="act" output={outputs.action}>
          {{
            action:
              advice?.shouldRollback && approval?.approved
                ? "rollback"
                : advice?.shouldRollback
                  ? "observe"
                  : "mitigate",
            summary:
              advice?.shouldRollback && approval?.approved
                ? `Approved rollback for ${ctx.input.deployment ?? "deployment"}: ${advice?.reason ?? ""}`
                : advice?.shouldRollback
                  ? `Rollback recommended but awaiting approval: ${advice?.reason ?? ""}`
                  : `Mitigation plan: ${advice?.mitigation ?? "observe and tune"}`,
            steps:
              advice?.shouldRollback && approval?.approved
                ? ["Initiate rollback", "Verify service health", "Notify stakeholders"]
                : advice?.shouldRollback
                  ? ["Await approval", "Monitor error rates"]
                  : (advice?.mitigation ?? "observe").split(". ").filter(Boolean),
          }}
        </Task>
      </Sequence>
    </Workflow>
  );
});
