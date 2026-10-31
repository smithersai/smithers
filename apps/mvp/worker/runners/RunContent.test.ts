// A run's transcript store (worker/runners/RunContent.ts) on a real SQLite: Node's, through the same synchronous port
// the `RunContent` Durable Object gives it over its own; e2e/agent-runner.spec.ts runs the object itself.
import { Transcript } from "@smthrs/agent"
import { describe, expect, test } from "vitest"
import { GENESIS, PAGE_EVENTS } from "../../src/features/transcript/contract.ts"
import { chain } from "../../src/features/transcript/digest.ts"
import { sqliteStore } from "../test/runContent.ts"
import * as Store from "./RunContent.ts"

const event = (seq: number, text = `word ${seq}`): Transcript.Event => ({
  seq,
  at: 1_000 + seq,
  kind: "agent_message_chunk",
  update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
})

describe("a run's transcript store", () => {
  test("keeps each event once in the order stored, and answers the next seq the generation lacks", () => {
    const sql = sqliteStore()
    const first = Store.append(sql, 1, [event(0), event(1), event(3)], 5_000)
    expect(first.next).toBe(2)
    expect(first.stored.map((row) => [row.n, row.seq])).toEqual([[1, 0], [2, 1], [3, 3]])
    // The runner sends again from 2: 3 is kept once, and 2 fills the gap.
    const again = Store.append(sql, 1, [event(2), event(3), event(4)], 6_000)
    expect(again.next).toBe(5)
    expect(again.stored.map((row) => row.seq)).toEqual([2, 4])
    // A repeat stores nothing; an empty request answers where the generation stands.
    expect(Store.append(sql, 1, [event(0)], 7_000)).toMatchObject({ next: 5, stored: [] })
    expect(Store.append(sql, 1, [], 7_000).next).toBe(5)
    // Another generation numbers from 0 on its own.
    expect(Store.append(sql, 2, [event(0)], 8_000)).toMatchObject({ next: 1, stored: [{ n: 6, generation: 2, seq: 0 }] })
    expect(Store.page(sql, -1).map((row) => [row.generation, row.seq])).toEqual([[1, 0], [1, 1], [1, 3], [1, 2], [1, 4], [2, 0]])
  })

  test("keeps totals and a digest chain the tab can compute from the events it holds", () => {
    const sql = sqliteStore()
    Store.append(sql, 1, [event(0), event(1)], 5_000)
    Store.append(sql, 1, [event(2, "é and \"quotes\"")], 5_000)
    const totals = Store.summary(sql)
    const rows = Store.page(sql, -1)
    expect(totals).toMatchObject({ events: 3, last: 3, truncated: false })
    expect(totals.bytes).toBe(rows.reduce((sum, row) => sum + JSON.stringify(row.update).length, 0))
    expect(totals.digest).toBe(rows.reduce(chain, GENESIS))
    expect(Store.summary(sqliteStore())).toEqual({ events: 0, bytes: 0, last: 0, digest: GENESIS, truncated: false })
  })

  test("pages a replay after any event, at most a page of events or bytes at a time", () => {
    const sql = sqliteStore()
    Store.append(sql, 1, Array.from({ length: PAGE_EVENTS + 20 }, (_, seq) => event(seq)), 5_000)
    const first = Store.page(sql, -1)
    expect(first).toHaveLength(PAGE_EVENTS)
    expect(Store.page(sql, first.at(-1)!.n).map((row) => row.seq)).toEqual(
      Array.from({ length: 20 }, (_, n) => PAGE_EVENTS + n),
    )
    expect(Store.page(sql, PAGE_EVENTS + 20)).toEqual([])
    // Big events: a page stops near the byte limit, never empty.
    const big = sqliteStore()
    Store.append(big, 1, Array.from({ length: 40 }, (_, seq) => event(seq, "k".repeat(15_000))), 5_000)
    const page = Store.page(big, -1)
    expect(page.length).toBeGreaterThan(1)
    expect(page.length).toBeLessThan(40)
  })

  test("past the run's cap keeps one truncated event, drops the rest, and still counts their seqs as taken", () => {
    const sql = sqliteStore()
    const text = "k".repeat(15_000)
    const perEvent = JSON.stringify(event(0, text).update).length
    const fits = Math.floor(Transcript.MAX_RUN_BYTES / perEvent)
    for (let from = 0; from < fits + 5; from += 200) {
      const batch = Array.from({ length: Math.min(200, fits + 5 - from) }, (_, n) => event(from + n, text))
      Store.append(sql, 1, batch, 5_000)
    }
    const totals = Store.summary(sql)
    expect(totals.truncated).toBe(true)
    expect(totals.bytes).toBeLessThanOrEqual(Transcript.MAX_RUN_BYTES)
    expect(totals.events).toBe(fits + 1)
    const last = Store.page(sql, totals.last - 1)
    expect(last.map((row) => [row.kind, row.seq, row.update])).toEqual([[Transcript.KINDS.truncated, fits, {}]])
    expect(Store.append(sql, 1, [event(fits + 5)], 6_000)).toMatchObject({ next: fits + 6, stored: [] })
    // One past a gap is dropped without taking the gap's seq.
    expect(Store.append(sql, 1, [event(fits + 8)], 6_000)).toMatchObject({ next: fits + 6, stored: [] })
    expect(Store.summary(sql).events).toBe(fits + 1)
  }, 60_000)
})
