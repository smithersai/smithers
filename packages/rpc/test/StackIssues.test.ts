import { describe, expect, test } from "vitest"
import type { MythicalItem, MythicalStack } from "../src/Mythical.ts"
import {
  issueGroups,
  issueProgress,
  issueWord,
  settledItems,
  stackMetricLabels,
  stackMetrics
} from "../src/StackIssues.ts"
import { itemReason, itemStateLabel } from "../src/StackView.ts"

const item = (id: string, state: MythicalItem["state"], details: Partial<MythicalItem> = {}): MythicalItem => ({
  id,
  state,
  attempt: 0,
  runs: {},
  dependsOn: [],
  updatedAt: "2026-09-29T12:00:00Z",
  ...details
})

const stack = (items: ReadonlyArray<MythicalItem>): MythicalStack => ({
  repository: "example/repo",
  state: "active",
  generation: 1,
  mainBehind: false,
  changes: [],
  items: [...items],
  lanes: [],
  limits: { maxParallel: 1 }
})

describe("stack metrics", () => {
  test("an empty stack has zero counts and no ratios with a zero denominator", () => {
    expect(stackMetrics(stack([]))).toMatchObject({
      landed: 0,
      landedUnedited: 0,
      landedUneditedShare: undefined,
      costPerLanded: undefined,
      misroutes: 0,
      replans: 0,
      veryHard: 0
    })
  })

  test("a stack with no landed items cannot quote cost per landed even when it has cost", () => {
    const metrics = stackMetrics(stack([
      item("rejected", "rejected", { costNanos: 2_000_000_000, humanEdited: false, todo: { replans: 2 } }),
      item("blocked", "blocked", { costNanos: 1_000_000_000, todo: { replans: 1, veryHard: true } })
    ]))
    expect(metrics).toMatchObject({
      landedUnedited: 0,
      landedUneditedShare: undefined,
      costPerLanded: undefined,
      replans: 3,
      veryHard: 0
    })
  })

  test("unedited share uses landed items and cost per landed includes all measured item cost", () => {
    const metrics = stackMetrics(stack([
      item("landed-untouched", "landed", { costNanos: 1_000_000_000, todo: { replans: 0 } }),
      item("landed-edited", "landed", {
        humanEdited: true,
        costNanos: 2_000_000_000,
        todo: { replans: 2, veryHard: true }
      }),
      item("rejected", "rejected", { humanEdited: false, costNanos: 3_000_000_000, todo: { replans: 1 } }),
      item("active-continuation", "running", { todo: { replans: 2, veryHard: true } }),
      item("scheduled-continuation", "retrying", { todo: { replans: 0, veryHard: true } }),
      item("queued", "queued", { humanEdited: false })
    ]))
    expect(metrics).toMatchObject({
      landed: 2,
      landedUnedited: 1,
      landedUneditedShare: 50,
      costPerLanded: 3,
      replans: 5,
      veryHard: 1
    })
  })

  test("zero cost, unavailable cost, and all-edited and all-unedited share boundaries", () => {
    expect(stackMetrics(stack([item("untouched", "landed")]))).toMatchObject({
      landedUnedited: 1,
      landedUneditedShare: 100,
      costPerLanded: undefined
    })
    expect(stackMetrics(stack([item("edited", "landed", { humanEdited: true, costNanos: 0 })]))).toMatchObject({
      landedUnedited: 0,
      landedUneditedShare: 0,
      costPerLanded: 0
    })
  })

  test("the unedited percentage rounds to a whole number", () => {
    expect(
      stackMetrics(stack([
        item("first", "landed"),
        item("second", "landed", { humanEdited: false }),
        item("third", "landed", { humanEdited: true })
      ])).landedUneditedShare
    ).toBe(67)
  })

  test("misroutes use the settled route outcome, including both ways to get one", () => {
    const routes = [
      { as: "close", landed: "change" },
      { as: "implement", landed: "close" },
      { as: "bug", landed: "close" },
      { as: "feature", landed: "close" },
      { as: "close", landed: "close" },
      { as: "implement", landed: "change" },
      { as: "bug", landed: "change" },
      { as: "feature", landed: "change" },
      { as: "close" }
    ] as const
    const items = routes.map((route, index) => item(`route-${index}`, "landed", { route }))
    items.push(item("no-route", "landed"))
    expect(stackMetrics(stack(items)).misroutes).toBe(3)
  })

  test("the header labels omit unavailable ratios and count only a live very-hard continuation", () => {
    const empty = stackMetricLabels(stackMetrics(stack([]))).map(({ text }) => text)
    expect(empty).toEqual(["0 reverts", "0 misroutes", "0 replans"])
    const value = stack([
      item("landed", "landed", { costNanos: 1_000_000_000 }),
      item("verifying", "verifying", { todo: { replans: 2, veryHard: true } }),
      item("retrying", "retrying", { todo: { replans: 2, veryHard: true } }),
      item("blocked", "blocked", { todo: { replans: 2, veryHard: true } })
    ])
    expect(stackMetrics(value).veryHard).toBe(1)
    expect(stackMetricLabels(stackMetrics(value)).map(({ text }) => text)).toEqual([
      "1/2 landed",
      "100% landed unedited",
      "$1.00/landed",
      "0 reverts",
      "0 misroutes",
      "6 replans",
      "1 very hard"
    ])
    expect(issueProgress(value.items[1]!)).toBe("plan 3 of 3 · very hard")
    expect(issueProgress(value.items[2]!)).toBe("plan 3 of 3")
    expect(issueProgress(value.items[3]!)).toBeUndefined()
  })

  test("never-started skipped issues stay out of Done today and the settled table", () => {
    const value = stack([
      item("skipped", "skipped"),
      item("landed", "landed"),
      item("declined", "declined")
    ])
    expect(issueGroups(value).find((group) => group.id === "done")?.items.map((row) => row.id)).toEqual([
      "landed",
      "declined"
    ])
    expect(settledItems(value).map((row) => row.id)).toEqual(["landed", "declined"])
    expect(
      issueWord(item("blocked", "blocked", { reason: "very hard: exhausted", todo: { replans: 2, veryHard: true } }))
    ).toBe("blocked")
  })

  test("a typed failure is the word and reason line, even on an open pull request or over old conflict paths", () => {
    const review = item("held", "proposed", {
      reason: "The review did not finish",
      failure: { kind: "review", fault: "user" }
    })
    expect(issueWord(review)).toBe("The review did not finish")
    expect(issueWord(item("open", "proposed", { reason: "waiting for CI on the approved head" }))).toBe("PR open")
    const model = item("model", "retrying", {
      reason: "The model provider did not answer",
      failure: { kind: "model", fault: "dependency" },
      integration: { conflict: { paths: ["a.ts"] } }
    })
    expect(itemReason(model)).toBe("The model provider did not answer")
    expect(itemStateLabel(model)).toBe("retrying")
    const conflict = item("conflict", "retrying", { integration: { conflict: { paths: ["a.ts"] } } })
    expect(itemReason(conflict)).toBe("a.ts")
    expect(itemStateLabel(conflict)).toBe("retrying")
    // Historical conflict data stays readable without claiming a new conflict wait.
    expect(issueWord(conflict)).toBe("retrying")
    expect(itemStateLabel({ ...conflict, state: "blocked" })).toBe("blocked")
    expect(itemStateLabel({ ...conflict, state: "integrating" })).toBe("rebasing")
    expect(itemStateLabel({ ...conflict, integration: { conflict: { paths: [] } } })).toBe("retrying")
    expect(itemReason({ ...conflict, integration: { conflict: { paths: [] } } })).toBeUndefined()
  })
})

