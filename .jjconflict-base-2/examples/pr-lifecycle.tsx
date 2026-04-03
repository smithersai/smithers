/**
 * <PRLifecycle> — Rebase → Self-review → Push → Poll CI → Merge.
 *
 * Pattern: Shepherd a PR through its full lifecycle to merge.
 * Use cases: automated PR merging, PR finalization, CI-gated merge.
 */
import { Sequence, Loop } from "smithers-orchestrator";
import { createExampleSmithers } from "./_example-kit";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { bash, read, grep } from "smithers-orchestrator/tools";
import { z } from "zod";
import RebasePrompt from "./prompts/pr-lifecycle/rebase.mdx";
import ReviewPrompt from "./prompts/pr-lifecycle/review.mdx";
import PushPrompt from "./prompts/pr-lifecycle/push.mdx";
import PollCiPrompt from "./prompts/pr-lifecycle/poll-ci.mdx";
import MergePrompt from "./prompts/pr-lifecycle/merge.mdx";

const rebaseSchema = z.object({
  conflicts: z.boolean(),
  conflictFiles: z.array(z.string()),
  summary: z.string(),
});

const reviewSchema = z.object({
  issues: z.array(z.object({
    file: z.string(),
    severity: z.enum(["critical", "warning", "nit"]),
    description: z.string(),
  })),
  approved: z.boolean(),
  summary: z.string(),
});

const ciSchema = z.object({
  status: z.enum(["pass", "fail", "pending"]),
  checks: z.array(z.object({
    name: z.string(),
    status: z.enum(["pass", "fail", "pending"]),
  })),
  mergeable: z.boolean(),
});

const pushSchema = z.object({
  pushed: z.boolean(),
  forced: z.boolean(),
  remote: z.string(),
  branch: z.string(),
  summary: z.string(),
});

const mergeSchema = z.object({
  merged: z.boolean(),
  sha: z.string().optional(),
  url: z.string().optional(),
  error: z.string().optional(),
});

const { Workflow, Task, smithers, outputs } = createExampleSmithers({
  rebase: rebaseSchema,
  review: reviewSchema,
  push: pushSchema,
  ci: ciSchema,
  merge: mergeSchema,
});

const gitAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { bash, read },
  instructions: `You are a git operations agent. Handle rebasing, pushing, and merging.
Resolve conflicts when possible. Always use non-interactive git commands.`,
});

const reviewAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { bash, read, grep },
  instructions: `You are a self-review agent. Review the PR diff thoroughly.
Focus on critical issues only. Approve if no blockers found.`,
});

const ciAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { bash },
  instructions: `You are a CI monitor. Check PR status using gh CLI.
Report check statuses and mergeability.`,
});

export default smithers((ctx) => {
  const rebase = ctx.outputMaybe("rebase", { nodeId: "rebase" });
  const review = ctx.outputMaybe("review", { nodeId: "review" });
  const push = ctx.outputMaybe("push", { nodeId: "push" });
  const ci = ctx.outputMaybe("ci", { nodeId: "poll-ci" });
  const readyToPush = (review?.approved ?? false) && !(rebase?.conflicts ?? false);
  const ciReady = push?.pushed ?? false;

  return (
    <Workflow name="pr-lifecycle">
      <Sequence>
        {/* Rebase on latest main */}
        <Task id="rebase" output={outputs.rebase} agent={gitAgent}>
          <RebasePrompt />
        </Task>

        {/* Self-review the diff */}
        <Task id="review" output={outputs.review} agent={reviewAgent} skipIf={rebase?.conflicts ?? false}>
          <ReviewPrompt />
        </Task>

        {/* Push */}
        <Task id="push" output={outputs.push} agent={gitAgent} skipIf={!readyToPush}>
          <PushPrompt />
        </Task>

        {/* Poll CI until green */}
        <Loop
          until={ci?.status === "pass"}
          maxIterations={20}
          onMaxReached="return-last"
          skipIf={!ciReady}
        >
          <Task id="poll-ci" output={outputs.ci} agent={ciAgent} timeoutMs={30_000}>
            <PollCiPrompt />
          </Task>
        </Loop>

        {/* Merge */}
        <Task
          id="merge"
          output={outputs.merge}
          agent={gitAgent}
          skipIf={!ciReady || !ci?.mergeable}
        >
          <MergePrompt mergeMethod={ctx.input.mergeMethod ?? "squash"} />
        </Task>
      </Sequence>
    </Workflow>
  );
});
