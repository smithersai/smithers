// @ts-nocheck
/**
 * <BenchmarkSheriff> — Run benchmarks against a stored baseline and only ask
 * an agent to explain when metrics move materially.
 *
 * Shape: benchmark runner → metric diff → threshold gate → analysis agent.
 */
import { Sequence } from "smithers-orchestrator";
import { createExampleSmithers } from "./_example-kit";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { bash } from "smithers-orchestrator/tools";
import { z } from "zod";
import RunPrompt from "./prompts/benchmark-sheriff/run.mdx";
import AnalyzePrompt from "./prompts/benchmark-sheriff/analyze.mdx";

const runSchema = z.object({
  benchmarks: z.array(
    z.object({
      name: z.string(),
      valueMs: z.number(),
    }),
  ),
  raw: z.string(),
});

const diffSchema = z.object({
  regressions: z.array(
    z.object({
      name: z.string(),
      baselineMs: z.number(),
      currentMs: z.number(),
      deltaPercent: z.number(),
    }),
  ),
  exceeded: z.boolean(),
});

const analysisSchema = z.object({
  findings: z.array(
    z.object({
      benchmark: z.string(),
      likelyCause: z.string(),
      severity: z.enum(["low", "medium", "high"]),
    }),
  ),
  summary: z.string(),
});

const outputSchema = z.object({
  status: z.enum(["clean", "regressed"]),
  regressionCount: z.number(),
  summary: z.string(),
});

const { Workflow, Task, Branch, smithers, outputs } = createExampleSmithers({
  run: runSchema,
  diff: diffSchema,
  analysis: analysisSchema,
  output: outputSchema,
});

const runner = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { bash },
  instructions: `You are a benchmark runner. Execute the given benchmark command,
parse the output, and return structured metric values.`,
});

const analyst = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { bash },
  instructions: `You are a performance analyst. Given benchmark regressions,
investigate root causes by inspecting recent changes, resource usage, or
measurement methodology. Be specific and actionable.`,
});

export default smithers((ctx) => {
  const threshold = Number(ctx.input.thresholdPercent ?? 5);
  const baseline: Array<{ name: string; valueMs: number }> =
    ctx.input.baseline ?? [];
  const runResult = ctx.outputMaybe("run", { nodeId: "run-benchmarks" });
  const diffResult = ctx.outputMaybe("diff", { nodeId: "compute-diff" });

  const regressions = baseline
    .map((b) => {
      const current = runResult?.benchmarks.find(
        (r: { name: string }) => r.name === b.name,
      );
      if (!current) return null;
      const delta = ((current.valueMs - b.valueMs) / b.valueMs) * 100;
      return {
        name: b.name,
        baselineMs: b.valueMs,
        currentMs: current.valueMs,
        deltaPercent: Math.round(delta * 100) / 100,
      };
    })
    .filter(
      (r): r is NonNullable<typeof r> => r !== null && r.deltaPercent >= threshold,
    );

  const exceeded = regressions.length > 0;

  return (
    <Workflow name="benchmark-sheriff">
      <Sequence>
        <Task id="run-benchmarks" output={outputs.run} agent={runner}>
          <RunPrompt
            command={ctx.input.command ?? "npm run bench"}
            cwd={ctx.input.cwd ?? "."}
          />
        </Task>

        <Task id="compute-diff" output={outputs.diff}>
          {{
            regressions,
            exceeded,
          }}
        </Task>

        <Branch
          if={diffResult?.exceeded ?? false}
          then={
            <Sequence>
              <Task id="analyze" output={outputs.analysis} agent={analyst}>
                <AnalyzePrompt
                  threshold={threshold}
                  regressions={JSON.stringify(regressions, null, 2)}
                />
              </Task>

              <Task id="result-regressed" output={outputs.output}>
                {{
                  status: "regressed" as const,
                  regressionCount: regressions.length,
                  summary: `${regressions.length} benchmark(s) exceeded the ${threshold}% threshold`,
                }}
              </Task>
            </Sequence>
          }
          else={
            <Task id="result-clean" output={outputs.output}>
              {{
                status: "clean" as const,
                regressionCount: 0,
                summary: `All benchmarks within the ${threshold}% threshold`,
              }}
            </Task>
          }
        />
      </Sequence>
    </Workflow>
  );
});
