import { describe, expect, test } from "vitest"
import { type JournalRecord, phaseExtent, traceFromJournal } from "../src/RunTrace.js"
const run = { runId: "run", flowId: "module", status: "running" }
const left = {
  executionId: "execution",
  stepId: "a".repeat(64),
  action: "coding/edit",
  attempt: 1,
  ask: 0,
  retry: 1,
  scope: "left",
  generation: 0
}
const right = { ...left, stepId: "b".repeat(64), scope: "right" }
const event = (
  sequence: number,
  kind: string,
  step: typeof left,
  payload: Record<string, unknown> = {}
): JournalRecord => ({
  runId: "run",
  sequence,
  kind,
  payload: { ...payload, step, at: sequence * 100 }
})
/** Frames in the order the merged model lists them: by recorded start, then by sequence. */
const framesOfModel = (model: ReturnType<typeof traceFromJournal>) => model.rows.filter((row) => row.kind === "frame")

describe("module agent frame ownership", () => {
  test.each(["completed", "failed", "cancelled"])(
    "a terminal %s run cannot leave an unclosed step running",
    (status) => {
      const model = traceFromJournal({ ...run, status }, [
        event(1, "control.agent.turn-opened", left),
        { sequence: 2, kind: `control.run.${status}`, payload: { at: 200 } }
      ])
      const frame = model.rows.find((row) => row.kind === "frame")!
      expect(frame.status).toBe("stopped")
      expect(frame.endedAt).toBe(200)
      expect(model.counts.running).toBe(0)
    }
  )

  test("a terminal summary without a terminal receipt invents no closing timestamp", () => {
    const model = traceFromJournal({ ...run, status: "failed" }, [event(1, "control.agent.turn-opened", left)])
    const frame = model.rows.find((row) => row.kind === "frame")!
    expect(frame.status).toBe("stopped")
    expect(frame.endedAt).toBeUndefined()
  })

  test("native gateway facts become scoped frames and replay copies add no frames", () => {
    const native = (sequence: number, step: typeof left): JournalRecord => ({
      runId: "run",
      sequence,
      kind: "control.engine.event",
      payload: {
        version: 1,
        executionId: step.executionId,
        generation: 1,
        sequence,
        emittedAtMs: sequence * 100,
        sourceId: `step-fact-v1:${step.stepId}:${step.attempt}:${step.ask}:${step.retry}`,
        sourceSequence: 123,
        eventType: "flows.harness.step-fact.v1",
        payload: {
          version: 1,
          step,
          generation: 0,
          frame: 0,
          ordinal: 0,
          cell: "",
          at: sequence * 100,
          eventType: "control.agent.turn-opened",
          sourceSequence: 123,
          payload: { seat: "test" }
        }
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
      event(2, "control.agent.cell-call-started", left, {
        callId: "left-call",
        flowName: "read",
        input: { path: "a.ts" }
      }),
      event(3, "control.agent.turn-opened", right),
      event(4, "control.agent.cell-call-started", right, {
        callId: "right-call",
        flowName: "write",
        input: { path: "b.ts" }
      }),
      event(5, "control.agent.cell-call-settled", right, {
        callId: "right-call",
        flowName: "write",
        outcome: "success",
        value: "right"
      }),
      event(6, "control.agent.turn-closed", right, { outcome: "resolved" }),
      event(7, "control.agent.cell-call-settled", left, {
        callId: "left-call",
        flowName: "read",
        outcome: "success",
        value: "left"
      }),
      event(8, "control.agent.turn-closed", left, { outcome: "resolved" })
    ])
    const frames = model.rows.filter((row) => row.kind === "frame")
    expect(frames).toHaveLength(2)
    expect(new Set(frames.map((frame) => frame.id)).size).toBe(2)
    expect(frames.map((frame) => [frame.startedAt, frame.endedAt])).toEqual([[100, 800], [300, 600]])
    expect(frames.map((frame) => frame.children.find((child) => child.kind === "call")?.detail.output)).toEqual([
      "left",
      "right"
    ])
    // Two steps each open their first frame; the merged list numbers the rows
    // a person reads, so no two rows wear the same number.
    expect(model.lines.map((line) => line.frame)).toEqual([1, 2])
    expect(phaseExtent(model)).toEqual({ start: 100, end: 800 })
    expect(model.rows.filter((row) => row.kind === "call").every((call) => call.status === "completed")).toBe(true)
  })

  const coordinates = [
    { executionId: "other" },
    { stepId: "c".repeat(64) },
    { attempt: 2 },
    { ask: 1 },
    { retry: 2 },
    { scope: "another-scope" },
    { generation: 1 }
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
        event(sequence + 3, "control.agent.cell-call-settled", step, {
          flowName: "read",
          outcome: "success",
          value: "same"
        }),
        event(sequence + 4, "control.agent.mutation-observed", step, {
          mutated: false,
          digest: "same",
          basis: "observed"
        }),
        event(sequence + 5, "control.agent.turn-closed", step, { outcome: "resolved" })
      )
    }
    const model = traceFromJournal(run, rows)
    expect(model.bands).toHaveLength(2)
    expect(model.bands[0]?.endedAt).toBe(500)
    expect(model.lines.every((line) => line.repeatOf === undefined)).toBe(true)
    expect(model.lines.map((line) => line.frame)).toEqual([1, 2])
    expect(model.notes).toEqual([])
  })

  test("scoped summaries retain descriptor precedence and recorded write outcomes", () => {
    const starts = [
      event(1, "control.agent.turn-opened", left),
      event(2, "control.agent.cell-call-started", left, {
        callId: "inspect",
        flowName: "write",
        input: { path: "a.ts" },
        descriptor: {
          name: "write",
          activity: "reads",
          presentation: {
            verb: { pending: "inspecting", success: "inspected", failure: "failed to inspect" },
            subject: "path",
            result: "text"
          }
        }
      }),
      event(3, "control.agent.turn-opened", right),
      event(4, "control.agent.cell-call-started", right, {
        callId: "write",
        flowName: "write",
        input: { path: "b.ts" },
        descriptor: {
          name: "write",
          activity: "writes",
          presentation: {
            verb: { pending: "writing", success: "wrote", failure: "failed to write" },
            subject: "path",
            result: "write"
          }
        }
      }),
      event(5, "control.agent.cell-call-settled", left, {
        callId: "inspect",
        flowName: "write",
        outcome: "success",
        value: "found"
      })
    ]
    const pending = traceFromJournal(run, starts)
    // The header reads the descriptor its own row reads, or the card says a
    // step is writing a file it is only inspecting.
    expect(pending.bands.map((band) => band.phase)).toEqual(["researching", "implementing"])
    expect(pending.lines[0]).toMatchObject({ verb: "inspected", result: "found", wrote: false })
    expect(pending.lines[1]).toMatchObject({ verb: "writing", result: "", wrote: false })
    const failed = traceFromJournal(run, [
      ...starts,
      event(6, "control.agent.cell-call-settled", right, {
        callId: "write",
        flowName: "write",
        outcome: "failure",
        message: "denied"
      })
    ])
    expect(failed.lines[1]).toMatchObject({ verb: "failed to write", result: "denied", failed: true, wrote: false })
    expect(failed.milestones).toEqual([])
    const value = { path: "b.ts", bytesWritten: 12 }
    const completed = traceFromJournal(run, [
      ...starts,
      event(6, "control.agent.cell-call-settled", right, {
        callId: "write",
        flowName: "write",
        outcome: "success",
        value
      })
    ])
    expect(completed.lines[1]).toMatchObject({ verb: "wrote", result: "12 bytes", failed: false, wrote: true })
    expect(completed.milestones).toEqual([{
      seq: 6,
      at: 600,
      label: "b.ts",
      tone: "brand",
      spanId: framesOfModel(completed)[1]!.id
    }])
    expect(
      completed.rows.find((span) => span.kind === "call" && span.detail.input !== undefined && span.startedAt === 400)
        ?.detail.output
    )
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
          event(++seq, "control.agent.cell-call-settled", step, {
            flowName: "write",
            outcome: "success",
            value: { bytesWritten: 4 }
          })
        )
        if (step === right) {
          rows.push(
            event(++seq, "control.agent.cell-call-started", step, { flowName: "read", input: { path: `${frame}.ts` } }),
            event(++seq, "control.agent.cell-call-settled", step, {
              flowName: "read",
              outcome: "success",
              value: `${frame}`
            })
          )
        }
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

  test("a merged repeat names the renumbered row of its own step", () => {
    const rows: JournalRecord[] = []
    let seq = 0
    for (let frame = 0; frame < 3; frame++) {
      for (const step of [left, right]) {
        rows.push(
          event(++seq, "control.agent.turn-opened", step),
          event(++seq, "control.agent.cell-call-started", step, {
            flowName: "write",
            input: { path: `${step.scope}.ts` }
          }),
          event(++seq, "control.agent.cell-call-settled", step, {
            flowName: "write",
            outcome: "success",
            value: { bytesWritten: 4 }
          }),
          event(++seq, "control.agent.mutation-observed", step, { basis: "observed", mutated: false }),
          event(++seq, "control.agent.turn-closed", step, { outcome: "resolved" })
        )
      }
    }
    const model = traceFromJournal(run, rows)
    expect(model.lines.map((line) => [line.frame, line.repeatOf]))
      .toEqual([[1, undefined], [2, undefined], [3, 1], [4, 2], [5, 1], [6, 2]])
  })

  test("interleaved steps keep enriched notes and pins in sequence order without empty steering", () => {
    const model = traceFromJournal(run, [
      event(1, "control.agent.turn-opened", left),
      event(2, "control.agent.turn-opened", right),
      event(3, "control.agent.steering-drained", left, { messages: [] }),
      event(4, "control.agent.steering-drained", right, { messages: [{ role: "user", text: "check first" }] }),
      {
        ...event(5, "control.agent.read-only-demand-issued", left, { streak: 3, cap: 3, nextFrame: 2 }),
        occurredAt: 50,
        payload: { step: left, at: 50, streak: 3, cap: 3, nextFrame: 2 }
      }
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
    runId: "run",
    sequence,
    kind: "control.engine.event",
    payload: {
      version: 1,
      executionId: step.executionId,
      generation: 1,
      sequence,
      emittedAtMs: at,
      sourceId: `step-fact-v1:${step.stepId}:${step.attempt}:${step.ask}:${step.retry}`,
      sourceSequence: sequence,
      eventType: "flows.harness.step-fact.v1",
      payload: {
        version: 1,
        step,
        generation: 0,
        frame: 0,
        ordinal: 0,
        cell: "",
        at,
        eventType: kind,
        sourceSequence: sequence,
        payload
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
  })

  test("equal and backward stamps never hand a position to another step, in any arrival order", () => {
    const records = [
      nativeStep(1, "control.agent.turn-opened", left, {}, 500),
      nativeStep(2, "control.agent.turn-opened", right, {}, 500),
      nativeStep(3, "control.agent.unmoved-demanded", left, { nextFrame: 2 }, 100),
      nativeStep(4, "control.agent.cell-call-started", right, {
        callId: "r",
        flowName: "read",
        input: { path: "b.ts" }
      }, 500)
    ]
    const model = traceFromJournal(run, records)
    const [a, b] = framesOfModel(model)
    expect(model.milestones.map((one) => one.spanId)).toEqual([a!.id])
    expect(traceFromJournal(run, [...records].reverse()).owners).toEqual(model.owners)
  })
})
