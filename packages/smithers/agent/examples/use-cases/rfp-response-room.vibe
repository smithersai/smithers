/**
 * Parse an RFP, draft a cited answer per requirement, review the drafts, and package the proposal.
 *
 * Port of the 0.x `rfp-response-room.jsx`. A parser agent turns the RFP into a
 * requirement matrix and a planner agent maps it to sources and owners. A
 * drafter agent answers every requirement, at most `maxDraftConcurrency`
 * (default 8) at a time, then security, legal and product reviewers read all
 * the drafts in parallel. A draft that needs an SME or falls under
 * `confidenceThreshold` (default 0.8), or a review that blocks, sends the
 * package to a person first; a packager agent assembles the proposal.
 *
 * 0.x's `<Approval>` is a `HumanTask` JSON question decoded to the same approval schema, so the packager reads the decision as 0.x's did. A denial ends the run with `ProposalDenied`, the reading `@smthrs/migrate` gives `<Approval>`.
 * 0.x re-rendered its tree once the requirements landed; here the drafts run in a `.child()` flow whose body plans over the real requirements.
 * 0.x's prompts ended by asking for structured data matching the output schema; `AgentAction` renders and enforces the output schema instead.
 * 0.x gave the agents `read`, `write`, `grep` and `bash` tools; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`).
 */
import * as AgentAction from "@smthrs/agent/AgentAction"
import { type Action, Flow, HumanTask, Interpreter } from "@smthrs/flow"
import * as Bounded from "@smthrs/patterns/Bounded"
import { Node } from "@smthrs/plan"
import type * as Planned from "@smthrs/plan/Planned"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const seat = "anthropic:claude-sonnet-5-5"

/** One row of the requirement matrix. */
export const Requirement = Schema.Struct({
  id: Schema.String,
  section: Schema.String,
  question: Schema.String,
  mandatory: Schema.Boolean,
  topic: Schema.Literals(["security", "legal", "implementation", "pricing", "support", "other"])
})

/** The parsed RFP. */
export const Rfp = Schema.Struct({
  opportunityName: Schema.String,
  customer: Schema.String,
  dueDate: Schema.String,
  requirements: Schema.Array(Requirement),
  submissionInstructions: Schema.Array(Schema.String)
})

/** Which owner answers which requirements, from which sources. */
export const AnswerPlan = Schema.Struct({
  workstreams: Schema.Array(Schema.Struct({
    topic: Schema.String,
    ownerRole: Schema.String,
    requirementIds: Schema.Array(Schema.String)
  })),
  sourceCollections: Schema.Array(Schema.String),
  risks: Schema.Array(Schema.String)
})

/** One cited answer. */
export const AnswerDraft = Schema.Struct({
  requirementId: Schema.String,
  topic: Schema.String,
  answer: Schema.String,
  citedSourceIds: Schema.Array(Schema.String),
  confidence: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  needsSME: Schema.Boolean
})

/** One reviewer's verdict on the drafts. */
export const Review = Schema.Struct({
  reviewerRole: Schema.Literals(["sales", "security", "legal", "product", "proposal-manager"]),
  approved: Schema.Boolean,
  requirementIds: Schema.Array(Schema.String),
  blockers: Schema.Array(Schema.String),
  suggestedEdits: Schema.Array(Schema.String)
})

/** The SME's decision on the exceptions. */
export const Approval = Schema.Struct({
  approved: Schema.Boolean,
  reviewer: Schema.String,
  note: Schema.String
})

/** The packaged proposal the flow settles with. */
export const ProposalPackage = Schema.Struct({
  files: Schema.Array(Schema.String),
  openQuestions: Schema.Array(Schema.String),
  submissionReady: Schema.Boolean,
  summary: Schema.String
})

/** The SME denied the exceptions, so nothing was packaged. */
export class ProposalDenied extends Schema.TaggedError<ProposalDenied>()(
  "examples/RfpResponseRoom/ProposalDenied",
  { message: Schema.String }
) {}

type Rfp = typeof Rfp.Type
type AnswerDraft = typeof AnswerDraft.Type
type Review = typeof Review.Type

/** The JSON Schema the SME's answer is checked against; it states {@link Approval}. */
export const approvalAnswer = {
  type: "object",
  properties: {
    approved: { type: "boolean" },
    reviewer: { type: "string" },
    note: { type: "string" }
  },
  required: ["approved", "reviewer", "note"]
}

/** The name the SME question is asked and answered under. */
export const smeReview = "sme-review"

/** Turns the source RFP into a requirement matrix. */
export const ParseRfp = AgentAction.make("examples/RfpResponseRoom/Parse", {
  payload: { rfp: Schema.String, customer: Schema.String },
  output: Rfp,
  seat,
  system: [
    `You are an RFP intake analyst. Parse the source RFP into a requirement
matrix with stable IDs, mandatory flags, topics, and submission instructions.`
  ],
  prompt: (input) =>
    `Parse the RFP into opportunity metadata, requirements, mandatory flags, topics, and submission instructions.\n\nINPUT: ${
      JSON.stringify(input)
    }`
})

