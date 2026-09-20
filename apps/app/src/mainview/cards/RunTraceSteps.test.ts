import { describe, expect, test } from "bun:test"
import { phaseExtent, traceFromJournal } from "./RunTrace"
import { frameAtSequence, phasePins } from "./RunTracePhaseStrip"
import type { JournalRecord } from "./RunTrace"
import { traceGoals, traceStatus } from "./RunTraceStatus"
import { CODING_PLAN } from "./fixtures/CodingPlan"
import { codingDecision, preparedCodingJournal } from "./fixtures/CodingJournal"
import { checkInputDigest } from "../../../../../flows/coding/schema"

const run = { runId: "run", flowId: "module", status: "running" }
const left = { executionId: "execution", stepId: "a".repeat(64), action: "coding/edit", attempt: 1, ask: 0, retry: 1, scope: "left", generation: 0 }
const right = { ...left, stepId: "b".repeat(64), scope: "right" }
const event = (sequence: number, kind: string, step: typeof left, payload: Record<string, unknown> = {}): JournalRecord => ({
  runId: "run", sequence, kind, payload: { ...payload, step, at: sequence * 100 }
})
/** Frames in the order the merged model lists them: by recorded start, then by sequence. */
const framesOfModel = (model: ReturnType<typeof traceFromJournal>) => model.rows.filter((row) => row.kind === "frame")

