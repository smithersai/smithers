/**
 * Normalize an inbound lead, enrich it, profile it, and write one CRM record.
 *
 * Port of the 0.x `lead-enricher.jsx`. Four steps run in sequence: an intake
 * step normalizes the raw lead, an enrichment agent researches the company, a
 * profiler agent scores the segment and ICP fit from both, and a CRM step
 * writes the record. There is no branch or loop.
 *
 * 0.x's `intake` and `crm-output` tasks had a prompt but no agent, so they settled with the prompt element and only passed under mocks; here they are agent steps over the same props.
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

const Segment = Schema.Literals(["startup", "smb", "mid-market", "enterprise"])

/** The normalized lead. */
export const Intake = Schema.Struct({
  leadId: Schema.String,
  company: Schema.String,
  contactName: Schema.String,
  contactEmail: Schema.String,
  source: Schema.Literals(["inbound-form", "webinar", "referral", "cold-outbound", "marketplace", "other"]),
  rawNotes: Schema.String,
  summary: Schema.String
})

const Firmographics = Schema.Struct({
  industry: Schema.String,
  employeeCount: Schema.Number,
  annualRevenue: Schema.optional(Schema.String),
  hqLocation: Schema.String,
  fundingStage: Schema.optional(Schema.String)
})

const NewsItem = Schema.Struct({
  headline: Schema.String,
  relevance: Schema.Literals(["low", "medium", "high"])
})

/** What the enrichment agent found about the company. */
export const Enrichment = Schema.Struct({
  firmographics: Firmographics,
  techStack: Schema.Array(Schema.String),
  recentNews: Schema.Array(NewsItem),
  competitors: Schema.Array(Schema.String),
  summary: Schema.String
})

/** The profiler's scored profile. */
export const Profile = Schema.Struct({
  segment: Segment,
  icpFit: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  buyerPersona: Schema.String,
  painPoints: Schema.Array(Schema.String),
  recommendedPlaybook: Schema.String,
  talkingPoints: Schema.Array(Schema.String),
  summary: Schema.String
})

/** The CRM record the flow settles with. */
export const CrmRecord = Schema.Struct({
  leadId: Schema.String,
  company: Schema.String,
  segment: Segment,
  icpFit: Schema.Number,
  owner: Schema.String,
  nextAction: Schema.String,
  status: Schema.Literals(["new", "enriched", "qualified", "disqualified", "routed"]),
  profileSummary: Schema.String,
  summary: Schema.String
})

/** Normalizes the raw lead. */
export const NormalizeLead = AgentAction.make("examples/LeadEnricher/Intake", {
  payload: { lead: Schema.Json, source: Schema.String },
  output: Intake,
  seat,
  prompt: ({ lead, source }) =>
    `Normalize this raw inbound lead into a structured lead record.\n\nSource: ${source}\nLead: ${JSON.stringify(lead)}`
})

/** Researches the lead's company. */
export const Enrich = AgentAction.make("examples/LeadEnricher/Enrich", {
  payload: { company: Schema.String, contactEmail: Schema.String, rawNotes: Schema.String },
  output: Enrichment,
  seat,
  system: [
    `You are a firmographic enrichment specialist. Given a company name and lead context,
research the company's industry, size, funding, tech stack, recent news, and competitive landscape.
Return structured enrichment data to support lead scoring and sales outreach.`
  ],
  prompt: ({ company, contactEmail, rawNotes }) =>
    `Enrich this lead's company.\n\nCompany: ${company}\nContact email: ${contactEmail}\nRaw notes: ${rawNotes}`
})

/** Scores the lead from its intake and enrichment. */
export const ProfileLead = AgentAction.make("examples/LeadEnricher/Profile", {
  payload: {
    intake: Intake,
    firmographics: Firmographics,
    techStack: Schema.Array(Schema.String),
    recentNews: Schema.Array(NewsItem)
  },
  output: Profile,
  seat,
  system: [
    `You are a lead profiling strategist. Given raw lead intake and firmographic enrichment,
determine the account segment, ICP fit score, buyer persona, key pain points, and recommended
sales playbook. Be specific about talking points that reference the prospect's context.`
  ],
  prompt: ({ firmographics, intake, recentNews, techStack }) =>
    `Profile this lead.\n\nIntake: ${JSON.stringify(intake)}\nFirmographics: ${
      JSON.stringify(firmographics)
    }\nTech stack: ${JSON.stringify(techStack)}\nRecent news: ${JSON.stringify(recentNews)}`
})

/** Writes the CRM record from the profile. */
export const WriteCrmRecord = AgentAction.make("examples/LeadEnricher/CrmOutput", {
  payload: {
    leadId: Schema.String,
    company: Schema.String,
    segment: Segment,
    icpFit: Schema.Number,
    recommendedPlaybook: Schema.String,
    painPoints: Schema.Array(Schema.String),
    talkingPoints: Schema.Array(Schema.String)
  },
  output: CrmRecord,
  seat,
  prompt: (profile) => `Write the CRM record for this profiled lead.\n\nProfile: ${JSON.stringify(profile)}`
})

/** The flow: intake, enrich, profile, CRM record. */
export const LeadEnricher = Flow.make("examples/LeadEnricher", {
  payload: { lead: Schema.optional(Schema.Json), source: Schema.optional(Schema.String) },
  success: CrmRecord,
  error: AgentAction.AgentFailure,
  body: ({ lead = {}, source = "other" }) =>
    Node.bindPlanned(
      NormalizeLead.call({ lead, source }),
      (intake: Planned.Planned<typeof Intake.Type>) =>
        Node.bindPlanned(
          Enrich.call({ company: intake.company, contactEmail: intake.contactEmail, rawNotes: intake.rawNotes }),
          (enrichment: Planned.Planned<typeof Enrichment.Type>) =>
            Node.bindPlanned(
              ProfileLead.call({
                intake,
                firmographics: enrichment.firmographics,
                techStack: enrichment.techStack,
                recentNews: enrichment.recentNews
              }),
              (profile: Planned.Planned<typeof Profile.Type>) =>
                WriteCrmRecord.call({
                  leadId: intake.leadId,
                  company: intake.company,
                  segment: profile.segment,
                  icpFit: profile.icpFit,
                  recommendedPlaybook: profile.recommendedPlaybook,
                  painPoints: profile.painPoints,
                  talkingPoints: profile.talkingPoints
                })
            )
        )
    )
})

/** Every step the flow calls. */
export const layer = Layer.mergeAll(NormalizeLead.layer, Enrich.layer, ProfileLead.layer, WriteCrmRecord.layer)
