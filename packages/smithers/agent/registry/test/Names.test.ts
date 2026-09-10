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

  it("warns but retains names that violate the Agent Skills grammar or length", () => {
    const invalidFormat = Names.deriveFromFrontmatter({
      fields: { name: "Review--PR" },
      dirBasename: "Review--PR",
      path: "/skills/Review--PR/SKILL.md"
    })
    const tooLong = Names.deriveFromFrontmatter({
      fields: { name: "a".repeat(65) },
      dirBasename: "a".repeat(65),
      path: `/skills/${"a".repeat(65)}/SKILL.md`
    })

    expect(invalidFormat.name).toBe("Review--PR")
    expect(invalidFormat.warnings).toContainEqual(expect.objectContaining({ code: "invalid_name" }))
    expect(tooLong.name).toBe("a".repeat(65))
    expect(tooLong.warnings).toContainEqual(expect.objectContaining({ code: "invalid_name" }))
  })

  it("warns but retains a valid frontmatter name that differs from its directory", () => {
    const result = Names.deriveFromFrontmatter({
      fields: { name: "review-pr" },
      dirBasename: "review",
      path: "/skills/review/SKILL.md"
    })

    expect(result.name).toBe("review-pr")
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "directory_name_mismatch" }))
  })
})
