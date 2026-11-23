import { traceFromJournal } from "@smthrs/gateway/RunTrace"
import type { AgentEvent } from "@smthrs/harness/AgentEvent"
import { readFileSync } from "node:fs"
import * as Activity from "../src/activity.ts"

const measure = (suite: string, name: string, fn: () => void, durationMs = 150) => {
  const warmupEnd = performance.now() + 30
  while (performance.now() < warmupEnd) fn()
  let batch = 1
  while (batch < 10_000) {
    const t0 = performance.now()
    for (let i = 0; i < batch; i++) fn()
    if (performance.now() - t0 >= 0.2) break
    batch *= 2
  }
  const samplesMs: Array<number> = []
  const deadline = performance.now() + durationMs
  while (performance.now() < deadline || samplesMs.length < 15) {
    const t0 = performance.now()
    for (let i = 0; i < batch; i++) fn()
    samplesMs.push((performance.now() - t0) / batch)
    if (samplesMs.length >= 2000) break
  }
  samplesMs.sort((a, b) => a - b)
  const n = samplesMs.length
  const minMs = samplesMs[0]!
  const maxMs = samplesMs[n - 1]!
  const meanMs = samplesMs.reduce((a, b) => a + b, 0) / n
  const p75Ms = samplesMs[Math.min(n - 1, Math.floor(n * 0.75))]!
  const p99Ms = samplesMs[Math.min(n - 1, Math.floor(n * 0.99))]!
  const hz = meanMs > 0 ? 1000 / meanMs : 0
  console.log("BENCH_METRIC " + JSON.stringify({ suite, name, hz, minMs, maxMs, meanMs, p75Ms, p99Ms, samples: n }))
}

const rows = readFileSync(new URL("../test/fixtures/fix-add.jsonl", import.meta.url), "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line) as { event: AgentEvent; at: number })
  .filter((row) => row.event._tag !== "resolved" && row.event._tag !== "aborted")

let base1k = Activity.empty
let idx = 0
while (base1k.records.length < 1_000) {
  const row = rows[idx++ % rows.length]!
  base1k = Activity.apply(base1k, row.event, row.at + idx)
}
Activity.model(base1k)

let cursor = idx
let liveActivity = base1k
measure("@smthrs/tui", "Activity.apply + model (incremental @ 1k records)", () => {
  const row = rows[cursor++ % rows.length]!
  liveActivity = Activity.apply(liveActivity, row.event, row.at + cursor)
  Activity.model(liveActivity)
})

measure("@smthrs/tui", "traceFromJournal full refold (1k records)", () => {
  traceFromJournal({ runId: "terminal", flowId: "chat", status: base1k.status }, base1k.records)
})

measure("@smthrs/tui", "Activity.apply full replay (fix-add fixture)", () => {
  let state = Activity.empty
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!
    state = Activity.apply(state, row.event, row.at + i)
  }
  Activity.model(state)
})
