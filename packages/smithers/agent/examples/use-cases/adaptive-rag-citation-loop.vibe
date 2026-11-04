/**
 * Route a question, gather evidence in parallel, and redraft a cited answer until a citation judge accepts it.
 *
 * Port of the 0.x `adaptive-rag-citation-loop.jsx`. A router agent decides
 * whether the question needs retrieval. If it does, a planner agent writes a
 * retrieval plan, and each round three retriever agents search vector,
 * keyword, and database or web sources in parallel. A writer agent drafts a
 * cited answer from all evidence so far and the previous grade, and a judge
 * agent grades it. A grounded answer (judged grounded and scoring at least
 * `groundedThreshold`, default 0.85) ends the loop; otherwise the planner
 * repairs the plan and the next round retrieves with it, up to
 * `maxIterations` (default 3).
 * An answer that ends ungrounded and scores below `reviewThreshold` (default
 * 0.75) waits for a person's review. The writer then produces the final
 * status.
 *
 * 0.x's `<Loop maxIterations>` is unrolled from the payload, and each grade branches to the final answer or to the next round.
 * 0.x's retrieval kept reading the first plan, because it preferred `plan-retrieval`'s output over `repair-retrieval-plan`'s, so a repair changed nothing; here each round after a repair retrieves with the repaired plan.
 * 0.x's `<Approval>` becomes a `HumanTask` asking for 0.x's approval schema; the writer reads the reviewer's note.
 * The route is one router agent's typed answer, as in 0.x; `@smthrs/patterns` has no classifier. `MapReduce` and `ReviewLoop` do not fit: the three searches are fixed, and 0.x's repair revises the retrieval plan while the writer redrafts from the grade.
 * 0.x's prompts ended by asking for structured data matching the output schema; `AgentAction` renders and enforces the output schema instead.
 * 0.x gave the agents `read`, `grep` and `bash` tools; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`).
 */
import * as AgentAction from "@smthrs/agent/AgentAction"
import { type Action, Flow, HumanTask } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import type * as Planned from "@smthrs/plan/Planned"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const seat = "anthropic:claude-sonnet-5-5"

const Fraction = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))

/** The router's decision. */
export const Route = Schema.Struct({
  mode: Schema.Literals(["answer-from-memory", "retrieve", "retrieve-and-use-tool", "insufficient"]),
  reason: Schema.String,
  risk: Schema.Literals(["low", "medium", "high"])
})

/** The planner's retrieval plan. */
export const RetrievalPlan = Schema.Struct({
  subqueries: Schema.Array(Schema.String),
  sources: Schema.Array(Schema.Literals(["vector", "keyword", "web", "database"])),
  mustCite: Schema.Boolean,
  gapsToClose: Schema.Array(Schema.String)
})

/** What one retriever found. */
export const Evidence = Schema.Struct({
  source: Schema.String,
  query: Schema.String,
  claims: Schema.Array(Schema.Struct({
    claim: Schema.String,
    sourceId: Schema.String,
    quoteOrLocation: Schema.String,
    confidence: Fraction
  })),
  gaps: Schema.Array(Schema.String)
})

/** The writer's cited draft. */
export const Answer = Schema.Struct({
  answer: Schema.String,
  citations: Schema.Array(Schema.Struct({ sentence: Schema.String, sourceIds: Schema.Array(Schema.String) })),
  unresolvedQuestions: Schema.Array(Schema.String)
})

/** The citation judge's grade. */
export const Grade = Schema.Struct({
  grounded: Schema.Boolean,
  score: Fraction,
  missingEvidence: Schema.Array(Schema.String),
  unsupportedSentences: Schema.Array(Schema.String)
})

/** A person's review of an answer that stayed ungrounded. */
export const Approval = Schema.Struct({
  approved: Schema.Boolean,
  reviewer: Schema.String,
  note: Schema.String
})

/** The final status the flow settles with. */
export const Final = Schema.Struct({
  status: Schema.Literals(["answered", "needs-human-review", "insufficient-evidence"]),
  answer: Schema.String,
  citationCount: Schema.Number,
  gaps: Schema.Array(Schema.String),
  summary: Schema.String
})

