import { createSmithers, Sequence } from "smithers-orchestrator";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";

// Define Zod schemas
const researchSchema = z.object({
  summary: z.string(),
  keyPoints: z.array(z.string()),
});

const outputSchema = z.object({
  article: z.string(),
  wordCount: z.number(),
});

// Create smithers with schema-driven API
const { Workflow, Task, smithers, outputs } = createSmithers({
  research: researchSchema,
  output: outputSchema,
});

// Create agents
const researchAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  instructions: "You are a research assistant. Provide concise summaries and key points.",
});

const writerAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  instructions: "You are a technical writer. Write clear, engaging content.",
});

// Export workflow
export default smithers((ctx) => (
  <Workflow name="simple-example">
    <Sequence>
      <Task id="research" output={outputs.research} agent={researchAgent}>
        {`Research this topic and provide a summary with 3-5 key points: ${ctx.input.topic}`}
      </Task>
      <Task id="write" output={outputs.output} agent={writerAgent}>
        {`Write a short article based on this research:
Summary: ${ctx.output("research", { nodeId: "research" }).summary}
Key Points: ${JSON.stringify(ctx.output("research", { nodeId: "research" }).keyPoints)}`}
      </Task>
    </Sequence>
  </Workflow>
));
