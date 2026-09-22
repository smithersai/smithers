import { describe, expect, it } from "vitest"
import * as Markdown from "../src/Markdown.ts"

describe("release coverage", () => {
  it("rejects a non-scalar allowed-tools value with the exact public error", () => {
    const result = Markdown.parseSkill(
      "---\nname: example\ndescription: Example\nallowed-tools:\n  nested: value\n---\nPrompt"
    )

    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        code: "skill_invalid_allowed_tools",
        message: "SKILL.md allowed-tools must be a space-separated scalar"
      }
    })
  })

  it("treats an unclosed fence as missing frontmatter", () => {
    const result = Markdown.parseSkill("---\nname: example\ndescription: Example\nPrompt")

    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        code: "skill_missing_frontmatter",
        message: "SKILL.md requires leading frontmatter"
      }
    })
  })

  it("rejects sequence frontmatter as a non-mapping", () => {
    const result = Markdown.parseSkill("---\n- example\n- description\n---\nPrompt")

    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        code: "skill_invalid_frontmatter",
        message: "Skill frontmatter must be a YAML mapping"
      }
    })
  })
})
