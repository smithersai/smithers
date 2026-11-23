import { describe, test } from "vitest"
import {
  phaseExtent,
  traceFold,
  traceFoldModel,
  traceFoldStep,
  traceFromJournal,
  turnNarratives,
  waterfallGeometry
} from "../src/RunTrace.ts"
import type { JournalRecord } from "../src/RunTrace.ts"

const makeJournal = (turns: number): ReadonlyArray<JournalRecord> => {
  const records: Array<JournalRecord> = [
    { sequence: 1, kind: "control.run.accepted", occurredAt: 1_000, payload: { at: 1_000, journalVersion: 1 } }
  ]
  let seq = 2
  let t = 1_100
  for (let i = 0; i < turns; i++) {
    records.push({
      sequence: seq++,
      kind: "control.agent.turn-opened",
      occurredAt: t,
      payload: { at: t, seat: "anthropic:claude-sonnet-4-6", contextDigest: `ctx-${i}`, journalVersion: 1 }
    })
    t += 400
    records.push({
      sequence: seq++,
      kind: "control.agent.model-settled",
      occurredAt: t,
      payload: {
        at: t,
        text: `Turn ${i}: inspect files and run checks`,
        usage: { inputTokens: 2_000 + i * 50, outputTokens: 180 },
        durationMillis: 380,
        journalVersion: 1
      }
    })
    t += 10
    records.push({
      sequence: seq++,
      kind: "control.agent.cell-produced",
      occurredAt: t,
      payload: { at: t, language: "ts", digest: `cell-${i}`, text: `await ctx.call("read", { path: "f${i}.ts" })`, journalVersion: 1 }
    })
    t += 120
    records.push({
      sequence: seq++,
      kind: "control.agent.cell-settled",
      occurredAt: t,
      payload: { at: t, digest: `cell-${i}`, status: "ok", durationMillis: 110, journalVersion: 1 }
    })
    t += 50
  }
  return records
}

const journal200 = makeJournal(50)
const runMeta = { runId: "run-bench-1", flowId: "agent-session", status: "running" }
const sampleModel = traceFromJournal(runMeta, journal200)

describe("gateway hot paths", () => {
  test("RunTrace.traceFromJournal", async ({ bench }) => {
    await bench("project 201-record 50-turn journal to trace model", () => {
      traceFromJournal(runMeta, journal200)
    }).run({ time: 120, warmupTime: 30 })
  })

  test("RunTrace.traceFoldStep incremental", async ({ bench }) => {
    await bench("incrementally step 201 journal records into trace fold", () => {
      let fold = traceFold({ runId: "run-bench-1", flowId: "agent-session" })
      for (const record of journal200) {
        fold = traceFoldStep(fold, record)
      }
      traceFoldModel(fold, "running")
    }).run({ time: 120, warmupTime: 30 })
  })

  test("RunTrace.waterfallGeometry + turnNarratives", async ({ bench }) => {
    const extent = phaseExtent(sampleModel)
    await bench("compute waterfall geometry + 50 turn narratives", () => {
      for (const span of sampleModel.rows) {
        waterfallGeometry(span, extent)
      }
      turnNarratives(sampleModel)
    }).run({ time: 120, warmupTime: 30 })
  })
})
