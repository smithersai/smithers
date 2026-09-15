import { describe, expect, test } from "bun:test"
import { durationWords, isTraceFilter, spanMatches, spanPath, traceFiltersFor, traceFromJournal, turnNarratives, waterfallGeometry } from "./RunTrace"
import type { JournalRecord } from "./RunTrace"

/*
 * The trace model over a journal in the agent's own shapes (AgentSession's
 * journal projection): frames nest cells, cells nest calls, calls pair with
 * their settlement by flow name, open work stays open, and the waterfall's
 * bars sit where the stamps put them. An empty journal is the run root alone.
 */

const at = (sequence: number, kind: string, payload: Record<string, unknown>, stamp: number): JournalRecord => ({
  sequence,
  kind,
  occurredAt: stamp + 7,
  // The agent stamps `at` itself; the journal's occurredAt is later and must not win.
  payload: { ...payload, at: stamp, journalVersion: 1 }
})

const JOURNAL: ReadonlyArray<JournalRecord> = [
  at(1, "control.run.accepted", {}, 1000),
  at(2, "control.agent.turn-opened", { seat: "openai:gpt-5.6-sol", contextDigest: "d1" }, 1000),
  at(3, "control.agent.model-settled", { text: "read the README, then run the tests", usage: { inputTokens: 1200, outputTokens: 80 }, durationMillis: 900 }, 2000),
  at(4, "control.agent.cell-produced", { language: "ts", digest: "c1", text: "const readme = await ctx.call(\"files.read\", { path: \"README.md\" })" }, 2000),
  at(5, "control.agent.cell-call-started", { flowName: "files.read", input: { path: "README.md" } }, 2100),
  at(6, "control.agent.cell-call-started", { flowName: "target.run", input: { label: "//apps/app:unitTests" } }, 2200),
  at(7, "control.agent.cell-call-settled", { flowName: "files.read", outcome: "success", value: "# Smithers" }, 2600),
  at(8, "control.agent.cell-call-settled", { flowName: "target.run", outcome: "failure", message: "1 of 213 failed" }, 4200),
  at(9, "control.agent.cell-printed", { cell: "c1", text: "README read; unitTests: 1 failure" }, 4300),
  at(10, "control.agent.cell-settled", { outcome: "success" }, 4300),
  at(11, "control.agent.turn-opened", { seat: "openai:gpt-5.6-sol", contextDigest: "d2" }, 5000),
  at(12, "control.agent.cell-produced", { language: "ts", digest: "c2", text: "await ctx.call(\"files.edit\", { path: \"src/x.ts\", patch })" }, 5500),
  at(13, "control.agent.cell-call-started", { flowName: "files.edit", input: { path: "src/x.ts" } }, 5600),
  at(14, "control.approval.requested", { requestId: "req-1", question: "write src/x.ts?", payload: {}, runId: "run-1" }, 6000)
]

const RUN = { runId: "run-1", flowId: "implement", status: "running", kind: "implement" }

