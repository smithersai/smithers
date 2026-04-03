// @ts-nocheck
/**
 * <FailOnlyReport> — Run commands and only invoke an agent when a run fails,
 * regresses, or produces a notable delta. Green runs stay cheap and quiet;
 * red runs get a useful root-cause report.
 *
 * Shape: trigger → shell runner → artifact collector → notable-event detector
 *        → report agent → sink (PR comment, Slack, issue).
 */
import { Sequence, Parallel, Branch } from "smithers-orchestrator";
import { createExampleSmithers } from "./_example-kit";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { bash, read } from "smithers-orchestrator/tools";
import { z } from "zod";
import RunPrompt from "./prompts/fail-only-report/run.mdx";
import AnalyzePrompt from "./prompts/fail-only-report/analyze.mdx";
import ReportPrompt from "./prompts/fail-only-report/report.mdx";

const runResultSchema = z.object({
  command: z.string(),
  exitCode: z.number(),
  stdout: z.string(),
  stderr: z.string(),
  durationMs: z.number(),
});

const analysisSchema = z.object({
  notable: z.boolean(),
  failingCommands: z.array(z.string()),
  regressingCommands: z.array(z.string()),
  artifacts: z.array(
    z.object({
      command: z.string(),
      category: z.enum(["failure", "regression", "delta"]),
      snippet: z.string(),
    }),
  ),
  summary: z.string(),
});

const reportSchema = z.object({
  rootCauses: z.array(
    z.object({
      command: z.string(),
      hypothesis: z.string(),
      confidence: z.enum(["high", "medium", "low"]),
      suggestedFix: z.string(),
    }),
  ),
  overallSummary: z.string(),
  sinkPayload: z.string(),
});

const sinkSchema = z.object({
  status: z.enum(["quiet", "reported"]),
  destination: z.string(),
  summary: z.string(),
});

const { Workflow, Task, smithers, outputs } = createExampleSmithers({
  run: runResultSchema,
  analysis: analysisSchema,
  report: reportSchema,
  sink: sinkSchema,
});

const runnerAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { bash, read },
  instructions: `You are a command runner. Execute commands exactly as specified,
capture their full stdout, stderr, and exit code. Do not fix or retry failures —
just observe and report accurately.`,
});

const analyzerAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read },
  instructions: `You are a CI artifact analyst. Examine command outputs to detect
failures, regressions, and notable deltas. Be precise: a non-zero exit code is
always notable, but also look for regression markers in stdout/stderr.`,
});

const reportAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { bash, read },
  instructions: `You are a failure analyst. Given notable CI events, produce
root-cause hypotheses with confidence levels and actionable next steps.
Keep reports concise and suitable for a PR comment or Slack message.`,
});

export default smithers((ctx) => {
  const runs = ctx.outputs.run ?? [];
  const analysis = ctx.outputMaybe("analysis", { nodeId: "analyze" });
  const report = ctx.outputMaybe("report", { nodeId: "report" });

  const commands = ctx.input.commands ?? [
    { name: "pytest", cmd: "pytest -q" },
    { name: "lint", cmd: "ruff check ." },
    { name: "typecheck", cmd: "npx tsc --noEmit" },
  ];

  const notable = analysis?.notable ?? false;

  return (
    <Workflow name="fail-only-report">
      <Sequence>
        {/* Stage 1: Run all commands in parallel */}
        <Parallel maxConcurrency={ctx.input.maxParallel ?? 4}>
          {commands.map((command: { name: string; cmd: string }) => (
            <Task
              key={command.name}
              id={`run-${command.name}`}
              output={outputs.run}
              agent={runnerAgent}
              continueOnFail
              timeoutMs={ctx.input.timeoutMs ?? 300_000}
            >
              <RunPrompt
                command={command.cmd}
                directory={ctx.input.directory ?? "."}
              />
            </Task>
          ))}
        </Parallel>

        {/* Stage 2: Collect artifacts and detect notable events */}
        <Task id="analyze" output={outputs.analysis} agent={analyzerAgent}>
          <AnalyzePrompt
            results={JSON.stringify(
              runs.map((r) => ({
                command: r.command,
                exitCode: r.exitCode,
                stdout: r.stdout.slice(0, 2000),
                stderr: r.stderr.slice(0, 2000),
                durationMs: r.durationMs,
              })),
            )}
          />
        </Task>

        {/* Stage 3: Branch — skip the expensive report agent on green runs */}
        <Branch
          if={notable}
          then={
            <Sequence>
              <Task id="report" output={outputs.report} agent={reportAgent}>
                <ReportPrompt
                  notableCommands={JSON.stringify(
                    [
                      ...(analysis?.failingCommands ?? []),
                      ...(analysis?.regressingCommands ?? []),
                    ],
                  )}
                  failureOutput={JSON.stringify(analysis?.artifacts ?? [])}
                />
              </Task>

              <Task id="sink-report" output={outputs.sink}>
                {{
                  status: "reported" as const,
                  destination: String(ctx.input.sink ?? "pr-comment"),
                  summary: report?.overallSummary ?? "Report generated for notable failures",
                }}
              </Task>
            </Sequence>
          }
          else={
            <Task id="sink-quiet" output={outputs.sink}>
              {{
                status: "quiet" as const,
                destination: String(ctx.input.sink ?? "pr-comment"),
                summary: `All ${runs.length} commands passed — no report needed`,
              }}
            </Task>
          }
        />
      </Sequence>
    </Workflow>
  );
});
