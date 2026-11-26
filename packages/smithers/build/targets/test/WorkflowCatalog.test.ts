/**
 * `.smithers/workflows/` in the flow catalog (decision 0171): which entries
 * are workflows, `<name>.vibe` before `<name>.ts`, and a workflow replacing
 * the `.smithers/flows/<name>/flow.ts` of the same id, as apps/mvp
 * `worker/ci/WorkflowDiscovery.ts` reads them.
 */
import { describe, expect, it } from "vitest"
import * as Flow from "../src/Flow.ts"
import * as FlowCatalog from "../src/FlowCatalog.ts"

const flow = (id: string, path: string): FlowCatalog.DiscoveredFlow => ({
  id,
  description: `Runs ${id}.`,
  kind: "ts",
  path,
  capabilities: [],
  model: null,
  modelInvocable: false
})

describe("FlowCatalog.workflowFiles", () => {
  it("reads <name>.vibe before <name>.ts whatever order the directory lists them in", () => {
    for (const entries of [["gate.ts", "gate.vibe"], ["gate.vibe", "gate.ts"]]) {
      expect(FlowCatalog.workflowFiles(entries)).toEqual([{ name: "gate", entry: "gate.vibe" }])
    }
  })

  it("keeps a .ts workflow that has no .vibe, sorted by name", () => {
    expect(FlowCatalog.workflowFiles(["release.ts", "gate.vibe", "fast-check.ts"])).toEqual([
      { name: "fast-check", entry: "fast-check.ts" },
      { name: "gate", entry: "gate.vibe" },
      { name: "release", entry: "release.ts" }
    ])
  })

  it("reads no declaration, test, other extension, or name a host cannot start", () => {
    const entries = [
      "gate.d.ts",
      "gate.d.vibe.ts",
      "gate.test.ts",
      "gate.test.vibe",
      "ci.tsx",
      "notes.md",
      "flow.mdx",
      ".hidden.vibe",
      "Gate.vibe",
      "-gate.vibe",
      "_gate.ts",
      "gate space.vibe",
      ".vibe",
      ".ts",
      `${"a".repeat(65)}.vibe`
    ]
    expect(FlowCatalog.workflowFiles(entries)).toEqual([])
    expect(FlowCatalog.workflowFiles([`${"a".repeat(64)}.vibe`, "a_b-9.ts"]).map((file) => file.name)).toEqual([
      "a_b-9",
      "a".repeat(64)
    ])
  })

  it("holds the name pattern the host that starts a workflow requires", () => {
    expect(FlowCatalog.workflowName.test("gate")).toBe(true)
    expect(FlowCatalog.workflowName.test("bench/gate")).toBe(false)
    expect(FlowCatalog.workflowName.test("")).toBe(false)
  })
})

describe("FlowCatalog.preferWorkflows", () => {
  it("replaces the flows/<name>/flow.ts of the same id and keeps every other flow", () => {
    const legacy = [
      flow("gate", ".smithers/flows/gate/flow.ts"),
      flow("bench/gate", ".smithers/flows/bench/gate/flow.ts"),
      flow("review", ".smithers/flows/review/flow.ts")
    ]
    const joined = FlowCatalog.preferWorkflows(legacy, [flow("gate", ".smithers/workflows/gate.vibe")])
    expect(joined.map((item) => [item.id, item.path])).toEqual([
      ["bench/gate", ".smithers/flows/bench/gate/flow.ts"],
      ["review", ".smithers/flows/review/flow.ts"],
      ["gate", ".smithers/workflows/gate.vibe"]
    ])
  })

  it("joins into catalog rows that carry the workflow's path for a declared flow", () => {
    const joined = FlowCatalog.preferWorkflows(
      [flow("gate", ".smithers/flows/gate/flow.ts")],
      [flow("gate", ".smithers/workflows/gate.vibe")]
    )
    const rows = FlowCatalog.rows(joined, [Flow.Flow({ flow: "gate", summary: "Gate.", featured: true })])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: "gate", featured: true, path: ".smithers/workflows/gate.vibe" })
  })

  it("adds workflows with no older flow and returns the flows unchanged when there are none", () => {
    const legacy = [flow("review", ".smithers/flows/review/flow.ts")]
    expect(FlowCatalog.preferWorkflows(legacy, [])).toEqual(legacy)
    expect(FlowCatalog.preferWorkflows([], [flow("gate", ".smithers/workflows/gate.ts")]).map((item) => item.path))
      .toEqual([".smithers/workflows/gate.ts"])
  })

  it("refuses two workflows of one id by name", () => {
    expect(() =>
      FlowCatalog.preferWorkflows([], [
        flow("gate", ".smithers/workflows/gate.vibe"),
        flow("gate", ".smithers/workflows/gate.ts")
      ])
    ).toThrow(/discovery reported the workflow "gate" twice/)
  })
})
