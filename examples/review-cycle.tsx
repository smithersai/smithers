// @ts-nocheck
/**
 * <ReviewCycle> — Implement → Review → Fix → loop until approved.
 *
 * Pattern: Agent implements, reviewer critiques, implementer fixes, repeat.
 * Use cases: code generation with quality gate, writing with editorial review,
 * design iteration, any produce-then-critique loop.
 */
import { Sequence, Loop } from "smithers-orchestrator";
import { createExampleSmithers } from "./_example-kit";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { read, write, edit, bash, grep } from "smithers-orchestrator/tools";
import { z } from "zod";
import ImplementPrompt from "./prompts/review-cycle/implement.mdx";
import ReviewPrompt from "./prompts/review-cycle/review.mdx";

const implementSchema = z.object({
  filesChanged: z.array(z.string()),
  approach: z.string(),
  summary: z.string(),
});

const reviewSchema = z.object({
  approved: z.boolean(),
  score: z.number().min(1).max(10),
  issues: z.array(z.object({
    severity: z.enum(["blocker", "major", "minor", "nit"]),
    file: z.string(),
    description: z.string(),
    suggestion: z.string(),
  })),
  summary: z.string(),
});

const resultSchema = z.object({
  approved: z.boolean(),
  iterations: z.number(),
  finalScore: z.number(),
  summary: z.string(),
});

const { Workflow, Task, smithers, outputs } = createExampleSmithers({
  implement: implementSchema,
  review: reviewSchema,
  result: resultSchema,
});

const implementer = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, write, edit, bash, grep },
  instructions: `You are a senior developer. Implement the requested changes with clean,
production-quality code. If you receive review feedback, address every issue.`,
});

const reviewer = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, grep },
  instructions: `You are a strict code reviewer. Review changes thoroughly.
Only approve (approved=true) when there are NO blocker or major issues.
Be specific about what needs fixing. Score from 1-10.`,
});

export default smithers((ctx) => {
  const reviews = ctx.outputs.review ?? [];
  const latestReview = reviews[reviews.length - 1];
  const isApproved = latestReview?.approved ?? false;

  return (
    <Workflow name="review-cycle">
      <Sequence>
        <Loop until={isApproved} maxIterations={ctx.input.maxIterations ?? 5} onMaxReached="return-last">
          <Sequence>
            <Task id="implement" output={outputs.implement} agent={implementer}>
              <ImplementPrompt
                mode={reviews.length === 0 ? "Implement" : "Fix issues from review and re-implement"}
                task={ctx.input.task}
                directory={ctx.input.directory}
                issues={latestReview?.issues ?? []}
              />
            </Task>

            <Task id="review" output={outputs.review} agent={reviewer} deps={{ implement: outputs.implement }}>
              {(deps) => (
                <ReviewPrompt
                  filesChanged={deps.implement.filesChanged}
                  approach={deps.implement.approach}
                />
              )}
            </Task>
          </Sequence>
        </Loop>

        <Task id="result" output={outputs.result}>
          {{
            approved: isApproved,
            iterations: reviews.length,
            finalScore: latestReview?.score ?? 0,
            summary: isApproved
              ? `Approved after ${reviews.length} iteration(s) with score ${latestReview?.score}/10`
              : `Not approved after ${reviews.length} iteration(s). Last score: ${latestReview?.score}/10`,
          }}
        </Task>
      </Sequence>
    </Workflow>
  );
});