describe("issue to landed", () => {
  const landed = (id: string, createdAt: string | undefined, updatedAt: string): MythicalItem =>
    item(id, "landed", { ...(createdAt === undefined ? {} : { createdAt }), updatedAt })

  test("p50 is the middle duration, or the mean of the two middle ones, over landed items with both stamps", () => {
    const odd = stack([
      landed("a", "2026-09-29T00:00:00Z", "2026-09-29T03:00:00Z"),
      landed("b", "2026-09-29T00:00:00Z", "2026-09-29T01:00:00Z"),
      landed("c", "2026-09-29T00:00:00Z", "2026-09-29T02:00:00Z")
    ])
    expect(stackMetrics(odd).p50Ms).toBe(2 * 3_600_000)
    const even = stack([...odd.items, landed("d", "2026-09-29T00:00:00Z", "2026-09-29T06:00:00Z")])
    expect(stackMetrics(even).p50Ms).toBe(2.5 * 3_600_000)
  })

  test("an item without createdAt, with an unreadable stamp, landing before it was seen, or not landed has no duration", () => {
    const metrics = stackMetrics(stack([
      landed("no-start", undefined, "2026-09-29T03:00:00Z"),
      landed("bad-start", "not a date", "2026-09-29T03:00:00Z"),
      landed("bad-end", "2026-09-29T00:00:00Z", ""),
      landed("backwards", "2026-09-29T05:00:00Z", "2026-09-29T03:00:00Z"),
      item("open", "proposed", { createdAt: "2026-09-29T00:00:00Z", updatedAt: "2026-09-29T03:00:00Z" })
    ]))
    expect(metrics.p50Ms).toBeUndefined()
    expect(metrics.landed).toBe(4)
    expect(stackMetricLabels(metrics).map((label) => label.id)).not.toContain("p50")
  })

  test.each([
    [0, "0m"],
    [59 * 60_000, "59m"],
    [60 * 60_000, "1h"],
    [47 * 3_600_000, "47h"],
    [48 * 3_600_000, "2d"],
    [10 * 86_400_000, "10d"]
  ])("a %d ms p50 reads %s in the header", (ms, text) => {
    const metrics = stackMetrics(
      stack([landed("a", "2026-09-01T00:00:00Z", new Date(Date.parse("2026-09-01T00:00:00Z") + ms).toISOString())])
    )
    expect(stackMetricLabels(metrics).find((label) => label.id === "p50")?.text).toBe(`${text} p50`)
  })
})