/** Maps the requirements to sources, owners and risks. */
export const BuildAnswerPlan = AgentAction.make("examples/RfpResponseRoom/Plan", {
  payload: { rfp: Rfp, approvedSources: Schema.String, pricingRules: Schema.String },
  output: AnswerPlan,
  seat,
  system: [
    `You are a proposal manager. Build an answer plan that maps each
requirement to approved source material, owner roles, and risks.`
  ],
  prompt: (input) =>
    `Build an RFP answer plan. Map requirements to workstreams, owner roles, approved source collections, and risks.\n\nINPUT: ${
      JSON.stringify(input)
    }`
})

/** Drafts one requirement's cited answer. */
export const DraftAnswer = AgentAction.make("examples/RfpResponseRoom/Draft", {
  payload: { requirement: Requirement, answerPlan: AnswerPlan, approvedSources: Schema.String },
  output: AnswerDraft,
  seat,
  system: [
    `You are an RFP response drafter. Use only approved source material,
cite source IDs, mark low-confidence answers, and never invent capabilities.`
  ],
  prompt: (input) =>
    `Draft a cited answer for one RFP requirement using approved material only. Mark low confidence or SME needs.\n\nINPUT: ${
      JSON.stringify(input)
    }`
})

/** One reviewer's pass over every draft. */
export const ReviewDrafts = AgentAction.make("examples/RfpResponseRoom/Review", {
  payload: { role: Schema.Literals(["security", "legal", "product"]), drafts: Schema.Array(AnswerDraft), rfp: Rfp },
  output: Review,
  seat,
  system: [
    `You are a proposal reviewer. Check drafts for source support,
policy compliance, overclaims, and reviewer-specific blockers.`
  ],
  prompt: (input) =>
    `Review RFP drafts for the named role. Approve only source-grounded answers and list blockers or edits.\n\nINPUT: ${
      JSON.stringify(input)
    }`
})

/** Assembles the reviewed answers into the proposal. */
export const PackageProposal = AgentAction.make("examples/RfpResponseRoom/Package", {
  payload: {
    rfp: Rfp,
    drafts: Schema.Array(AnswerDraft),
    reviews: Schema.Array(Review),
    approval: Schema.NullOr(Approval),
    outputFormat: Schema.String
  },
  output: ProposalPackage,
  seat,
  system: [
    `You are a proposal packager. Assemble reviewed answers into the
requested output files, list open questions, and mark whether the package is ready.`
  ],
  prompt: (input) =>
    `Package reviewed RFP answers into submission files. List open questions and whether the response is submission-ready.\n\nINPUT: ${
      JSON.stringify(input)
    }`
})

/**
 * Drafts every requirement. It runs as a child execution, so its payload is
 * real when its body plans: one draft per requirement, at most
 * `maxDraftConcurrency` at a time, in requirement order.
 */
export const DraftAnswers = Flow.make("examples/RfpResponseRoom/DraftAnswers", {
  payload: {
    requirements: Schema.Array(Requirement),
    answerPlan: AnswerPlan,
    approvedSources: Schema.String,
    maxDraftConcurrency: Schema.Int.check(Schema.isGreaterThan(0))
  },
  success: Schema.Array(AnswerDraft),
  error: AgentAction.AgentFailure,
  body: ({ answerPlan, approvedSources, maxDraftConcurrency, requirements }) => {
    if (requirements.length === 0) return Node.succeed([])
    const members = Object.fromEntries(requirements.map((requirement) => [
      requirement.id,
      DraftAnswer.call({ requirement, answerPlan, approvedSources })
    ]))
    const joined = Bounded.all(members, { concurrency: maxDraftConcurrency })
    return Node.map(joined, (drafted) => requirements.map((requirement) => drafted[requirement.id]!))
  }
})

/**
 * Whether a person must see the drafts first, and what they are asked. As in
 * 0.x, the threshold decides, but the count in the question uses 0.8.
 */
const exceptions = (
  { confidenceThreshold, drafts, reviews }: {
    readonly drafts: ReadonlyArray<AnswerDraft>
    readonly reviews: ReadonlyArray<Review>
    readonly confidenceThreshold: number
  }
): { readonly needsReview: boolean; readonly prompt: string } => {
  const lowConfidence = drafts.some((draft) => draft.needsSME || draft.confidence < confidenceThreshold)
  const blocked = reviews.some((review) => !review.approved || review.blockers.length > 0)
  const low = drafts.filter((draft) => draft.needsSME || draft.confidence < 0.8).length
  const blockers = reviews.flatMap((review) => review.blockers).length
  return {
    needsReview: lowConfidence || blocked,
    prompt: `Review RFP response exceptions\n${low} low-confidence draft(s); ${blockers} blocker(s).`
  }
}

