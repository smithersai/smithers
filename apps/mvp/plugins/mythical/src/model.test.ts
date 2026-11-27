import { describe, expect, it } from "vitest"
import { extractMythical, groupByEpic } from "./model"

describe("mythical plugin model", () => {
  it("returns empty state when no mythical feed document exists", () => {
    expect(extractMythical([])).toEqual({
      hasFeed: false,
      commits: [],
      epics: [],
      treeEqualToMain: false,
      updatedAt: null,
    })
  })

  it("extracts commits, sorts newest position first, groups by epic, and preserves tree-equality and notes", () => {
    const res = extractMythical([
      {
        id: "smithersai/smithers:mythical",
        repo: "smithersai/smithers",
        name: "mythical",
        updatedAt: "2026-11-26T23:00:00Z",
        body: {
          updatedAt: "2026-11-26T23:55:00Z",
          commits: [
            {
              position: 1,
              epic: "cloud-object-store",
              title: "feat(object-store): unify shared R2 + Postgres artifact plane",
              summary: "Single object store for artifacts, audits, wiki, and cache",
              commitSha: "aaaa1111bbbb2222",
              treeEqualToMain: false,
              authorLogin: "roninjin10",
              notes: [{ kind: "decision", summary: "Use R2 with inline <=256 KiB fallback" }],
            },
            {
              position: 2,
              epic: "trust",
              title: "feat(trust): isolate untrusted community runs from cache and gates",
              summary: "Encourages untrusted runs while blocking cache poisoning",
              commitSha: "cccc3333dddd4444",
              mainFoldedSha: "cccc3333dddd4444",
              treeEqualToMain: true,
              prNumber: 42,
              authorLogin: "roninjin10",
              notes: [
                { kind: "evidence", summary: "All 57 unit tests passing", ref: "audit-report/latest.json" },
                { kind: "abandoned", summary: "Rejected client-declared trust headers" },
              ],
            },
          ],
        },
      },
    ])

    expect(res.hasFeed).toBe(true)
    expect(res.treeEqualToMain).toBe(true)
    expect(res.commits.map((c) => c.position)).toEqual([2, 1])
    expect(res.commits[0]!.notes).toHaveLength(2)
    expect(res.epics.map((e) => e.epic)).toEqual(["trust", "cloud-object-store"])
    expect(groupByEpic(res.commits)).toHaveLength(2)
  })
})
