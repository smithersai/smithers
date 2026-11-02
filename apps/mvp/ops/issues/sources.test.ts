// The importer's records (ops/issues/sources.mjs) and their places in the tree (ops/issues/tree.mjs), on synthetic
// input only.
import { describe, expect, test } from "vitest"
// @ts-expect-error: a plain .mjs script, untyped.
import { draftRecords, fuzzRecords, migrationRecords, queueRecords, reviewRoundRecords, scopedRecords } from "./sources.mjs"
// @ts-expect-error: a plain .mjs script, untyped.
import { nodeOfLane, nodeOfParentText, place, ROOT } from "./tree.mjs"

type Row = { key: string; parent: string; labels: Array<string>; links: Array<{ kind: string; state?: string }>; title: string; body: string; depth: number }
const keys = (rows: Array<Row>) => rows.map((row) => row.key)

describe("the importer's records", () => {
  test("queue: queued and held entries, and a rejected one only while it is its lane's latest", () => {
    const rows = queueRecords([
      { id: "1-a", lane: "migfix-alchemy", rev: "aaa", at: "2026-11-01T00:00:00Z", state: "queued" },
      { id: "2-b", lane: "fix-b", at: "2026-11-01T00:00:00Z", state: "rejected" },
      { id: "3-b", lane: "fix-b", at: "2026-11-02T00:00:00Z", state: "landed" },
      { id: "4-c", lane: "spec-lander", at: "2026-11-02T00:00:00Z", state: "rejected", reason: "conflicts" },
      { id: "5-d", lane: "fix-d", at: "2026-11-02T00:00:00Z", state: "superseded" },
      { id: "6-e", lane: "fix-e", at: "2026-11-02T00:00:00Z", state: "held" },
    ])
    expect(keys(rows)).toEqual(["queue:1-a", "queue:4-c", "queue:6-e"])
    expect(rows[0].labels).toEqual(["queue", "migrate:alchemy"])
    expect(rows[0].parent).toBe("tree:repos:alchemy")
    expect(rows[1].links.map((link: { kind: string; state?: string }) => `${link.kind}:${link.state ?? ""}`)).toEqual(["queue:failed", "session:"])
    expect(rows[1].parent).toBe("tree:spec")
  })

  test("spec review: the round's unfixed findings, and one record per still-open row across reviewers", () => {
    const opus = [
      "## Findings",
      "### OPUS-1 [major] 002:652 — FIXED abc123",
      "fixed text",
      "### OPUS-2 [minor] 001:483",
      "What is wrong. Something.",
      "## Still open from earlier rounds",
      "| # | Finding | Still on this main | Queue status |",
      "| --- | --- | --- | --- |",
      "| 1 | r2 OPUS-2 / ASTRA-2 [major]: warnings without a VIP | 007:145 | rejected |",
    ].join("\n")
    const astra = ["## Still open from earlier rounds", "| 1 | R2 ASTRA-2: advisory authority | 007:126 | rejected |", "| 2 | R3 OPUS-1: a name twice | 004:310 | queued |"].join("\n")
    const rows = reviewRoundRecords([{ reviewer: "opus", round: 15, text: opus }, { reviewer: "astra", round: 15, text: astra }])
    expect(keys(rows)).toEqual(["review:spec:r15-OPUS-2", "review:spec:r2-OPUS-2", "review:spec:r3-OPUS-1"])
    expect(rows[1].body).toContain("Also reported as r2-ASTRA-2")
    expect(rows.every((row: Row) => row.parent === "tree:spec")).toBe(true)
  })

  test("scoped review: a finding any line marks fixed is left out", () => {
    const text = ["### RC-1 [major] `a` — bad", "body", "### RC-2 — minor — worse", "body", "## pass 3", "RC-1 fixed in abc"].join("\n")
    expect(keys(scopedRecords("rev-compiler", text))).toEqual(["review:rev-compiler:RC-2"])
    expect(scopedRecords("rev-docs", "### RD-001 [major] x\nbody")[0].parent).toBe("tree:docs")
  })

  test("migration: numbered and dated findings, without addenda, messages or fixed ones", () => {
    const text = [
      "### alchemy-1: lint panics",
      "details",
      "### alchemy-2: a fix landed",
      "FIXED by a commit",
      "### alchemy-1 addendum: more",
      "### alchemy-3 (drive-alchemy, 2026-10-31T10:00Z): a gate",
      "## Orchestrator, 2026-10-31T08:25Z, for migfix-alchemy: priorities",
      "## 2026-11-01T02:18Z platform: a message",
      "## 2026-10-31: setup leaves a stale lockfile",
      "## 2026-10-31: note, a remark",
      "### alchemy-4: still broken",
      "## migfix, 2026-11-01: alchemy-4 fixed in abc",
    ].join("\n")
    const rows = migrationRecords("alchemy", text)
    expect(rows.map((row: Row) => row.title)).toEqual(["alchemy migration: lint panics", "alchemy migration: a gate", "alchemy migration: setup leaves a stale lockfile"])
    expect(rows[0]).toMatchObject({ key: "migrate:alchemy:alchemy-1", labels: ["migration-finding", "migrate:alchemy"], parent: "tree:repos:alchemy" })
  })

  test("fuzz: open oracle lines grouped by area, target and reason; corpus and superseded lines skip", () => {
    const { records, areas } = fuzzRecords([{
      name: "data.txt",
      text: [
        "# comment",
        "FuzzData feature:a compiler VIP-7: match accepts a missing semicolon; lane vip-match",
        "FuzzData feature:b compiler VIP-7: match accepts a missing semicolon; lane vip-match",
        "FuzzData corpus:a compiler VIP-7: match accepts a missing semicolon; lane vip-match; reproduction",
        "FuzzData ek:EK48* superseded VIP-6: gone",
        "FuzzData feature:c compiler crash: parser panics",
      ].join("\n"),
    }])
    expect(records).toHaveLength(2)
    expect(records[0].title).toBe("FuzzData: match accepts a missing semicolon (VIP-7)")
    expect(records[0].body).toContain("keys (2): `feature:a`, `feature:b`")
    expect(records[0].links).toEqual([{ kind: "session", ref: "lane:vip-match", label: "lane vip-match" }])
    expect(areas).toEqual([["tree:fuzz:data", "Fuzz findings: data", "tree:fuzz"]])
    expect(fuzzRecords([{ name: "data.txt", text: "FuzzData feature:z compiler VIP-7: match accepts a missing semicolon; lane other" }]).records[0].key).toBe(records[0].key)
  })

  test("drafts: filed under the node their parent text names", () => {
    const rows = draftRecords("opencode", [
      { title: "Loader fails", body: "b", labels: ["bug"], parent: "Ship VibeLang > Tooling" },
      { title: "Track opencode", body: "b", parent: "Example repos: opencode", draft_id: "d1" },
      { title: "Gate", body: "b", parent: "Release 0.0.11 gates", repo: "smithersai/smithers" },
    ])
    expect(rows.map((row: Row) => row.parent)).toEqual(["tree:tooling", "tree:repos:opencode", "tree:release"])
    expect(rows[0].labels).toEqual(["bug", "migrate:opencode"])
    expect(rows[1].key).toBe("draft:opencode:d1")
    expect(nodeOfParentText("The vibe and main workflow")).toBe("tree:workflow")
    expect(nodeOfLane("core-land")).toBe("tree:explicit-effects")
  })

  test("drafts: closed ones skip, their own keys and links carry over, labels place an unparented one", () => {
    const rows = draftRecords("spec", [
      { key: "lane-x", title: "Retire a form", body: "b", labels: ["spec", "compiler"], links: { lane: "class1", mq: ["4cff70"], commit: "" }, state: "open" },
      { key: "lane-y", title: "Done already", body: "b", labels: ["compiler"], state: "closed" },
      { id: "foldkit-4", title: "Docs page", body: "b", labels: ["docs"], status: "draft" },
      { title: "A compiler gap", body: "b", labels: ["compiler"] },
    ])
    expect(keys(rows)).toEqual(["draft:spec:lane-x", "draft:spec:foldkit-4", expect.stringMatching(/^draft:spec:[0-9a-f]{12}$/)])
    expect(rows[0].links).toEqual([{ kind: "session", ref: "lane:class1", label: "lane class1" }, { kind: "queue", ref: "4cff70", label: "queue 4cff70" }])
    expect(rows.map((row: Row) => row.parent)).toEqual(["tree:spec", "tree:docs", "tree:impl"])
  })

  test("drafts: a repository's tracking draft becomes its tree node's issue, not a child of it", () => {
    const rows = [
      ...draftRecords("t3code", [{ title: "Migrate t3code's Effect modules to VibeLang", body: "scope", parent: "Example repos / t3code (this is the t3code node)" }]),
      ...draftRecords("alchemy", [{ title: "Migrate alchemy to VibeLang (tracking)", body: "scope", parent: "Example repos", role: "the alchemy node under Example repos" }]),
      ...draftRecords("t3code", [{ title: "t3code: a codemod gap", body: "b", parent: "Example repos / t3code" }]),
    ]
    expect(rows.map((row: { asNode?: string }) => row.asNode)).toEqual(["tree:repos:t3code", "tree:repos:alchemy", undefined])
    const tree = place(rows)
    expect(tree.records.map((row: Row) => row.title)).toEqual(["t3code: a codemod gap"])
    expect(tree.nodes.find((node: { key: string }) => node.key === "tree:repos:t3code")).toMatchObject({ title: "Migrate t3code's Effect modules to VibeLang", about: "scope" })
  })
})

