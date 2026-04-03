// @ts-nocheck
/**
 * <RetryBudgetManager> — Track retry budgets across steps, adapt backoff/routing
 * based on failure class, and escalate when continuing is wasteful.
 *
 * Pattern: step runner ↔ retry policy controller → escalation/approval.
 * Use cases: API call retries, job queue resilience, payment processing retry logic.
 */
import { Sequence, Loop } from "smithers-orchestrator";
import { createExampleSmithers } from "./_example-kit";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { read, write, bash, grep } from "smithers-orchestrator/tools";
import { z } from "zod";
import StepRunnerPrompt from "./prompts/retry-budget-manager/step-runner.mdx";
import PolicyPrompt from "./prompts/retry-budget-manager/policy.mdx";
import EscalationPrompt from "./prompts/retry-budget-manager/escalation.mdx";

const failureClass = z.enum(["transient", "persistent", "quota", "timeout", "unknown"]);

const stepResultSchema = z.object({
  stepName: z.string(),
  success: z.boolean(),
  failureClass: failureClass.optional(),
  errorMessage: z.string().optional(),
  latencyMs: z.number(),
  attempt: z.number(),
});

const policyDecisionSchema = z.object({
  shouldRetry: z.boolean(),
  backoffMs: z.number(),
  budgetRemaining: z.number(),
  budgetSpent: z.number(),
  reasoning: z.string(),
  routeOverride: z.string().optional(),
  escalate: z.boolean(),
});

const escalationSchema = z.object({
  severity: z.enum(["low", "medium", "high", "critical"]),
  recommendation: z.enum(["retry-with-approval", "skip-step", "abort-workflow", "fallback-route"]),
  summary: z.string(),
  budgetAnalysis: z.string(),
  failureBreakdown: z.array(z.object({
    failureClass,
    count: z.number(),
    percentage: z.number(),
  })),
});

const reportSchema = z.object({
  totalAttempts: z.number(),
  successfulSteps: z.number(),
  failedSteps: z.number(),
  budgetUsed: z.number(),
  budgetTotal: z.number(),
  escalated: z.boolean(),
  summary: z.string(),
});

const { Workflow, Task, smithers, outputs } = createExampleSmithers({
  stepResult: stepResultSchema,
  policy: policyDecisionSchema,
  escalation: escalationSchema,
  report: reportSchema,
});

const stepRunner = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { bash, read, grep },
  instructions: `You are a step executor. Run the given step, capture its result including
latency and any error details. Classify failures accurately: transient (network blips,
temporary unavailability), persistent (bad config, missing resource), quota (rate limits,
capacity), timeout (deadline exceeded). Report honestly — never mask failures.`,
});

const policyController = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read },
  instructions: `You are a retry policy controller. Analyse the failure class, remaining budget,
and history of previous attempts. Use exponential backoff for transient failures, immediate
escalation for persistent ones, and cooldown periods for quota errors. Be conservative —
wasting budget on hopeless retries is worse than escalating early.`,
});

const escalationAgent = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { read, write },
  instructions: `You are an escalation analyst. When the retry budget is exhausted or the
policy controller flags escalation, produce a clear severity assessment, a concrete
recommendation, and a breakdown of failure classes observed. Be actionable and concise.`,
});

export default smithers((ctx) => {
  const budget = ctx.input.budget ?? 5;
  const stepResults = ctx.outputs.stepResult ?? [];
  const policies = ctx.outputs.policy ?? [];
  const latestPolicy = policies[policies.length - 1];
  const latestEscalation = ctx.outputs.escalation?.[ctx.outputs.escalation.length - 1];

  const budgetExhausted = (latestPolicy?.budgetRemaining ?? budget) <= 0;
  const shouldEscalate = latestPolicy?.escalate ?? false;
  const allSucceeded = stepResults.length > 0 && stepResults[stepResults.length - 1]?.success === true;
  const stopLoop = allSucceeded || budgetExhausted || shouldEscalate;

  return (
    <Workflow name="retry-budget-manager">
      <Sequence>
        <Loop until={stopLoop} maxIterations={budget} onMaxReached="return-last">
          <Sequence>
            <Task id="step" output={outputs.stepResult} agent={stepRunner}>
              <StepRunnerPrompt
                stepName={ctx.input.stepName ?? "default-step"}
                command={ctx.input.command}
                attempt={stepResults.length + 1}
                budgetTotal={budget}
                budgetRemaining={latestPolicy?.budgetRemaining ?? budget}
                routeOverride={latestPolicy?.routeOverride}
                previousError={stepResults[stepResults.length - 1]?.errorMessage}
              />
            </Task>

            <Task
              id="policy"
              output={outputs.policy}
              agent={policyController}
              skipIf={stepResults[stepResults.length - 1]?.success ?? false}
            >
              <PolicyPrompt
                stepResult={stepResults[stepResults.length - 1]}
                attempt={stepResults.length}
                budgetTotal={budget}
                budgetSpent={stepResults.length}
                history={stepResults}
              />
            </Task>
          </Sequence>
        </Loop>

        <Task
          id="escalation"
          output={outputs.escalation}
          agent={escalationAgent}
          skipIf={allSucceeded}
        >
          <EscalationPrompt
            stepName={ctx.input.stepName ?? "default-step"}
            stepResults={stepResults}
            policies={policies}
            budgetTotal={budget}
            budgetUsed={stepResults.length}
          />
        </Task>

        <Task id="report" output={outputs.report}>
          {{
            totalAttempts: stepResults.length,
            successfulSteps: stepResults.filter((r) => r.success).length,
            failedSteps: stepResults.filter((r) => !r.success).length,
            budgetUsed: stepResults.length,
            budgetTotal: budget,
            escalated: !allSucceeded,
            summary: allSucceeded
              ? `Step "${ctx.input.stepName ?? "default-step"}" succeeded after ${stepResults.length} attempt(s)`
              : `Exhausted ${stepResults.length}/${budget} retries — escalated as ${latestEscalation?.severity ?? "unknown"}: ${latestEscalation?.recommendation ?? "abort-workflow"}`,
          }}
        </Task>
      </Sequence>
    </Workflow>
  );
});
