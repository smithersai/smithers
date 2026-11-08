/**
 * Retry a step within a budget, letting a policy agent decide each retry, and escalate when it gives up.
 *
 * Port of the 0.x `retry-budget-manager.jsx`. A step runner agent runs the
 * step and classifies any failure. After a failure a policy controller agent
 * decides the backoff, the budget left, any route override and whether to
 * escalate; the next attempt is told its decision and the previous error. The
 * loop stops when the step succeeds, when the policy reports no budget left or
 * asks to escalate, or after `budget` attempts (default 5). Unless the step
 * succeeded, an escalation agent assesses the run. A report counts the
 * attempts.
 *
 * 0.x's `<Loop maxIterations={budget}>` is unrolled from the payload's budget, and each policy decision branches to the next attempt or to the escalation.
 * 0.x never waited out the policy's `backoffMs`, and neither does this port.
 * The policy controller stays an agent as in 0.x: `RetryPolicy.decide` and `Escalation` would replace its judgment with a fixed ladder, and `Budget` meters model spend, not attempts.
 * 0.x's prompts were placeholders that printed their props; these are minimal prompts over the same props.
 * 0.x gave the agents `bash`, `read`, `grep` and `write` tools; in 1.0 tools are the host's registered flows (see `25-agent-tools-in-sandbox.ts`).
 */
