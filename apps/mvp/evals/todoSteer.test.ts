import { expect, test } from "vitest"
import { todoSteerLines } from "./todoSteer.ts"

const both = { todoLine: true, steeredLine: true, orderedLines: true }

test.each(["\n", "\r\n"])("accepts the word on its own line with the steered line right after it, %j line endings", (newline) => {
  expect(todoSteerLines(["# Widgets", "", "w123", "steered w123", ""].join(newline), "w123")).toEqual(both)
})

test("ignores whitespace around a line", () => {
  expect(todoSteerLines("# Widgets\n\n  w123  \nsteered w123 \n", "w123")).toEqual(both)
})

test.each([
  // The steered line alone: the agent dropped the TODO's own line.
  ["steered w123\n", false, true],
  ["w123\n", true, false],
  ["", false, false],
  ["prefix w123 suffix\nsteered w123\n", false, true],
  ["w1234\nsteered w1234\n", false, false],
  ["w123\nprefix steered w123 suffix\n", true, false],
  ["steered w123\nw123\n", true, true],
  ["w123\nunrelated\nsteered w123\n", true, true],
])("rejects a missing line, a line inside other text, the other order or a line between: %j", (readme, todoLine, steeredLine) => {
  expect(todoSteerLines(readme, "w123")).toEqual({ todoLine, steeredLine, orderedLines: false })
})
