import { createSmithers, Loop } from "smithers-orchestrator";
import { z } from "zod";

const { Workflow, Task, smithers, outputs } = createSmithers({ review: z.object({ approved: z.boolean(), feedback: z.string() }) });

export default smithers((ctx) => {
  const review = ctx.latest(outputs.review, "review");
  return (
    <Workflow name="code-review">
      <Loop until={review?.approved}>
        <Task agent={reviewer}>
          <AnalyzeCodePrompt code={ctx.input.code} />
        </Task>
        {!review?.approved && (
          <Task agent={coder}>
            <FixCodePrompt feedback={review?.feedback ?? ""} />
          </Task>
        )}
      </Loop>
    </Workflow>
  );
});
