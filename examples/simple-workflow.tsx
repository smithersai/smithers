import { Sequence } from "smithers-orchestrator";
import { createExampleSmithers } from "./_example-kit";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import ResearchPrompt from "./prompts/simple-workflow/research.mdx";
import WritePrompt from "./prompts/simple-workflow/write.mdx";

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
const { Workflow, Task, smithers, outputs } = createExampleSmithers({
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
        <ResearchPrompt topic={ctx.input.topic} />
      </Task>
      <Task id="write" output={outputs.output} agent={writerAgent} deps={{ research: outputs.research }}>
        {(deps) => (
          <WritePrompt
            summary={deps.research.summary}
            keyPoints={deps.research.keyPoints}
          />
        )}
      </Task>
    </Sequence>
  </Workflow>
));
