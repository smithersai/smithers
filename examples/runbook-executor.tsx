// @ts-nocheck
/**
 * <RunbookExecutor> — Execute safe runbook steps automatically, pause on risky steps for approval.
 *
 * Pattern: Orchestrator → tool steps → approval checkpoints → operator/agent notes.
 * Use cases: incident response, maintenance windows, deployment runbooks,
 * infrastructure changes, database migrations with manual gates.
 */
import { createSmithers, Sequence, Loop } from "smithers-orchestrator";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { read, write, bash, grep } from "smithers-orchestrator/tools";
import { z } from "zod";
import ClassifyPrompt from "./prompts/runbook-executor/classify.mdx";
import ExecutePrompt from "./prompts/runbook-executor/execute.mdx";
import ReviewPrompt from "./prompts/runbook-executor/review.mdx";

const stepSchema = z.object({
  name: z.string(),
  risk: z.enum(["safe", "risky"]),
  command: z.string().describe("Shell command or action to perform"),
  reason: z.string().describe("Why this step is safe or risky"),
});

const classifySchema = z.object({
  steps: z.array(stepSchema),
  totalSafe: z.number(),
  totalRisky: z.number(),
  summary: z.string(),
});

const executeSchema = z.object({
  stepName: z.string(),
  success: z.boolean(),
  output: z.string(),
  durationMs: z.number(),
  notes: z.string().describe("Operator-relevant observations from execution"),
});

const approvalDecisionSchema = z.object({
  approved: z.boolean(),
  approvedBy: z.string(),
  note: z.string(),
});

const reviewSchema = z.object({
  allPassed: z.boolean(),
  stepsExecuted: z.number(),
  stepsFailed: z.number(),
  stepsSkipped: z.number(),
  operatorNotes: z.array(z.string()),
  summary: z.string(),
});

const { Workflow, Task, Approval, smithers, outputs } = createSmithers({
  classify: classifySchema,
  execute: executeSchema,
  approval: approvalDecisionSchema,
  review: reviewSchema,
});

const classifier = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, bash },
  instructions: `You are a runbook analyst. Classify each step as safe or risky based on
its blast radius, reversibility, and impact on production state. Be conservative —
anything that modifies state or could cause downtime is risky.`,
});

const executor = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, write, bash, grep },
  instructions: `You are a runbook executor. Run the given step carefully and report the
outcome. Capture all relevant output. If a step fails, do NOT retry — report the failure
and let the orchestrator decide.`,
});

export default smithers((ctx) => {
  const classification = ctx.outputMaybe("classify", { nodeId: "classify" });
  const executions = ctx.outputs.execute ?? [];
  const approval = ctx.outputMaybe("approval", { nodeId: "approve-risky" });

  const safeSteps = classification?.steps.filter((s) => s.risk === "safe") ?? [];
  const riskySteps = classification?.steps.filter((s) => s.risk === "risky") ?? [];

  const safeIndex = executions.filter((e) =>
    safeSteps.some((s) => s.name === e.stepName)
  ).length;
  const allSafeDone = safeIndex >= safeSteps.length;

  const riskyIndex = executions.filter((e) =>
    riskySteps.some((s) => s.name === e.stepName)
  ).length;
  const allRiskyDone = riskyIndex >= riskySteps.length;

  const currentSafe = safeSteps[safeIndex];
  const currentRisky = riskySteps[riskyIndex];

  return (
    <Workflow name="runbook-executor">
      <Sequence>
        {/* Step 1: Classify all runbook steps by risk */}
        <Task id="classify" output={outputs.classify} agent={classifier}>
          <ClassifyPrompt
            runbook={ctx.input.runbook}
            steps={ctx.input.steps}
            environment={ctx.input.environment ?? "production"}
          />
        </Task>

        {/* Step 2: Execute safe steps automatically in a loop */}
        <Loop until={allSafeDone} maxIterations={safeSteps.length || 1} onMaxReached="return-last">
          <Task id="execute" output={outputs.execute} agent={executor}>
            <ExecutePrompt
              step={currentSafe}
              index={safeIndex + 1}
              total={safeSteps.length}
              mode="auto"
              environment={ctx.input.environment ?? "production"}
              previousResults={executions}
            />
          </Task>
        </Loop>

        {/* Step 3: Pause for operator approval before risky steps */}
        <Approval
          id="approve-risky"
          output={outputs.approval}
          request={{
            title: "Approve risky runbook steps",
            summary: `${riskySteps.length} risky step(s) require approval: ${riskySteps.map((s) => s.name).join(", ")}`,
          }}
          skipIf={riskySteps.length === 0}
        />

        {/* Step 4: Execute approved risky steps in a loop */}
        <Loop
          until={allRiskyDone}
          maxIterations={riskySteps.length || 1}
          onMaxReached="return-last"
          skipIf={!approval?.approved || riskySteps.length === 0}
        >
          <Task id="execute" output={outputs.execute} agent={executor}>
            <ExecutePrompt
              step={currentRisky}
              index={riskyIndex + 1}
              total={riskySteps.length}
              mode="approved"
              environment={ctx.input.environment ?? "production"}
              previousResults={executions}
              approvalNote={approval?.note}
            />
          </Task>
        </Loop>

        {/* Step 5: Review and produce operator notes */}
        <Task id="review" output={outputs.review} agent={classifier}>
          <ReviewPrompt
            executions={executions}
            classification={classification}
            approval={approval}
            environment={ctx.input.environment ?? "production"}
          />
        </Task>
      </Sequence>
    </Workflow>
  );
});
