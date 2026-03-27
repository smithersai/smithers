import { createSmithers, Loop, ClaudeCodeAgent } from "smithers-orchestrator";
import { z } from "zod";

const { Workflow, Task, smithers, outputs } = createSmithers({
  check: z.object({ status: z.string() }),
});

const agent = new ClaudeCodeAgent({
  model: "claude-sonnet-4-6",
  dangerouslySkipPermissions: true,
});

export default smithers((ctx) => (
  <Workflow name="ralph-loop">
    <Loop until={false}>
      <Task id="check" output={outputs.check} agent={agent}>
        Check the current status of: {ctx.input.target}
      </Task>
    </Loop>
  </Workflow>
));
