import { describe, test } from "vitest"
import * as Batch from "../src/internal/Batch.ts"
import * as SyncPolicy from "../src/SyncPolicy.ts"

const batchMessages = [
  ...Array.from({ length: 180 }, (_, i) => ({
    key: `row-${i}`,
    value: { id: `row-${i}`, title: `Item ${i}`, status: i % 2 === 0 ? "open" : "closed" },
    headers: { operation: i % 3 === 0 ? "insert" : "update", txids: [i], lsn: String(1_000_000 + i) }
  })),
  ...Array.from({ length: 18 }, (_, i) => ({
    key: `del-${i}`,
    value: { id: `del-${i}` },
    headers: { operation: "delete" }
  })),
  { headers: { control: "up-to-date", global_last_seen_lsn: "1000200" } },
  { headers: { control: "subset-end" } }
]

const batchJson = JSON.stringify(batchMessages)
const nowMs = Date.parse("2026-11-22T12:00:00.000Z")

describe("effect-electric hot paths", () => {
  test("Batch.rowsIn on 200-message shape batch", async ({ bench }) => {
    await bench("validate and count 200 Electric shape messages", () => {
      Batch.rowsIn(batchJson)
    }).run({ time: 120, warmupTime: 30 })
  })

  test("SyncPolicy.retryAfterMs", async ({ bench }) => {
    await bench("parse delta-seconds and HTTP-date Retry-After headers", () => {
      SyncPolicy.retryAfterMs("15", nowMs)
      SyncPolicy.retryAfterMs("Sun, 22 Nov 2026 12:00:30 GMT", nowMs)
      SyncPolicy.retryAfterMs(null, nowMs)
    }).run({ time: 120, warmupTime: 30 })
  })
})
