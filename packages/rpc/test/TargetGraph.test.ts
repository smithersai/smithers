import { describe, expect, test } from "vitest"
import { GraphNodeSchema } from "../src/TargetGraph.ts"

describe("GraphNodeSchema", () => {
  const node = {
    label: "//src:typeCheck",
    package: "//src",
    name: "typeCheck",
    rule: "Shell.Test",
    kinds: ["test"],
    plan: {
      mode: "execute",
      cacheable: true,
      key: "a".repeat(64),
      argv: ["node_modules/.bin/tsc", "--noEmit"],
      sandbox: "workspace",
      outDirs: ["dist"],
      outFiles: ["tsconfig.tsbuildinfo"]
    },
    source: { file: "src/PACKAGE.ts", line: 42 }
  }

  test("parses a fixture-shaped node and defaults `private` to false", () => {
    const parsed = GraphNodeSchema.parse(node)
    expect(parsed.private).toBe(false)
    expect(parsed.plan?.key).toBe("a".repeat(64))
    expect(parsed.plan?.argv).toEqual(["node_modules/.bin/tsc", "--noEmit"])
    expect(parsed.plan?.argv?.[0]).toContain("node_modules/.bin/tsc")
    expect(parsed.source).toEqual({ file: "src/PACKAGE.ts", line: 42 })
  })

  test("parses the minimum the loader can emit: no kinds, no plan, no source", () => {
    const parsed = GraphNodeSchema.parse({
      label: "//:claudeMd",
      package: "//",
      name: "claudeMd",
      rule: "Filegroup",
      kinds: []
    })
    expect(parsed).toEqual({
      label: "//:claudeMd",
      package: "//",
      name: "claudeMd",
      rule: "Filegroup",
      kinds: [],
      private: false
    })
  })

  test("carries a private helper node and a plan-time refusal", () => {
    const parsed = GraphNodeSchema.parse({
      label: "//src:__private_Overlay_4",
      package: "//src",
      name: "__private_Overlay_4",
      rule: "Overlay",
      kinds: [],
      private: true,
      plan: { mode: "check", cacheable: false, refusal: "host bin absent: go" }
    })
    expect(parsed.private).toBe(true)
    expect(parsed.plan?.refusal).toBe("host bin absent: go")
  })

  test("refuses a missing label, a non-array `kinds`, a wrong plan mode, and a non-boolean cacheable", () => {
    expect(GraphNodeSchema.safeParse({ package: "//src", name: "x", rule: "R", kinds: [] }).success).toBe(false)
    expect(GraphNodeSchema.safeParse({ ...node, kinds: "test" }).success).toBe(false)
    expect(GraphNodeSchema.safeParse({ ...node, plan: { mode: "build" } }).success).toBe(false)
    expect(GraphNodeSchema.safeParse({ ...node, plan: { cacheable: "yes" } }).success).toBe(false)
    expect(GraphNodeSchema.safeParse({ ...node, source: { line: 3 } }).success).toBe(false)
    expect(GraphNodeSchema.safeParse({ ...node, source: { file: "p.ts", line: "3" } }).success).toBe(false)
  })
})
