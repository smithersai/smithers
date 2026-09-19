import { expect, test } from "bun:test"
import { frameAtSequence, phasePins, tracePositions } from "./RunTracePhaseStrip"
import { traceFromJournal } from "./RunTrace"

test("scrub positions preserve sparse sequences, ties and clock regressions in journal order", () => {
  const records = [
    { sequence: 40, occurredAt: 4000 },
    { sequence: 3, occurredAt: 1000 },
    { sequence: 12, occurredAt: 3000 },
    { sequence: 10, occurredAt: 1000 },
    { sequence: 31, occurredAt: 2000 },
    { sequence: 40, occurredAt: 4000 },
    { sequence: NaN, occurredAt: 6000 },
    { occurredAt: 0 }
  ]
  expect(tracePositions(records, { start: 1000, end: 4000 })).toEqual([
    { seq: 3, left: 0 }, { seq: 10, left: 0 }, { seq: 12, left: (2 / 3) * 100 },
    { seq: 31, left: (1 / 3) * 100 }, { seq: 40, left: 100 }
  ])
})

test("zero-duration and untimed journals keep every recorded position, and an empty journal has none", () => {
  expect(tracePositions([{ sequence: 1 }, { sequence: 2 }, { sequence: 3 }], { start: 0, end: 0 }))
    .toEqual([{ seq: 1, left: 0 }, { seq: 2, left: 50 }, { seq: 3, left: 100 }])
  expect(tracePositions([{ sequence: 9, occurredAt: 20 }], { start: 20, end: 20 })).toEqual([{ seq: 9, left: 0 }])
  expect(tracePositions([], { start: 0, end: 0 })).toEqual([])
})

test("pin doors and their owning frames follow sequence when timestamps tie or regress", () => {
  const model = traceFromJournal({ runId: "r", flowId: "probe", status: "completed" }, [
    { sequence: 1, kind: "control.agent.turn-opened", occurredAt: 3000 },
    { sequence: 4, kind: "control.agent.turn-opened", occurredAt: 3000 },
    { sequence: 7, kind: "control.agent.turn-opened", occurredAt: 2000 }
  ])
  for (const [seq, owner] of [[0, "run:r"], [1, "frame-1"], [3, "frame-1"], [4, "frame-2"], [6, "frame-2"], [7, "frame-3"], [9, "frame-3"]] as const) {
    expect(frameAtSequence(model, seq)).toBe(owner)
  }
  const pins = phasePins([
    { seq: 8, at: 2000, label: "last", tone: "good" },
    { seq: 5, at: 3000, label: "middle", tone: "brand" },
    { seq: 2, at: 3000, label: "first", tone: "warn" }
  ], { start: 1000, end: 4000 })
  expect(pins.map((pin) => pin.milestone.seq)).toEqual([2, 5, 8])
})

test("a cluster's members remain before the next pin in DOM order when stamps regress", () => {
  const moments = [1000, 2000, 1000, 1000, 2000, 1000].map((at, seq) => ({ at, seq, label: String(seq), tone: "brand" as const }))
  const pins = phasePins(moments, { start: 1000, end: 11000 })
  expect(pins.flatMap((pin) => [pin.milestone, ...pin.folded]).map((moment) => moment.seq)).toEqual([0, 1, 2, 3, 4, 5])
})
