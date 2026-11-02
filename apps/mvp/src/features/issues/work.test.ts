import { describe, expect, test } from "vitest"
import { passesWorkFilter, workLinkId, workLinksRoute, workStatusOf, type WorkLinkFacts } from "./work"

const at = (minute: number) => `2026-11-01T10:${String(minute).padStart(2, "0")}:00.000000Z`
const link = (kind: WorkLinkFacts["kind"], state: WorkLinkFacts["state"], minute: number): WorkLinkFacts => ({ kind, state, updatedAt: at(minute) })

describe("an issue's work status", () => {
  test("follows the latest link that says anything; none says none", () => {
    expect(workStatusOf([])).toBe("none")
    expect(workStatusOf([link("assignee", null, 1), link("review", null, 2)])).toBe("none")
    expect(workStatusOf([link("session", "working", 1)])).toBe("working")
    expect(workStatusOf([link("session", "working", 1), link("queue", "queued", 2)])).toBe("queued")
    expect(workStatusOf([link("session", "working", 1), link("queue", "failed", 3), link("queue", "queued", 2)])).toBe("failed")
    expect(workStatusOf([link("queue", "failed", 3), link("session", "working", 4)])).toBe("working")
    expect(workStatusOf([link("pr", "open", 5)])).toBe("in_review")
    expect(workStatusOf([link("queue", "passed", 5)])).toBe("passed")
    expect(workStatusOf([link("session", "done", 5)])).toBe("done")
  })

  test("is merged for good once a link merged; closed links say nothing; a tie goes to the later kind", () => {
    expect(workStatusOf([link("merge", "merged", 1), link("session", "working", 9)])).toBe("merged")
    expect(workStatusOf([link("session", "working", 1), link("queue", "closed", 9)])).toBe("working")
    expect(workStatusOf([link("queue", "queued", 1), link("session", "working", 1)])).toBe("queued")
    expect(workStatusOf([link("session", "working", 1), link("queue", "queued", 1)])).toBe("queued")
  })

  test("the filter Will asked for: a pull request or a queue entry; any: any link", () => {
    expect(passesWorkFilter("pr-or-queue", ["assignee", "pr"])).toBe(true)
    expect(passesWorkFilter("pr-or-queue", ["queue"])).toBe(true)
    expect(passesWorkFilter("pr-or-queue", ["assignee", "session"])).toBe(false)
    expect(passesWorkFilter("any", ["assignee"])).toBe(true)
    expect(passesWorkFilter("any", [])).toBe(false)
  })

  test("names its route and keys", () => {
    expect(workLinksRoute("acme", "widgets", 7)).toBe("/api/repos/acme/widgets/issues/7/links")
    expect(workLinkId("github/acme/widgets", 7, "queue", "q-1")).toBe("github/acme/widgets#7/queue/q-1")
  })
})