describe("the trace model", () => {
  test("turn explanations use recorded prose and fall back to actual calls without presenting code or truncated metadata as intent", () => {
    const model = traceFromJournal(RUN, JOURNAL)
    expect(turnNarratives(model).map(({ number, text, source }) => ({ number, text, source }))).toEqual([
      { number: 1, text: "read the README, then run the tests.", source: "model" },
      { number: 2, text: "The agent called files.edit.", source: "calls" }
    ])
    const code = traceFromJournal(RUN, [
      at(1, "control.agent.turn-opened", {}, 1),
      at(2, "control.agent.model-settled", { text: "```ts\nconst result = 1\n```\nI’ll check the failing assertion.\nMore detail." }, 2),
      at(3, "control.agent.turn-opened", {}, 3),
      at(4, "control.agent.model-settled", { text: { truncated: true, bytes: 99999, digest: "d" } }, 4),
      at(5, "control.agent.turn-opened", {}, 5),
      at(6, "control.agent.model-settled", { text: "const result = await ctx.call('read')" }, 6)
    ])
    expect(turnNarratives(code).map(({ text }) => text)).toEqual(["I’ll check the failing assertion.", "The model responded; no script or flow calls were recorded in this turn.", "The model responded; no script or flow calls were recorded in this turn."])
    expect(turnNarratives(traceFromJournal(RUN, []))).toEqual([])
  })

  test("selection ancestry is recorded, and only a successful agent/spawn result establishes a child run edge", () => {
    const model = traceFromJournal(RUN, [
      at(1, "control.agent.turn-opened", {}, 1),
      at(2, "control.agent.cell-produced", { text: "await ctx.call('agent/spawn')" }, 2),
      at(3, "control.agent.cell-call-started", { flowName: "agent/spawn", input: { flow: "review" } }, 3),
      at(4, "control.agent.cell-call-settled", { flowName: "agent/spawn", outcome: "success", value: { child: "run-1/child/review" } }, 4),
      at(5, "control.agent.cell-call-started", { flowName: "files.read" }, 5),
      at(6, "control.agent.cell-call-settled", { flowName: "files.read", outcome: "success", value: { child: "unrelated" } }, 6)
    ])
    expect(spanPath(model, "call-1").map((span) => span.id)).toEqual(["run:run-1", "frame-1", "cell-2", "call-1"])
    expect(model.rows.find((span) => span.id === "call-1")?.detail.childRunId).toBe("run-1/child/review")
    expect(model.rows.find((span) => span.id === "call-2")?.detail.childRunId).toBeUndefined()
    expect(spanPath(model, "unrecorded").map((span) => span.id)).toEqual(["run:run-1"])
  })
  test("nests the journal as run → frame → cell → call, pairing settlements by flow name", () => {
    const model = traceFromJournal(RUN, JOURNAL)
    const { root } = model
    expect(root.label).toBe("run run-1 · implement")
    expect(root.status).toBe("running")
    // The accepted event lands on the run itself, before any frame.
    expect(root.children.map((span) => `${span.kind}:${span.label}`)).toEqual([
      "event:run.accepted",
      "frame:frame 1 · openai:gpt-5.6-sol",
      "frame:frame 2 · openai:gpt-5.6-sol"
    ])
    const [, frame1, frame2] = root.children
    expect(frame1?.children.map((span) => span.kind)).toEqual(["model", "cell"])
    const cell1 = frame1?.children[1]
    expect(cell1?.children.map((span) => `${span.id} ${span.label} ${span.status}`)).toEqual([
      "call-1 files.read completed",
      "call-2 target.run failed"
    ])
    // A settlement pairs with the oldest open call of its flow name, so the earlier files.read settles first.
    expect(cell1?.children[0]).toMatchObject({ startedAt: 2100, endedAt: 2600, detail: { input: { path: "README.md" }, output: "# Smithers" } })
    expect(cell1?.children[1]).toMatchObject({ startedAt: 2200, endedAt: 4200, detail: { message: "1 of 213 failed" } })
    // The cell carries its source and what it printed; it closes on cell-settled.
    expect(cell1).toMatchObject({ startedAt: 2000, endedAt: 4300, status: "completed" })
    expect(cell1?.detail.source).toContain("files.read")
    expect(cell1?.detail.printed).toBe("README read; unitTests: 1 failure")
    // The model call's bar runs its measured duration back from its settlement.
    expect(frame1?.children[0]).toMatchObject({ startedAt: 1100, endedAt: 2000, detail: { usage: { inputTokens: 1200, outputTokens: 80 }, seat: "openai:gpt-5.6-sol" } })
    // A frame closes when the next opens.
    expect(frame1).toMatchObject({ startedAt: 1000, endedAt: 5000, status: "completed" })
    // Open work stays open: the second frame, its cell, the unsettled call, the pending approval.
    expect(frame2?.endedAt).toBeUndefined()
    expect(frame2?.status).toBe("running")
    const cell2 = frame2?.children[0]
    expect(cell2?.children[0]).toMatchObject({ id: "call-3", label: "files.edit", status: "running" })
    expect(cell2?.children[0]?.endedAt).toBeUndefined()
    expect(frame2?.children[1]).toMatchObject({ kind: "approval", label: "approval · write src/x.ts?", status: "waiting" })
    expect(model.counts).toEqual({ spans: 10, running: 3, failed: 1 })
    // Rows are the tree in order, with depth.
    expect(model.rows.map((span) => `${span.depth}:${span.id}`)).toEqual([
      "0:run:run-1",
      "1:event-1",
      "1:frame-1",
      "2:model-3",
      "2:cell-4",
      "3:call-1",
      "3:call-2",
      "1:frame-2",
      "2:cell-12",
      "3:call-3",
      "2:approval-req-1"
    ])
  })

  test("the waterfall axis spans the first stamp to the last, open bars run to the axis end, instants are zero width", () => {
    const model = traceFromJournal(RUN, JOURNAL)
    expect(model.extent).toEqual({ start: 1000, end: 6000 })
    const call1 = model.rows.find((span) => span.id === "call-1")!
    expect(waterfallGeometry(call1, model.extent)).toEqual({ left: 22, width: 10 })
    const call3 = model.rows.find((span) => span.id === "call-3")!
    expect(waterfallGeometry(call3, model.extent)).toEqual({ left: 92, width: 8 })
    const accepted = model.rows.find((span) => span.id === "event-1")!
    expect(waterfallGeometry(accepted, model.extent)).toEqual({ left: 0, width: 0 })
    // A decided approval and a denied one settle where the decision lands.
    const decided = traceFromJournal(RUN, [
      ...JOURNAL,
      at(15, "control.approval.denied", { tokenId: "req-1" }, 6500)
    ])
    expect(decided.rows.find((span) => span.id === "approval-req-1")).toMatchObject({ status: "denied", endedAt: 6500 })
  })

  test("a journal read out of order folds the same trace", () => {
    const shuffled = [...JOURNAL].reverse()
    expect(traceFromJournal(RUN, shuffled).rows.map((span) => span.id)).toEqual(traceFromJournal(RUN, JOURNAL).rows.map((span) => span.id))
  })

  test("a settled run closes its last frame where the journal ends; a call the journal never settled stays open", () => {
    const model = traceFromJournal({ ...RUN, status: "completed" }, [...JOURNAL, at(15, "control.run.completed", {}, 7000)])
    expect(model.root.endedAt).toBe(7000)
    const frame2 = model.root.children[2]
    expect(frame2).toMatchObject({ endedAt: 7000, status: "completed" })
    expect(model.rows.find((span) => span.id === "call-3")?.endedAt).toBeUndefined()
    // Without the run's own terminal event, the card's terminal phase still closes the frame at the last stamp.
    const byPhase = traceFromJournal({ ...RUN, status: "failed" }, JOURNAL)
    expect(byPhase.root.children[2]).toMatchObject({ endedAt: 6000 })
    expect(byPhase.root.status).toBe("failed")
  })

  test("no journal yet is the run root alone, wearing the run's status", () => {
    const model = traceFromJournal({ runId: "run-9", flowId: "prototype", status: "launching", kind: "prototype" }, [])
    expect(model.rows).toHaveLength(1)
    expect(model.root).toMatchObject({ kind: "run", status: "launching", children: [], detail: { fields: { kind: "prototype" } } })
    expect(model.extent).toEqual({ start: 0, end: 0 })
    expect(model.counts).toEqual({ spans: 0, running: 0, failed: 0 })
    // Records that are not control events are not spans.
    expect(traceFromJournal(RUN, [{ sequence: 1, kind: "engine.step", occurredAt: 5, payload: {} }]).counts.spans).toBe(0)
  })

  test("filters keep a span whose subtree matches, so the tree stays a tree", () => {
    const model = traceFromJournal(RUN, JOURNAL)
    const visible = (filter: Parameters<typeof spanMatches>[1]) =>
      model.rows.filter((span) => span.kind === "run" || spanMatches(span, filter)).map((span) => span.id)
    expect(visible("failed")).toEqual(["run:run-1", "frame-1", "cell-4", "call-2"])
    expect(visible("running")).toEqual(["run:run-1", "frame-2", "cell-12", "call-3", "approval-req-1"])
    expect(visible("model")).toEqual(["run:run-1", "frame-1", "model-3"])
    expect(visible("flow")).toEqual(["run:run-1", "frame-1", "cell-4", "call-1", "call-2", "frame-2", "cell-12", "call-3"])
    expect(visible("all")).toHaveLength(11)
  })

  test("a prototype offers all, messages and failed; every other run the shared six (spec 06 §2, §3)", () => {
    expect(traceFiltersFor("prototype").map(([id]) => id)).toEqual(["all", "messages", "failed"])
    expect(traceFiltersFor("implement").map(([id]) => id)).toEqual(["all", "running", "failed", "model", "flow", "forks"])
    expect(traceFiltersFor(undefined).map(([id, label]) => `${id}=${label}`)).toEqual([
      "all=all",
      "running=running",
      "failed=failed",
      "model=model calls",
      "flow=flow calls",
      "forks=forks"
    ])
    expect(isTraceFilter("messages")).toBe(true)
    expect(isTraceFilter("calls")).toBe(false)
  })

  test("the messages filter keeps a prototype's agent/send and agent/await spans with their ancestors", () => {
    const model = traceFromJournal({ runId: "run-2", flowId: "prototype", status: "running", kind: "prototype" }, [
      at(1, "control.agent.turn-opened", { seat: "openai:gpt-5.6-sol" }, 1000),
      at(2, "control.agent.cell-produced", { language: "ts", digest: "c1", text: "await ctx.call(\"agent/send\", { to: \"w2\", text: \"edges are note→target\" })" }, 1100),
      at(3, "control.agent.cell-call-started", { flowName: "files.read", input: { path: "README.md" } }, 1200),
      at(4, "control.agent.cell-call-started", { flowName: "agent/send", input: { to: "w2", text: "edges are note→target" } }, 1300),
      at(5, "control.agent.cell-call-started", { flowName: "agent/await", input: { from: "w4" } }, 1400)
    ])
    const visible = model.rows.filter((span) => span.kind === "run" || spanMatches(span, "messages")).map((span) => span.label)
    expect(visible).toEqual(["run run-2 · prototype", "frame 1 · openai:gpt-5.6-sol", "cell · ts", "agent/send", "agent/await"])
  })

  test("durations read in the trace's units", () => {
    expect(durationWords(120)).toBe("120ms")
    expect(durationWords(4400)).toBe("4.4s")
    expect(durationWords(201_000)).toBe("3m21s")
  })
})


