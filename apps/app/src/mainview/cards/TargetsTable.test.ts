import { describe, expect, test } from "bun:test"
import type { Target } from "@smthrs/rpc/LocalApp"
import type { RunRecord } from "@smthrs/rpc/TargetGraph"
import { filterRows, kindsOf, lastRunsByLabel, runStateOf, targetRows, toggled, workspacesOf } from "./TargetsTable"

const target = (label: string, kinds: ReadonlyArray<string>, workspace = ".", featured?: boolean): Target => ({
  id: `id-${label}`,
  label,
  target: "Shell.Test",
  kinds: [...kinds],
  package: label.split(":")[0] ?? "//",
  name: label.split(":")[1] ?? label,
  workspace,
  ...(featured === undefined ? {} : { featured })
})

/** `//a:build` is featured by its declaration; the others are bare. */
const featured = (rows: ReadonlyArray<Target>): Array<Target> =>
  rows.map((row) => (row.label === "//a:build" ? { ...row, featured: true } : row))

const run = (runId: string, label: string, status: RunRecord["status"], startedAt: number): RunRecord => ({
  runId,
  repoId: "repo",
  label,
  labels: [label],
  status,
  startedAt
})

const targets = [
  target("//a:build", ["build"]),
  target("//a:test", ["test"]),
  target("//b:lint", ["lint"], "tools"),
  target("//b:check", ["test", "lint"], "tools")
]

describe("the targets table's rules", () => {
  test("a row's state comes from its LATEST recorded run, never from an older one", () => {
    const runs = [
      run("r1", "//a:test", "failed", 10),
      run("r2", "//a:test", "done", 20),
      run("r3", "//a:build", "running", 5)
    ]
    expect(lastRunsByLabel(runs).get("//a:test")?.runId).toBe("r2")
    const rows = targetRows(targets, runs)
    expect(rows.map((row) => row.state)).toEqual(["running", "passed", "never", "never"])
    expect(runStateOf(run("x", "//a", "cancelled", 1))).toBe("failed")
    expect(runStateOf(run("x", "//a", "pending", 1))).toBe("running")
    expect(runStateOf(undefined)).toBe("never")
  })

  test("filters narrow by query, kind, state, and workspace; an empty facet keeps everything", () => {
    const rows = targetRows(targets, [run("r1", "//a:test", "failed", 1)])
    expect(filterRows(rows, undefined)).toHaveLength(4)
    expect(filterRows(rows, { kinds: [], states: [] })).toHaveLength(4)
    expect(filterRows(rows, { query: "//b" }).map((row) => row.target.label)).toEqual(["//b:lint", "//b:check"])
    expect(filterRows(rows, { query: "TOOLS" })).toHaveLength(2)
    expect(filterRows(rows, { kinds: ["lint"] }).map((row) => row.target.label)).toEqual(["//b:lint", "//b:check"])
    expect(filterRows(rows, { kinds: ["lint", "build"] })).toHaveLength(3)
    expect(filterRows(rows, { states: ["failed"] }).map((row) => row.target.label)).toEqual(["//a:test"])
    expect(filterRows(rows, { states: ["never"] })).toHaveLength(3)
    expect(filterRows(rows, { workspace: "tools", kinds: ["test"] }).map((row) => row.target.label)).toEqual(["//b:check"])
  })

  test("chip vocabularies come from the data in first-seen order; toggling flips membership", () => {
    expect(kindsOf(targets)).toEqual(["build", "test", "lint"])
    expect(workspacesOf(targets)).toEqual([".", "tools"])
    expect(toggled(undefined, "test")).toEqual(["test"])
    expect(toggled(["test", "lint"], "test")).toEqual(["lint"])
  })
})

import { groupLabel, groupRows, groupSummary, patternRuns, pickedMembers, viewMode } from "./TargetsTable"

