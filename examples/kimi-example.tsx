import { createSmithers, Sequence } from "smithers-orchestrator";
import { KimiAgent } from "smithers-orchestrator";
import { z } from "zod";

// Define Zod schemas
const analysisSchema = z.object({
  summary: z.string(),
  keyPoints: z.array(z.string()),
  complexity: z.enum(["low", "medium", "high"]),
});

const outputSchema = z.object({
  report: z.string(),
  recommendations: z.array(z.string()),
});

// Create smithers with schema-driven API
const { Workflow, Task, smithers, outputs } = createSmithers({
  analysis: analysisSchema,
  output: outputSchema,
});

// Create Kimi agent
const kimiAnalyzer = new KimiAgent({
  model: "kimi-latest",
  thinking: true,
  timeoutMs: 5 * 60 * 1000, // 5 minutes
});

const kimiReporter = new KimiAgent({
  model: "kimi-latest",
  timeoutMs: 3 * 60 * 1000, // 3 minutes
});

// Export workflow
export default smithers((ctx) => (
  <Workflow name="kimi-analysis">
    <Sequence>
      <Task id="analysis" output={outputs.analysis} agent={kimiAnalyzer}>
        {`Analyze the following topic and provide a structured analysis:

Topic: ${ctx.input.topic}

Please analyze this topic thoroughly and return your findings in the required JSON format.`}
      </Task>
      <Task id="report" output={outputs.output} agent={kimiReporter}>
        {`Based on the following analysis, create a comprehensive report:

Summary: ${ctx.output("analysis", { nodeId: "analysis" }).summary}
Key Points: ${JSON.stringify(ctx.output("analysis", { nodeId: "analysis" }).keyPoints)}
Complexity: ${ctx.output("analysis", { nodeId: "analysis" }).complexity}

Generate a detailed report with actionable recommendations.`}
      </Task>
    </Sequence>
  </Workflow>
));
