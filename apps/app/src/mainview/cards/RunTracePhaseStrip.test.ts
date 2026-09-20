import { expect, test } from "bun:test"
import { bandAtSequence, frameAtSequence, phasePins, tracePositions } from "./RunTracePhaseStrip"
import { phaseExtent, traceFromJournal } from "./RunTrace"

const RUN = { runId: "run", flowId: "module", status: "running" }
const LEFT = { executionId: "execution", stepId: "a".repeat(64), action: "coding/edit", attempt: 1, ask: 0, retry: 1, scope: "left", generation: 0 }
const RIGHT = { ...LEFT, stepId: "b".repeat(64), scope: "right" }
/** A producer envelope: the fact stamps `at` itself, the follower copies it later. */
const native = (sequence: number, kind: string, step: typeof LEFT, at: number, occurredAt: number, payload = {}) => ({
  runId: "run", sequence, kind: "control.engine.event", occurredAt,
  payload: {
    version: 1, executionId: step.executionId, generation: 1, sequence, emittedAtMs: at,
    sourceId: `step-fact-v1:${step.stepId}:${step.attempt}:${step.ask}:${step.retry}`,
    sourceSequence: sequence, eventType: "flows.harness.step-fact.v1",
    payload: { version: 1, step, generation: 0, frame: 0, ordinal: 0, cell: "", at, eventType: kind, sourceSequence: sequence, payload }
  }
})

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
    { seq: 8, at: 2000, label: "last", tone: "good", spanId: "frame-3" },
    { seq: 5, at: 3000, label: "middle", tone: "brand", spanId: "frame-2" },
    { seq: 2, at: 3000, label: "first", tone: "warn", spanId: "frame-1" }
  ], { start: 1000, end: 4000 })
  expect(pins.map((pin) => pin.milestone.seq)).toEqual([2, 5, 8])
  // Sorting by sequence never rewrites a moment's own frame.
  expect(pins.map((pin) => pin.milestone.spanId)).toEqual(["frame-1", "frame-2", "frame-3"])
})

test("a cluster's members remain before the next pin in DOM order when stamps regress", () => {
  const moments = [1000, 2000, 1000, 1000, 2000, 1000].map((at, seq) =>
    ({ at, seq, label: String(seq), tone: "brand" as const, spanId: `frame-${seq + 1}` }))
  const pins = phasePins(moments, { start: 1000, end: 11000 })
  const disclosed = pins.flatMap((pin) => [pin.milestone, ...pin.folded])
  expect(disclosed.map((moment) => moment.seq)).toEqual([0, 1, 2, 3, 4, 5])
  // A folded member keeps its own frame, so selecting it selects its own step.
  expect(disclosed.map((moment) => moment.spanId)).toEqual([1, 2, 3, 4, 5, 6].map((one) => `frame-${one}`))
})

test("a stop reads the clock its pin reads, and a replay copy adds no stop", () => {
  // The follower copies in batches: facts stamped 0s, 30s and 60s all land at ~61s.
  const records = [
    native(1, "control.agent.turn-opened", LEFT, 0, 61_000),
    native(2, "control.agent.read-only-demanded", LEFT, 30_000, 61_001, { streak: 3, cap: 3, nextFrame: 2 }),
    native(3, "control.agent.repeat-demanded", LEFT, 60_000, 61_002, { frames: 4, cap: 4 })
  ]
  const model = traceFromJournal(RUN, records)
  const extent = phaseExtent(model)
  const positions = tracePositions(records, extent)
  expect(positions.map((position) => position.left)).toEqual([0, 50, 100])
  for (const pin of phasePins(model.milestones, extent)) {
    expect(positions.find((position) => position.seq === pin.milestone.seq)!.left).toBe(pin.left)
  }
  // A replay of a committed fact is the same fact, so it is the same stop.
  expect(tracePositions([...records, { ...records[0]!, sequence: 4 }], extent).map((position) => position.seq)).toEqual([1, 2, 3])
})

test("the cursor's band is the one holding its own step's frame", () => {
  const records = [
    native(1, "control.agent.turn-opened", LEFT, 100, 100),
    native(2, "control.agent.cell-call-started", LEFT, 200, 200, { callId: "a1", flowName: "read", input: { path: "a.ts" } }),
    native(3, "control.agent.turn-opened", RIGHT, 300, 300),
    native(4, "control.agent.cell-call-started", RIGHT, 400, 400, { callId: "b1", flowName: "write", input: { path: "b.ts" } }),
    native(5, "control.agent.read-only-demanded", LEFT, 500, 500, { streak: 3, cap: 3, nextFrame: 2 })
  ]
  const model = traceFromJournal(RUN, records)
  expect(model.bands.map((band) => band.phase)).toEqual(["researching", "implementing"])
  expect(bandAtSequence(model, 5)?.phase).toBe("researching")
  expect(bandAtSequence(model, 4)?.phase).toBe("implementing")
  expect(bandAtSequence(model, 2)?.phase).toBe("researching")
  // A sequence recorded before any frame opened keeps the rule the strip had.
  expect(bandAtSequence(model, 0)).toBeUndefined()
})