describe("decided and reverts", () => {
  test("landed, rejected, blocked and declined are decided; cancelled, skipped and live items are not", () => {
    const metrics = stackMetrics({
      ...stack([
        item("l", "landed"),
        item("r", "rejected"),
        item("b", "blocked"),
        item("d", "declined"),
        item("c", "cancelled"),
        item("s", "skipped"),
        item("q", "queued"),
        item("p", "proposed")
      ]),
      changes: [
        { changeId: "1", commitId: "a", title: "Revert x", kind: "revert", state: "landed" },
        { changeId: "2", commitId: "b", title: "x", kind: "item", state: "landed" }
      ]
    })
    expect([metrics.landed, metrics.decided, metrics.reverts]).toEqual([1, 4, 1])
    expect(stackMetricLabels(metrics).slice(0, 1)).toEqual([{ id: "landed", text: "1/4 landed" }])
    expect(stackMetricLabels(metrics).find((label) => label.id === "reverts")?.text).toBe("1 revert")
  })
})

describe("issue groups", () => {
  const ids = (groups: ReturnType<typeof issueGroups>, id: string) =>
    groups.find((group) => group.id === id)!.items.map((row) => row.id)

  test("needs you waits longest first, working lists lanes in lane order before the queue, done is newest first", () => {
    const groups = issueGroups(stack([
      item("q1", "queued"),
      item("lane2", "running", { lane: 2 }),
      item("newer-block", "blocked", { updatedAt: "2026-09-29T12:00:00Z" }),
      item("q2", "queued"),
      item("lane1", "running", { lane: 1 }),
      item("older-pr", "proposed", { updatedAt: "2026-09-29T08:00:00Z" }),
      item("old-done", "landed", { updatedAt: "2026-09-28T00:00:00Z" }),
      item("new-done", "declined", { updatedAt: "2026-09-29T11:00:00Z" })
    ]))
    expect(groups.map((group) => group.id)).toEqual(["needs-you", "working", "done"])
    expect(ids(groups, "needs-you")).toEqual(["older-pr", "newer-block"])
    expect(ids(groups, "working")).toEqual(["lane1", "lane2", "q1", "q2"])
    expect(ids(groups, "done")).toEqual(["new-done", "old-done"])
  })

  test("with a clock, Done keeps the last 24 hours and any item without a readable stamp", () => {
    const now = Date.parse("2026-09-29T12:00:00Z")
    const groups = issueGroups(
      stack([
        item("edge", "landed", { updatedAt: "2026-09-28T12:00:00Z" }),
        item("stale", "landed", { updatedAt: "2026-09-28T11:59:59Z" }),
        item("unstamped", "cancelled", { updatedAt: "" })
      ]),
      now
    )
    expect(ids(groups, "done")).toEqual(["edge", "unstamped"])
  })
})

describe("ties and singular counts", () => {
  test("Needs you items waiting since the same moment keep snapshot order", () => {
    const groups = issueGroups(stack([
      item("b", "blocked", { updatedAt: "2026-09-29T08:00:00Z" }),
      item("a", "proposed", { updatedAt: "2026-09-29T08:00:00Z" }),
      item("c", "blocked", { updatedAt: "2026-09-29T07:00:00Z" })
    ]))
    expect(groups.find((group) => group.id === "needs-you")?.items.map((one) => one.id)).toEqual(["c", "b", "a"])
  })

  test("one misroute and one replan read in the singular, two in the plural", () => {
    const base = stackMetrics(stack([]))
    const text = (misroutes: number, replans: number) =>
      stackMetricLabels({ ...base, misroutes, replans }).filter(({ id }) => id === "misroutes" || id === "replans")
        .map((label) => label.text)
    expect(text(1, 1)).toEqual(["1 misroute", "1 replan"])
    expect(text(2, 2)).toEqual(["2 misroutes", "2 replans"])
  })
})
