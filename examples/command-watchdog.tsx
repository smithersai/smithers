// @ts-nocheck
/**
 * <CommandWatchdog> — Run a local or CI command on a schedule and only escalate
 * when exit code, output signature, timing, or diff becomes notable.
 *
 * Pattern: scheduler → command runner → anomaly/notability check → report agent.
 * Use cases: CI health watches, cron job monitoring, flaky-command alerting.
 */
import { createSmithers, Sequence, Loop } from "smithers-orchestrator";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { bash, read, grep } from "smithers-orchestrator/tools";
import { z } from "zod";
import RunPrompt from "./prompts/command-watchdog/run.mdx";
import DetectPrompt from "./prompts/command-watchdog/detect.mdx";
import ReportPrompt from "./prompts/command-watchdog/report.mdx";

const runResultSchema = z.object({
  exitCode: z.number(),
  durationMs: z.number(),
  outputSignature: z.string(),
  stdoutTail: z.string(),
  iteration: z.number(),
});

const notabilitySchema = z.object({
  notable: z.boolean(),
  reasons: z.array(z.string()),
  exitCodeChanged: z.boolean(),
  durationDeltaPercent: z.number(),
  signatureChanged: z.boolean(),
  diffSummary: z.string(),
});

const reportSchema = z.object({
  status: z.enum(["steady", "escalated"]),
  anomalies: z.array(z.string()),
  runCount: z.number(),
  summary: z.string(),
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  run: runResultSchema,
  notability: notabilitySchema,
  report: reportSchema,
});

const runner = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { bash },
  instructions: `You are a command executor. Run the given command, capture its exit code,
measure wall-clock duration, and produce a short signature of the output (e.g. hash of
key lines or a recognisable fingerprint). Return the structured result.`,
});

const detector = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { bash, read, grep },
  instructions: `You are an anomaly detector. Compare the latest command run against previous
runs. Flag anything notable: non-zero exit codes, duration regressions beyond threshold,
changed output signatures, or meaningful diffs in stdout. Be precise about why something
is notable and avoid false positives.`,
});

const reporter = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read },
  instructions: `You are an escalation reporter. Summarise the anomalies detected during
the watchdog loop into a concise, actionable report suitable for on-call engineers or
CI dashboards. Include root-cause hints when possible.`,
});

export default smithers((ctx) => {
  const runs = ctx.outputs.run ?? [];
  const latestRun = runs[runs.length - 1];
  const previousRun = runs.length >= 2 ? runs[runs.length - 2] : undefined;
  const notability = ctx.outputMaybe("notability", { nodeId: "detect" });
  const maxRuns = ctx.input.maxRuns ?? 5;
  const thresholdPercent = ctx.input.thresholdPercent ?? 25;
  const shouldEscalate = notability?.notable ?? false;

  return (
    <Workflow name="command-watchdog">
      <Sequence>
        <Loop
          until={shouldEscalate}
          maxIterations={maxRuns}
          onMaxReached="return-last"
        >
          <Sequence>
            <Task id="run" output={outputs.run} agent={runner}>
              <RunPrompt
                command={ctx.input.command}
                iteration={runs.length + 1}
                previousDurationMs={latestRun?.durationMs ?? "none"}
                previousExitCode={latestRun?.exitCode ?? "none"}
              />
            </Task>

            <Task id="detect" output={outputs.notability} agent={detector}>
              <DetectPrompt
                current={latestRun}
                previous={previousRun}
                thresholdPercent={thresholdPercent}
                command={ctx.input.command}
                iteration={runs.length}
              />
            </Task>
          </Sequence>
        </Loop>

        <Task
          id="report"
          output={outputs.report}
          agent={reporter}
          skipIf={!shouldEscalate}
        >
          <ReportPrompt
            command={ctx.input.command}
            notable={shouldEscalate}
            reasons={notability?.reasons ?? []}
            runs={runs}
            diffSummary={notability?.diffSummary ?? ""}
          />
        </Task>

        <Task id="steady" output={outputs.report} skipIf={shouldEscalate}>
          {{
            status: "steady",
            anomalies: [],
            runCount: runs.length,
            summary: `${ctx.input.command} ran ${runs.length} times with no notable anomalies`,
          }}
        </Task>
      </Sequence>
    </Workflow>
  );
});