type Requirements = Action.Requirement<
  | "examples/RfpResponseRoom/Parse"
  | "examples/RfpResponseRoom/Plan"
  | "examples/RfpResponseRoom/Review"
  | "examples/RfpResponseRoom/Package"
>

type Failure = AgentAction.AgentFailure | HumanTask.HumanTaskFailed | ProposalDenied

/** The three reviews, then the exception gate, then the package. */
const reviewAndPackage = (
  rfp: Planned.Planned<Rfp>,
  drafts: Planned.Planned<ReadonlyArray<AnswerDraft>>,
  confidenceThreshold: number,
  outputFormat: string
): Node.Node<typeof ProposalPackage.Type, Failure, Requirements> => {
  const reviewed = Node.map(
    Node.all({
      security: ReviewDrafts.call({ role: "security", drafts, rfp }),
      legal: ReviewDrafts.call({ role: "legal", drafts, rfp }),
      product: ReviewDrafts.call({ role: "product", drafts, rfp })
    }),
    Node.capture({}, ({ legal, product, security }): ReadonlyArray<Review> => [security, legal, product])
  )
  return Node.bindPlanned(
    reviewed,
    Node.capture({ confidenceThreshold, outputFormat }, (reviews: Planned.Planned<ReadonlyArray<Review>>) => {
      const pack = (approval: Planned.Planned<typeof Approval.Type> | null) =>
        PackageProposal.call({ rfp, drafts, reviews, approval, outputFormat })
      return Node.branch(Node.map(Node.succeed({ drafts, reviews, confidenceThreshold }), exceptions), {
        if: Node.capture({}, (gate) => gate.needsReview),
        then: (gate) =>
          Node.branch(
            HumanTask.decode(Approval)(
              HumanTask.action.call({ name: smeReview, kind: "json", prompt: gate.prompt, schema: approvalAnswer })
            ),
            {
              if: Node.capture({}, (approval) => approval.approved),
              then: (approval) => pack(approval),
              // `Node.fail` types its error as the JSON projection of `toJSON`,
              // which is `unknown`; the flow's error schema decodes it back.
              else: () =>
                Node.fail(new ProposalDenied({ message: "The SME denied the RFP response exceptions." })) as Node.Node<
                  never,
                  ProposalDenied
                >
            }
          ),
        else: () => pack(null)
      })
    })
  )
}

/** The flow: parse, plan, draft, review, gate, package. */
export const RfpResponseRoom = Flow.make("examples/RfpResponseRoom", {
  payload: {
    rfp: Schema.optional(Schema.String),
    customer: Schema.optional(Schema.String),
    approvedSources: Schema.optional(Schema.String),
    pricingRules: Schema.optional(Schema.String),
    maxDraftConcurrency: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
    confidenceThreshold: Schema.optional(Schema.Number),
    outputFormat: Schema.optional(Schema.String)
  },
  success: ProposalPackage,
  error: Schema.Union([AgentAction.AgentFailure, HumanTask.HumanTaskFailed, ProposalDenied]),
  body: ({
    approvedSources = "fixtures/rfp-response-room/approved-answers",
    confidenceThreshold = 0.8,
    customer = "Example customer",
    maxDraftConcurrency = 8,
    outputFormat = "markdown",
    pricingRules = "fixtures/rfp-response-room/pricing-rules.md",
    rfp = "fixtures/rfp-response-room/rfp.md"
  }) =>
    Node.bindPlanned(
      ParseRfp.call({ rfp, customer }),
      Node.capture(
        { approvedSources, pricingRules, maxDraftConcurrency, confidenceThreshold, outputFormat },
        (parsed: Planned.Planned<Rfp>) =>
          Node.bindPlanned(
            BuildAnswerPlan.call({ rfp: parsed, approvedSources, pricingRules }),
            Node.capture(
              { approvedSources, maxDraftConcurrency, confidenceThreshold, outputFormat },
              (answerPlan: Planned.Planned<typeof AnswerPlan.Type>) =>
                Node.bindPlanned(
                  DraftAnswers.child({
                    requirements: parsed.requirements,
                    answerPlan,
                    approvedSources,
                    maxDraftConcurrency
                  }),
                  Node.capture(
                    { confidenceThreshold, outputFormat },
                    (drafts: Planned.Planned<ReadonlyArray<AnswerDraft>>) =>
                      reviewAndPackage(parsed, drafts, confidenceThreshold, outputFormat)
                  )
                )
            )
          )
      )
    )
})

/** Every step the flow calls, the SME question included, and the child flow it starts. */
export const layer = Layer.mergeAll(
  ParseRfp.layer,
  BuildAnswerPlan.layer,
  DraftAnswer.layer,
  ReviewDrafts.layer,
  PackageProposal.layer,
  Interpreter.layer(DraftAnswers)
)
