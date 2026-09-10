import { describe, expect, it } from "vitest"
import { schemaIssuePath } from "../src/internal/schemaIssuePath.ts"

/** Builds `depth` nested issue nodes, each contributing one path segment. */
const nested = (depth: number) => {
  let issue: unknown = { path: ["leaf"] }
  for (let level = depth - 1; level > 0; level--) issue = { path: [`level-${level}`], issue }
  return { issue }
}

describe("schemaIssuePath", () => {
  it("joins the segments of the first offending node with dots", () => {
    expect(schemaIssuePath({ issue: { path: ["attributes", "bad"] } }, "resource")).toBe("attributes.bad")
    expect(schemaIssuePath({ issue: { path: ["capacity"] } }, "options")).toBe("capacity")
  })

  it("stringifies non-string segments", () => {
    expect(schemaIssuePath({ issue: { path: ["reasons", 0, "error"] } }, "options")).toBe("reasons.0.error")
  })

  it("descends a nested issue and the first member of a composite one", () => {
    expect(schemaIssuePath({ issue: { path: ["outer"], issue: { path: ["inner"] } } }, "options")).toBe("outer.inner")
    expect(
      schemaIssuePath({ issue: { path: ["outer"], issues: [{ path: ["first"] }, { path: ["second"] }] } }, "resource")
    ).toBe("outer.first")
  })

  it("returns the caller's fallback when the failure names no path", () => {
    expect(schemaIssuePath({ issue: {} }, "options")).toBe("options")
    expect(schemaIssuePath({ issue: { issues: [] } }, "resource")).toBe("resource")
    expect(schemaIssuePath({}, "options")).toBe("options")
    expect(schemaIssuePath(null, "resource")).toBe("resource")
    expect(schemaIssuePath({ issue: "not a node" }, "options")).toBe("options")
  })

  it("stops after 64 levels, so a self-referential tree cannot spin", () => {
    expect(schemaIssuePath(nested(200), "options").split(".")).toHaveLength(64)

    const cyclic: { path: ReadonlyArray<string>; issue?: unknown } = { path: ["loop"] }
    cyclic.issue = cyclic
    expect(schemaIssuePath({ issue: cyclic }, "options")).toBe(Array.from({ length: 64 }, () => "loop").join("."))
  })
})
