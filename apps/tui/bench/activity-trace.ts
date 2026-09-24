/**
 * What one event costs the monitor as a turn's journal grows.
 *
 * Replays the recorded `fix-add` session, repeated until the journal holds
 * `size` records, then times further events: `Activity.apply` plus the trace
 * the scrubber reads. `refold` rebuilds the trace from the whole journal on
 * every event, which is what the monitor did before the fold was incremental.
 *
 *   bun apps/tui/bench/activity-trace.ts
 */
import { traceFromJournal } from "@smthrs/gateway/RunTrace"
import type { AgentEvent } from "@smthrs/harness/AgentEvent"
import { readFileSync } from "node:fs"
import * as Activity from "../src/activity.ts"

const rows = readFileSync(new URL("../test/fixtures/fix-add.jsonl", import.meta.url), "utf8").trim().split("\n")
  .map((line) => JSON.parse(line) as { event: AgentEvent; at: number })
  // The verdict ends a turn; a long turn is the same work, repeated, still running.
  .filter((row) => row.event._tag !== "resolved" && row.event._tag !== "aborted")

/** Microseconds per event after the journal reaches `size` records. */
const bench = (size: number, refold: boolean, measured: number): number => {
  let activity = Activity.empty
  let index = 0
  const next = () => {
    const row = rows[index++ % rows.length]!
    activity = Activity.apply(activity, row.event, row.at + index)
  }
  while (activity.records.length < size) next()
  Activity.model(activity)
  const start = performance.now()
  for (let event = 0; event < measured; event++) {
    next()
    if (refold) traceFromJournal({ runId: "terminal", flowId: "chat", status: activity.status }, activity.records)
    else Activity.model(activity)
  }
  return ((performance.now() - start) / measured) * 1000
}

console.log("records  incremental µs/event  refold µs/event")
for (const size of [1_000, 4_000, 16_000]) {
  const incremental = bench(size, false, 200)
  const refold = bench(size, true, 5)
  console.log(`${String(size).padStart(7)}  ${incremental.toFixed(0).padStart(20)}  ${refold.toFixed(0).padStart(15)}`)
}