type RetrievalPlan = typeof RetrievalPlan.Type
type Evidence = typeof Evidence.Type
type Answer = typeof Answer.Type
type Grade = typeof Grade.Type
type Final = typeof Final.Type

/** The name the review question is asked and answered under, 0.x's approval id. */
export const reviewTask = "human-review"

/** {@link Approval} as the JSON Schema a `HumanTask` checks an answer against. */
const approvalSchema = {
  type: "object",
  properties: { approved: { type: "boolean" }, reviewer: { type: "string" }, note: { type: "string" } },
  required: ["approved", "reviewer", "note"]
}

const planner = `You are an agentic RAG planner. Break the question into subqueries,
choose source types, and list evidence gaps that must be closed before answering.`

const writer = `You are a cited-answer writer. Every factual sentence must map to
source IDs. Do not invent citations. Preserve open questions instead of guessing.`

/** Decides whether the question needs retrieval. */
export const RouteQuery = AgentAction.make("examples/AdaptiveRagCitationLoop/Route", {
  payload: { question: Schema.String, riskPolicy: Schema.String },
  output: Route,
  seat,
  system: [
    `You are a query router. Decide whether the question can be answered
from stable memory, requires retrieval, requires tool/database lookup, or lacks enough context.`
  ],
  prompt: (input) =>
    `Classify the question into a retrieval route. Explain whether retrieval or tools are required and assign risk.\n\nINPUT: ${
      JSON.stringify(input)
    }`
})

/** Writes the first retrieval plan. */
export const PlanRetrieval = AgentAction.make("examples/AdaptiveRagCitationLoop/PlanRetrieval", {
  payload: { question: Schema.String, route: Route, corpus: Schema.String, requiredCitationPolicy: Schema.String },
  output: RetrievalPlan,
  seat,
  system: [planner],
  prompt: (input) =>
    `Create a retrieval plan with subqueries, source types, citation requirements, and evidence gaps to close.\n\nINPUT: ${
      JSON.stringify(input)
    }`
})

/** Searches one source type. */
export const Retrieve = AgentAction.make("examples/AdaptiveRagCitationLoop/Retrieve", {
  payload: { source: Schema.String, plan: RetrievalPlan, question: Schema.String },
  output: Evidence,
  seat,
  system: [
    `You are an evidence retriever. Search the requested corpus or source
type and return atomic claims with source IDs, locations, and confidence scores.`
  ],
  prompt: (input) =>
    `Retrieve evidence for the requested source type. Return atomic claims with source IDs, locations, confidence, and gaps.\n\nINPUT: ${
      JSON.stringify(input)
    }`
})

/** Drafts a cited answer from every piece of evidence so far. */
export const DraftAnswer = AgentAction.make("examples/AdaptiveRagCitationLoop/DraftAnswer", {
  payload: {
    question: Schema.String,
    route: Route,
    evidence: Schema.Array(Evidence),
    previousGrade: Schema.optional(Grade)
  },
  output: Answer,
  seat,
  system: [writer],
  prompt: (input) =>
    `Draft an answer using only supplied evidence. Attach source IDs to every factual sentence and keep unresolved questions explicit.\n\nINPUT: ${
      JSON.stringify(input)
    }`
})

/** Grades the draft's groundedness. */
export const JudgeCitations = AgentAction.make("examples/AdaptiveRagCitationLoop/CitationJudge", {
  payload: { question: Schema.String, answer: Answer, evidence: Schema.Array(Evidence), threshold: Schema.Number },
  output: Grade,
  seat,
  system: [
    `You are a citation and faithfulness judge. Check whether the answer
is fully supported by the evidence and name every unsupported sentence or missing fact.`
  ],
  prompt: (input) =>
    `Judge whether the answer is grounded in the evidence. List unsupported sentences and missing evidence precisely.\n\nINPUT: ${
      JSON.stringify(input)
    }`
})

/** Repairs the retrieval plan from the judge's grade. */
export const RepairPlan = AgentAction.make("examples/AdaptiveRagCitationLoop/RepairPlan", {
  payload: { question: Schema.String, priorPlan: RetrievalPlan, grade: Grade, evidence: Schema.Array(Evidence) },
  output: RetrievalPlan,
  seat,
  system: [planner],
  prompt: (input) =>
    `Repair the retrieval plan based on the citation judge result. Add subqueries and source types that close the missing evidence.\n\nINPUT: ${
      JSON.stringify(input)
    }`
})