describe("module agent frame ownership", () => {
  test.each(["completed", "failed", "cancelled"])("a terminal %s run cannot leave an unclosed step running", (status) => {
    const model = traceFromJournal({ ...run, status }, [
      event(1, "control.agent.turn-opened", left),
      { sequence: 2, kind: `control.run.${status}`, payload: { at: 200 } }
    ])
    const frame = model.rows.find((row) => row.kind === "frame")!
    expect(frame.status).toBe("stopped")
    expect(frame.endedAt).toBe(200)
    expect(model.counts.running).toBe(0)
  })

  test("a terminal summary without a terminal receipt invents no closing timestamp", () => {
    const model = traceFromJournal({ ...run, status: "failed" }, [event(1, "control.agent.turn-opened", left)])
    const frame = model.rows.find((row) => row.kind === "frame")!
    expect(frame.status).toBe("stopped")
    expect(frame.endedAt).toBeUndefined()
  })

  test("native gateway facts become scoped frames and replay copies add no frames", () => {
    const native = (sequence: number, step: typeof left): JournalRecord => ({
      runId: "run", sequence, kind: "control.engine.event",
      payload: {
        version: 1, executionId: step.executionId, generation: 1, sequence, emittedAtMs: sequence * 100,
        sourceId: `step-fact-v1:${step.stepId}:${step.attempt}:${step.ask}:${step.retry}`,
        sourceSequence: 123,
        eventType: "flows.harness.step-fact.v1",
        payload: { version: 1, step, generation: 0, frame: 0, ordinal: 0, cell: "", at: sequence * 100,
          eventType: "control.agent.turn-opened", sourceSequence: 123, payload: { seat: "test" } }
      }
    })
    const first = native(1, left)
    const records = [first, native(2, right), { ...first, sequence: 3 }]
    const model = traceFromJournal(run, [...records].reverse())
    expect(model.journal).toEqual(records)
    const frames = model.rows.filter((row) => row.kind === "frame")
    expect(frames).toHaveLength(2)
    expect(frames.map((frame) => frame.startedAt)).toEqual([100, 200])
    expect(model.rows.some((row) => row.detail.event === "flows.harness.step-fact.v1")).toBe(false)
  })

  test("interleaved steps retain their calls and close at their own recorded end", () => {
    const model = traceFromJournal(run, [
      event(1, "control.agent.turn-opened", left),
      event(2, "control.agent.cell-call-started", left, { callId: "left-call", flowName: "read", input: { path: "a.ts" } }),
      event(3, "control.agent.turn-opened", right),
      event(4, "control.agent.cell-call-started", right, { callId: "right-call", flowName: "write", input: { path: "b.ts" } }),
      event(5, "control.agent.cell-call-settled", right, { callId: "right-call", flowName: "write", outcome: "success", value: "right" }),
      event(6, "control.agent.turn-closed", right, { outcome: "resolved" }),
      event(7, "control.agent.cell-call-settled", left, { callId: "left-call", flowName: "read", outcome: "success", value: "left" }),
      event(8, "control.agent.turn-closed", left, { outcome: "resolved" })
    ])
    const frames = model.rows.filter((row) => row.kind === "frame")
    expect(frames).toHaveLength(2)
    expect(new Set(frames.map((frame) => frame.id)).size).toBe(2)
    expect(frames.map((frame) => [frame.startedAt, frame.endedAt])).toEqual([[100, 800], [300, 600]])
    expect(frames.map((frame) => frame.children.find((child) => child.kind === "call")?.detail.output)).toEqual(["left", "right"])
    expect(model.lines.map((line) => line.frame)).toEqual([1, 1])
    expect(phaseExtent(model)).toEqual({ start: 100, end: 800 })
    expect(model.rows.filter((row) => row.kind === "call").every((call) => call.status === "completed")).toBe(true)
  })

  const coordinates = [
    { executionId: "other" }, { stepId: "c".repeat(64) }, { attempt: 2 },
    { ask: 1 }, { retry: 2 }, { scope: "another-scope" }, { generation: 1 }
  ]
  test.each(coordinates)("keeps an independent cursor when the recorded coordinate changes: %j", (changed) => {
    const model = traceFromJournal(run, [
      event(1, "control.agent.turn-opened", left),
      event(2, "control.agent.turn-opened", { ...left, ...changed }),
      event(3, "control.agent.turn-closed", { ...left, ...changed }, { outcome: "resolved" })
    ])
    const frames = model.rows.filter((row) => row.kind === "frame")
    expect(frames).toHaveLength(2)
    expect(frames[0]?.endedAt).toBeUndefined()
    expect(frames[1]?.endedAt).toBe(300)
    expect(frames.every((frame) => frame.id.endsWith("/frame-1"))).toBe(true)
  })

  test("a later step cannot extend another step's band or inherit its repeat history", () => {
    const rows: JournalRecord[] = []
    for (const [index, step] of [left, right].entries()) {
      const sequence = index * 10
      rows.push(
        event(sequence + 1, "control.agent.turn-opened", step),
        event(sequence + 2, "control.agent.cell-call-started", step, { flowName: "read", input: { path: "same.ts" } }),
        event(sequence + 3, "control.agent.cell-call-settled", step, { flowName: "read", outcome: "success", value: "same" }),
        event(sequence + 4, "control.agent.mutation-observed", step, { mutated: false, digest: "same", basis: "observed" }),
        event(sequence + 5, "control.agent.turn-closed", step, { outcome: "resolved" })
      )
    }
    const model = traceFromJournal(run, rows)
    expect(model.bands).toHaveLength(2)
    expect(model.bands[0]?.endedAt).toBe(500)
    expect(model.lines.every((line) => line.repeatOf === undefined)).toBe(true)
    expect(model.lines.map((line) => line.frame)).toEqual([1, 1])
    expect(model.notes).toEqual([])
  })

  test("status and goal receipts read the same scoped model at the recorded cursor", () => {
    const target = CODING_PLAN.changes[0]!.checks[0]!.target
    const records = [
      event(1, "control.agent.turn-opened", left),
      event(2, "control.agent.cell-call-started", left, { callId: "check", flowName: "test", input: { selection: [target] } }),
      event(3, "control.agent.cell-call-settled", left, { callId: "check", flowName: "test", outcome: "success", value: { exitCode: 0 } }),
      event(4, "control.agent.turn-closed", left, { outcome: "resolved" }),
      { sequence: 5, kind: "control.run.completed", payload: { at: 500 } }
    ]
    const model = traceFromJournal(run, [...records].reverse())
    expect(model.journal).toEqual(records)
    expect(traceStatus(model)).toEqual({ verdict: "completed" })
    expect(traceStatus(model, 2).activity).toBe(`Running ${target}`)
    expect(traceStatus(model, 3).activity).toBe(`Ran ${target}`)
    expect(traceGoals(model, CODING_PLAN, 2)[0]?.checks[0]?.state).toBe("running")
    // A recorded command is partial evidence at every cursor: only a receipt verifies.
    expect(traceGoals(model, CODING_PLAN, 3)[0]?.checks[0]?.state).toBe("narrowed")
    expect(traceGoals(model, CODING_PLAN)[0]?.state).toBe("narrowed")
  })

  test.each([undefined, "reused-call"])("status and goals match interleaved settlements within their step: %s", (callId) => {
    const first = CODING_PLAN.changes[0]!.checks[0]!.target
    const second = CODING_PLAN.changes[1]!.checks[0]!.target
    const records = [
      event(1, "control.agent.turn-opened", left),
      event(2, "control.agent.cell-call-started", left, { callId, flowName: "test", input: { selection: [first] } }),
      event(3, "control.agent.turn-opened", right),
      event(4, "control.agent.cell-call-started", right, { callId, flowName: "test", input: { selection: [second] } }),
      event(5, "control.agent.cell-call-settled", right, { callId, flowName: "test", outcome: "success", value: { exitCode: 1 } })
    ]
    const partial = traceFromJournal(run, records)
    expect(traceStatus(partial).activity).toBe(`Running ${first}`)
    expect(traceGoals(partial, CODING_PLAN).map((goal) => goal.checks[0]?.state)).toEqual(["running", "failed"])
    const settled = traceFromJournal(run, [...records,
      event(6, "control.agent.cell-call-settled", left, { callId, flowName: "test", outcome: "success", value: { exitCode: 0 } })
    ])
    expect(traceStatus(settled).activity).toBe(`Ran ${first}`)
    expect(traceGoals(settled, CODING_PLAN).map((goal) => goal.checks[0]?.state)).toEqual(["narrowed", "failed"])
  })

  test("scoped summaries retain descriptor precedence and recorded write outcomes", () => {
    const descriptors = [{ name: "write", activity: "reads", presentation: {
      verb: { pending: "inspecting", success: "inspected", failure: "failed to inspect" }, subject: "path", result: "text"
    } }] as const
    const starts = [
      event(1, "control.agent.turn-opened", left),
      event(2, "control.agent.cell-call-started", left, { callId: "inspect", flowName: "write", input: { path: "a.ts" } }),
      event(3, "control.agent.turn-opened", right),
      event(4, "control.agent.cell-call-started", right, { callId: "write", flowName: "write", input: { path: "b.ts" }, descriptor: {
        name: "write", activity: "writes", presentation: {
          verb: { pending: "writing", success: "wrote", failure: "failed to write" }, subject: "path", result: "write"
        }
      } }),
      event(5, "control.agent.cell-call-settled", left, { callId: "inspect", flowName: "write", outcome: "success", value: "found" })
    ]
    const pending = traceFromJournal(run, starts, { descriptors })
    expect(pending.bands.map((band) => band.phase)).toEqual(["researching", "implementing"])
    expect(pending.lines[0]).toMatchObject({ verb: "inspected", result: "found", wrote: false })
    expect(pending.lines[1]).toMatchObject({ verb: "writing", result: "", wrote: false })
    const failed = traceFromJournal(run, [...starts,
      event(6, "control.agent.cell-call-settled", right, { callId: "write", flowName: "write", outcome: "failure", message: "denied" })
    ], { descriptors })
    expect(failed.lines[1]).toMatchObject({ verb: "failed to write", result: "denied", failed: true, wrote: false })
    expect(failed.milestones).toEqual([])
    const value = { path: "b.ts", bytesWritten: 12 }
    const completed = traceFromJournal(run, [...starts,
      event(6, "control.agent.cell-call-settled", right, { callId: "write", flowName: "write", outcome: "success", value })
    ], { descriptors })
    expect(completed.lines[1]).toMatchObject({ verb: "wrote", result: "12 bytes", failed: false, wrote: true })
    expect(completed.milestones).toEqual([{ seq: 6, at: 600, label: "b.ts", tone: "brand", spanId: framesOfModel(completed)[1]!.id }])
    expect(completed.rows.find((span) => span.kind === "call" && span.detail.input !== undefined && span.startedAt === 400)?.detail.output)
      .toBe(JSON.stringify(value))
  })

  test("each step stalls only when all its work repeats settled results on an observed unchanged tree", () => {
    let seq = 0
    const rows: JournalRecord[] = []
    for (let frame = 0; frame < 3; frame++) {
      for (const step of [left, right]) {
        rows.push(
          event(++seq, "control.agent.turn-opened", step),
          event(++seq, "control.agent.cell-call-started", step, { flowName: "write", input: { path: "same.ts" } }),
          event(++seq, "control.agent.cell-call-settled", step, { flowName: "write", outcome: "success", value: { bytesWritten: 4 } })
        )
        if (step === right) rows.push(
          event(++seq, "control.agent.cell-call-started", step, { flowName: "read", input: { path: `${frame}.ts` } }),
          event(++seq, "control.agent.cell-call-settled", step, { flowName: "read", outcome: "success", value: `${frame}` })
        )
        rows.push(
          event(++seq, "control.agent.mutation-observed", step, { basis: "observed", mutated: false }),
          event(++seq, "control.agent.turn-closed", step, { outcome: "resolved" })
        )
      }
    }
    const model = traceFromJournal(run, rows)
    const frames = model.rows.filter((span) => span.kind === "frame")
    expect(model.bands.filter((band) => band.phase === "stuck").flatMap((band) => band.frames))
      .toEqual([frames[2]!.id, frames[4]!.id])
    expect(model.lines.map((line) => line.repeatOf)).toEqual([undefined, undefined, 1, undefined, 1, undefined])
  })

  test("interleaved steps keep enriched notes and pins in sequence order without empty steering", () => {
    const model = traceFromJournal(run, [
      event(1, "control.agent.turn-opened", left),
      event(2, "control.agent.turn-opened", right),
      event(3, "control.agent.steering-drained", left, { messages: [] }),
      event(4, "control.agent.steering-drained", right, { messages: [{ role: "user", text: "check first" }] }),
      { ...event(5, "control.agent.read-only-demand-issued", left, { streak: 3, cap: 3, nextFrame: 2 }), occurredAt: 50,
        payload: { step: left, at: 50, streak: 3, cap: 3, nextFrame: 2 } }
    ])
    const frames = model.rows.filter((span) => span.kind === "frame")
    expect(model.notes.map((note) => [note.seq, note.spanId])).toEqual([[4, frames[1]!.id], [5, frames[0]!.id]])
    expect(model.notes[0]?.evidence).toEqual(["check first"])
    expect(model.notes[1]?.body).toBe("3 of 3 frames changed nothing. Frame 2.")
    expect(model.milestones.map((pin) => [pin.seq, pin.at])).toEqual([[4, 400], [5, 50]])
  })
})

