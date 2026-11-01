import { Option } from "effect"
import { describe, expect, it } from "vitest"
import { Provenance } from "../src/Descriptor.ts"
import * as MarkdownFlow from "../src/MarkdownFlow.vibe"

const parse = (declaration: string) =>
  MarkdownFlow.fromMarkdown({
    text: `---\ndescription: Review\n${declaration}\n---\nBody`,
    path: "/flows/review/SKILL.md",
    baseDirectory: "/flows/review",
    naming: "path",
    name: Option.some("review"),
    dirBasename: "review",
    provenance: new Provenance({ source: "test", root: "/flows" })
  })

describe("Markdown limit admission regressions", () => {
  it.each([
    "budget: soon",
    "budget:",
    "budget: []",
    "budget: {}",
    "budget:\n  tokens: soon",
    "budget:\n  milliseconds: -1",
    "budget:\n  usd: free",
    "budget:\n  token: 500",
    "budget:\n  onExceeded: park",
    "budget:\n  tokens: 500\n  milliseconds: soon",
    "budget:\n  tokens: 500\n  token: 1"
  ])("refuses an invalid declared budget: %s", (declaration) => {
    const result = parse(declaration)
    expect(Option.isNone(result.descriptor)).toBe(true)
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "invalid_budget" }))
  })

  it.each(["soon", "0", "-5 minutes", "1.5", "[]", "{}", ""])(
    "refuses an invalid explicit deadline: %s",
    (deadline) => {
      for (const budget of ["", "budget:\n  tokens: 500\n"]) {
        const result = parse(`${budget}deadline: ${deadline}`)
        expect(Option.isNone(result.descriptor)).toBe(true)
        expect(result.warnings).toContainEqual(expect.objectContaining({ code: "invalid_deadline" }))
      }
    }
  )
})
