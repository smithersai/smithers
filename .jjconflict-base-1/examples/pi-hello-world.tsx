/** @jsxImportSource smithers-orchestrator */
import { Task, Workflow, PiAgent } from "smithers-orchestrator";
import { z } from "zod";
import { createExampleSmithers } from "./_example-kit";

const HelloSchema = z.object({
  message: z.string(),
});

const { smithers, outputs } = createExampleSmithers({
  output: HelloSchema,
});

const pi = new PiAgent({
  provider: "openai-codex",
  model: "gpt-5.4",
  mode: "json",
});

export default smithers(() => (
  <Workflow name="pi-hello-world">
    <Task id="hello" output={outputs.output} agent={pi}>
      {`Return exactly this JSON and nothing else:
{"message":"hello world"}`}
    </Task>
  </Workflow>
));
