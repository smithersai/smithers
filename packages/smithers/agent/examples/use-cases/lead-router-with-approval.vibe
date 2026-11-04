/**
 * Score an inbound lead and route it, asking a person to approve borderline routes.
 *
 * Port of the 0.x `lead-router-with-approval.jsx`. An intake agent normalizes
 * the raw lead and a scoring agent proposes a score, tier and route. A lead the
 * scorer flags as needing approval waits for a person's decision; a denial
 * fails the run, as 0.x's default `onDeny` did, and the CRM step never runs.
 * Otherwise a CRM agent records the route and the next action.
 *
 * 0.x's `<Approval>` becomes a `HumanTask` asking for 0.x's approval schema. The CRM step reads the reviewer's note.
 * 0.x's prompts were placeholders that printed their props; these are minimal prompts over the same props.
 * 0.x gave the agents `read`, `bash` and `grep` tools; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`).
 */
import * as AgentAction from "@smthrs/agent/AgentAction"
import { Flow, HumanTask } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import type * as Planned from "@smthrs/plan/Planned"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const seat = "anthropic:claude-sonnet-5-5"

/** The normalized lead. */
export const Lead = Schema.Struct({
  company: Schema.String,
  contactEmail: Schema.String,
  source: Schema.String,
  annualContractValue: Schema.Number,
  employeeCount: Schema.Number,
  intent: Schema.String,
  rawNotes: Schema.String
})

/** The scorer's proposal. */
export const Score = Schema.Struct({
  score: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  tier: Schema.Literals(["enterprise", "mid-market", "smb", "self-serve"]),
  route: Schema.String,
  needsApproval: Schema.Boolean,
  reasoning: Schema.String,
  signals: Schema.Array(Schema.String)
})

/** A person's decision on a borderline route. */
export const Approval = Schema.Struct({
  approved: Schema.Boolean,
  reviewer: Schema.String,
  note: Schema.String
})

/** What the CRM step recorded. */
export const Sink = Schema.Struct({
  crmRecordId: Schema.String,
  assignedTo: Schema.String,
  nextAction: Schema.String,
  status: Schema.Literals(["routed", "queued-for-review", "discarded"]),
  summary: Schema.String
})

/** A person denied the proposed route. */
export const RouteDenied = Schema.TaggedStruct("examples/LeadRouterWithApproval/RouteDenied", {
  company: Schema.String,
  reviewer: Schema.String,
  note: Schema.String
})

/** The name the approval question is asked and answered under. */
export const approvalTask = "approve-route"

/** {@link Approval} as the JSON Schema a `HumanTask` checks an answer against. */
const approvalSchema = {
  type: "object",
  properties: { approved: { type: "boolean" }, reviewer: { type: "string" }, note: { type: "string" } },
  required: ["approved", "reviewer", "note"]
}

/** Parses the raw lead. */
export const Intake = AgentAction.make("examples/LeadRouterWithApproval/Intake", {
  payload: { rawLead: Schema.Json, source: Schema.String },
  output: Lead,
  seat,
  system: [
    `You are a lead intake specialist. Parse raw lead data from any source
(webhook payloads, emails, form submissions) into a structured lead record.
Normalise company names, infer employee count when missing, and extract buying intent.`
  ],
  prompt: ({ rawLead, source }) => `Parse this inbound lead.\n\nSource: ${source}\nRaw lead: ${JSON.stringify(rawLead)}`
})

/** Scores the lead and proposes a route. */
export const ScoreLead = AgentAction.make("examples/LeadRouterWithApproval/Score", {
  payload: Lead,
  output: Score,
  seat,
  system: [
    `You are a lead scoring and routing engine. Evaluate leads on firmographic fit,
buying intent, and deal size. Assign a 0-100 score, a tier, and a recommended route.
Flag borderline cases (score 40-70) as needing human approval.`
  ],
  prompt: (lead) => `Score and route this lead.\n\nLead: ${JSON.stringify(lead)}`
})

