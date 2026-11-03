import { afterAll, expect, it } from "@effect/vitest"
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import { DurableDeferred, HumanTask } from "@smthrs/flow"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schedule from "effect/Schedule"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Kit from "../../../examples/use-cases/kit.vibe"
import { approvalTask, layer, RollbackAdvisor } from "../../../examples/use-cases/rollback-advisor.vibe"

const directory = mkdtempSync(join(tmpdir(), "rollback-advisor-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

/**
 * An evidence agent whose findings name the symptoms it was handed, an advisor
 * that recommends a rollback when the findings mention 5xx, and a person who
 * answers `decision`. Every request, the person's included, is recorded in
 * order.
 */
const script = () => {
  const turns: Array<string> = []
  const answer: Kit.Script = (asked) => {
    const gather = /Gather evidence about a failed deployment\.\n\nDeployment: (.+)\nSymptoms: (.*)/.exec(asked)
    if (gather !== null) {
      turns.push(`gather ${gather[1]}: ${gather[2]}`)
      return {
        deployment: gather[1],
        errorRate: 12,
        affectedEndpoints: ["/checkout"],
        timeline: "errors began 2 minutes after the deploy",
        severity: "high",
        rawFindings: `findings for ${gather[2]}`
      }
    }
    const advise = /recommend whether to rollback, mitigate, or observe\.\n\nDeployment: (.+)\nEvidence: (.+)/.exec(
      asked
    )
    if (advise !== null) {
      turns.push(`advise on ${advise[2]}`)
      const rollback = advise[2]!.includes("5xx")
      return {
        shouldRollback: rollback,
        reason: rollback ? `${advise[2]} after the deploy` : "latency only",
        mitigation: "Disable the new-cart flag. Shift 10% of traffic back",
        rollbackSafe: true,
        risks: []
      }
    }
    return undefined
  }
  return { answer, turns }
}

/** Answers the real durable question once the engine parks on it. */
const approver = (executionId: string, decision: "approve" | "deny", turns: Array<string>) =>
  Layer.effectDiscard(Effect.forkScoped(Effect.orDie(Effect.gen(function*() {
    const state = yield* DurableEngineState.DurableEngineState
    const row = yield* state.waiting(executionId).pipe(Effect.repeat({
      until: (waiting) => Option.isSome(waiting) && waiting.value.reason === "approval" && waiting.value.token !== null,
      schedule: Schedule.spaced(10)
    }))
    const { request, token } = Option.getOrThrow(row)
    const { name, kind, prompt } = request as { readonly name: string; readonly kind: string; readonly prompt: string }
    expect(name).toBe(approvalTask)
    expect(kind).toBe("json")
    turns.push(`approve ${prompt}`)
    yield* HumanTask.answer({
      token: DurableDeferred.Token.make(token ?? ""),
      value: { approved: decision === "approve", note: "not during the sale" }
    })
  }))))

it.live("rolls back once a person approves", () =>
  Effect.gen(function*() {
    const { answer, turns } = script()
    const outcome = yield* Kit.run(RollbackAdvisor, { deployment: "api-v42", symptoms: ["5xx spike", "timeouts"] }, {
      filename: join(directory, "approved.sqlite"),
      executionId: "rollback-advisor-approved",
      script: answer,
      actions: Layer.mergeAll(layer, approver("rollback-advisor-approved", "approve", turns))
    })

    // The person was asked after the advisor, about this deployment and the advisor's reason.
    expect(turns).toEqual([
      "gather api-v42: 5xx spike, timeouts",
      "advise on findings for 5xx spike, timeouts",
      "approve Rollback api-v42\n\nfindings for 5xx spike, timeouts after the deploy"
    ])
    expect(outcome).toEqual({
      action: "rollback",
      summary: "Approved rollback for api-v42: findings for 5xx spike, timeouts after the deploy",
      steps: ["Initiate rollback", "Verify service health", "Notify stakeholders"]
    })
  }), { timeout: 60_000 })

it.live("fails with RollbackDenied before rollback when a person denies it", () =>
  Effect.gen(function*() {
    const { answer, turns } = script()
    const failure = yield* Effect.flip(Kit.run(RollbackAdvisor, { deployment: "api-v42", symptoms: ["5xx spike"] }, {
      filename: join(directory, "denied.sqlite"),
      executionId: "rollback-advisor-denied",
      script: answer,
      actions: Layer.mergeAll(layer, approver("rollback-advisor-denied", "deny", turns))
    }))

    expect(turns.at(-1)).toBe("approve Rollback api-v42\n\nfindings for 5xx spike after the deploy")
    expect(failure).toMatchObject({ _tag: "examples/RollbackAdvisor/RollbackDenied", note: "not during the sale" })
  }), { timeout: 60_000 })

it.live("mitigates without asking anyone when no rollback is recommended", () =>
  Effect.gen(function*() {
    const { answer, turns } = script()
    const outcome = yield* Kit.run(RollbackAdvisor, {}, {
      filename: join(directory, "mitigate.sqlite"),
      executionId: "rollback-advisor-mitigate",
      script: answer,
      actions: Layer.mergeAll(layer, approver("rollback-advisor-mitigate", "approve", turns))
    })

    // The 0.x defaults: an unknown deployment and no symptoms. Nobody was asked to approve.
    expect(turns).toEqual(["gather unknown: ", "advise on findings for "])
    expect(outcome).toEqual({
      action: "mitigate",
      summary: "Mitigation plan: Disable the new-cart flag. Shift 10% of traffic back",
      steps: ["Disable the new-cart flag", "Shift 10% of traffic back"]
    })
  }), { timeout: 60_000 })