describe("recorded step identity", () => {
  /** A real `control.engine.event` envelope, so the fold reads identity through the gateway's own normalization. */
  const nativeStep = (
    sequence: number,
    kind: string,
    step: typeof left,
    payload: Record<string, unknown> = {},
    at = sequence * 100
  ): JournalRecord => ({
    runId: "run", sequence, kind: "control.engine.event",
    payload: {
      version: 1, executionId: step.executionId, generation: 1, sequence, emittedAtMs: at,
      sourceId: `step-fact-v1:${step.stepId}:${step.attempt}:${step.ask}:${step.retry}`,
      sourceSequence: sequence, eventType: "flows.harness.step-fact.v1",
      payload: {
        version: 1, step, generation: 0, frame: 0, ordinal: 0, cell: "", at,
        eventType: kind, sourceSequence: sequence, payload
      }
    }
  })

  test("a milestone and a slider position keep the frame of the step that recorded them", () => {
    const records = [
      nativeStep(1, "control.agent.turn-opened", left),
      nativeStep(2, "control.agent.turn-opened", right),
      nativeStep(3, "control.agent.read-only-demanded", left, { streak: 3, cap: 3, nextFrame: 2 }),
      nativeStep(4, "control.agent.repeat-demanded", right, { frames: 4, cap: 4 })
    ]
    const model = traceFromJournal(run, records)
    const [a, b] = framesOfModel(model)
    expect(a!.id).not.toBe(b!.id)
    expect(model.milestones.map((one) => [one.seq, one.spanId])).toEqual([[3, a!.id], [4, b!.id]])
    expect(frameAtSequence(model, 3)).toBe(a!.id)
    expect(frameAtSequence(model, 4)).toBe(b!.id)
    expect(phasePins(model.milestones, phaseExtent(model)).map((pin) => pin.milestone.spanId)).toEqual([a!.id, b!.id])
  })

  test("equal and backward stamps never hand a position to another step, in any arrival order", () => {
    const records = [
      nativeStep(1, "control.agent.turn-opened", left, {}, 500),
      nativeStep(2, "control.agent.turn-opened", right, {}, 500),
      nativeStep(3, "control.agent.unmoved-demanded", left, { nextFrame: 2 }, 100),
      nativeStep(4, "control.agent.cell-call-started", right, { callId: "r", flowName: "read", input: { path: "b.ts" } }, 500)
    ]
    const model = traceFromJournal(run, records)
    const [a, b] = framesOfModel(model)
    expect(frameAtSequence(model, 3)).toBe(a!.id)
    expect(frameAtSequence(model, 4)).toBe(b!.id)
    expect(model.milestones.map((one) => one.spanId)).toEqual([a!.id])
    expect(traceFromJournal(run, [...records].reverse()).owners).toEqual(model.owners)
  })

  test("another step's mutation, sufficiency or resume cannot close a step's thrashing", () => {
    const thrashing = [
      nativeStep(1, "control.agent.turn-opened", left),
      nativeStep(2, "control.agent.repeat-demanded", left, { frames: 4, cap: 4 }),
      nativeStep(3, "control.agent.turn-opened", right)
    ]
    const elsewhere = [
      nativeStep(4, "control.agent.mutation-observed", right, { basis: "observed", mutated: true }),
      nativeStep(5, "control.agent.sufficiency-observed", right, { flow: "test", failed: "before", passed: "after" }),
      { runId: "run", sequence: 6, kind: "control.run.resumed", payload: { at: 600 } }
    ]
    expect(traceStatus(traceFromJournal(run, [...thrashing, ...elsewhere])).condition).toBe("thrashing")
    for (const closing of [
      nativeStep(7, "control.agent.mutation-observed", left, { basis: "observed", mutated: true }),
      nativeStep(7, "control.agent.sufficiency-observed", left, { flow: "test", failed: "before", passed: "after" })
    ]) expect(traceStatus(traceFromJournal(run, [...thrashing, ...elsewhere, closing])).condition).toBeUndefined()
  })

  test.each(["control.agent.resolved", "control.agent.aborted"])("%s ends the condition the same invocation recorded", (ending) => {
    const records = [
      nativeStep(1, "control.agent.turn-opened", left),
      nativeStep(2, "control.agent.repeat-demanded", left, { frames: 4, cap: 4 }),
      nativeStep(3, "control.agent.turn-opened", right),
      nativeStep(4, ending, left, { text: "done", reason: "stop" })
    ]
    expect(traceStatus(traceFromJournal(run, records))).toEqual({ activity: "Thinking" })
    // Another step's ending says nothing about this step's brake.
    expect(traceStatus(traceFromJournal(run, [...records.slice(0, 3), nativeStep(4, ending, right, {})])).condition).toBe("thrashing")
  })

  test("a newer attempt of a step replaces the condition its earlier attempt recorded", () => {
    const retried = { ...left, retry: 2 }
    const records = [
      nativeStep(1, "control.agent.turn-opened", left),
      nativeStep(2, "control.agent.repeat-demanded", left, { frames: 4, cap: 4 }),
      nativeStep(3, "control.agent.turn-closed", left, { outcome: "failed" }),
      nativeStep(4, "control.agent.turn-opened", retried),
      nativeStep(5, "control.agent.cell-call-started", retried, { callId: "w", flowName: "write", input: { path: "a.ts" } }),
      nativeStep(6, "control.agent.cell-call-settled", retried, { callId: "w", flowName: "write", outcome: "success", value: { bytesWritten: 1 } }),
      nativeStep(7, "control.agent.mutation-observed", retried, { basis: "observed", mutated: true })
    ]
    expect(traceStatus(traceFromJournal(run, records))).toEqual({ activity: "Wrote a.ts" })
    // The earlier attempt's brake stands until the newer one is recorded.
    expect(traceStatus(traceFromJournal(run, records.slice(0, 3))).condition).toBe("thrashing")
  })

  test("a park ends when the step's next attempt records work, with no run-level resume", () => {
    const resumed = { ...right, retry: 2 }
    const records = [
      nativeStep(1, "control.agent.turn-opened", right),
      nativeStep(2, "control.agent.suspended", right, { reason: "quota" }),
      nativeStep(3, "control.agent.turn-opened", resumed),
      nativeStep(4, "control.agent.cell-call-started", resumed, { callId: "r", flowName: "read", input: { path: "a.ts" } })
    ]
    expect(traceStatus(traceFromJournal(run, records))).toEqual({ activity: "Reading a.ts" })
    expect(traceStatus(traceFromJournal(run, records.slice(0, 2)))).toMatchObject({ condition: "blocked", action: "resume" })
  })

  test("a park belongs to its step, a run-level resume ends it, and an approval outranks both", () => {
    const parked = [
      nativeStep(1, "control.agent.turn-opened", left),
      nativeStep(2, "control.agent.repeat-demanded", left, { frames: 4, cap: 4 }),
      nativeStep(3, "control.agent.turn-opened", right),
      nativeStep(4, "control.agent.suspended", right, { reason: "event" })
    ]
    expect(traceStatus(traceFromJournal(run, parked))).toMatchObject({ condition: "blocked", action: "resume" })
    const resumed = [...parked, { runId: "run", sequence: 5, kind: "control.run.resumed", payload: { at: 500 } }]
    expect(traceStatus(traceFromJournal(run, resumed)).condition).toBe("thrashing")
    expect(traceStatus(traceFromJournal(run, [...parked,
      { runId: "run", sequence: 5, kind: "control.approval.requested", payload: { at: 500, requestId: "q" } }])))
      .toMatchObject({ condition: "approval", action: "approval" })
  })

  test("a call recorded as a read cannot certify a required check, whatever its name and selection", () => {
    const check = CODING_PLAN.changes[0]!.checks[0]!
    const records = [
      nativeStep(1, "control.agent.turn-opened", left),
      nativeStep(2, "control.agent.cell-call-started", left, {
        callId: "probe", flowName: "test", input: { selection: [check.target] },
        descriptor: { name: "test", activity: "reads" }
      }),
      nativeStep(3, "control.agent.cell-call-settled", left, {
        callId: "probe", flowName: "test", outcome: "success", value: { exitCode: 0 }
      })
    ]
    const model = traceFromJournal(run, records)
    expect(model.bands.map((band) => band.phase)).toEqual(["researching"])
    expect(traceGoals(model, CODING_PLAN)[0]!.checks[0]!.state).toBe("pending")
  })

  test("a recorded command with no receipt is partial evidence, and a display hint never certifies", () => {
    const check = CODING_PLAN.changes[0]!.checks[0]!
    const recorded = (descriptor?: Record<string, unknown>) => traceFromJournal(run, [
      nativeStep(1, "control.agent.turn-opened", left),
      nativeStep(2, "control.agent.cell-call-started", left, {
        callId: "probe", flowName: "test", input: { selection: [check.target] },
        ...(descriptor === undefined ? {} : { descriptor })
      }),
      nativeStep(3, "control.agent.cell-call-settled", left, {
        callId: "probe", flowName: "test", outcome: "success", value: { exitCode: 0 }
      })
    ])
    expect(traceGoals(recorded(), CODING_PLAN)[0]!.checks[0]!.state).toBe("narrowed")
    expect(traceGoals(recorded({ name: "test", activity: "checks" }), CODING_PLAN)[0]!.checks[0]!.state).toBe("narrowed")
    expect(traceGoals(recorded(), CODING_PLAN)[0]!.state).toBe("narrowed")
  })

  test("a custom flow recorded as a write invalidates a check on a planned path", () => {
    const check = CODING_PLAN.changes[0]!.checks[0]!
    const ran = [
      nativeStep(1, "control.agent.turn-opened", left),
      nativeStep(2, "control.agent.cell-call-started", left, { callId: "probe", flowName: "test", input: { selection: [check.target] } }),
      nativeStep(3, "control.agent.cell-call-settled", left, { callId: "probe", flowName: "test", outcome: "success", value: { exitCode: 0 } })
    ]
    const wrote = (path: string) => [
      nativeStep(4, "control.agent.cell-call-started", left, {
        callId: "patch", flowName: "morph", input: { path },
        descriptor: { name: "morph", activity: "writes" }
      }),
      nativeStep(5, "control.agent.cell-call-settled", left, { callId: "patch", flowName: "morph", outcome: "success", value: { bytesWritten: 4 } })
    ]
    expect(traceGoals(traceFromJournal(run, [...ran, ...wrote("src/memory.ts")]), CODING_PLAN)[0]!.checks[0]!.state).toBe("stale")
    expect(traceGoals(traceFromJournal(run, [...ran, ...wrote("docs/other.md")]), CODING_PLAN)[0]!.checks[0]!.state).toBe("narrowed")
  })

  test("a flow named write but recorded as a read moves no tree, so it invalidates nothing", () => {
    const change = CODING_PLAN.changes[0]!, check = change.checks[0]!
    const planned = change.atoms[0]!.writes[0]!
    const inspected = (first: number) => [
      nativeStep(first, "control.agent.cell-call-started", left, {
        callId: "shadow", flowName: "write", input: { path: planned },
        descriptor: { name: "write", activity: "reads" }
      }),
      nativeStep(first + 1, "control.agent.cell-call-settled", left, { callId: "shadow", flowName: "write", outcome: "success", value: "found" })
    ]
    const ran = [
      nativeStep(1, "control.agent.turn-opened", left),
      nativeStep(2, "control.agent.cell-call-started", left, { callId: "probe", flowName: "test", input: { selection: [check.target] } }),
      nativeStep(3, "control.agent.cell-call-settled", left, { callId: "probe", flowName: "test", outcome: "success", value: { exitCode: 0 } })
    ]
    expect(traceGoals(traceFromJournal(run, [...ran, ...inspected(4)]), CODING_PLAN)[0]!.checks[0]!.state).toBe("narrowed")
    // A receipt is bound to the tree it covered; only a recorded write moves it.
    const implementation = { change: change.id, parent: CODING_PLAN.base, head: CODING_PLAN.base, atoms: [CODING_PLAN.base], reads: [], writes: [planned] }
    const bound = [...preparedCodingJournal(), codingDecision(6, "check", "coding/CommandCheck", {
      parent: "correct", status: "completed", input: { flow: check.flow, input: { implementation, check } },
      value: { checkId: check.id, target: check.target, tier: check.tier, change: change.id, commitId: implementation.head.commitId,
        treeId: implementation.head.treeId, inputDigest: checkInputDigest(implementation, check), status: "passed", evidence: "", findings: [] }
    })]
    const certified = (records: ReadonlyArray<JournalRecord>) =>
      traceGoals(traceFromJournal({ ...run, runId: "run-1" }, records), CODING_PLAN)[0]!.checks[0]!.state
    expect(certified(bound)).toBe("passed")
    expect(certified([...bound, ...inspected(7)])).toBe("passed")
  })
})
