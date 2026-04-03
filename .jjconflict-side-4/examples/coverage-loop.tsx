/**
 * <CoverageLoop> — Run tests → measure coverage → write tests → repeat until target.
 *
 * Pattern: Iterative quality improvement loop with measurable convergence.
 * Use cases: test coverage, type coverage, lint fixes, accessibility score.
 */
import { Sequence, Loop } from "smithers-orchestrator";
import { createExampleSmithers } from "./_example-kit";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { read, write, bash, grep } from "smithers-orchestrator/tools";
import { z } from "zod";
import MeasurePrompt from "./prompts/coverage-loop/measure.mdx";
import FixPrompt from "./prompts/coverage-loop/fix.mdx";

const measureSchema = z.object({
  coverage: z.number(),
  uncoveredFiles: z.array(z.object({
    file: z.string(),
    coverage: z.number(),
    uncoveredLines: z.array(z.number()),
  })),
  totalFiles: z.number(),
});

const fixSchema = z.object({
  testsWritten: z.number(),
  filesCreated: z.array(z.string()),
  expectedCoverageGain: z.number(),
  summary: z.string(),
});

const reportSchema = z.object({
  initialCoverage: z.number(),
  finalCoverage: z.number(),
  totalTestsWritten: z.number(),
  iterations: z.number(),
  summary: z.string(),
});

const { Workflow, Task, smithers, outputs } = createExampleSmithers({
  measure: measureSchema,
  fix: fixSchema,
  report: reportSchema,
});

const measurer = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { bash },
  instructions: `You are a coverage analyst. Run the test suite with coverage enabled
and parse the output to identify uncovered files and lines. Be precise with numbers.`,
});

const testWriter = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, write, bash, grep },
  instructions: `You are a test engineer. Write focused, minimal test cases to cover
the uncovered lines. Prefer testing behavior over implementation. Write 2-3 test files per iteration.
Make atomic commits after writing each test file.`,
});

export default smithers((ctx) => {
  const target = ctx.input.target ?? 90;
  const measures = ctx.outputs.measure ?? [];
  const fixes = ctx.outputs.fix ?? [];
  const latestMeasure = measures[measures.length - 1];
  const hitTarget = (latestMeasure?.coverage ?? 0) >= target;

  return (
    <Workflow name="coverage-loop">
      <Sequence>
        <Loop until={hitTarget} maxIterations={ctx.input.maxIterations ?? 10} onMaxReached="return-last">
          <Sequence>
            <Task id="measure" output={outputs.measure} agent={measurer}>
              <MeasurePrompt
                directory={ctx.input.directory}
                coverageCmd={ctx.input.coverageCmd ?? "npx vitest --coverage --reporter=json"}
                target={target}
                current={latestMeasure?.coverage ?? "unknown"}
              />
            </Task>

            <Task id="fix" output={outputs.fix} agent={testWriter} skipIf={hitTarget}>
              <FixPrompt
                current={latestMeasure?.coverage ?? 0}
                target={target}
                uncoveredFiles={latestMeasure?.uncoveredFiles?.slice(0, 5) ?? []}
                directory={ctx.input.directory}
              />
            </Task>
          </Sequence>
        </Loop>

        <Task id="report" output={outputs.report}>
          {{
            initialCoverage: measures[0]?.coverage ?? 0,
            finalCoverage: latestMeasure?.coverage ?? 0,
            totalTestsWritten: fixes.reduce((sum, f) => sum + f.testsWritten, 0),
            iterations: measures.length,
            summary: `Coverage: ${measures[0]?.coverage ?? 0}% → ${latestMeasure?.coverage ?? 0}% over ${measures.length} iterations (target: ${target}%)`,
          }}
        </Task>
      </Sequence>
    </Workflow>
  );
});
