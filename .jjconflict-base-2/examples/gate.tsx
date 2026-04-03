/**
 * <Gate> — Block execution until an external condition is met (polling).
 *
 * Pattern: Check condition → wait → recheck → proceed when satisfied.
 * Use cases: CI status gates, deployment readiness, approval polling,
 * dependency availability, service health checks.
 */
import { Sequence, Loop } from "smithers-orchestrator";
import { createExampleSmithers } from "./_example-kit";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { bash } from "smithers-orchestrator/tools";
import { z } from "zod";
import CheckPrompt from "./prompts/gate/check.mdx";

const checkSchema = z.object({
  satisfied: z.boolean(),
  status: z.string(),
  details: z.string(),
  checkedAt: z.string(),
});

const gateSchema = z.object({
  passed: z.boolean(),
  totalChecks: z.number(),
  finalStatus: z.string(),
  summary: z.string(),
});

const { Workflow, Task, smithers, outputs } = createExampleSmithers({
  check: checkSchema,
  gate: gateSchema,
});

const checker = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { bash },
  instructions: `You are a status checker. Run the specified check command and determine
if the condition is satisfied. Be precise about the current status.`,
});

export default smithers((ctx) => {
  const checks = ctx.outputs.check ?? [];
  const latestCheck = checks[checks.length - 1];
  const satisfied = latestCheck?.satisfied ?? false;

  return (
    <Workflow name="gate">
      <Sequence>
        <Loop
          until={satisfied}
          maxIterations={ctx.input.maxChecks ?? 30}
          onMaxReached="return-last"
        >
          <Task id="check" output={outputs.check} agent={checker} timeoutMs={30_000}>
            <CheckPrompt
              condition={ctx.input.condition}
              checkCmd={ctx.input.checkCmd}
              previousStatus={latestCheck?.status ?? "not yet checked"}
              checkNumber={checks.length + 1}
            />
          </Task>
        </Loop>

        <Task id="gate" output={outputs.gate}>
          {{
            passed: satisfied,
            totalChecks: checks.length,
            finalStatus: latestCheck?.status ?? "never checked",
            summary: satisfied
              ? `Gate passed after ${checks.length} check(s)`
              : `Gate timed out after ${checks.length} check(s). Last status: ${latestCheck?.status ?? "unknown"}`,
          }}
        </Task>
      </Sequence>
    </Workflow>
  );
});
