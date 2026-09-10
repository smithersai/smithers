import * as Node from "@smthrs/plan/Node"
import * as SharedPlan from "@smthrs/targets/test-support/plan"
import * as Target from "@smthrs/targets/Target"
import * as Schema from "effect/Schema"
import { expect, it } from "vitest"
import { plannedArgv, plannedCalls, plannedValue, type PlannedCall } from "./plan.ts"

const Fixture = Target.make("SharedPlanFixture", {
  attrs: Schema.Struct({ message: Schema.String }),
  kinds: ["test"],
  implementation: ({ message }) =>
    Node.actionCall<{ readonly payload: { readonly argv: ReadonlyArray<string> } }>(
      undefined,
      "fixture/read",
      { argv: ["echo", message] }
    ).pipe(
      Node.map((call) => call.payload.argv),
      Node.bindPlanned((argv) => Node.actionCall(undefined, "fixture/write", { argv })),
      Node.map((written) => ({ written }))
    )
})

it("preserves mapper and continuation results through the consumer plan helpers", () => {
  expect(plannedCalls).toBe(SharedPlan.plannedCalls)
  expect(plannedArgv).toBe(SharedPlan.plannedArgv)
  expect(plannedValue).toBe(SharedPlan.plannedValue)

  const target = Fixture({ message: "fixture" })
  const read = { action: "fixture/read", payload: { argv: ["echo", "fixture"] } }
  const write = { action: "fixture/write", payload: { argv: ["echo", "fixture"] } }

  expect(plannedCalls(target)).toEqual([read, write])
  expect(plannedArgv(target)).toEqual(["echo", "fixture"])
  expect(plannedValue(target)).toEqual({ written: write })
  expect(plannedValue(target, (call: PlannedCall) =>
    call.action === "fixture/read" ? { payload: { argv: ["echo", "simulated"] } } : call
  )).toEqual({
    written: { action: "fixture/write", payload: { argv: ["echo", "simulated"] } }
  })
})
