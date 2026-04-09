/**
 * Example workflow for Kubernetes deployment.
 *
 * This runs identically locally (single process, SQLite) and on Kubernetes
 * (distributed orchestrator + workers, Postgres). No code changes needed.
 */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod";

const { smithers, Workflow, Task, Sequence, outputs } = createSmithers({
  analysis: z.object({
    summary: z.string(),
    findings: z.array(z.string()),
    score: z.number().min(0).max(100),
  }),
  report: z.object({
    markdown: z.string(),
  }),
});

export default smithers((ctx) => (
  <Workflow name="distributed-analysis">
    <Sequence>
      <Task id="analyze" output={outputs.analysis}>
        Analyze the current project structure and identify the top 3 areas for
        improvement. Return a summary, list of findings, and an overall quality
        score from 0-100.
      </Task>
      <Task id="report" output={outputs.report}>
        Write a concise markdown report based on this analysis:
        {JSON.stringify(ctx.output("analyze"))}
      </Task>
    </Sequence>
  </Workflow>
));
