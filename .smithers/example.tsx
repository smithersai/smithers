/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "./agents";

const inputSchema = z.object({
  code: z.string().default("Review the current repository changes."),
});

const reviewOutputSchema = z.object({
  approved: z.boolean(),
  feedback: z.string(),
});

const { Workflow, Task, Loop, smithers, outputs } = createSmithers({
  input: inputSchema,
  review: reviewOutputSchema,
});

export default smithers((ctx) => {
  const review = ctx.latest(outputs.review, "review");
  return (
    <Workflow name="code-review">
      <Loop until={review?.approved}>
        <Task id="review" output={outputs.review} agent={agents.smart}>
          {`Review this code and return whether it is approved with concise feedback.\n\n${ctx.input.code}`}
        </Task>
        {!review?.approved && (
          <Task id="fix" output={outputs.review} agent={agents.smartTool} dependsOn={["review"]}>
            {`Fix the issues from the latest review, then return whether the code is approved.\n\nFeedback:\n${review?.feedback ?? ""}`}
          </Task>
        )}
      </Loop>
    </Workflow>
  );
});
