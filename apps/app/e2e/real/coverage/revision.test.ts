import { expect, test } from "bun:test"
import { admitSourceRevision } from "./revision"

test("automatic source identity uses the independently detected checkout", () => {
  expect(admitSourceRevision("a".repeat(40), undefined)).toBe("a".repeat(40))
})

test("an explicit source label must agree with the actual checkout", () => {
  expect(admitSourceRevision("a".repeat(40), "a".repeat(40))).toBe("a".repeat(40))
  expect(() => admitSourceRevision("a".repeat(40), "b".repeat(40))).toThrow("does not match")
})

test.each([undefined, "", "main", "abc123"])("a caller cannot rescue missing or malformed detection: %s", (detected) => {
  expect(() => admitSourceRevision(detected, "a".repeat(40))).toThrow("Cannot identify")
})