import * as AgentAction from "@smthrs/agent/AgentAction"
import { type Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import type * as Planned from "@smthrs/plan/Planned"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

const seat = "anthropic:claude-sonnet-5-5"

const FailureClass = Schema.Literals(["transient", "persistent", "quota", "timeout", "unknown"])

/** One attempt at the step. */
export const StepResult = Schema.Struct({
  stepName: Schema.String,
  success: Schema.Boolean,
  failureClass: Schema.optional(FailureClass),
  errorMessage: Schema.optional(Schema.String),
  latencyMs: Schema.Number,
  attempt: Schema.Number
})

/** The policy controller's decision after a failed attempt. */
export const PolicyDecision = Schema.Struct({
  shouldRetry: Schema.Boolean,
  backoffMs: Schema.Number,
  budgetRemaining: Schema.Number,
  budgetSpent: Schema.Number,
  reasoning: Schema.String,
  routeOverride: Schema.optional(Schema.String),
  escalate: Schema.Boolean
})

/** The escalation agent's assessment. */
export const Escalation = Schema.Struct({
  severity: Schema.Literals(["low", "medium", "high", "critical"]),
  recommendation: Schema.Literals(["retry-with-approval", "skip-step", "abort-workflow", "fallback-route"]),
  summary: Schema.String,
  budgetAnalysis: Schema.String,
  failureBreakdown: Schema.Array(Schema.Struct({
    failureClass: FailureClass,
    count: Schema.Number,
    percentage: Schema.Number
  }))
})

/** The report the flow settles with. */
export const Report = Schema.Struct({
  totalAttempts: Schema.Number,
  successfulSteps: Schema.Number,
  failedSteps: Schema.Number,
  budgetUsed: Schema.Number,
  budgetTotal: Schema.Number,
  escalated: Schema.Boolean,
  summary: Schema.String
})

type StepResult = typeof StepResult.Type
type PolicyDecision = typeof PolicyDecision.Type
type Report = typeof Report.Type

/** Runs the step once and classifies a failure. */
export const RunStep = AgentAction.make("examples/RetryBudgetManager/Step", {
  payload: {
    stepName: Schema.String,
    command: Schema.String,
    attempt: Schema.Number,
    budgetTotal: Schema.Number,
    budgetRemaining: Schema.Number,
    routeOverride: Schema.optional(Schema.String),
    previousError: Schema.optional(Schema.String)
  },
  output: StepResult,
  seat,
  system: [
    `You are a step executor. Run the given step, capture its result including
latency and any error details. Classify failures accurately: transient (network blips,
temporary unavailability), persistent (bad config, missing resource), quota (rate limits,
capacity), timeout (deadline exceeded). Report honestly — never mask failures.`
  ],
  prompt: ({ attempt, budgetRemaining, budgetTotal, command, previousError, routeOverride, stepName }) =>
    `Run step "${stepName}", attempt ${attempt} of ${budgetTotal} (${budgetRemaining} left in the budget).\n\nCommand: ${command}\nRoute override: ${
      routeOverride ?? "none"
    }\nPrevious error: ${previousError ?? "none"}`
})

/** Decides whether a failed attempt is worth retrying. */
export const DecidePolicy = AgentAction.make("examples/RetryBudgetManager/Policy", {
  payload: {
    stepResult: StepResult,
    attempt: Schema.Number,
    budgetTotal: Schema.Number,
    budgetSpent: Schema.Number,
    history: Schema.Array(StepResult)
  },
  output: PolicyDecision,
  seat,
  system: [
    `You are a retry policy controller. Analyse the failure class, remaining budget,
and history of previous attempts. Use exponential backoff for transient failures, immediate
escalation for persistent ones, and cooldown periods for quota errors. Be conservative —
wasting budget on hopeless retries is worse than escalating early.`
  ],
  prompt: ({ attempt, budgetSpent, budgetTotal, history, stepResult }) =>
    `Decide the retry policy after attempt ${attempt}.\n\nBudget: ${budgetSpent} of ${budgetTotal} spent\nLatest result: ${
      JSON.stringify(stepResult)
    }\nHistory: ${JSON.stringify(history)}`
})

/** Assesses a run that did not succeed. */
export const Escalate = AgentAction.make("examples/RetryBudgetManager/Escalation", {
  payload: {
    stepName: Schema.String,
    stepResults: Schema.Array(StepResult),
    policies: Schema.Array(PolicyDecision),
    budgetTotal: Schema.Number,
    budgetUsed: Schema.Number
  },
  output: Escalation,
  seat,
  system: [
    `You are an escalation analyst. When the retry budget is exhausted or the
policy controller flags escalation, produce a clear severity assessment, a concrete
recommendation, and a breakdown of failure classes observed. Be actionable and concise.`
  ],
  prompt: ({ budgetTotal, budgetUsed, policies, stepName, stepResults }) =>
    `Escalate step "${stepName}" after ${budgetUsed} of ${budgetTotal} attempts.\n\nResults: ${
      JSON.stringify(stepResults)
    }\nPolicy decisions: ${JSON.stringify(policies)}`
})

interface Run {
  readonly stepName: string
  readonly command: string
  readonly budget: number
}

/** Counts the attempts. Pure, so it is a `Node.map`, not a step. */
const report = ({ budget, escalation, results, stepName }: {
  readonly stepName: string
  readonly budget: number
  readonly results: ReadonlyArray<StepResult>
  readonly escalation: typeof Escalation.Type | null
}): Report => ({
  totalAttempts: results.length,
  successfulSteps: results.filter((result) => result.success).length,
  failedSteps: results.filter((result) => !result.success).length,
  budgetUsed: results.length,
  budgetTotal: budget,
  escalated: escalation !== null,
  summary: escalation === null
    ? `Step "${stepName}" succeeded after ${results.length} attempt(s)`
    : `Exhausted ${results.length}/${budget} retries — escalated as ${escalation.severity}: ${escalation.recommendation}`
})

type Requirements = Action.Requirement<
  "examples/RetryBudgetManager/Step" | "examples/RetryBudgetManager/Policy" | "examples/RetryBudgetManager/Escalation"
>

/** The escalation and report for a run whose last attempt failed. */
const escalate = (
  { budget, stepName }: Run,
  results: ReadonlyArray<Planned.Planned<StepResult>>,
  policies: ReadonlyArray<Planned.Planned<PolicyDecision>>
): Node.Node<Report, AgentAction.AgentFailure, Requirements> =>
  Node.bindPlanned(
    Escalate.call({ stepName, stepResults: results, policies, budgetTotal: budget, budgetUsed: results.length }),
    (escalation) => Node.map(Node.succeed({ stepName, budget, results, escalation }), report)
  )

/**
 * Attempt `n`: run the step, settle on success, otherwise ask the policy
 * and stop or go again. `results` and `policies` hold the earlier attempts'
 * planned answers, so each prompt reads them once they exist.
 */
const tryStep = (
  run: Run,
  n: number,
  results: ReadonlyArray<Planned.Planned<StepResult>>,
  policies: ReadonlyArray<Planned.Planned<PolicyDecision>>
): Node.Node<Report, AgentAction.AgentFailure, Requirements> => {
  const { budget, command, stepName } = run
  const latest = policies.at(-1)
  return Node.branch(
    RunStep.call({
      stepName,
      command,
      attempt: n,
      budgetTotal: budget,
      budgetRemaining: latest?.budgetRemaining ?? budget,
      routeOverride: latest?.routeOverride,
      previousError: results.at(-1)?.errorMessage
    }),
    {
      if: (step) => step.success,
      then: (step) =>
        Node.map(Node.succeed({ stepName, budget, results: [...results, step], escalation: null }), report),
      else: (step) => {
        const tried = [...results, step]
        return Node.branch(
          DecidePolicy.call({ stepResult: step, attempt: n, budgetTotal: budget, budgetSpent: n, history: tried }),
          {
            if: (policy) => policy.budgetRemaining <= 0 || policy.escalate,
            then: (policy) => escalate(run, tried, [...policies, policy]),
            else: (policy) =>
              n >= budget
                ? escalate(run, tried, [...policies, policy])
                : tryStep(run, n + 1, tried, [...policies, policy])
          }
        )
      }
    }
  )
}

/** The flow. `budget` is real at plan time, so it sets how many attempts the plan holds. */
export const RetryBudgetManager = Flow.make("examples/RetryBudgetManager", {
  payload: {
    command: Schema.String,
    stepName: Schema.optional(Schema.String),
    budget: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0)))
  },
  success: Report,
  error: AgentAction.AgentFailure,
  body: ({ budget = 5, command, stepName = "default-step" }) => tryStep({ stepName, command, budget }, 1, [], [])
})

/** Every step the flow calls. */
export const layer = Layer.mergeAll(RunStep.layer, DecidePolicy.layer, Escalate.layer)
