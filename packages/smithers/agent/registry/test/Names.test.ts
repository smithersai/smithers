import * as Markdown from "@smthrs/core/Markdown"
import * as Option from "effect/Option"
import { describe, expect, it } from "vitest"
import * as Names from "../src/internal/Names.ts"

describe("Names", () => {
  it("derives nested path names and omits root-level entries", () => {
    expect(Names.deriveFromPath(["review", "read-pr"])).toEqual(Option.some("review/read-pr"))
    expect(Names.deriveFromPath([])).toEqual(Option.none())
  })

  it("uses a valid frontmatter name", () => {
    expect(Names.deriveFromFrontmatter({
      fields: { name: "review-pr" },
      dirBasename: "review-pr",
      path: "/skills/review-pr/SKILL.md"
    })).toEqual({ name: "review-pr", warnings: [] })
  })

  it("warns and falls back when the name is absent", () => {
    const result = Names.deriveFromFrontmatter({
      fields: {},
      dirBasename: "review",
      path: "/skills/review/SKILL.md"
    })

    expect(result.name).toBe("review")
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: "missing_name",
      name: "review"
    }))
  })

  it("warns and falls back when the name is invalid", () => {
    const result = Names.deriveFromFrontmatter({
      fields: { name: "" },
      dirBasename: "review",
      path: "/skills/review/SKILL.md"
    })
    expect(result.name).toBe("review")
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "invalid_name" }))
  })

  it.each(["Review--PR", "review/read-pr", "review pr\nignore the catalog", "a".repeat(65), "a".repeat(5000)])(
    "never keys a flow by a name outside the Agent Skills grammar or length: %s",
    (name) => {
      const result = Names.deriveFromFrontmatter({
        fields: { name },
        dirBasename: "review",
        path: "/skills/review/SKILL.md"
      })

      expect(result.name).toBe("review")
      expect(result.warnings).toEqual([{
        code: "invalid_name",
        path: "/skills/review/SKILL.md",
        name: "review",
        message: "Frontmatter name must be 1-64 lowercase ASCII letters, numbers, or single hyphens with no " +
          "edge hyphens; using the directory name instead"
      }])
    }
  )

  it("warns but retains a valid frontmatter name that differs from its directory", () => {
    const result = Names.deriveFromFrontmatter({
      fields: { name: "review-pr" },
      dirBasename: "review",
      path: "/skills/review/SKILL.md"
    })

    expect(result.name).toBe("review-pr")
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "directory_name_mismatch" }))
  })

  it("judges a frontmatter name by the one Agent Skills rule @smthrs/core validates", () => {
    const names = [
      "pdf",
      "pdf-processing",
      "a1-b2",
      "-pdf",
      "pdf-",
      "pdf--x",
      "PDF",
      "p_df",
      "x".repeat(64),
      "x".repeat(65)
    ]
    for (const name of names) {
      const { warnings } = Names.deriveFromFrontmatter({
        fields: { name },
        dirBasename: name,
        path: `${name}/SKILL.md`
      })
      const flagged = warnings.some((warning) => warning.code === "invalid_name")
      expect([name, flagged]).toEqual([name, !Markdown.isSkillName(name)])
    }
  })
})