describe("the issue tree", () => {
  test("places records under their nodes, splits a node past 100 children into parts, and stays within 8 levels", () => {
    const records = Array.from({ length: 230 }, (_, i) => ({ key: `fuzz:${i}`, title: `t${i}`, parent: "tree:fuzz:data" }))
    records.push({ key: "x", title: "x", parent: "tree:nowhere" })
    const tree = place(records, [["tree:fuzz:data", "Fuzz findings: data", "tree:fuzz"]])
    const root = tree.nodes.find((node: { key: string }) => node.key === ROOT)
    expect(root).toMatchObject({ title: "Ship VibeLang", depth: 1 })
    expect(tree.nodes.filter((node: { parent?: string }) => node.parent === ROOT)).toHaveLength(9)
    expect(tree.nodes.filter((node: { parent?: string }) => node.parent === "tree:release")).toHaveLength(6)
    expect(tree.nodes.filter((node: { parent?: string }) => node.parent === "tree:repos").map((node: { title: string }) => node.title))
      .toEqual(["Migrate alchemy", "Migrate foldkit", "Migrate opencode", "Migrate t3code", "Migrate smithers"])
    const parts = tree.nodes.filter((node: { parent?: string }) => node.parent === "tree:fuzz:data")
    expect(parts.map((node: { title: string }) => node.title)).toEqual(["Fuzz findings: data, part 1 of 3", "Fuzz findings: data, part 2 of 3", "Fuzz findings: data, part 3 of 3"])
    const counts = new Map<string, number>()
    for (const row of [...tree.nodes, ...tree.records]) if (row.parent !== undefined) counts.set(row.parent, (counts.get(row.parent) ?? 0) + 1)
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(100)
    expect(tree.records.at(-1)).toMatchObject({ key: "x", parent: "tree:impl", depth: 3 })
    expect(Math.max(...tree.records.map((row: Row) => row.depth))).toBe(5)
  })
})
