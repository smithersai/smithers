import { expect, test } from "vitest"
import { outputLogs } from "./outputLogs"
const value = (data: unknown, clipped = false) => ({ text: JSON.stringify(data), bytes: 10, clipped })
test("CI logs preserve both streams, bounds and sealed results without another step's output", () => {
  const result = { steps: [{ output: { stdout: "previous" } }, { output: { stdout: "hello\n", stderr: "warn\n", truncated: true } }] }
  expect(outputLogs(value(result))).toEqual([
    { text: "hello\n", bytes: 6, clipped: true }, { text: "warn\n", bytes: 5, clipped: true },
  ])
  expect(outputLogs(value({ _tag: "Success", value: { steps: [{ output: { stdout: "é", stderr: "", truncated: false } }] } })))
    .toEqual([{ text: "é", bytes: 2, clipped: false }])
  for (const data of [null, [], {}, { steps: [] }, { steps: [null] }, { steps: [{ output: { stdout: 7, stderr: null } }] }]) {
    expect(outputLogs(value(data))).toEqual([])
  }
  expect(outputLogs(null)).toEqual([])
  expect(outputLogs(value(result, true))).toEqual([])
  expect(outputLogs({ text: "bad", bytes: 3, clipped: false })).toEqual([])
})
