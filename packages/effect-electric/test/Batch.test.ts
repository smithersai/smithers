import { expect, test } from "vitest"
import { rowsIn } from "../src/internal/Batch.vibe"

// Pure wire-format validation, before Electric parses column types or advances its offset.
test("counts inserts, partial updates and deletes while accepting every supported control and event", () => {
  const messages = [
    {
      key: "a",
      value: { id: "a" },
      headers: { operation: "insert", txids: [0, 1], tags: ["a"], lsn: "18446744073709551615" }
    },
    {
      key: "a",
      value: { text: "changed" },
      old_value: { text: "old" },
      headers: { operation: "update", removed_tags: ["a"], active_conditions: [true] }
    },
    { key: "a", value: { id: "a" }, headers: { operation: "delete" } },
    { headers: { control: "up-to-date", global_last_seen_lsn: "18446744073709551615" } },
    { headers: { control: "must-refetch" } },
    { headers: { control: "snapshot-end", xmin: "1", xmax: "2", xip_list: ["1"] } },
    { headers: { control: "subset-end" } },
    { headers: { event: "move-out", patterns: [{ pos: 0, value: "a" }] } },
    { headers: { event: "move-in", patterns: [{ pos: 0, value: "a" }] } }
  ]
  expect(rowsIn(JSON.stringify(messages))).toBe(3)
  expect(rowsIn("[]")).toBe(0)
  expect(rowsIn(JSON.stringify(messages.slice(3)))).toBe(0)
})

test.each([
  "",
  "[",
  "null",
  "{}",
  "1",
  "\"batch\"",
  "[1]",
  "[\"message\"]",
  "[false]",
  "[{\"headers\":{}}]",
  JSON.stringify([{ headers: { operation: "insert" }, value: {} }]),
  JSON.stringify([{ key: "a", value: {}, headers: { operation: "insert", txids: "1" } }]),
  JSON.stringify([{ key: "a", value: {}, old_value: [], headers: { operation: "update" } }]),
  JSON.stringify([{ headers: { control: "snapshot-end", xmin: "1", xmax: "2" } }]),
  JSON.stringify([{ headers: { event: "move-out", patterns: [null] } }]),
  JSON.stringify([{ key: "a", value: {}, headers: { operation: "insert", txids: [-1] } }]),
  JSON.stringify([{ key: "a", value: {}, headers: { operation: "insert", txids: [1.5] } }]),
  JSON.stringify([{ key: "a", value: {}, headers: { operation: "insert", lsn: "" } }]),
  JSON.stringify([{ headers: { control: "up-to-date", global_last_seen_lsn: "1.5" } }]),
  JSON.stringify([{ headers: { control: "snapshot-end", xmin: "-1", xmax: "2", xip_list: [] } }]),
  JSON.stringify([{ headers: { event: "move-out", patterns: [{ pos: -1, value: "a" }] } }]),
  JSON.stringify([{ headers: { event: "move-out", patterns: [{ pos: 0.5, value: "a" }] } }]),
  JSON.stringify([{ headers: { event: "move-in", patterns: [{ pos: "0", value: "a" }] } }])
])("rejects incomplete or malformed wire data: %s", (body) => {
  expect(rowsIn(body)).toBeUndefined()
})
