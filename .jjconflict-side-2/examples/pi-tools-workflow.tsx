/** @jsxImportSource smithers-orchestrator */
import { Task, Workflow, PiAgent } from "smithers-orchestrator";
import { z } from "zod";
import { createExampleSmithers } from "./_example-kit";

const OutputSchema = z.object({
  phrase: z.string().regex(/^saffron-orbit-lantern$/),
  lineCount: z.number().int().min(3).max(3),
  cwdBasename: z.string().regex(/^examples$/),
  summary: z.string(),
});

const { smithers, outputs } = createExampleSmithers({
  output: OutputSchema,
});

const pi = new PiAgent({
  provider: "openai-codex",
  model: "gpt-5.4",
  mode: "rpc",
  tools: ["read", "bash"],
});

export default smithers(() => (
  <Workflow name="pi-tools-workflow">
    <Task id="inspect-file" output={outputs.output} agent={pi} retries={2}>
      {`Use the read tool to inspect ./pi-tools-input.txt and use the bash tool to determine the basename of the current working directory.

Then return exactly this JSON and nothing else:
{
  "phrase": "the unique phrase from the file",
  "lineCount": 3,
  "cwdBasename": "the basename of the current working directory",
  "summary": "one short sentence confirming what you found"
}`}
    </Task>
  </Workflow>
));
