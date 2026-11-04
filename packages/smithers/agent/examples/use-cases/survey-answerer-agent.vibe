/**
 * Answer a questionnaire from source material with typed, cited answers, then audit them for consistency.
 *
 * Port of the 0.x `survey-answerer-agent.jsx`. A gatherer agent indexes the
 * sources against the questions, an answer agent answers every question from
 * that context or marks it unanswered, and an auditor agent checks the answers
 * for contradictions and unsupported claims and proposes revisions. It is one
 * pass with no loop: the audit's revisions are reported, not applied.
 *
 * 0.x's prompts were placeholders that printed their props; these are minimal prompts written from the same props.
 * 0.x gave the agents `read`, `bash` and `grep` tools; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`).
 */
import * as AgentAction from "@smthrs/agent/AgentAction"
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import type * as Planned from "@smthrs/plan/Planned"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const seat = "anthropic:claude-sonnet-5-5"

const Severity = Schema.Literals(["low", "medium", "high"])

/** The sources, indexed by topic with provenance. */
export const SourceContext = Schema.Struct({
  documentSummaries: Schema.Array(Schema.Struct({
    sourceId: Schema.String,
    title: Schema.String,
    relevantExcerpts: Schema.Array(Schema.String),
    topics: Schema.Array(Schema.String)
  })),
  keyFacts: Schema.Record(Schema.String, Schema.String),
  summary: Schema.String
})

/** Every answered question with its sources, and every question left unanswered. */
export const SurveyAnswers = Schema.Struct({
  answers: Schema.Array(Schema.Struct({
    questionId: Schema.String,
    questionText: Schema.String,
    answer: Schema.String,
    confidence: Schema.Literals(["high", "medium", "low"]),
    sourceRefs: Schema.Array(Schema.String),
    reasoning: Schema.String
  })),
  unanswered: Schema.Array(Schema.Struct({
    questionId: Schema.String,
    questionText: Schema.String,
    reason: Schema.String
  })),
  summary: Schema.String
})

/** The audit of the answers. */
export const Validation = Schema.Struct({
  overallConsistency: Schema.Literals(["pass", "warn", "fail"]),
  contradictions: Schema.Array(Schema.Struct({
    questionIds: Schema.Array(Schema.String),
    description: Schema.String,
    severity: Severity
  })),
  unsupportedClaims: Schema.Array(Schema.Struct({
    questionId: Schema.String,
    claim: Schema.String,
    issue: Schema.String
  })),
  revisedAnswers: Schema.Array(Schema.Struct({
    questionId: Schema.String,
    originalAnswer: Schema.String,
    revisedAnswer: Schema.String,
    reason: Schema.String
  })),
  summary: Schema.String
})

/** What the flow settles with: the answers and their audit. */
export const Output = Schema.Struct({ answers: SurveyAnswers, validation: Validation })

/** Indexes the sources against the questions. */
export const GatherContext = AgentAction.make("examples/SurveyAnswererAgent/GatherContext", {
  payload: { sources: Schema.Array(Schema.Json), questions: Schema.Array(Schema.Json) },
  output: SourceContext,
  seat,
  system: [
    `You are a source material analyst. Given a set of documents or data sources
and a survey/questionnaire, extract all relevant facts, excerpts, and key data points that
could be used to answer the survey questions. Organize findings by topic and track provenance
so every answer can be traced back to its source.`
  ],
  prompt: ({ questions, sources }) =>
    `Gather the source material these survey questions need.\n\nSources: ${JSON.stringify(sources)}\nQuestions: ${
      JSON.stringify(questions)
    }`
})

/** Answers every question from the gathered context. */
export const GenerateAnswers = AgentAction.make("examples/SurveyAnswererAgent/GenerateAnswers", {
  payload: {
    questions: Schema.Array(Schema.Json),
    documentSummaries: SourceContext.fields.documentSummaries,
    keyFacts: SourceContext.fields.keyFacts
  },
  output: SurveyAnswers,
  seat,
  system: [
    `You are a survey response specialist. Given extracted source context and a list
of survey questions, produce precise, well-supported answers. For each answer, cite the source
references and assign a confidence level. If a question cannot be answered from the available
material, flag it as unanswered with a clear reason. Prefer factual, verifiable statements
over speculative ones.`
  ],
  prompt: ({ documentSummaries, keyFacts, questions }) =>
    `Answer every survey question from the source context.\n\nQuestions: ${JSON.stringify(questions)}\nKey facts: ${
      JSON.stringify(keyFacts)
    }\nDocument summaries: ${JSON.stringify(documentSummaries)}`
})

/** Audits the answers against each other and the sources. */
export const Validate = AgentAction.make("examples/SurveyAnswererAgent/Validate", {
  payload: {
    answers: SurveyAnswers.fields.answers,
    unanswered: SurveyAnswers.fields.unanswered,
    keyFacts: SourceContext.fields.keyFacts,
    documentSummaries: SourceContext.fields.documentSummaries
  },
  output: Validation,
  seat,
  system: [
    `You are a consistency and accuracy auditor for survey responses. Given a set of
answers and their source context, check for internal contradictions between answers, unsupported
claims, and factual inconsistencies. If you find issues, propose revised answers that resolve
the contradictions while staying faithful to the source material. Be strict but fair.`
  ],
  prompt: ({ answers, documentSummaries, keyFacts, unanswered }) =>
    `Check these survey answers for contradictions and unsupported claims.\n\nAnswers: ${
      JSON.stringify(answers)
    }\nUnanswered: ${JSON.stringify(unanswered)}\nKey facts: ${JSON.stringify(keyFacts)}\nDocument summaries: ${
      JSON.stringify(documentSummaries)
    }`
})

/** The flow: gather, answer, audit. */
export const SurveyAnswererAgent = Flow.make("examples/SurveyAnswererAgent", {
  payload: {
    sources: Schema.optional(Schema.Array(Schema.Json)),
    questions: Schema.optional(Schema.Array(Schema.Json))
  },
  success: Output,
  error: AgentAction.AgentFailure,
  body: ({ questions = [], sources = [] }) =>
    Node.bindPlanned(
      GatherContext.call({ sources, questions }),
      (context: Planned.Planned<typeof SourceContext.Type>) =>
        Node.bindPlanned(
          GenerateAnswers.call({
            questions,
            documentSummaries: context.documentSummaries,
            keyFacts: context.keyFacts
          }),
          (answers: Planned.Planned<typeof SurveyAnswers.Type>) =>
            Node.bindPlanned(
              Validate.call({
                answers: answers.answers,
                unanswered: answers.unanswered,
                keyFacts: context.keyFacts,
                documentSummaries: context.documentSummaries
              }),
              (validation: Planned.Planned<typeof Validation.Type>) => Node.succeed({ answers, validation })
            )
        )
    )
})

/** Every step the flow calls. */
export const layer = Layer.mergeAll(GatherContext.layer, GenerateAnswers.layer, Validate.layer)
