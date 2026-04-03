/**
 * <PromptOptimizerHarness> — Run prompt variants against test cases, evaluate with checks,
 * and select the best-performing prompt.
 *
 * Pattern: dataset/test cases → candidate prompt → evals/checks → optimize → regenerate.
 * Use cases: prompt engineering, A/B testing prompts, iterative prompt refinement.
 */
import { Sequence, Loop } from "smithers-orchestrator";
import { createExampleSmithers } from "./_example-kit";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { read, write, bash, grep } from "smithers-orchestrator/tools";
import { z } from "zod";
import GeneratePrompt from "./prompts/prompt-optimizer-harness/generate.mdx";
import EvaluatePrompt from "./prompts/prompt-optimizer-harness/evaluate.mdx";
import OptimizePrompt from "./prompts/prompt-optimizer-harness/optimize.mdx";
import ReportPrompt from "./prompts/prompt-optimizer-harness/report.mdx";

const testCaseSchema = z.object({
  input: z.string(),
  expectedOutput: z.string(),
  tags: z.array(z.string()).optional(),
});

const candidateSchema = z.object({
  name: z.string(),
  promptText: z.string(),
  iter: z.number(),
});

const evalResultSchema = z.object({
  candidateName: z.string(),
  passed: z.number(),
  failed: z.number(),
  totalScore: z.number(),
  maxScore: z.number(),
  failures: z.array(z.object({
    testCase: z.string(),
    expected: z.string(),
    actual: z.string(),
    reason: z.string(),
  })),
});

const optimizeSchema = z.object({
  revisedPromptText: z.string(),
  changesApplied: z.array(z.string()),
  targetedFailures: z.number(),
  summary: z.string(),
});

const reportSchema = z.object({
  bestCandidate: z.string(),
  bestScore: z.number(),
  totalIterations: z.number(),
  scoreHistory: z.array(z.object({
    iteration: z.number(),
    candidateName: z.string(),
    score: z.number(),
  })),
  finalPromptText: z.string(),
  summary: z.string(),
});

const { Workflow, Task, smithers, outputs } = createExampleSmithers({
  candidate: candidateSchema,
  evalResult: evalResultSchema,
  optimize: optimizeSchema,
  report: reportSchema,
});

const generator = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, write },
  instructions: `You are a prompt engineer. Given a task description and optional prior feedback,
generate a candidate prompt that maximizes clarity, specificity, and test-case coverage.
Include few-shot examples when beneficial.`,
});

const evaluator = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { bash, read },
  instructions: `You are a prompt evaluator. Run each test case against the candidate prompt,
compare outputs to expected results, and score objectively. Be strict — partial matches
score partial credit. Report every failure with a clear reason.`,
});

const optimizer = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, write, grep },
  instructions: `You are a prompt optimizer. Analyze evaluation failures, identify patterns,
and revise the prompt to address the most impactful issues first. Preserve what already works.
Make targeted, minimal edits rather than wholesale rewrites.`,
});

export default smithers((ctx) => {
  const targetScore = ctx.input.targetScore ?? 95;
  const testCases: z.infer<typeof testCaseSchema>[] = ctx.input.testCases ?? [];
  const evals = ctx.outputs.evalResult ?? [];
  const candidates = ctx.outputs.candidate ?? [];
  const optimizations = ctx.outputs.optimize ?? [];

  const latestEval = evals[evals.length - 1];
  const latestScore = latestEval
    ? Math.round((latestEval.totalScore / latestEval.maxScore) * 100)
    : 0;
  const hitTarget = latestScore >= targetScore;

  const bestEval = evals.slice().sort((a, b) =>
    (b.totalScore / b.maxScore) - (a.totalScore / a.maxScore)
  )[0];

  const latestPromptText = optimizations.length > 0
    ? optimizations[optimizations.length - 1].revisedPromptText
    : ctx.input.initialPrompt ?? "";

  return (
    <Workflow name="prompt-optimizer-harness">
      <Sequence>
        <Loop
          until={hitTarget}
          maxIterations={ctx.input.maxIterations ?? 5}
          onMaxReached="return-last"
        >
          <Sequence>
            <Task id="candidate" output={outputs.candidate} agent={generator}>
              <GeneratePrompt
                taskDescription={ctx.input.taskDescription}
                currentPrompt={latestPromptText}
                iteration={candidates.length + 1}
                priorFailures={latestEval?.failures ?? []}
                testCaseCount={testCases.length}
              />
            </Task>

            <Task id="evalResult" output={outputs.evalResult} agent={evaluator}>
              <EvaluatePrompt
                candidateName={candidates[candidates.length - 1]?.name ?? "candidate-1"}
                promptText={latestPromptText}
                testCases={testCases}
                targetScore={targetScore}
              />
            </Task>

            <Task id="optimize" output={outputs.optimize} agent={optimizer} skipIf={hitTarget}>
              <OptimizePrompt
                currentPrompt={latestPromptText}
                evalResult={latestEval}
                currentScore={latestScore}
                targetScore={targetScore}
                iteration={candidates.length}
              />
            </Task>
          </Sequence>
        </Loop>

        <Task id="report" output={outputs.report}>
          {{
            bestCandidate: bestEval?.candidateName ?? "none",
            bestScore: bestEval
              ? Math.round((bestEval.totalScore / bestEval.maxScore) * 100)
              : 0,
            totalIterations: evals.length,
            scoreHistory: evals.map((e, i) => ({
              iteration: i + 1,
              candidateName: e.candidateName,
              score: Math.round((e.totalScore / e.maxScore) * 100),
            })),
            finalPromptText: latestPromptText,
            summary: `Evaluated ${evals.length} prompt variants across ${testCases.length} test cases. Best score: ${bestEval ? Math.round((bestEval.totalScore / bestEval.maxScore) * 100) : 0}% (target: ${targetScore}%)`,
          }}
        </Task>
      </Sequence>
    </Workflow>
  );
});