/** Produces the final status from the last draft and grade. */
export const FinalAnswer = AgentAction.make("examples/AdaptiveRagCitationLoop/FinalAnswer", {
  payload: {
    question: Schema.String,
    answer: Answer,
    grade: Grade,
    approval: Schema.optional(Approval),
    grounded: Schema.Boolean
  },
  output: Final,
  seat,
  system: [writer],
  prompt: (input) =>
    `Produce the final cited-answer status. Preserve gaps when evidence remains insufficient or human review is required.\n\nINPUT: ${
      JSON.stringify(input)
    }`
})

/** The third search's source: the database when the plan names one, else the web. */
const fetchSource = (plan: RetrievalPlan): string => plan.sources.includes("database") ? "database" : "web"

/** 0.x's approval request title and summary, as one question. */
const reviewRequest = (grade: Grade): string =>
  `Review insufficiently grounded answer\n\nCitation score ${grade.score}; missing evidence: ${
    grade.missingEvidence.join(", ") || "none listed"
  }`

/** What every round reads from the payload, real at plan time. */
interface Ask {
  readonly question: string
  readonly threshold: number
  readonly reviewThreshold: number
  readonly maxIterations: number
}

type Requirements = Action.Requirement<
  `examples/AdaptiveRagCitationLoop/${
    | "Route"
    | "PlanRetrieval"
    | "Retrieve"
    | "DraftAnswer"
    | "CitationJudge"
    | "RepairPlan"
    | "FinalAnswer"}`
>

type Step = Node.Node<Final, AgentAction.AgentFailure | HumanTask.HumanTaskFailed, Requirements>

/** The three searches of one round, run together. */
const gather = (question: string, plan: Planned.Planned<RetrievalPlan>) =>
  Node.all({
    vector: Retrieve.call({ source: "vector", plan, question }),
    keyword: Retrieve.call({ source: "keyword", plan, question }),
    fetched: Node.bindPlanned(
      Node.map(Node.succeed(plan), fetchSource),
      Node.capture({ question }, (source) => Retrieve.call({ source, plan, question }))
    )
  })

/**
 * The final answer for an answer the loop left ungrounded: a person reviews
 * it first when its score is below the review threshold.
 */
const settleUngrounded = (ask: Ask, answer: Planned.Planned<Answer>, grade: Planned.Planned<Grade>): Step =>
  Node.branch(Node.succeed(grade), {
    if: Node.capture({ reviewThreshold: ask.reviewThreshold }, function(graded: Grade) {
      return graded.score < this.reviewThreshold
    }),
    then: Node.capture({ ask }, (graded) =>
      Node.bindPlanned(
        Node.bindPlanned(
          Node.map(Node.succeed(graded), reviewRequest),
          Node.capture({ name: reviewTask, schema: approvalSchema }, (prompt: Planned.Planned<string>) =>
            HumanTask.action.call({ name: reviewTask, kind: "json", prompt, schema: approvalSchema }).pipe(
              HumanTask.decode(Approval)
            ))
        ),
        Node.capture({ ask }, (approval) =>
          FinalAnswer.call({ question: ask.question, answer, grade: graded, approval, grounded: false }))
      )),
    else: Node.capture(
      { ask },
      (graded) => FinalAnswer.call({ question: ask.question, answer, grade: graded, grounded: false })
    )
  })

/**
 * Round `n`: draft from `evidence`, judge, then settle or repair and go
 * again. A `plan` of `undefined` is the router's answer-from-memory path,
 * which neither retrieves nor repairs.
 */
