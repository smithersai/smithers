import { describe, expect, test } from "vitest"
import type { WorkLinkRow } from "./schema"
import { filterWork, withWork, workByIssue, workSearch, workSections } from "./workView"

const row = (number: number, kind: WorkLinkRow["kind"], ref: string, state: WorkLinkRow["state"], minute: number, url: string | null = null): WorkLinkRow => ({
  id: `github/acme/widgets#${number}/${kind}/${ref}`,
  repoId: "github/acme/widgets",
  number,
  kind,
  ref,
  label: ref,
  url,
  state,
  source: "runner:lane-host",
  updatedAt: `2026-11-01 10:${String(minute).padStart(2, "0")}:00+00`,
})

const rows = [
  row(1, "assignee", "lane-a", null, 1),
  row(1, "session", "lane:lane-a", "working", 2),
  row(1, "queue", "q-1", "queued", 3, "https://queue.example.test/q-1"),
  row(1, "pr", "7", "open", 3, "https://github.com/acme/widgets/pull/7"),
  row(2, "assignee", "maya", null, 1),
]

describe("work on the list and the issue page", () => {
  test("groups links by issue, newest first, with each issue's status", () => {
    const work = workByIssue(rows)
    expect(work.get(1)!.links.map((link) => link.ref)).toEqual(["7", "q-1", "lane:lane-a", "lane-a"])
    expect(work.get(1)!.status).toBe("in_review")
    expect(work.get(2)!.status).toBe("none")
    expect(work.get(3)).toBeUndefined()
  })

  test("filters rows by the URL's ?work=, and ignores one it doesn't know", () => {
    const work = workByIssue(rows)
    const issues = [{ number: 1 }, { number: 2 }, { number: 3 }]
    expect(filterWork(issues, work, undefined)).toEqual(issues)
    expect(filterWork(issues, work, "pr-or-queue")).toEqual([{ number: 1 }])
    expect(filterWork(issues, work, "any")).toEqual([{ number: 1 }, { number: 2 }])
    expect(workSearch({ work: "pr-or-queue" })).toEqual({ work: "pr-or-queue" })
    expect(workSearch({ work: "everything" })).toEqual({})
  })

  test("puts the status chip and the addressed pull request and queue entry on each row", () => {
    const work = workByIssue(rows)
    const shown = withWork([
      { number: 1, title: "One", state: "open", labels: ["bug"], links: [{ label: "T1", href: "/acme/widgets/stack/1" }] },
      { number: 2, title: "Two", state: "open" },
      { number: 3, title: "Three", state: "open" },
      { number: null, title: "Requested", state: "open" },
    ], work)
    expect(shown[0]).toMatchObject({
      labels: ["bug", "In review"],
      links: [
        { label: "T1", href: "/acme/widgets/stack/1" },
        { label: "Pull request: 7", href: "https://github.com/acme/widgets/pull/7" },
        { label: "Queue entry: q-1", href: "https://queue.example.test/q-1" },
      ],
    })
    expect(shown[1]).toEqual({ number: 2, title: "Two", state: "open" })
    expect(shown[2]).toEqual({ number: 3, title: "Three", state: "open" })
    expect(shown[3]).toEqual({ number: null, title: "Requested", state: "open" })
    expect(withWork([{ number: 1, title: "One", state: "open" }], workByIssue([row(1, "queue", "q-2", "queued", 4)]))[0])
      .toEqual({ number: 1, title: "One", state: "open", labels: ["Queued to merge"] })
    expect(withWork([{ number: 1, title: "One", state: "open" }], workByIssue([row(1, "merge", "abc", "merged", 5, "https://github.com/acme/widgets/commit/abc")]))[0])
      .toEqual({ number: 1, title: "One", state: "open", labels: ["Merged"], links: [{ label: "Merge: abc", href: "https://github.com/acme/widgets/commit/abc" }] })
  })

  test("gives the issue page a section per kind, in order, each link with its state", () => {
    expect(workSections(undefined)).toEqual([])
    expect(workSections(workByIssue(rows).get(1))).toEqual([
      { kind: "assignee", title: "Working on it", links: [{ label: "lane-a", href: null }] },
      { kind: "session", title: "Session", links: [{ label: "lane:lane-a · working", href: null }] },
      { kind: "queue", title: "Queue entry", links: [{ label: "q-1 · queued", href: "https://queue.example.test/q-1" }] },
      { kind: "pr", title: "Pull request", links: [{ label: "7 · open", href: "https://github.com/acme/widgets/pull/7" }] },
    ])
  })
})
