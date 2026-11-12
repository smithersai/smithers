// The issue seed (ops/issue-tracking/seed.mjs): a record counts as seeded only once its write is done, against a
// recorded fetch and a temporary state file.
import { describe, expect, test } from "vitest"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
// @ts-expect-error: a plain .mjs script, untyped.
import { seed, WATCH_ROUNDS, writeIdOf } from "./seed.mjs"

type Answer = [number, unknown]
const records = [{ key: "lane:a", title: "A", body: "a" }, { key: "lane:b", title: "B", body: "b" }]
const run = (state: string, answer: (writeId: string) => Answer) => {
  const sent: Array<string> = []
  const said: Array<{ event: string }> = []
  const fetch = async (_url: string, init: RequestInit) => {
    const { writeId } = JSON.parse(String(init.body))
    sent.push(writeId)
    const [status, body] = answer(writeId)
    return new Response(JSON.stringify(body), { status })
  }
  const final = seed({
    repo: "acme/widgets", origin: "https://smithers.test", records, state, every: 0, lockedEvery: 0, limit: undefined,
    headers: {}, fetch, sleep: async () => {}, locked: () => false, log: (line: { event: string }) => void said.push(line),
  })
  return final.then((value: Record<string, unknown>) => ({ final: value, sent, said }))
}
const stateFile = () => join(mkdtempSync(join(tmpdir(), "seed-")), "seed-state.jsonl")
const idOf = (key: string) => writeIdOf(`acme/widgets:${key}`)
const lines = (state: string) => readFileSync(state, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))

describe("the issue seed", () => {
  test("a write that failed is reported, never counted as seeded, and reported again on the next run", async () => {
    const state = stateFile()
    const answer = (writeId: string): Answer => writeId === idOf("lane:a") ? [200, { status: "failed" }] : [202, { writeId }]
    let watched = 0
    const first = await run(state, (writeId) => {
      if (writeId === idOf("lane:b") && watched++ > 0) return [200, { status: "done" }]
      return answer(writeId)
    })
    expect(first.final).toMatchObject({ event: "unsettled", sent: 2, done: 1, pending: 0, failed: 1 })
    expect(first.said).toContainEqual({ event: "failed", key: "lane:a", writeId: idOf("lane:a"), status: "failed" })
    // One admission line per key, as the e2e proof reads it, and each settlement beside it.
    expect(lines(state).filter((line) => line.settled === undefined).map((line) => line.key)).toEqual(["lane:a", "lane:b"])
    expect(lines(state).filter((line) => line.settled !== undefined).map((line) => [line.key, line.settled])).toEqual([["lane:a", "failed"], ["lane:b", "done"]])

    const second = await run(state, () => [200, { status: "failed" }])
    expect(second.sent).toEqual([idOf("lane:a")])
    expect(second.final).toMatchObject({ event: "unsettled", sent: 2, done: 1, failed: 1 })
  })

  test("an admitted write is watched until it is done, also across runs", async () => {
    const state = stateFile()
    const first = await run(state, (writeId) => [202, { writeId }])
    expect(first.final).toMatchObject({ event: "unsettled", sent: 2, done: 0, pending: 2, failed: 0 })
    expect(first.sent).toHaveLength(2 + 2 * WATCH_ROUNDS)

    const second = await run(state, () => [200, { status: "done" }])
    expect(second.sent).toEqual([idOf("lane:a"), idOf("lane:b")])
    expect(second.final).toMatchObject({ event: "done", sent: 2, done: 2, pending: 0, failed: 0 })
    const third = await run(state, () => [200, { status: "failed" }])
    expect(third.sent).toEqual([])
    expect(third.final).toMatchObject({ event: "done", sent: 2, done: 2 })
  })

  test("a state file written before settlements were recorded rechecks each write it holds", async () => {
    const state = stateFile()
    writeFileSync(state, records.map(({ key }) => JSON.stringify({ key, writeId: idOf(key), status: 200, at: "2026-11-02T00:00:00.000Z" })).join("\n") + "\n")
    const rerun = await run(state, (writeId) => [200, { status: writeId === idOf("lane:a") ? "refused" : "done" }])
    expect(rerun.sent).toEqual([idOf("lane:a"), idOf("lane:b")])
    expect(rerun.final).toMatchObject({ event: "unsettled", sent: 2, done: 1, failed: 1 })
    expect(rerun.said).toContainEqual({ event: "failed", key: "lane:a", writeId: idOf("lane:a"), status: "refused" })
  })
})