const draft = (
  ask: Ask,
  n: number,
  route: Planned.Planned<typeof Route.Type>,
  plan: Planned.Planned<RetrievalPlan> | undefined,
  evidence: ReadonlyArray<Planned.Planned<Evidence>>,
  previousGrade: Planned.Planned<Grade> | undefined
): Step =>
  Node.bindPlanned(
    DraftAnswer.call({ question: ask.question, route, evidence, previousGrade }),
    Node.capture({ ask, n }, (answer: Planned.Planned<Answer>) =>
      Node.branch(JudgeCitations.call({ question: ask.question, answer, evidence, threshold: ask.threshold }), {
        if: Node.capture({ threshold: ask.threshold }, function(grade: Grade) {
          return grade.grounded && grade.score >= this.threshold
        }),
        then: Node.capture({ ask }, (grade) =>
          FinalAnswer.call({ question: ask.question, answer, grade, grounded: true })),
        else: Node.capture({ ask, n }, (grade) => {
          const last = n >= ask.maxIterations
          if (plan === undefined) {
            return last ? settleUngrounded(ask, answer, grade) : round(ask, n + 1, route, plan, evidence, grade)
          }
          // The repair runs on every ungrounded round, the last one included, as in 0.x.
          const repair = RepairPlan.call({ question: ask.question, priorPlan: plan, grade, evidence })
          return last
            ? Node.andThen(repair, settleUngrounded(ask, answer, grade))
            : Node.bindPlanned(
              repair,
              Node.capture({ ask, n }, (repaired) =>
                round(ask, n + 1, route, repaired, evidence, grade))
            )
        })
      }))
  )

/** Round `n`: gather evidence when the route retrieves, then draft. */
const round = (
  ask: Ask,
  n: number,
  route: Planned.Planned<typeof Route.Type>,
  plan: Planned.Planned<RetrievalPlan> | undefined,
  evidence: ReadonlyArray<Planned.Planned<Evidence>>,
  previousGrade: Planned.Planned<Grade> | undefined
): Step =>
  plan === undefined
    ? draft(ask, n, route, plan, evidence, previousGrade)
    : Node.bindPlanned(
      gather(ask.question, plan),
      Node.capture({ ask, n }, (found) =>
        draft(ask, n, route, plan, [...evidence, found.vector, found.keyword, found.fetched], previousGrade))
    )

/** The flow. `maxIterations` is real at plan time, so it sets how many rounds the plan holds. */
export const AdaptiveRagCitationLoop = Flow.make("examples/AdaptiveRagCitationLoop", {
  payload: {
    question: Schema.String,
    riskPolicy: Schema.optional(Schema.String),
    corpus: Schema.optional(Schema.String),
    requiredCitationPolicy: Schema.optional(Schema.String),
    groundedThreshold: Schema.optional(Fraction),
    reviewThreshold: Schema.optional(Fraction),
    maxIterations: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0)))
  },
  success: Final,
  error: Schema.Union([AgentAction.AgentFailure, HumanTask.HumanTaskFailed]),
  body: Node.capture({ tag: "examples/AdaptiveRagCitationLoop" }, ({
    corpus = "fixtures/adaptive-rag",
    groundedThreshold = 0.85,
    maxIterations = 3,
    question,
    requiredCitationPolicy = "Cite every factual sentence.",
    reviewThreshold = 0.75,
    riskPolicy = "Escalate high-risk or unsupported claims."
  }) => {
    const ask: Ask = { question, threshold: groundedThreshold, reviewThreshold, maxIterations }
    return Node.branch(RouteQuery.call({ question, riskPolicy }), {
      if: Node.capture({ mode: "answer-from-memory" }, (route) => route.mode !== "answer-from-memory"),
      then: Node.capture({ ask, question, corpus, requiredCitationPolicy }, (route) =>
        Node.bindPlanned(
          PlanRetrieval.call({ question, route, corpus, requiredCitationPolicy }),
          Node.capture({ ask }, (plan: Planned.Planned<RetrievalPlan>) => round(ask, 1, route, plan, [], undefined))
        )),
      else: Node.capture({ ask }, (route) => round(ask, 1, route, undefined, [], undefined))
    })
  })
})

/** Every step the flow calls, the review question included. */
export const layer = Layer.mergeAll(
  RouteQuery.layer,
  PlanRetrieval.layer,
  Retrieve.layer,
  DraftAnswer.layer,
  JudgeCitations.layer,
  RepairPlan.layer,
  FinalAnswer.layer
)
