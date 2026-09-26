/**
 * `Smithers.Flow` and the catalog join it feeds.
 *
 * The declaration is validated where it is written; the catalog is the join
 * of discovery and declarations, and the two properties that matter most are
 * that a declaration naming no discovered flow fails by id and that the row
 * order is featured first, in declaration order. The projection that writes
 * the rows is `FactoryProjection`, tested in `Factory.test.ts`.
 */
import { describe, expect, it } from "vitest"
import * as Flow from "../src/Flow.ts"
import * as FlowCatalog from "../src/FlowCatalog.ts"

const discovered = (
  id: string,
  overrides: Partial<FlowCatalog.DiscoveredFlow> = {}
): FlowCatalog.DiscoveredFlow => ({
  id,
  description: `Describes ${id}.`,
  kind: "mdx",
  path: `flows/${id}/flow.mdx`,
  capabilities: ["fs:read:**"],
  model: null,
  modelInvocable: true,
  ...overrides
})

describe("Smithers.Flow", () => {
  it("declares a frozen, tagged, plain declaration with the presentation applied", () => {
    const review = Flow.Flow({ flow: "review", summary: "  Review the change.  ", featured: true })
    expect(review).toEqual({ _tag: "FlowDeclaration", flow: "review", summary: "Review the change.", featured: true })
    expect(Object.isFrozen(review)).toBe(true)
    expect(Flow.isFlowDeclaration(review)).toBe(true)
    expect(Flow.isFlowDeclaration({ flow: "review" })).toBe(false)
  })

  it("defaults featured to false and leaves an absent summary absent", () => {
    const lint = Flow.Flow({ flow: "create-flow/scaffold" })
    expect(lint).toEqual({ _tag: "FlowDeclaration", flow: "create-flow/scaffold", featured: false })
    expect("summary" in lint).toBe(false)
    expect(Flow.Flow({ flow: "lint", summary: undefined, featured: undefined }).featured).toBe(false)
  })

  it("validates the summary and featured through the shared presentation rule", () => {
    expect(() => Flow.Flow({ flow: "review", summary: "" })).toThrow(/summary must not be empty/)
    expect(() => Flow.Flow({ flow: "review", summary: "two\nlines" })).toThrow(/summary must be one line/)
    expect(() => Flow.Flow({ flow: "review", summary: 3 as never })).toThrow(/summary must be a string/)
    expect(() => Flow.Flow({ flow: "review", featured: "yes" as never })).toThrow(/featured must be a boolean/)
  })

  it("refuses an id that is not a directory path below flows/", () => {
    expect(() => Flow.Flow({ flow: "" })).toThrow(/directory path below flows/)
    expect(() => Flow.Flow({ flow: "/review" })).toThrow(/directory path below flows/)
    expect(() => Flow.Flow({ flow: "review/" })).toThrow(/directory path below flows/)
    expect(() => Flow.Flow({ flow: "re view" })).toThrow(/directory path below flows/)
    expect(() => Flow.Flow({ flow: "a".repeat(Flow.maximumIdLength + 1) })).toThrow(/directory path below flows/)
    expect(() => Flow.Flow({ flow: 7 as never })).toThrow(/well-formed string/)
    expect(() => Flow.Flow({ flow: "\uD800" })).toThrow(/well-formed string/)
  })

  it("refuses options that are not a plain object of enumerable data properties", () => {
    expect(() => Flow.Flow(null as never)).toThrow(/plain object/)
    expect(() => Flow.Flow(["review"] as never)).toThrow(/plain object/)
    expect(() => Flow.Flow(new Proxy({ flow: "review" }, {}))).toThrow(/plain object/)
    class Options {
      flow = "review"
    }
    expect(() => Flow.Flow(new Options())).toThrow(/plain object/)
    expect(() => Flow.Flow({ flow: "review", [Symbol("x")]: 1 } as never)).toThrow(/symbol properties/)
    expect(() => Flow.Flow({ flow: "review", model: "gpt" } as never)).toThrow(/unknown option "model"/)
    expect(() =>
      Flow.Flow(Object.defineProperty({ flow: "review" }, "featured", { get: () => true, enumerable: true }))
    ).toThrow(/enumerable data property/)
    expect(() => Flow.Flow(Object.defineProperty({ flow: "review" }, "featured", { value: true, enumerable: false })))
      .toThrow(/enumerable data property/)
  })
})

describe("FlowCatalog.rows", () => {
  const review = Flow.Flow({ flow: "review", summary: "Review the change.", featured: true })
  const lint = Flow.Flow({ flow: "lint", summary: "Lint the named files.", featured: true })
  const notes = Flow.Flow({ flow: "release-notes", summary: "Draft the notes." })
  const found = [
    discovered("release-notes", { kind: "ts", path: "flows/release-notes/flow.ts", model: "openai:gpt-5.6-sol" }),
    discovered("create-flow/scaffold"),
    discovered("lint", { modelInvocable: false }),
    discovered("review", { kind: "skill", path: "flows/review/SKILL.md", capabilities: [] }),
    discovered("alpha"),
    discovered("beta")
  ]

  it("orders featured rows first in declaration order, then declared rows, then the rest by id", () => {
    const rows = FlowCatalog.rows(found, [lint, notes, review])
    expect(rows.map((row) => row.id)).toEqual([
      "lint",
      "review",
      "release-notes",
      "alpha",
      "beta",
      "create-flow/scaffold"
    ])
    expect(rows.map((row) => row.featured)).toEqual([true, true, false, false, false, false])
    expect(rows.map((row) => row.summary)).toEqual([
      "Lint the named files.",
      "Review the change.",
      "Draft the notes.",
      null,
      null,
      null
    ])
  })

  it("carries every discovered field onto the row", () => {
    const [row] = FlowCatalog.rows([found[0]!], [notes])
    expect(row).toEqual({
      id: "release-notes",
      description: "Describes release-notes.",
      summary: "Draft the notes.",
      featured: false,
      kind: "ts",
      path: "flows/release-notes/flow.ts",
      capabilities: ["fs:read:**"],
      model: "openai:gpt-5.6-sol",
      modelInvocable: true
    })
  })

  it("fails by id when a declaration names no discovered flow", () => {
    const missing = Flow.Flow({ flow: "reveiw", featured: true })
    expect(() => FlowCatalog.rows(found, [review, missing])).toThrow(FlowCatalog.FlowCatalogError)
    expect(() => FlowCatalog.rows(found, [review, missing])).toThrow(/discovery did not find: "reveiw"/)
    expect(() => FlowCatalog.rows(found, [missing, Flow.Flow({ flow: "nope" })]))
      .toThrow(/flows discovery did not find: "reveiw", "nope"/)
  })

  it("fails when a flow is declared twice or discovered twice", () => {
    expect(() => FlowCatalog.rows(found, [review, Flow.Flow({ flow: "review" })]))
      .toThrow(/declares the flow "review" twice/)
    expect(() => FlowCatalog.rows([...found, discovered("alpha")], []))
      .toThrow(/reported the flow "alpha" twice/)
  })
})
