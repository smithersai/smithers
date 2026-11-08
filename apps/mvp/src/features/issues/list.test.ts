import { expect, test } from "vitest"
import { awaitingListRows, listSearch, visibleRows, withSearched } from "./list"

test("a cold search keeps its gated first paint until this repository and query have an answer", () => {
  const pending = { syncing: true, failed: false, rows: 0, filtered: false, repoId: "r", q: " #12 ", searched: undefined }
  expect(awaitingListRows(pending)).toBe(true)
  expect(awaitingListRows({ ...pending, searched: { repoId: "other", q: "#12" } })).toBe(true)
  expect(awaitingListRows({ ...pending, searched: { repoId: "r", q: "#13" } })).toBe(true)
  // Even zero matching rows is a complete answer; the shell must not outlive it.
  expect(awaitingListRows({ ...pending, searched: { repoId: "r", q: "#12" } })).toBe(false)
  expect(awaitingListRows({ ...pending, q: undefined })).toBe(true)
  for (const settled of [{ syncing: false }, { failed: true }, { rows: 1 }, { filtered: true }]) {
    expect(awaitingListRows({ ...pending, ...settled })).toBe(false)
  }
})

test("search and sort survive validated URLs", () => {
  expect(listSearch({ q: " crash ", sort: "oldest", ignored: 1 })).toEqual({ q: " crash ", sort: "oldest" })
  for (const sort of ["newest", "oldest", "updated"]) expect(listSearch({ sort })).toEqual({ sort })
  for (const q of [undefined, null, 1, "", "  "]) expect(listSearch({ q, sort: "invalid" })).toEqual({})
})

test("searches titles and numbers, orders by the date shown, and retains pending writes", () => {
  const rows = [
    { title: "Crash", number: 3, createdAt: "2026-01-01", updatedAt: "2026-03-01", local: 0 },
    { title: "Docs", number: 1, createdAt: "2026-02-01", updatedAt: "2026-02-01", local: 0 },
    { title: "Pending", number: 0, updatedAt: "", local: 1 },
  ]
  expect(visibleRows(rows, {}).map((row) => row.number)).toEqual([0, 3, 1])
  expect(visibleRows(rows, { sort: "oldest" }).map((row) => row.number)).toEqual([0, 3, 1])
  expect(visibleRows(rows, { sort: "newest" }).map((row) => row.number)).toEqual([0, 1, 3])
  expect(visibleRows(rows, { q: " cRaSh " })).toEqual([rows[0]])
  expect(visibleRows(rows, { q: "#1", sort: "newest" })[0]!.updatedAt).toBe("2026-02-01")
  expect(visibleRows(rows, { q: "absent" })).toEqual([])
  expect(rows[0]!.updatedAt).toBe("2026-03-01")
  const tied = [{ title: "a", number: 1, updatedAt: "x" }, { title: "b", number: 2, updatedAt: "x" }]
  for (const sort of ["newest", "oldest", "updated"] as const) expect(visibleRows(tied, { sort }).map((row) => row.number)).toEqual([2, 1])
})

test("a search the route answered adds its rows to a list that hasn't synced; any other search adds nothing", () => {
  const issue = (number: number) => ({ number, title: `t${number}`, state: "open", author: { login: number === 8 ? null : "ada" }, comments: 1, created_at: "c", updated_at: "u", triage: "", commitment: number === 8 ? null : "now" })
  const own = { id: "r#7", number: 7, title: "own", state: "open", author: "me", comments: 0, updatedAt: "x", triage: "", pending: "", reason: "", local: 0 }
  const searched = { repoId: "r", q: "t", issues: [issue(7), issue(8), issue(9)] }
  expect(withSearched([own], undefined, "r", "t")).toEqual([own])
  expect(withSearched([own], searched, "other", "t")).toEqual([own])
  expect(withSearched([own], searched, "r", "tt")).toEqual([own])
  expect(withSearched([own], searched, "r", undefined)).toEqual([own])
  const merged = withSearched([own], searched, "r", " t ")
  // The device's own row stays; the rest come as list rows under the shapes' ids.
  expect(merged.map((row) => [row.id, row.title, row.author, (row as { readonly commitment?: string | null }).commitment])).toEqual([
    ["r#7", "own", "me", undefined],
    ["r#8", "t8", "", ""],
    ["r#9", "t9", "ada", "now"],
  ])
  expect(merged[1]).toMatchObject({ updatedAt: "u", createdAt: "c", local: 0, pending: "" })
})
