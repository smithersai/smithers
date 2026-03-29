import { Sequence } from "smithers-orchestrator";
import { createExampleSmithers } from "./_example-kit";
import { KimiAgent } from "smithers-orchestrator";
import { z } from "zod";
import AnalysisPrompt from "./prompts/kimi-example/analysis.mdx";
import ReportPrompt from "./prompts/kimi-example/report.mdx";

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
const { Workflow, Task, smithers, outputs } = createExampleSmithers({
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
        <AnalysisPrompt topic={ctx.input.topic} />
      </Task>
      <Task id="report" output={outputs.output} agent={kimiReporter} deps={{ analysis: outputs.analysis }}>
        {(deps) => (
          <ReportPrompt
            summary={deps.analysis.summary}
            keyPoints={deps.analysis.keyPoints}
            complexity={deps.analysis.complexity}
          />
        )}
      </Task>
    </Sequence>
  </Workflow>
));
