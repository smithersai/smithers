// @ts-nocheck
/**
 * <LeadEnricher> — Take a raw inbound lead, enrich firmographic/context data,
 * and write a structured profile for downstream scoring or outreach.
 *
 * Shape: lead intake -> enrichment tools -> profiler agent -> CRM output.
 */
import { Sequence } from "smithers-orchestrator";
import { createExampleSmithers } from "./_example-kit";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { read, bash, grep } from "smithers-orchestrator/tools";
import { z } from "zod";
import IntakePrompt from "./prompts/lead-enricher/intake.mdx";
import EnrichPrompt from "./prompts/lead-enricher/enrich.mdx";
import ProfilePrompt from "./prompts/lead-enricher/profile.mdx";
import CrmOutputPrompt from "./prompts/lead-enricher/crm-output.mdx";

const intakeSchema = z.object({
  leadId: z.string(),
  company: z.string(),
  contactName: z.string(),
  contactEmail: z.string(),
  source: z.enum(["inbound-form", "webinar", "referral", "cold-outbound", "marketplace", "other"]),
  rawNotes: z.string(),
  summary: z.string(),
});

const enrichmentSchema = z.object({
  firmographics: z.object({
    industry: z.string(),
    employeeCount: z.number(),
    annualRevenue: z.string().optional(),
    hqLocation: z.string(),
    fundingStage: z.string().optional(),
  }),
  techStack: z.array(z.string()),
  recentNews: z.array(
    z.object({
      headline: z.string(),
      relevance: z.enum(["low", "medium", "high"]),
    })
  ),
  competitors: z.array(z.string()),
  summary: z.string(),
});

const profileSchema = z.object({
  segment: z.enum(["startup", "smb", "mid-market", "enterprise"]),
  icpFit: z.number().min(0).max(1),
  buyerPersona: z.string(),
  painPoints: z.array(z.string()),
  recommendedPlaybook: z.string(),
  talkingPoints: z.array(z.string()),
  summary: z.string(),
});

const crmRecordSchema = z.object({
  leadId: z.string(),
  company: z.string(),
  segment: z.enum(["startup", "smb", "mid-market", "enterprise"]),
  icpFit: z.number(),
  owner: z.string(),
  nextAction: z.string(),
  status: z.enum(["new", "enriched", "qualified", "disqualified", "routed"]),
  profileSummary: z.string(),
  summary: z.string(),
});

const { Workflow, Task, smithers, outputs } = createExampleSmithers({
  intake: intakeSchema,
  enrichment: enrichmentSchema,
  profile: profileSchema,
  crmRecord: crmRecordSchema,
});

const enrichmentAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, bash, grep },
  instructions: `You are a firmographic enrichment specialist. Given a company name and lead context,
research the company's industry, size, funding, tech stack, recent news, and competitive landscape.
Return structured enrichment data to support lead scoring and sales outreach.`,
});

const profilerAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, bash, grep },
  instructions: `You are a lead profiling strategist. Given raw lead intake and firmographic enrichment,
determine the account segment, ICP fit score, buyer persona, key pain points, and recommended
sales playbook. Be specific about talking points that reference the prospect's context.`,
});

export default smithers((ctx) => {
  const intake = ctx.outputMaybe("intake", { nodeId: "intake" });
  const enrichment = ctx.outputMaybe("enrichment", { nodeId: "enrich" });
  const profile = ctx.outputMaybe("profile", { nodeId: "profiler" });

  return (
    <Workflow name="lead-enricher">
      <Sequence>
        {/* Stage 1: Normalize and parse the raw inbound lead */}
        <Task id="intake" output={outputs.intake}>
          <IntakePrompt
            lead={ctx.input.lead ?? {}}
            source={ctx.input.source ?? "other"}
          />
        </Task>

        {/* Stage 2: Enrich with firmographic and contextual data */}
        <Task id="enrich" output={outputs.enrichment} agent={enrichmentAgent}>
          <EnrichPrompt
            company={intake?.company ?? ""}
            contactEmail={intake?.contactEmail ?? ""}
            rawNotes={intake?.rawNotes ?? ""}
          />
        </Task>

        {/* Stage 3: Profiler agent synthesizes enrichment into a scored profile */}
        <Task id="profiler" output={outputs.profile} agent={profilerAgent}>
          <ProfilePrompt
            intake={intake ?? {}}
            firmographics={enrichment?.firmographics ?? {}}
            techStack={enrichment?.techStack ?? []}
            recentNews={enrichment?.recentNews ?? []}
          />
        </Task>

        {/* Stage 4: Write structured record for CRM ingestion */}
        <Task id="crm-output" output={outputs.crmRecord}>
          <CrmOutputPrompt
            leadId={intake?.leadId ?? ""}
            company={intake?.company ?? ""}
            segment={profile?.segment ?? "smb"}
            icpFit={profile?.icpFit ?? 0}
            recommendedPlaybook={profile?.recommendedPlaybook ?? ""}
            painPoints={profile?.painPoints ?? []}
            talkingPoints={profile?.talkingPoints ?? []}
          />
        </Task>
      </Sequence>
    </Workflow>
  );
});
