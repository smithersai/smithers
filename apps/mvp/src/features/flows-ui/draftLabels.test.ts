import { expect, test } from "vitest"
import { draftLabel } from "./draftLabels"

const a = { id: "a", name: "review", request: "Review files", createdAt: "2026-10-27T00:00:00Z" }
const b = { ...a, id: "b", request: "Review changes" }
test("draft rows and Delete names distinguish repeated names by request", () => {
  expect(draftLabel(a, [a])).toBe("review")
  expect(draftLabel(a, [a, b])).toBe("review · Review files")
  expect(draftLabel(b, [a, b])).toBe("review · Review changes")
})
test("identical requests and clipped requests have stable distinct labels regardless of query order", () => {
  const same = { ...a, id: "c" }
  expect(draftLabel(a, [same, a])).toBe("review · Review files · 1")
  expect(draftLabel(same, [a, same])).toBe("review · Review files · 2")
  const unnamed = { ...a, name: null }
  expect(draftLabel(unnamed, [unnamed, { ...unnamed, id: "c" }])).toBe("Review files · 1")
  const long = { ...a, request: "x".repeat(100) }
  const next = { ...long, id: "z", request: long.request + "y", createdAt: "2026-10-28T00:00:00Z" }
  expect(draftLabel(long, [next, long])).not.toBe(draftLabel(next, [long, next]))
})
