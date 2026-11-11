import { readdirSync } from "node:fs"
import { expect, test } from "vitest"
import * as Rpc from "../src/index.ts"
import * as UiInstruction from "../src/UiInstruction.ts"

const offRoot = new Set(["index", "FormInstructions.generated"])

test("the root exports every source module as a namespace of the same name", () => {
  const modules = readdirSync(new URL("../src/", import.meta.url))
    .filter((name) => name.endsWith(".ts"))
    .map((name) => name.slice(0, -".ts".length))
    .filter((name) => !offRoot.has(name))
  expect(Object.keys(Rpc).sort()).toEqual(modules.sort())
  expect(Rpc.UiInstruction).toBe(UiInstruction)
})

test("the generated form fields reach the root through UiInstruction", () => {
  expect(Rpc.UiInstruction.FORM_INSTRUCTION_FIELDS["branch"]).toEqual(["name"])
})

test("the root exposes contracts without retired host implementations", () => {
  for (
    const module of [
      "BrowserFetch",
      "ApplicationTarget",
      "ApplicationAuth",
      "AppEntry",
      "AppBootstrap",
      "CloudTunnel",
      "AgentApiRoutes",
      "BillingPlans"
    ]
  ) expect(Rpc).not.toHaveProperty(module)
})

test("TODO creation has one schema, distinct from scratch adoption", () => {
  expect(Rpc.CardAction).not.toHaveProperty("TodoNewInputSchema")
  expect(Rpc.TodoCommands.TodoNewInputSchema.parse({ text: "  ", before: 3 })).toEqual({ text: "  ", before: 3 })
  expect(Rpc.CardAction.BranchAddToStackInputSchema.parse({ text: "  Adopt  ", after: 3 }))
    .toEqual({ text: "Adopt", after: 3 })
  expect(Rpc.CardAction.BranchAddToStackInputSchema.safeParse({ text: "  " }).success).toBe(false)
})
