// @ts-nocheck
/**
 * <MCPHealthProbe> — Periodically exercise MCP servers/tools, detect outages
 * or capability drift, and report only when something changed materially.
 *
 * Pattern: scheduler -> MCP probe set -> result checker -> report agent
 * Use cases: MCP fleet health monitoring, capability drift detection, outage alerting.
 */
import { createSmithers, Sequence, Parallel, Loop } from "smithers-orchestrator";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { read, write, bash, grep } from "smithers-orchestrator/tools";
import { z } from "zod";
import SchedulePrompt from "./prompts/mcp-health-probe/schedule.mdx";
import ProbePrompt from "./prompts/mcp-health-probe/probe.mdx";
import CheckPrompt from "./prompts/mcp-health-probe/check.mdx";
import ReportPrompt from "./prompts/mcp-health-probe/report.mdx";

const probeResultSchema = z.object({
  server: z.string(),
  healthy: z.boolean(),
  latencyMs: z.number(),
  capabilities: z.array(z.string()),
  capabilityDrift: z.boolean(),
  driftDetails: z.string().optional(),
  error: z.string().optional(),
});

const checkSchema = z.object({
  materialChange: z.boolean(),
  unhealthyServers: z.array(z.string()),
  driftedServers: z.array(z.string()),
  newIssues: z.array(z.string()),
  resolvedIssues: z.array(z.string()),
});

const reportSchema = z.object({
  reported: z.boolean(),
  summary: z.string(),
  details: z.string(),
  recommendations: z.array(z.string()),
});

const scheduleSchema = z.object({
  shouldProbe: z.boolean(),
  reason: z.string(),
  intervalMs: z.number(),
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  schedule: scheduleSchema,
  probe: probeResultSchema,
  check: checkSchema,
  report: reportSchema,
});

const scheduler = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { bash },
  instructions: `You are a scheduling agent. Determine whether it is time to probe
MCP servers based on the configured interval and last probe timestamp. Check system
time and compare against the last run.`,
});

const prober = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { bash, read },
  instructions: `You are an MCP health prober. Exercise the given MCP server by listing
its tools and invoking a lightweight canary call. Measure latency, check whether the
tool list matches the known baseline, and flag any capability drift. Be precise with
latency measurements and capability comparisons.`,
});

const checker = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, grep },
  instructions: `You are a results analyst. Compare the current probe results against
the previous baseline. Determine whether any change is material — an outage, a new
capability appearing or disappearing, or a latency regression beyond the threshold.
Only flag material changes; ignore noise.`,
});

const reporter = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, write, bash },
  instructions: `You are a concise incident reporter. When material changes are detected,
produce a clear, actionable report with specific recommendations. If nothing material
changed, produce a short "all clear" note. Write reports to the configured output path.`,
});

export default smithers((ctx) => {
  const servers: string[] = ctx.input.servers ?? [];
  const probes = ctx.outputs.probe ?? [];
  const latestCheck = ctx.outputs.check?.[ctx.outputs.check.length - 1];
  const noMaterialChange = latestCheck?.materialChange === false;

  return (
    <Workflow name="mcp-health-probe">
      <Loop
        until={noMaterialChange}
        maxIterations={ctx.input.maxIterations ?? 5}
        onMaxReached="return-last"
      >
        <Sequence>
          <Task id="schedule" output={outputs.schedule} agent={scheduler}>
            <SchedulePrompt
              intervalMs={ctx.input.intervalMs ?? 300_000}
              lastRun={ctx.input.lastRun}
              iteration={ctx.outputs.schedule?.length ?? 0}
            />
          </Task>

          <Parallel maxConcurrency={ctx.input.maxConcurrency ?? 5}>
            {servers.map((server: string) => (
              <Task
                key={server}
                id={`probe-${server}`}
                output={outputs.probe}
                agent={prober}
              >
                <ProbePrompt
                  server={server}
                  baselineCapabilities={ctx.input.baselines?.[server] ?? []}
                  latencyThresholdMs={ctx.input.latencyThresholdMs ?? 5000}
                />
              </Task>
            ))}
          </Parallel>

          <Task id="check" output={outputs.check} agent={checker}>
            <CheckPrompt
              probeResults={probes}
              previousBaseline={ctx.input.previousBaseline}
              latencyThresholdMs={ctx.input.latencyThresholdMs ?? 5000}
            />
          </Task>

          <Task
            id="report"
            output={outputs.report}
            agent={reporter}
            skipIf={noMaterialChange}
          >
            <ReportPrompt
              check={latestCheck}
              probeResults={probes}
              outputPath={ctx.input.outputPath ?? "./mcp-health-report.md"}
              notifyChannel={ctx.input.notifyChannel}
            />
          </Task>
        </Sequence>
      </Loop>
    </Workflow>
  );
});
