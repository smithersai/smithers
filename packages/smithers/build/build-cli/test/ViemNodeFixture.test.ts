import * as NodePath from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { serve } from "./helpers/ServeCli.ts"

const fixture = NodePath.join(NodePath.dirname(fileURLToPath(import.meta.url)), "fixtures", "viem-node-spec")

describe("verbatim viem Node-only PACKAGE.ts fixture", () => {
  it("loads the packages that do not touch chain tooling", async () => {
    const result = await serve(fixture, ["query", "//...", "--format", "json"])
    expect(result.exitCode, result.output).toBe(0)
    const rows = JSON.parse(result.output).targets as ReadonlyArray<{ readonly target: string }>
    const rules = new Set(rows.map((row) => row.target))
    // Overlay and Literal are private members of //src build filegroups; a
    // missing constructor would have failed module evaluation before query.
    expect(rows.length).toBeGreaterThan(10)
    expect(rules).toContain("Shell.Build")
    expect(rules).toContain("Generate")
  })

  it("graphs with exactly data/gates/services edges and zero warnings", async () => {
    const result = await serve(fixture, ["graph", "//...", "--format", "json"])
    expect(result.exitCode, result.output).toBe(0)
    const graph = JSON.parse(result.output) as {
      readonly edges: ReadonlyArray<{ readonly kind: string }>
      readonly warnings: ReadonlyArray<unknown>
    }
    expect(graph.warnings).toEqual([])
    expect(graph.edges.every((edge) => ["data", "gates", "services"].includes(edge.kind))).toBe(true)
  })
})
