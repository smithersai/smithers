import { Loop, ClaudeCodeAgent } from "smithers-orchestrator";
import { createExampleSmithers } from "./_example-kit";
import { z } from "zod";
import CheckPrompt from "./prompts/ralph-loop/check.mdx";

const { Workflow, Task, smithers, outputs } = createExampleSmithers({
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
        <CheckPrompt target={ctx.input.target} />
      </Task>
    </Loop>
  </Workflow>
));
