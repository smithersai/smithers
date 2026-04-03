// @ts-nocheck
/**
 * <TestSharderJudge> — Use diff/context to select the most relevant tests first,
 * shard them across parallel runners, then adjudicate the results.
 *
 * Shape: change analyzer → test selector agent → sharded runners → result adjudicator.
 */
import { Sequence, Parallel } from "smithers-orchestrator";
import { createExampleSmithers } from "./_example-kit";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { read, bash, grep } from "smithers-orchestrator/tools";
import { z } from "zod";
import AnalyzePrompt from "./prompts/test-sharder-judge/analyze.mdx";
import SelectPrompt from "./prompts/test-sharder-judge/select.mdx";
import RunPrompt from "./prompts/test-sharder-judge/run.mdx";
import AdjudicatePrompt from "./prompts/test-sharder-judge/adjudicate.mdx";

const analysisSchema = z.object({
  changedFiles: z.array(z.string()),
  affectedModules: z.array(z.string()),
  riskLevel: z.enum(["low", "medium", "high"]),
});

const selectionSchema = z.object({
  priorityTests: z.array(z.object({
    file: z.string(),
    reason: z.string(),
    confidence: z.number().min(0).max(1),
  })),
  deferredTests: z.array(z.string()),
  totalCandidates: z.number(),
});

const runResultSchema = z.object({
  testFile: z.string(),
  status: z.enum(["pass", "fail", "error", "skipped"]),
  durationMs: z.number(),
  errorMessage: z.string().optional(),
});

const adjudicationSchema = z.object({
  verdict: z.enum(["green", "yellow", "red"]),
  failedTests: z.array(z.string()),
  deferredTests: z.array(z.string()),
  shouldExpandRun: z.boolean(),
  summary: z.string(),
});

const { Workflow, Task, smithers, outputs } = createExampleSmithers({
  analysis: analysisSchema,
  selection: selectionSchema,
  runResult: runResultSchema,
  adjudication: adjudicationSchema,
});

const changeAnalyzer = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { bash, grep, read },
  instructions: `You are a change analyzer. Inspect the diff and surrounding context
to determine which files changed, what modules are affected, and the overall risk level.`,
});

const testSelector = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { bash, grep, read },
  instructions: `You are a test selector. Given a change analysis, identify the highest-signal
tests to run first. Prioritize tests that directly cover changed code paths. Defer tests
that are unlikely to be affected.`,
});

const testRunner = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { bash, read },
  instructions: `You are a test runner. Execute the assigned test file and report the result.
Capture the status, duration, and any error messages.`,
});

const adjudicator = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  instructions: `You are a result adjudicator. Analyze test results and decide whether
the change is safe (green), uncertain and needs more tests (yellow), or broken (red).
If uncertainty remains, recommend expanding to deferred tests.`,
});

export default smithers((ctx) => {
  const selection = ctx.outputMaybe("selection", { nodeId: "select" });
  const results = ctx.outputs.runResult ?? [];

  return (
    <Workflow name="test-sharder-judge">
      <Sequence>
        {/* Step 1: Analyze the change to understand blast radius */}
        <Task id="analyze" output={outputs.analysis} agent={changeAnalyzer}>
          <AnalyzePrompt
            diff={ctx.input.diff}
            baseBranch={ctx.input.baseBranch ?? "main"}
          />
        </Task>

        {/* Step 2: Select highest-signal tests based on analysis */}
        <Task id="select" output={outputs.selection} agent={testSelector} deps={{ analyze: outputs.analysis }}>
          {(deps) => (
            <SelectPrompt
              changedFiles={deps.analyze.changedFiles}
              affectedModules={deps.analyze.affectedModules}
              riskLevel={deps.analyze.riskLevel}
              testGlob={ctx.input.testGlob ?? "**/*.test.{ts,tsx}"}
            />
          )}
        </Task>

        {/* Step 3: Shard priority tests across parallel runners */}
        {selection && (
          <Parallel maxConcurrency={ctx.input.maxConcurrency ?? 4}>
            {selection.priorityTests.map((test) => (
              <Task
                key={test.file}
                id={`run-${test.file}`}
                output={outputs.runResult}
                agent={testRunner}
                continueOnFail
                timeoutMs={ctx.input.timeoutMs ?? 60_000}
              >
                <RunPrompt
                  testFile={test.file}
                  reason={test.reason}
                  runner={ctx.input.runner ?? "npx vitest run"}
                />
              </Task>
            ))}
          </Parallel>
        )}

        {/* Step 4: Adjudicate results and decide next steps */}
        <Task id="adjudicate" output={outputs.adjudication} agent={adjudicator} deps={{ analyze: outputs.analysis, select: outputs.selection }}>
          {(deps) => (
            <AdjudicatePrompt
              results={results}
              deferredTests={deps.select.deferredTests}
              riskLevel={deps.analyze.riskLevel}
            />
          )}
        </Task>
      </Sequence>
    </Workflow>
  );
});
