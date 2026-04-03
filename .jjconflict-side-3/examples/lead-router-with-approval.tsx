// @ts-nocheck
/**
 * <LeadRouterWithApproval> — Score inbound leads, propose routing or follow-up,
 * and optionally ask a human to validate borderline cases.
 *
 * Pattern: Lead intake → scoring agent → approval gate → CRM/task sink.
 * Use cases: inbound lead qualification, sales routing, partner onboarding,
 * deal desk triage, territory assignment.
 */
import { Sequence } from "smithers-orchestrator";
import { createExampleSmithers } from "./_example-kit";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { read, bash, grep } from "smithers-orchestrator/tools";
import { z } from "zod";
import IntakePrompt from "./prompts/lead-router-with-approval/intake.mdx";
import ScorePrompt from "./prompts/lead-router-with-approval/score.mdx";
import SinkPrompt from "./prompts/lead-router-with-approval/sink.mdx";

const leadSchema = z.object({
  company: z.string(),
  contactEmail: z.string(),
  source: z.string(),
  annualContractValue: z.number(),
  employeeCount: z.number(),
  intent: z.string(),
  rawNotes: z.string(),
});

const scoreSchema = z.object({
  score: z.number().min(0).max(100),
  tier: z.enum(["enterprise", "mid-market", "smb", "self-serve"]),
  route: z.string(),
  needsApproval: z.boolean(),
  reasoning: z.string(),
  signals: z.array(z.string()),
});

const approvalSchema = z.object({
  approved: z.boolean(),
  reviewer: z.string(),
  note: z.string(),
});

const sinkSchema = z.object({
  crmRecordId: z.string(),
  assignedTo: z.string(),
  nextAction: z.string(),
  status: z.enum(["routed", "queued-for-review", "discarded"]),
  summary: z.string(),
});

const { Workflow, Task, Branch, Approval, smithers, outputs } = createExampleSmithers({
  lead: leadSchema,
  score: scoreSchema,
  approval: approvalSchema,
  sink: sinkSchema,
});

const intakeAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, bash, grep },
  instructions: `You are a lead intake specialist. Parse raw lead data from any source
(webhook payloads, emails, form submissions) into a structured lead record.
Normalise company names, infer employee count when missing, and extract buying intent.`,
});

const scoringAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, bash, grep },
  instructions: `You are a lead scoring and routing engine. Evaluate leads on firmographic fit,
buying intent, and deal size. Assign a 0-100 score, a tier, and a recommended route.
Flag borderline cases (score 40-70) as needing human approval.`,
});

const sinkAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { bash },
  instructions: `You are a CRM integration agent. Create or update CRM records and task
assignments based on the scored and approved lead. Output the record ID and next action.`,
});

export default smithers((ctx) => {
  const lead = ctx.outputMaybe("lead", { nodeId: "intake" });
  const score = ctx.outputMaybe("score", { nodeId: "score" });
  const approval = ctx.outputMaybe("approval", { nodeId: "approve-route" });

  const borderline = score?.needsApproval ?? false;
  const approvedOrNotNeeded = !borderline || (approval?.approved ?? false);

  return (
    <Workflow name="lead-router-with-approval">
      <Sequence>
        {/* 1. Intake: normalise raw lead data */}
        <Task id="intake" output={outputs.lead} agent={intakeAgent}>
          <IntakePrompt
            rawLead={ctx.input.lead ?? ctx.input.rawPayload ?? null}
            source={ctx.input.source ?? "inbound-form"}
          />
        </Task>

        {/* 2. Score and propose routing */}
        <Task id="score" output={outputs.score} agent={scoringAgent}>
          <ScorePrompt
            company={lead?.company ?? "unknown"}
            contactEmail={lead?.contactEmail ?? ""}
            annualContractValue={lead?.annualContractValue ?? 0}
            employeeCount={lead?.employeeCount ?? 0}
            intent={lead?.intent ?? "unknown"}
            rawNotes={lead?.rawNotes ?? ""}
            source={lead?.source ?? "unknown"}
          />
        </Task>

        {/* 3. Approval gate for borderline leads */}
        <Branch
          if={borderline}
          then={
            <Approval
              id="approve-route"
              output={outputs.approval}
              request={{
                title: `Approve routing for ${lead?.company ?? "lead"}`,
                summary: `Score ${score?.score ?? 0}/100 (${score?.tier ?? "unknown"}) — proposed route: ${score?.route ?? "unassigned"}. Reasoning: ${score?.reasoning ?? "n/a"}`,
              }}
            />
          }
          else={null}
        />

        {/* 4. CRM / task sink */}
        <Task id="sink" output={outputs.sink} agent={sinkAgent}>
          <SinkPrompt
            company={lead?.company ?? "unknown"}
            contactEmail={lead?.contactEmail ?? ""}
            score={score?.score ?? 0}
            tier={score?.tier ?? "unknown"}
            route={score?.route ?? "unassigned"}
            signals={score?.signals ?? []}
            approved={approvedOrNotNeeded}
            approvalNote={approval?.note ?? ""}
            borderline={borderline}
          />
        </Task>
      </Sequence>
    </Workflow>
  );
});