/** Records the route in the CRM. */
export const RecordRoute = AgentAction.make("examples/LeadRouterWithApproval/Sink", {
  payload: {
    company: Schema.String,
    contactEmail: Schema.String,
    score: Schema.Number,
    tier: Schema.String,
    route: Schema.String,
    signals: Schema.Array(Schema.String),
    approved: Schema.Boolean,
    approvalNote: Schema.String,
    borderline: Schema.Boolean
  },
  output: Sink,
  seat,
  system: [
    `You are a CRM integration agent. Create or update CRM records and task
assignments based on the scored and approved lead. Output the record ID and next action.`
  ],
  prompt: (routed) => `Record this routed lead in the CRM.\n\nRouted lead: ${JSON.stringify(routed)}`
})

type Lead = typeof Lead.Type
type Score = typeof Score.Type

/** 0.x's approval request title and summary, as one question. */
const question = ({ company, score }: { readonly company: string; readonly score: Score }): string =>
  `Approve routing for ${company}\n\nScore ${score.score}/100 (${score.tier}) — proposed route: ${score.route}. Reasoning: ${score.reasoning}`

/** Asks a person, and settles with their typed decision. */
const approve = (lead: Planned.Planned<Lead>, score: Planned.Planned<Score>) =>
  Node.bindPlanned(
    Node.map(Node.succeed({ company: lead.company, score }), question),
    Node.capture({}, (prompt: Planned.Planned<string>) =>
      HumanTask.action.call({ name: approvalTask, kind: "json", prompt, schema: approvalSchema }).pipe(
        HumanTask.decode(Approval)
      ))
  )

/** The CRM call for a lead that was approved, or that needed no approval. */
const record = (
  lead: Planned.Planned<Lead>,
  score: Planned.Planned<Score>,
  decision: { readonly approved: Planned.Planned<boolean> | boolean; readonly note: Planned.Planned<string> | string },
  borderline: boolean
) =>
  RecordRoute.call({
    company: lead.company,
    contactEmail: lead.contactEmail,
    score: score.score,
    tier: score.tier,
    route: score.route,
    signals: score.signals,
    approved: decision.approved,
    approvalNote: decision.note,
    borderline
  })

/** The flow: intake, score, approve when borderline, record. */
export const LeadRouterWithApproval = Flow.make("examples/LeadRouterWithApproval", {
  payload: {
    lead: Schema.optional(Schema.Json),
    rawPayload: Schema.optional(Schema.Json),
    source: Schema.optional(Schema.String)
  },
  success: Sink,
  error: Schema.Union([AgentAction.AgentFailure, HumanTask.HumanTaskFailed, RouteDenied]),
  body: Node.capture({}, ({ lead, rawPayload, source = "inbound-form" }) =>
    Node.bindPlanned(
      Intake.call({ rawLead: lead ?? rawPayload ?? null, source }),
      Node.capture({}, (parsed: Planned.Planned<Lead>) =>
        Node.branch(ScoreLead.call(parsed), {
          if: Node.capture({}, (score) => score.needsApproval),
          then: Node.capture({}, (score) =>
            Node.branch(approve(parsed, score), {
              if: Node.capture({}, (approval) => approval.approved),
              then: Node.capture({}, (approval) => record(parsed, score, approval, true)),
              else: Node.capture({}, (approval) =>
                Node.fail({
                  _tag: "examples/LeadRouterWithApproval/RouteDenied" as const,
                  company: parsed.company,
                  reviewer: approval.reviewer,
                  note: approval.note
                }))
            })),
          else: Node.capture({}, (score) => record(parsed, score, { approved: true, note: "" }, false))
        }))
    ))
})

/** The flow's action implementations; the interpreter supplies approvals. */
export const layer = Layer.mergeAll(Intake.layer, ScoreLead.layer, RecordRoute.layer)