describe("the Featured and Recent views", () => {
  const facts = { starred: ["//b:lint"] }

  test("the default view is Featured only when a declaration features something or the user starred something", () => {
    expect(viewMode(undefined, targetRows(targets))).toBe("all")
    expect(viewMode(undefined, targetRows(featured(targets)))).toBe("featured")
    expect(viewMode(undefined, targetRows(targets, [], facts))).toBe("featured")
    expect(viewMode({ mode: "recent" }, targetRows(featured(targets), [], facts))).toBe("recent")
    expect(viewMode({ mode: "all" }, targetRows(featured(targets), [], facts))).toBe("all")
  })

  test("Featured keeps the declarations' featured labels and the user's stars, in loader order", () => {
    const rows = targetRows(featured(targets), [], facts)
    expect(rows.map((row) => [row.featured, row.starred])).toEqual([[true, false], [false, false], [false, true], [false, false]])
    expect(filterRows(rows, undefined, "featured").map((row) => row.target.label)).toEqual(["//a:build", "//b:lint"])
    // The text filter still narrows inside the view.
    expect(filterRows(rows, { query: "lint" }, "featured").map((row) => row.target.label)).toEqual(["//b:lint"])
  })

  test("the query matches a declared summary too", () => {
    const rows = targetRows([{ ...target("//a:build", ["build"]), summary: "Emit the aggregate barrel's dist." }])
    expect(filterRows(rows, { query: "barrel" }).map((row) => row.target.label)).toEqual(["//a:build"])
    expect(filterRows(rows, { query: "nothing" })).toEqual([])
  })

  test("Recent keeps only targets with a recorded run, most recent first", () => {
    const runs = [run("r1", "//a:test", "done", 10), run("r2", "//b:check", "failed", 30), run("r3", "//a:build", "done", 20)]
    const rows = targetRows(targets, runs)
    expect(filterRows(rows, undefined, "recent").map((row) => row.target.label)).toEqual(["//b:check", "//a:build", "//a:test"])
    expect(filterRows(rows, undefined, "all").map((row) => row.target.label)).toEqual(targets.map((t) => t.label))
  })
})

describe("name groups across packages", () => {
  const many = [
    target("//packages/a:lint", ["lint"]),
    target("//packages/a:build", ["build"]),
    target("//packages/b:lint", ["lint"]),
    target("//packages/c:lint", ["lint", "check"]),
    target("//tools:release", ["run"])
  ]

  test("targets sharing a name collapse into one //...:name row at the first member's position; singletons stay", () => {
    const rows = groupRows(targetRows(many))
    expect(rows.map((row) => row.target.label)).toEqual([groupLabel("lint"), "//packages/a:build", "//tools:release"])
    const group = rows[0]?.group
    expect(group?.members.map((member) => member.target.label)).toEqual(["//packages/a:lint", "//packages/b:lint", "//packages/c:lint"])
    expect(rows[0]?.target.kinds).toEqual(["lint", "check"])
    expect(rows[0]?.target.id).toBe("//...:lint")
  })

  test("a group's state is its worst member's, its last run the latest, and its summary counts states", () => {
    const runs = [run("r1", "//packages/a:lint", "done", 10), run("r2", "//packages/b:lint", "failed", 5)]
    const [group] = groupRows(targetRows(many, runs))
    expect(group?.state).toBe("failed")
    expect(group?.lastRun?.runId).toBe("r1")
    expect(groupSummary(group!.group!.counts)).toBe("1 failed · 1 passed · 1 never run")
  })

  test("a featured member features its group, stars apply to the group label or a member, and the filter matches a member's label", () => {
    const withFeatured = many.map((row) => (row.label === "//packages/c:lint" ? { ...row, featured: true } : row))
    const rows = groupRows(targetRows(withFeatured, [], { starred: ["//packages/b:lint"] }))
    expect(rows[0]?.featured).toBe(true)
    expect(rows[0]?.group?.members[2]?.featured).toBe(true)
    expect(rows[0]?.group?.members[1]?.starred).toBe(true)
    expect(filterRows(rows, undefined, "featured").map((row) => row.target.label)).toEqual([groupLabel("lint")])
    // A member-only star still lights the group in Featured.
    const memberOnly = groupRows(targetRows(many, [], { starred: ["//packages/b:lint"] }))
    expect(filterRows(memberOnly, undefined, "featured").map((row) => row.target.label)).toEqual([groupLabel("lint")])
    expect(filterRows(rows, { query: "packages/c" }).map((row) => row.target.label)).toEqual([groupLabel("lint")])
    expect(filterRows(rows, { query: "release" }).map((row) => row.target.label)).toEqual(["//tools:release"])
  })

  test("picked members default to all, and a pick list narrows the set", () => {
    const [group] = groupRows(targetRows(many))
    expect(pickedMembers(group!.group!, undefined).length).toBe(3)
    expect(pickedMembers(group!.group!, { [groupLabel("lint")]: ["//packages/c:lint"] }).map((m) => m.target.label)).toEqual(["//packages/c:lint"])
    expect(pickedMembers(group!.group!, { [groupLabel("lint")]: [] })).toEqual([])
  })
})

test("the run strip is derived from the kinds the targets carry: ci always, then one verb per present kind", () => {
  expect(patternRuns([])).toEqual([])
  expect(patternRuns(targets).map((run) => [run.id, run.verb, run.pattern, run.workspace])).toEqual([
    ["ci", "ci", "//...", "."],
    ["build", "build", "//...", "."],
    ["test", "test", "//...", "."],
    ["lint", "lint", "//...", "."]
  ])
  expect(patternRuns([target("//docs:site", ["docs"])]).map((run) => run.verb)).toEqual(["ci", "docs"])
  // `run` targets are services, never swept.
  expect(patternRuns([target("//web:dev", ["run"])]).map((run) => run.verb)).toEqual(["ci"])
})
