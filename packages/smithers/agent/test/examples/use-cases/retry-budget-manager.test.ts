import { afterAll, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Kit from "../../../examples/use-cases/kit.vibe"
import { layer, RetryBudgetManager } from "../../../examples/use-cases/retry-budget-manager.vibe"

const directory = mkdtempSync(join(tmpdir(), "retry-budget-manager-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

interface Seen {
  readonly attempt: number
  readonly total: number
  readonly spent: number
  readonly failureClass: string
}

/**
 * A step runner that succeeds from attempt `succeedOn` and otherwise fails
 * with `failureClass`; a policy agent whose decision is `decide` applied to
 * what its prompt carried; and an escalation agent that counts the failure
 * classes it was handed. Each request is recorded in order.
 */
const script = (options: {
  readonly succeedOn?: number
  readonly failureClass?: string
  readonly decide: (
    seen: Seen
  ) => { readonly budgetRemaining: number; readonly escalate: boolean; readonly routeOverride?: string }
}) => {
  const turns: Array<string> = []
  const answer: Kit.Script = (asked) => {
    const step = new RegExp(
      String.raw`Run step "(.+)", attempt (\d+) of \d+ \((\d+) left in the budget\)\.\n\nCommand: .+\n` +
        String.raw`Route override: (.+)\nPrevious error: (.+)`
    ).exec(asked)
    if (step !== null) {
      const n = Number(step[2])
      turns.push(`step ${n}: ${step[3]} left, route ${step[4]}, previous ${step[5]}`)
      const success = n >= (options.succeedOn ?? Infinity)
      return success
        ? { stepName: step[1], success, latencyMs: 30, attempt: n }
        : {
          stepName: step[1],
          success,
          failureClass: options.failureClass ?? "transient",
          errorMessage: `503 on try ${n}`,
          latencyMs: 30,
          attempt: n
        }
    }
    const policy = new RegExp(
      String.raw`Decide the retry policy after attempt (\d+)\.\n\nBudget: (\d+) of (\d+) spent\n` +
        String.raw`Latest result: (.+)\nHistory: (.+)`
    ).exec(asked)
    if (policy !== null) {
      const history: ReadonlyArray<unknown> = JSON.parse(policy[5]!)
      const latest = JSON.parse(policy[4]!)
      turns.push(`policy ${policy[1]}: ${history.length} in history`)
      const decision = options.decide({
        attempt: Number(policy[1]),
        spent: Number(policy[2]),
        total: Number(policy[3]),
        failureClass: latest.failureClass
      })
      return {
        shouldRetry: !decision.escalate && decision.budgetRemaining > 0,
        backoffMs: 100 * 2 ** Number(policy[1]),
        budgetSpent: Number(policy[2]),
        reasoning: `${latest.failureClass} error`,
        ...decision
      }
    }
    const escalate = /Escalate step ".+" after (\d+) of (\d+) attempts\.\n\nResults: (.+)\nPolicy decisions: (.+)/
      .exec(asked)
    if (escalate !== null) {
      const results: ReadonlyArray<{ readonly failureClass: string }> = JSON.parse(escalate[3]!)
      const policies: ReadonlyArray<unknown> = JSON.parse(escalate[4]!)
      turns.push(`escalate: ${results.length} results, ${policies.length} policies`)
      const failureClass = results[0]!.failureClass
      return {
        severity: failureClass === "persistent" ? "high" : "medium",
        recommendation: failureClass === "persistent" ? "abort-workflow" : "retry-with-approval",
        summary: `${results.length} ${failureClass} errors`,
        budgetAnalysis: `${escalate[1]} of ${escalate[2]} attempts spent`,
        failureBreakdown: [{ failureClass, count: results.length, percentage: 100 }]
      }
    }
    return undefined
  }
  return { answer, turns }
}

it.effect("retries with the policy's budget and route until the step succeeds", () =>
  Effect.gen(function*() {
    const { answer, turns } = script({
      succeedOn: 3,
      decide: ({ attempt, spent, total }) => ({
        budgetRemaining: total - spent,
        escalate: false,
        ...(attempt === 2 ? { routeOverride: "replica" } : {})
      })
    })
    const report = yield* Kit.run(RetryBudgetManager, { stepName: "charge-card", command: "curl -X POST /charge" }, {
      filename: join(directory, "succeeds.sqlite"),
      executionId: "retry-budget-succeeds",
      script: answer,
      actions: layer
    })

    // Each attempt was told the latest policy's budget and route and the
    // previous attempt's error; no policy ran after the success.
    expect(turns).toEqual([
      "step 1: 5 left, route none, previous none",
      "policy 1: 1 in history",
      "step 2: 4 left, route none, previous 503 on try 1",
      "policy 2: 2 in history",
      "step 3: 3 left, route replica, previous 503 on try 2"
    ])
    expect(report).toEqual({
      totalAttempts: 3,
      successfulSteps: 1,
      failedSteps: 2,
      budgetUsed: 3,
      budgetTotal: 5,
      escalated: false,
      summary: "Step \"charge-card\" succeeded after 3 attempt(s)"
    })
  }))

it.effect("escalates as soon as the policy flags a hopeless failure", () =>
  Effect.gen(function*() {
    const { answer, turns } = script({
      failureClass: "persistent",
      decide: ({ failureClass, spent, total }) => ({
        budgetRemaining: total - spent,
        escalate: failureClass === "persistent"
      })
    })
    const report = yield* Kit.run(RetryBudgetManager, { command: "curl -X POST /charge" }, {
      filename: join(directory, "escalates.sqlite"),
      executionId: "retry-budget-escalates",
      script: answer,
      actions: layer
    })

    expect(turns).toEqual([
      "step 1: 5 left, route none, previous none",
      "policy 1: 1 in history",
      "escalate: 1 results, 1 policies"
    ])
    expect(report).toEqual({
      totalAttempts: 1,
      successfulSteps: 0,
      failedSteps: 1,
      budgetUsed: 1,
      budgetTotal: 5,
      escalated: true,
      summary: "Exhausted 1/5 retries — escalated as high: abort-workflow"
    })
  }))

it.effect("stops when the policy reports no budget left", () =>
  Effect.gen(function*() {
    const { answer, turns } = script({ decide: ({ attempt }) => ({ budgetRemaining: 2 - attempt, escalate: false }) })
    const report = yield* Kit.run(RetryBudgetManager, { command: "curl -X POST /charge" }, {
      filename: join(directory, "no-budget.sqlite"),
      executionId: "retry-budget-no-budget",
      script: answer,
      actions: layer
    })

    expect(turns).toEqual([
      "step 1: 5 left, route none, previous none",
      "policy 1: 1 in history",
      "step 2: 1 left, route none, previous 503 on try 1",
      "policy 2: 2 in history",
      "escalate: 2 results, 2 policies"
    ])
    expect(report.summary).toBe("Exhausted 2/5 retries — escalated as medium: retry-with-approval")
  }))

it.effect("stops after the payload's budget of attempts", () =>
  Effect.gen(function*() {
    const { answer, turns } = script({ decide: () => ({ budgetRemaining: 99, escalate: false }) })
    const report = yield* Kit.run(RetryBudgetManager, { command: "curl -X POST /charge", budget: 2 }, {
      filename: join(directory, "budget-bound.sqlite"),
      executionId: "retry-budget-bound",
      script: answer,
      actions: layer
    })

    // The last attempt's policy still ran, as 0.x's loop body did, and the
    // loop then ended on its bound.
    expect(turns).toEqual([
      "step 1: 2 left, route none, previous none",
      "policy 1: 1 in history",
      "step 2: 99 left, route none, previous 503 on try 1",
      "policy 2: 2 in history",
      "escalate: 2 results, 2 policies"
    ])
    expect(report).toEqual({
      totalAttempts: 2,
      successfulSteps: 0,
      failedSteps: 2,
      budgetUsed: 2,
      budgetTotal: 2,
      escalated: true,
      summary: "Exhausted 2/2 retries — escalated as medium: retry-with-approval"
    })
  }))
