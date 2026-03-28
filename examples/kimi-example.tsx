import { createSmithers, Sequence } from "smithers-orchestrator";
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
export default smithers((ctx) => {
  const analysis = ctx.outputMaybe("analysis", { nodeId: "analysis" });

  return (
    <Workflow name="kimi-analysis">
      <Sequence>
        <Task id="analysis" output={outputs.analysis} agent={kimiAnalyzer}>
          <AnalysisPrompt topic={ctx.input.topic} />
        </Task>
        <Task id="report" output={outputs.output} agent={kimiReporter}>
          <ReportPrompt
            summary={analysis?.summary ?? ""}
            keyPoints={analysis?.keyPoints ?? []}
            complexity={analysis?.complexity ?? "medium"}
          />
        </Task>
      </Sequence>
    </Workflow>
  );
});
