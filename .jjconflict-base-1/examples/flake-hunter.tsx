// @ts-nocheck
/**
 * <FlakeHunter> — Rerun a failing test under controlled variants and produce
 * a flakiness report when outcomes diverge.
 *
 * Pattern: command runner ↔ retry controller → evidence packer → analyst agent.
 * Use cases: CI flake detection, intermittent failure classification, test stability audits.
 */
import { Sequence, Loop } from "smithers-orchestrator";
import { createExampleSmithers } from "./_example-kit";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { read, bash, grep } from "smithers-orchestrator/tools";
import { z } from "zod";
import RunPrompt from "./prompts/flake-hunter/run.mdx";
import PackPrompt from "./prompts/flake-hunter/pack.mdx";
import AnalyzePrompt from "./prompts/flake-hunter/analyze.mdx";

const runResultSchema = z.object({
  attempt: z.number(),
  outcome: z.enum(["pass", "fail"]),
  exitCode: z.number(),
  durationMs: z.number(),
  stdout: z.string(),
  stderr: z.string(),
  signature: z.string().describe("Short fingerprint of the failure, e.g. error message or stack trace head"),
});

const evidenceSchema = z.object({
  totalRuns: z.number(),
  passes: z.number(),
  failures: z.number(),
  uniqueSignatures: z.array(z.string()),
  divergent: z.boolean(),
  runs: z.array(z.object({
    attempt: z.number(),
    outcome: z.enum(["pass", "fail"]),
    signature: z.string(),
    durationMs: z.number(),
  })),
});

const reportSchema = z.object({
  classification: z.enum(["flaky", "consistent-pass", "consistent-fail"]),
  confidence: z.number().min(0).max(1),
  flakeRate: z.number().min(0).max(1),
  rootCauseCandidates: z.array(z.string()),
  recommendation: z.string(),
  summary: z.string(),
});

const { Workflow, Task, smithers, outputs } = createExampleSmithers({
  runResult: runResultSchema,
  evidence: evidenceSchema,
  report: reportSchema,
});

const commandRunner = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { bash },
  instructions: `You are a test runner. Execute the provided test command exactly as given.
Capture stdout, stderr, exit code, and wall-clock duration. Parse the output to extract
a short failure signature (the key error message or stack trace head). Do not modify the command.`,
});

const analyst = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, bash, grep },
  instructions: `You are a flake analyst. Examine the evidence from multiple test runs.
Identify patterns in timing, error signatures, and environmental factors that explain
divergent outcomes. Be specific about root-cause candidates and actionable in recommendations.`,
});

export default smithers((ctx) => {
  const maxRuns = ctx.input.runs ?? 5;
  const results = ctx.outputs.runResult ?? [];
  const passes = results.filter((r) => r.outcome === "pass").length;
  const failures = results.filter((r) => r.outcome === "fail").length;
  const uniqueSignatures = [...new Set(results.map((r) => r.signature))];
  const divergent = passes > 0 && failures > 0;
  const finished = results.length >= maxRuns;

  return (
    <Workflow name="flake-hunter">
      <Sequence>
        {/* Phase 1: Retry controller — rerun the test command N times */}
        <Loop until={finished} maxIterations={maxRuns} onMaxReached="return-last">
          <Task id="runResult" output={outputs.runResult} agent={commandRunner}>
            <RunPrompt
              command={ctx.input.command}
              attempt={results.length + 1}
              maxRuns={maxRuns}
              previousOutcome={results[results.length - 1]?.outcome ?? "none"}
            />
          </Task>
        </Loop>

        {/* Phase 2: Evidence packer — collate run data into a summary */}
        <Task id="evidence" output={outputs.evidence}>
          {{
            totalRuns: results.length,
            passes,
            failures,
            uniqueSignatures,
            divergent,
            runs: results.map((r) => ({
              attempt: r.attempt,
              outcome: r.outcome,
              signature: r.signature,
              durationMs: r.durationMs,
            })),
          }}
        </Task>

        {/* Phase 3: Analyst agent — examine divergent outcomes and produce report */}
        <Task id="report-analysis" output={outputs.report} agent={analyst} skipIf={!divergent}>
          <AnalyzePrompt
            command={ctx.input.command}
            evidence={ctx.outputs.evidence}
            divergent={divergent}
          />
        </Task>

        {/* Fallback: consistent result — no analyst needed */}
        <Task id="report-static" output={outputs.report} skipIf={divergent}>
          {{
            classification: passes === results.length ? "consistent-pass" : "consistent-fail",
            confidence: 1.0,
            flakeRate: passes === results.length ? 0 : 1,
            rootCauseCandidates: [],
            recommendation: passes === results.length
              ? "Test passes consistently — original failure may have been environmental."
              : `Test fails consistently with signature: ${uniqueSignatures[0] ?? "unknown"}`,
            summary: `${results.length} runs, all ${passes === results.length ? "passed" : "failed"}. No flakiness detected.`,
          }}
        </Task>
      </Sequence>
    </Workflow>
  );
});
