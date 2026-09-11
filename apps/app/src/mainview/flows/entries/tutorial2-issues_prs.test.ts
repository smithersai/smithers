import { describe, expect, test } from "bun:test"
import { issuesFlows } from "./issues"
import { prsFlows } from "./prs"
import type { CommandActions } from "./Declare"
import { payloadFor } from "../SlashPayload"
describe("the tutorial's bare issue and pull-request doors", () => {
for (const [name, entries] of [["issues", issuesFlows], ["prs", prsFlows]] as const) test(`/${name} keeps the list grammar and agent door`, () => {
  const entry = entries({} as CommandActions).find(row => row.declaredName === name)!
  expect(entry.binding.descriptor.modelInvocable).toBe(true)
  expect(entry.metadata.runtimeAny).toEqual(["cloud", "local.repositories"])
  expect(payloadFor(name, "", entry.metadata.grammar)).toEqual({ payload: name === "issues" ? { filter: "open" } : {} })
  expect(payloadFor(name, "will/repo", entry.metadata.grammar)).toEqual({ payload: name === "issues" ? { filter: "open", repo: "will/repo" } : { repo: "will/repo" } })
})
})
