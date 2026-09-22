import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import * as Explore from "../src/Explore.ts"
import * as Glob from "../src/Glob.ts"
import * as Grep from "../src/Grep.ts"
import * as Ls from "../src/Ls.ts"
import * as Read from "../src/Read.ts"

const forbiddenActions = ["fs:write", "net:post", "proc:spawn"] as const

const hasAction = (capability: string, action: string): boolean =>
  capability === action || capability.startsWith(`${action}:`)

describe("Explore", () => {
  it("exposes exactly the four read-only reconnaissance flows", () => {
    expect(Explore.flow.flows).toEqual([
      Read.flow,
      Ls.flow,
      Glob.flow,
      Grep.flow
    ])
  })

  it("does not grant write, post, or process authority transitively", () => {
    const capabilities = [
      ...Explore.capabilities,
      ...Read.capabilities,
      ...Ls.capabilities,
      ...Glob.capabilities,
      ...Grep.capabilities
    ]

    for (const action of forbiddenActions) {
      expect(capabilities.some((capability) => hasAction(capability, action))).toBe(false)
    }
  })

  it("has a non-empty action-first description", () => {
    expect(Explore.description.trim()).not.toBe("")
    expect(Explore.description).toMatch(/^Investigate\b/)
  })

  it("decodes prompt inputs and findings outputs", () => {
    expect(Schema.decodeUnknownSync(Explore.Input)({ prompt: "Locate the registry." })).toEqual({
      prompt: "Locate the registry."
    })
    expect(Schema.decodeUnknownSync(Explore.Output)({ findings: "src/a.ts:1 defines it." })).toEqual({
      findings: "src/a.ts:1 defines it."
    })
  })
})
