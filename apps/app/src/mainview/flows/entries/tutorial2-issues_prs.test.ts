import { describe, expect, test } from "bun:test"
import { issuesFlows } from "./issues"
import { prsFlows } from "./prs"
import type { CommandActions } from "./Declare"
import { payloadFor } from "../SlashPayload"
import { formFieldsFor } from "../FlowForms"
describe("the tutorial's bare issue and pull-request doors", () => {
for (const [name, entries] of [["issues", issuesFlows], ["prs", prsFlows]] as const) test(`/${name} keeps the list grammar and agent door`, () => {
  const entry = entries({} as CommandActions).find(row => row.declaredName === name)!
  expect(entry.binding.descriptor.modelInvocable).toBe(true)
  // "practice": the bundled practice repository answers on every host (state/practice).
  expect(entry.metadata.runtimeAny).toEqual(["cloud", "local.repositories", "practice"])
  expect(payloadFor(name, "", entry.metadata.grammar)).toEqual({ payload: name === "issues" ? { filter: "open" } : {} })
  expect(payloadFor(name, "will/repo", entry.metadata.grammar)).toEqual({ payload: name === "issues" ? { filter: "open", repo: "will/repo" } : { repo: "will/repo" } })
})
})

test("issue flows expose slash, button and agent doors; Add flow preserves context through its form", () => {
  const entries = issuesFlows({} as CommandActions)
  for (const name of ["issue.flows", "issue.repro", "issue.poc", "issue.implement", "issue.add-flow"]) {
    const entry = entries.find(row => row.declaredName === name)!
    expect(entry).toBeDefined()
    expect(entry.binding.descriptor.modelInvocable).toBe(true)
  }
  const add = entries.find(row => row.declaredName === "issue.add-flow")!
  expect(formFieldsFor(add.input, add.metadata.form).find(field => field.name === "description")).toMatchObject({
    label: "What should this issue flow do?", placeholder: "Describe the flow to add", required: true
  })
  const payload = { number: 3, repo: "practice:smithersai/hello-server", description: "Research errors\nwithout losing the issue context" }
  expect(payloadFor("issue.add-flow", add.metadata.form?.args?.(payload))).toEqual({payload})
})
