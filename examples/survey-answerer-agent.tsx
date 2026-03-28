/**
 * <SurveyAnswererAgent> — Read source material and produce constrained, typed
 * survey/questionnaire answers with consistency checks.
 *
 * Shape: context gatherer → answer generator → validator.
 */
import { createSmithers, Sequence } from "smithers-orchestrator";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { read, bash, grep } from "smithers-orchestrator/tools";
import { z } from "zod";
import GatherContextPrompt from "./prompts/survey-answerer-agent/gather-context.mdx";
import GenerateAnswersPrompt from "./prompts/survey-answerer-agent/generate-answers.mdx";
import ValidatePrompt from "./prompts/survey-answerer-agent/validate.mdx";

const sourceContextSchema = z.object({
  documentSummaries: z.array(
    z.object({
      sourceId: z.string(),
      title: z.string(),
      relevantExcerpts: z.array(z.string()),
      topics: z.array(z.string()),
    })
  ),
  keyFacts: z.record(z.string(), z.string()),
  summary: z.string(),
});

const surveyAnswerSchema = z.object({
  answers: z.array(
    z.object({
      questionId: z.string(),
      questionText: z.string(),
      answer: z.string(),
      confidence: z.enum(["high", "medium", "low"]),
      sourceRefs: z.array(z.string()),
      reasoning: z.string(),
    })
  ),
  unanswered: z.array(
    z.object({
      questionId: z.string(),
      questionText: z.string(),
      reason: z.string(),
    })
  ),
  summary: z.string(),
});

const validationSchema = z.object({
  overallConsistency: z.enum(["pass", "warn", "fail"]),
  contradictions: z.array(
    z.object({
      questionIds: z.array(z.string()),
      description: z.string(),
      severity: z.enum(["low", "medium", "high"]),
    })
  ),
  unsupportedClaims: z.array(
    z.object({
      questionId: z.string(),
      claim: z.string(),
      issue: z.string(),
    })
  ),
  revisedAnswers: z.array(
    z.object({
      questionId: z.string(),
      originalAnswer: z.string(),
      revisedAnswer: z.string(),
      reason: z.string(),
    })
  ),
  summary: z.string(),
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  sourceContext: sourceContextSchema,
  surveyAnswers: surveyAnswerSchema,
  validation: validationSchema,
});

const contextGathererAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, bash, grep },
  instructions: `You are a source material analyst. Given a set of documents or data sources
and a survey/questionnaire, extract all relevant facts, excerpts, and key data points that
could be used to answer the survey questions. Organize findings by topic and track provenance
so every answer can be traced back to its source.`,
});

const answerGeneratorAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, bash, grep },
  instructions: `You are a survey response specialist. Given extracted source context and a list
of survey questions, produce precise, well-supported answers. For each answer, cite the source
references and assign a confidence level. If a question cannot be answered from the available
material, flag it as unanswered with a clear reason. Prefer factual, verifiable statements
over speculative ones.`,
});

const validatorAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, bash, grep },
  instructions: `You are a consistency and accuracy auditor for survey responses. Given a set of
answers and their source context, check for internal contradictions between answers, unsupported
claims, and factual inconsistencies. If you find issues, propose revised answers that resolve
the contradictions while staying faithful to the source material. Be strict but fair.`,
});

export default smithers((ctx) => {
  const context = ctx.outputMaybe("sourceContext", { nodeId: "gather-context" });
  const answers = ctx.outputMaybe("surveyAnswers", { nodeId: "generate-answers" });

  return (
    <Workflow name="survey-answerer-agent">
      <Sequence>
        {/* Stage 1: Gather and index source material */}
        <Task id="gather-context" output={outputs.sourceContext} agent={contextGathererAgent}>
          <GatherContextPrompt
            sources={ctx.input.sources ?? []}
            questions={ctx.input.questions ?? []}
          />
        </Task>

        {/* Stage 2: Generate typed, cited answers */}
        <Task id="generate-answers" output={outputs.surveyAnswers} agent={answerGeneratorAgent}>
          <GenerateAnswersPrompt
            questions={ctx.input.questions ?? []}
            documentSummaries={context?.documentSummaries ?? []}
            keyFacts={context?.keyFacts ?? {}}
          />
        </Task>

        {/* Stage 3: Validate consistency and accuracy */}
        <Task id="validate" output={outputs.validation} agent={validatorAgent}>
          <ValidatePrompt
            answers={answers?.answers ?? []}
            unanswered={answers?.unanswered ?? []}
            keyFacts={context?.keyFacts ?? {}}
            documentSummaries={context?.documentSummaries ?? []}
          />
        </Task>
      </Sequence>
    </Workflow>
  );
});
