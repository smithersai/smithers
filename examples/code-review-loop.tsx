import { createSmithers, Sequence, Ralph } from "smithers-orchestrator";
import { ToolLoopAgent as Agent, Output } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { read, bash, grep } from "smithers-orchestrator/tools";
import { z } from "zod";

// Define Zod schemas
const reviewSchema = z.object({
  approved: z.boolean(),
  feedback: z.string(),
  issues: z.array(z.string()).optional(),
});

const fixSchema = z.object({
  filesChanged: z.array(z.string()),
  changesSummary: z.string(),
});

const outputSchema = z.object({
  finalSummary: z.string(),
  totalIterations: z.number(),
});

// Create smithers with schema-driven API
const { Workflow, Task, smithers, outputs } = createSmithers({
  review: reviewSchema,
  fix: fixSchema,
  output: outputSchema,
});

const reviewAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, grep, bash },
  output: Output.object({ schema: reviewSchema }),
  instructions: `You are a senior code reviewer. Review the codebase thoroughly.
If everything looks good, set approved to true and say "LGTM" in feedback.
If there are issues, set approved to false and list specific issues to fix.`,
});

const fixAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, grep },  // Remove edit to prevent actual changes
  instructions: `You are a senior software engineer. Analyze the issues and describe what fixes would be needed.
Do NOT actually make changes - just describe what you WOULD fix.

Respond with ONLY a JSON object:
{"filesChanged": ["path/to/file1.ts"], "changesSummary": "Description of fixes needed"}`,
});

export default smithers((ctx) => {
  const latestReview = ctx.outputs.review?.[ctx.outputs.review.length - 1];
  const isApproved = latestReview?.approved ?? false;

  return (
    <Workflow name="code-review-loop">
      <Ralph until={isApproved} maxIterations={3} onMaxReached="return-last">
        <Sequence>
          <Task id="review" output={outputs.review} agent={reviewAgent}>
            {`Review the codebase in directory: ${ctx.input.directory}
Focus area: ${ctx.input.focus}

${latestReview ? `Previous issues that were supposedly fixed:\n${latestReview.issues?.join("\n")}` : "This is the initial review."}

Use the tools to explore the code. Look for:
- Code quality issues
- Potential bugs
- Missing error handling
- Type safety problems
- Any issues related to: ${ctx.input.focus}`}
          </Task>
          <Task id="fix" output={outputs.fix} agent={fixAgent} skipIf={isApproved}>
            {`Fix the issues found in the code review:

Feedback: ${ctx.outputMaybe("review", { nodeId: "review" })?.feedback ?? "No feedback yet"}

Issues to fix:
${ctx.outputMaybe("review", { nodeId: "review" })?.issues?.join("\n") ?? "No specific issues listed"}

Directory: ${ctx.input.directory}

IMPORTANT: After analysis, output EXACTLY this JSON format (no other text):
{"filesChanged": ["file1.ts", "file2.ts"], "changesSummary": "What changes are needed"}`}
          </Task>
        </Sequence>
      </Ralph>
      <Task id="summary" output={outputs.output}>
        {{
          finalSummary: isApproved
            ? "Code review passed - LGTM!"
            : `Review completed after ${ctx.outputs.review?.length ?? 0} iterations`,
          totalIterations: ctx.outputs.review?.length ?? 0,
        }}
      </Task>
    </Workflow>
  );
});
