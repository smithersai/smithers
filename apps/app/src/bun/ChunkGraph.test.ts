import { describe, expect, test } from "bun:test"
import { assertAcyclicChunks } from "../../scripts/chunk-graph"

describe("built chunks preserve dependency initialization order", () => {
  test("rejects a vendor-only cycle even when nothing imports the entry", () => {
    expect(() =>
      assertAcyclicChunks([
        { fileName: "entry.js", imports: ["vendor-a.js"] },
        { fileName: "vendor-a.js", imports: ["vendor-b.js"] },
        { fileName: "vendor-b.js", imports: ["vendor-a.js"] }
      ])
    ).toThrow("vendor-a.js -> vendor-b.js -> vendor-a.js")
  })
  test("also guards a lazy entry and a self-import", () => {
    expect(() =>
      assertAcyclicChunks([
        { fileName: "entry.js", imports: [] },
        { fileName: "lazy.js", imports: ["shared.js"] },
        { fileName: "shared.js", imports: ["lazy.js"] }
      ])
    ).toThrow("lazy.js -> shared.js -> lazy.js")
    expect(() => assertAcyclicChunks([{ fileName: "self.js", imports: ["self.js"] }])).toThrow("self.js -> self.js")
  })
  test("accepts shared acyclic dependencies and external imports", () => {
    expect(() =>
      assertAcyclicChunks([
        { fileName: "entry.js", imports: ["a.js", "b.js"] },
        { fileName: "a.js", imports: ["shared.js"] },
        { fileName: "b.js", imports: ["shared.js"] },
        { fileName: "shared.js", imports: ["external"] }
      ])
    ).not.toThrow()
  })
})
