// Your conversations' list as the device works it out (docs/features/conversations.md#the-list): from the synced rows,
// this device's acts on their way and the search, with no store. The store runs the same functions
// (src/features/conversations/conversations.test.ts).
import { describe, expect, test } from "vitest"
import { branchPath, newBranchName, NEW_BRANCH_PREFIX } from "./contract"
import { archivedOf, landed, listOf } from "./list"
import type { Mine, Search } from "./schema"
import { emptyTitle, paramsOf } from "./view"

const row = (conversationId: string, fields: Partial<Mine> = {}): Mine => ({
  conversationId,
  personId: "person-member",
  owner: "octo",
  repo: "hello",
  branch: conversationId,
  openedAt: "2026-10-22 10:00:00+00",
  archivedAt: null,
  changedAt: "2026-10-22 10:00:00+00",
  ...fields,
})

/** 2026-10-22 10:00:00 UTC, in milliseconds. */
const TEN = Date.UTC(2026, 9, 22, 10)

const open: Search = { id: "search", text: "", archived: false, loaded: true }

describe("whether a conversation is archived", () => {
  test("the row says, until this device acted later than the row last changed", () => {
    expect(archivedOf(row("a"), undefined)).toBe(false)
    expect(archivedOf(row("a", { archivedAt: "2026-10-22 10:00:00+00" }), undefined)).toBe(true)
    // This device archived it after the row last changed: archived, before the row shows it.
    expect(archivedOf(row("a"), { conversationId: "a", archived: true, at: TEN + 1 })).toBe(true)
    // An act no later than the row's latest change is the row's already, or was overtaken: opening the branch restored it.
    expect(archivedOf(row("a"), { conversationId: "a", archived: true, at: TEN })).toBe(false)
    expect(archivedOf(row("a", { archivedAt: "2026-10-22 10:00:00+00" }), { conversationId: "a", archived: false, at: TEN + 5 }))
      .toBe(false)
  })

  test("the device forgets an act once the row's latest change reaches it, never before", () => {
    const rows = [row("a"), row("b", { changedAt: "2026-10-22 10:00:00.005+00" })]
    const acts = [
      { conversationId: "a", archived: true, at: TEN + 1 },
      { conversationId: "b", archived: true, at: TEN + 5 },
      // A conversation the device hasn't synced yet: kept.
      { conversationId: "c", archived: true, at: TEN },
    ]
    expect(landed(rows, acts)).toEqual(["b"])
  })
})

describe("the list", () => {
  const rows = [
    row("a", { branch: "feature/login", openedAt: "2026-10-22 09:00:00+00" }),
    row("b", { branch: "docs", owner: "Octo", repo: "Website", openedAt: "2026-10-22 11:00:00+00" }),
    row("c", { branch: "old", archivedAt: "2026-10-22 10:00:00+00", openedAt: "2026-10-22 12:00:00+00" }),
  ]

  test("shows the conversations that aren't archived, the latest opened first; the archived ones are one switch away", () => {
    expect(listOf(rows, [], open)).toEqual([
      { conversationId: "b", repo: "Octo/Website", branch: "docs", openedAt: "2026-10-22 11:00:00+00", archived: false },
      { conversationId: "a", repo: "octo/hello", branch: "feature/login", openedAt: "2026-10-22 09:00:00+00", archived: false },
    ])
    expect(listOf(rows, [], { ...open, archived: true }).map((listed) => [listed.conversationId, listed.archived]))
      .toEqual([["c", true]])
  })

  test("this device's act moves a conversation between the two at once", () => {
    const acts = [{ conversationId: "a", archived: true, at: TEN + 1 }, { conversationId: "c", archived: false, at: TEN + 1 }]
    expect(listOf(rows, acts, open).map((listed) => listed.conversationId)).toEqual(["c", "b"])
    expect(listOf(rows, acts, { ...open, archived: true }).map((listed) => listed.conversationId)).toEqual(["a"])
  })

  test("a search matches every word, ignoring case, in the repository or the branch", () => {
    const ids = (text: string) => listOf(rows, [], { ...open, text }).map((listed) => listed.conversationId)
    expect(ids("login")).toEqual(["a"])
    expect(ids("  WEBSITE ")).toEqual(["b"])
    expect(ids("octo")).toEqual(["b", "a"])
    expect(ids("octo docs")).toEqual(["b"])
    expect(ids("hello docs")).toEqual([])
    // Archived conversations are searched in their own list only.
    expect(ids("old")).toEqual([])
    expect(listOf(rows, [], { ...open, archived: true, text: "old" }).map((listed) => listed.conversationId)).toEqual(["c"])
  })

  test("conversations opened at the same moment keep one order", () => {
    const same = [row("y"), row("x")]
    expect(listOf(same, [], open).map((listed) => listed.conversationId)).toEqual(["x", "y"])
  })
})

describe("where a row and a new conversation go", () => {
  test("a row opens its branch's page, a branch with a slash included", () => {
    expect(paramsOf({ conversationId: "a", repo: "octo/hello", branch: "feature/login/two", openedAt: "", archived: false }))
      .toEqual({ owner: "octo", repo: "hello", ref: "feature", _splat: "login/two" })
    expect(paramsOf({ conversationId: "a", repo: "octo/hello", branch: "main", openedAt: "", archived: false }))
      .toEqual({ owner: "octo", repo: "hello", ref: "main", _splat: "" })
    expect(branchPath("octo/hello", "feature/a b")).toBe("/octo/hello/tree/feature/a%20b")
  })

  test("a new conversation's branch is named for its run: the same run, the same name", () => {
    expect(newBranchName("1A2b3C4d-0000-5000-8000-000000000000")).toBe(`${NEW_BRANCH_PREFIX}1a2b3c`)
    expect(newBranchName("1A2b3C4d-0000-5000-8000-000000000000"))
      .toBe(newBranchName("1a2b3c4d-0000-5000-8000-000000000000"))
    expect(newBranchName("")).toBe(`${NEW_BRANCH_PREFIX}000000`)
  })
})


test("empty searches say No matches in either list", () => {
  expect(emptyTitle("missing", false)).toBe("No matches")
  expect(emptyTitle("missing", true)).toBe("No matches")
  expect(emptyTitle(" ", false)).toBe("No conversations")
  expect(emptyTitle("", true)).toBe("No archived conversations")
})

