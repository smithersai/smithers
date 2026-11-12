import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8")

describe("approval documentation", () => {
  const contracts = [
    [
      "runtime adapter",
      () =>
        read("src/ControlRuntime.ts").split("Execution-engine operations required")[1]!.split(
          "export interface Service"
        )[0]!
    ],
    [
      "approval guide",
      () => read("docs/guides/approvals.md").split("## What a decision does")[1]!.split("## Refusals")[0]!
    ],
    [
      "API reference",
      () => read("docs/api.md").split("## ControlRuntime")[1]!.split("### Service")[1]!.split("### Models")[0]!
    ]
  ] as const

  for (const [name, contract] of contracts) {
    it(`${name} documents resolution before journaling`, () => {
      const text = contract()
      expect(text).toMatch(
        /authorizeApproval[\s\S]*lookupApproval[\s\S]*resolveApproval[\s\S]*journal/
      )
      expect(text).toMatch(/recheck/i)
      expect(text).toMatch(/atomically/)
      expect(text).not.toMatch(/invoked only after grant installation/)
    })
  }

  it("README names default identities and explicit host delegation for agents", () => {
    const text = read("README.md")
    expect(text).not.toMatch(/Approval and denial are operator-only/)
    expect(text).toContain("local/operator")
    expect(text).toContain("memory/test")
    expect(text).toMatch(/host[\s\S]*delegat[\s\S]*agent/i)
    expect(text).toContain("docs/guides/approvals.md#who-may-decide")
  })
})