test("identified same-flow calls settle in reverse order; unidentified output cannot consume an identified start", () => {
  const model = traceFromJournal(RUN, [
    at(1, "control.agent.cell-call-started", { flowName: "read", callId: "first", input: "a" }, 1),
    at(2, "control.agent.cell-call-started", { flowName: "read", callId: "second", input: "b" }, 2),
    at(3, "control.agent.cell-call-settled", { flowName: "read", outcome: "success", value: "unidentified" }, 3),
    at(4, "control.agent.cell-call-settled", { flowName: "read", callId: "second", outcome: "success", value: "B" }, 4),
    at(5, "control.agent.cell-call-settled", { flowName: "read", callId: "first", outcome: "success", value: "A" }, 5)
  ])
  expect(model.rows.filter(row => row.kind === "call").map(row => [row.id, row.detail.input, row.detail.output, row.endedAt])).toEqual([
    ["call-1", "a", "A", 5], ["call-2", "b", "B", 4]
  ])
})

test("native call facts upgrade telemetry through the gateway's shared normalization without a second span", () => {
  const callId = `cell-call-v1:${"a".repeat(64)}`
  const native = (phase: "invoked" | "settled", sequence: number): JournalRecord => ({
    runId: RUN.runId, sequence, occurredAt: sequence, kind: "control.engine.event", payload: {
      version: 1, sequence, eventType: "flows.harness.call-fact.v1", executionId: "execution", generation: 0, emittedAtMs: sequence,
      sourceSequence: 0, sourceId: `call-fact-v1:${callId}:${phase}`, payload: {
        version: 1, phase, callId, identity: { runId: RUN.runId, frame: 0, cell: "cell", ordinal: 0, declaration: "read", layers: [] },
        flowName: "read", input: { path: "a" }, ...(phase === "settled" ? { outcome: "success", value: "recorded" } : {})
      }
    }
  })
  const model = traceFromJournal(RUN, [
    at(1, "control.agent.cell-call-started", { callId, flowName: "read", input: { truncated: true } }, 1),
    at(2, "control.agent.cell-call-settled", { callId, flowName: "read", outcome: "success", value: "telemetry" }, 2),
    native("invoked", 3), native("settled", 4)
  ])
  const calls = model.rows.filter(row => row.kind === "call")
  expect(calls).toHaveLength(1)
  expect(calls[0]).toMatchObject({ id: "call-1", detail: { input: { path: "a" }, output: "recorded" } })
})
