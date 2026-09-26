import { expect, test } from "bun:test"
import type { Card } from "./AppState"
import { librarianReceiptFor, librarianRunCards } from "./LibrarianLaunch"

const entry = { kind: "history" as const, repo: "will/demo", scope: "this-attempt", phase: "launching" as const, startedAt: 100 }
const run = (id: string, ordinal: number, lastSeq: number, phase: "running" | "completed" = "running"): Extract<Card, { kind: "run-trace" }> => ({
  id, ordinal, createdAt: 100, kind: "run-trace", status: "active", title: "Mythical history",
  payload: { repo: entry.repo, runId: "run-1", workflow: "librarian/history", phase, steps: [], lastSeq, result: null,
    input: { _librarian: { kind: entry.kind, scope: entry.scope, inspected: false } } },
})

test("poll copies share a run, and the newest gateway revision replaces an older transcript copy", () => {
  const copies = Array.from({ length: 12 }, (_, index) => run(`copy-${index}`, index, 1))
  const completed = run("original", 0, 2, "completed")
  expect(librarianRunCards([...copies, completed])).toEqual([completed])
  expect(librarianReceiptFor([...copies, completed], entry)?.payload.phase).toBe("completed")
})

test("recovery matches the attempt's repo, scope, kind and receipt without borrowing an older run", () => {
  const card = run("original", 0, 1)
  expect(librarianReceiptFor([card], entry)).toEqual(card)
  expect(librarianReceiptFor([card], { ...entry, repo: "other/repo" })).toBeUndefined()
  expect(librarianReceiptFor([card], { ...entry, scope: "earlier-playthrough" })).toBeUndefined()
  // A launch of the retired Wiki generator never matches a history receipt.
  expect(librarianReceiptFor([card], { ...entry, kind: "wiki" })).toBeUndefined()
  expect(librarianReceiptFor([card], { ...entry, runId: "retry-run" })).toBeUndefined()
  expect(librarianReceiptFor([card], { ...entry, startedAt: 101 })).toBeUndefined()
  expect(librarianReceiptFor([card], { ...entry, runId: "run-1", startedAt: 101 })).toEqual(card)
})
