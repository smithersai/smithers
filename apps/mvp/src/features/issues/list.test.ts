import { expect, test } from "vitest"
import { listSearch, visibleRows } from "./list"

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
