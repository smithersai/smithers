import { describe, expect, test } from "bun:test"
import { journalMeaning, assertSuccessfulEdit, requireLaterPhase, TimelineEvidenceError } from "../run-inspection/semantic"
import { moduleMeaning, moduleRows } from "../run-inspection/module-evidence"

const event = (sequence: number, kind: string, payload: Record<string, unknown> = {}) => ({ sequence, kind, payload })
const opened = "control.agent.turn-opened"
const started = "control.agent.cell-call-started"
const settled = "control.agent.cell-call-settled"
const journal = [
  event(1, opened),
  event(2, started, { flowName: "read", callId: "a", input: { path: "README.md" } }),
  event(3, settled, { flowName: "read", callId: "a", outcome: "success", value: { startLine: 1, endLine: 4 } }),
  event(4, opened),
  event(5, started, { flowName: "write", callId: "b", input: { path: "README.md", content: "marker\n" } }),
  event(6, settled, { flowName: "write", callId: "b", outcome: "success", value: { bytesWritten: 7 } }),
  event(7, opened),
  event(8, started, { flowName: "bash", callId: "c", input: { command: "bun test marker.test.ts" } }),
  event(9, settled, { flowName: "bash", callId: "c", outcome: "success", value: { exitCode: 0 } }),
  event(10, "control.run.completed")
]

const moduleFact = (sequence: number, kind: string, payload: Record<string, unknown>, suffix = "a") => {
  const step = { stepId: suffix.repeat(64), executionId: `child-${suffix}`, action: "coding/dispatch-turn", attempt: 1, ask: 0, retry: 1, scope: "turn" }
  return { ...event(sequence, "control.engine.event", {
    version: 1, eventType: "flows.harness.step-fact.v1", executionId: step.executionId, generation: 0, sequence, emittedAtMs: sequence,
    sourceId: `step-fact-v1:${step.stepId}:1:0:1`, sourceSequence: sequence,
    payload: { version: 1, step, generation: 0, frame: 0, ordinal: sequence, cell: "cell", at: sequence,
      eventType: kind, sourceSequence: sequence, payload }
  }), runId: "run-1" }
}

describe("ordinary module journal evidence", () => {
  test("recorded module ownership keeps identical call ids in separate steps", () => {
    const rows = [moduleFact(1, opened, {}), moduleFact(2, opened, {}, "b"),
      moduleFact(3, started, { callId: "same", flowName: "read", input: { path: "one.txt" } }),
      moduleFact(4, started, { callId: "same", flowName: "read", input: { path: "two.txt" } }, "b"),
      moduleFact(5, settled, { callId: "same", flowName: "read", outcome: "success", value: { startLine: 1, endLine: 2 } }, "b"),
      moduleFact(6, settled, { callId: "same", flowName: "read", outcome: "success", value: { startLine: 1, endLine: 4 } })]
    const meaning = moduleMeaning(rows)
    expect(meaning.lines.map(line => [line.subject, line.result])).toEqual([["one.txt", "4 lines"], ["two.txt", "2 lines"]])
    expect(new Set(meaning.lines.map(line => line.node)).size).toBe(2)
    expect(moduleMeaning(rows, 5).status).toBe("Reading one.txt")
    expect(meaning.bands).toEqual([{ seq: 1, phase: "researching" }, { seq: 2, phase: "researching" }])
  })

  test("replayed observations are deduplicated by their recorded source", () => {
    const first = moduleFact(1, opened, {})
    const replay = { ...first, sequence: 9 }
    expect(moduleRows([first, replay])).toHaveLength(1)
    expect(moduleMeaning([first, replay]).frames).toHaveLength(1)
  })

  test("a mismatched module execution is unsupported evidence", () => {
    const row = moduleFact(1, opened, {})
    expect(() => moduleRows([{ ...row, payload: { ...row.payload, executionId: "another" } }])).toThrow(TimelineEvidenceError)
  })
})

describe("the independent timeline evidence oracle", () => {
  test("read, write and test bands and lines come from calls and their outcomes", () => {
    const meaning = journalMeaning(journal)
    expect(meaning.bands).toEqual([
      { phase: "researching", seq: 1 }, { phase: "implementing", seq: 4 }, { phase: "testing", seq: 7 }
    ])
    expect(meaning.lines.map(line => [line.verb, line.subject, line.result])).toEqual([
      ["read", "README.md", "4 lines"], ["wrote", "README.md", "7 bytes"], ["ran", "bun test marker.test.ts", "exit 0"]
    ])
    expect(meaning.pins).toEqual([{ seq: 6, label: "README.md" }, { seq: 10, label: "completed" }])
    expect(meaning.status).toBe("Finished.")
    expect(meaning.goals).toEqual([])
  })

  test("a pending or failed write never becomes wrote or earns a file pin", () => {
    expect(journalMeaning(journal.slice(0, 5)).lines[1]?.verb).toBe("writing")
    const failed = [...journal.slice(0, 5), event(6, settled, { flowName: "write", callId: "b", outcome: "failure", message: "read only" }), event(7, "control.run.failed")]
    expect(journalMeaning(failed).lines[1]).toMatchObject({ verb: "failed to write", result: "read only" })
    expect(journalMeaning(failed).pins).toEqual([{ seq: 7, label: "failed" }])
    expect(journalMeaning(failed).status).toBe("Failed.")
  })

  test("call ids pair interleaved outcomes and the cursor does not borrow later results", () => {
    const rows = [event(1, opened),
      event(2, started, { flowName: "read", callId: "a", input: { path: "first.txt" } }),
      event(3, started, { flowName: "read", callId: "b", input: { path: "second.txt" } }),
      event(4, settled, { flowName: "read", callId: "b", outcome: "success", value: { startLine: 1, endLine: 20 } }),
      event(5, settled, { flowName: "read", callId: "a", outcome: "success", value: { startLine: 1, endLine: 2 } })]
    expect(journalMeaning(rows).lines[0]).toMatchObject({ subject: "first.txt", result: "2 lines" })
    expect(journalMeaning(rows, 4).lines[0]).toMatchObject({ verb: "reading", result: "" })
    expect(journalMeaning(rows, 4).status).toBe("Reading first.txt")
  })

  test("an outcome must be recorded before the oracle can say wrote", () => {
    expect(() => journalMeaning([...journal.slice(0, 5), event(6, settled, { flowName: "write", callId: "b", value: { bytesWritten: 7 } })])).toThrow(TimelineEvidenceError)
  })

  test.each(["completed", "failed", "cancelled"])("late agent telemetry cannot replace the recorded %s run outcome", outcome => {
    const rows = [...journal.slice(0, 3), event(4, `control.run.${outcome}`), event(5, opened)]
    expect(journalMeaning(rows).status).toBe({ completed: "Finished.", failed: "Failed.", cancelled: "Cancelled." }[outcome]!)
    expect(journalMeaning(rows, 3).status).toBe("Read README.md")
  })

  test("native calls establish the cursor's evidence before their duplicate telemetry arrives", () => {
    const callId = `cell-call-v1:${"a".repeat(64)}`
    const fact = (sequence: number, phase: "invoked" | "settled") => ({
      ...event(sequence, "control.engine.event", {
        version: 1, eventType: "flows.harness.call-fact.v1", executionId: "run-1", generation: 0, sequence, emittedAtMs: sequence,
        sourceSequence: 0, sourceId: `call-fact-v1:${callId}:${phase}`,
        payload: { version: 1, phase, callId, flowName: "read", identity: { runId: "run-1", cell: "cell", frame: 0, ordinal: 0, declaration: "read", layers: [] },
          ...(phase === "invoked" ? { input: { path: "README.md" } } : { outcome: "success", value: { startLine: 1, endLine: 4 } }) }
      }), runId: "run-1"
    })
    const rows = [event(1, opened), fact(2, "invoked"), event(3, "control.agent.cell-produced"), fact(4, "settled"),
      event(5, started, { callId, flowName: "read", input: { path: "README.md" } }),
      event(6, settled, { callId, flowName: "read", outcome: "success", value: { startLine: 1, endLine: 4 } })]
    expect(journalMeaning(rows, 3).status).toBe("Reading README.md")
    expect(journalMeaning(rows, 4).lines[0]?.result).toBe("4 lines")
    expect(journalMeaning(rows).frames[0]?.calls).toHaveLength(1)
    expect(journalMeaning(rows).lines).toEqual(journalMeaning(rows, 4).lines)
  })

  test("a terminal pin cannot stand in for a later phase", () => {
    const meaning = journalMeaning([...journal.slice(0, 3), event(4, "control.run.completed")])
    expect(() => requireLaterPhase(meaning)).toThrow(TimelineEvidenceError)
    expect(requireLaterPhase(journalMeaning(journal))).toEqual({ phase: "testing", seq: 7 })
  })

  test("completed status and model prose do not prove the edit", () => {
    expect(() => assertSuccessfulEdit("completed", "before\n", "before\n", "marker")).toThrow(TimelineEvidenceError)
    expect(() => assertSuccessfulEdit("failed", "before\n", "before\nmarker\n", "marker")).toThrow(TimelineEvidenceError)
    expect(() => assertSuccessfulEdit("completed", "before\n", "before\nmarker extra\n", "marker")).toThrow(TimelineEvidenceError)
    expect(() => assertSuccessfulEdit("completed", "before\n", "before\nmarker\n", "marker")).not.toThrow()
  })

  test("empty old steering payloads are absent evidence, not steering pins", () => {
    expect(journalMeaning([event(1, "control.agent.steering-drained", {})]).pins).toEqual([])
    expect(journalMeaning([event(1, "control.agent.steering-drained", { messages: [] })]).pins).toEqual([])
    expect(journalMeaning([event(1, "control.agent.steering-drained", { messages: [{ role: "user", text: "continue" }] })]).pins).toEqual([{ seq: 1, label: "steering" }])
  })

  test("only a demanded claim is a milestone; unknown event names add no pins", () => {
    expect(journalMeaning([event(1, "control.agent.claim-demanded", { demanded: false })]).pins).toEqual([])
    expect(journalMeaning([event(1, "control.agent.claim-demanded", { demanded: true })]).pins).toEqual([{ seq: 1, label: "claim" }])
    expect(journalMeaning([event(1, "constructor")]).pins).toEqual([])
  })

  test("unsupported calls and plans fail visibly instead of making semantic claims", () => {
    expect(() => journalMeaning([event(1, opened), event(2, started, { flowName: "unknown", input: {} })])).toThrow(TimelineEvidenceError)
    expect(() => journalMeaning([event(1, "coding/PreparePlan", { changes: [{}] })])).toThrow(TimelineEvidenceError)
  })

  test("a discipline pin does not hide the written files in the same frame", () => {
    const rows = [event(1, opened), event(2, "control.agent.read-only-demand-issued"),
      event(3, started, { flowName: "write", callId: "a", input: { path: "one.txt" } }),
      event(4, settled, { flowName: "write", callId: "a", outcome: "success", value: { bytesWritten: 1 } }),
      event(5, started, { flowName: "write", callId: "b", input: { path: "two.txt" } }),
      event(6, settled, { flowName: "write", callId: "b", outcome: "success", value: { bytesWritten: 2 } })]
    expect(journalMeaning(rows).pins).toEqual([{ seq: 2, label: "read-only" }, { seq: 4, label: "one.txt +1" }])
  })

  test.each([
    ["read", { path: "dir/a.txt" }, { startLine: 2, endLine: 2 }, "read", "a.txt", "1 line", "researching"],
    ["write", { path: "a.txt" }, { bytesWritten: 1 }, "wrote", "a.txt", "1 byte", "implementing"],
    ["edit", { path: "a.txt" }, { replacements: 2 }, "edited", "a.txt", "2 replacements", "implementing"],
    ["apply_patch", { input: "*** Add File: a.txt\n*** Update File: b.txt" }, { added: ["a.txt"], modified: ["b.txt"], deleted: [] }, "patched", "a.txt +1", "2 files", "implementing"],
    ["bash", { command: "bun test" }, { exitCode: 1 }, "ran", "bun test", "exit 1", "testing"],
    ["test", { selection: ["test/unit"] }, { exitCode: 2 }, "ran", "test/unit", "exit 2", "testing"],
    ["grep", { pattern: "marker" }, { matches: [1, 2] }, "searched", "marker", "2 matches", "researching"],
    ["glob", { pattern: "*.ts" }, { paths: ["a.ts"] }, "listed", "*.ts", "1 file", "researching"],
    ["ls", { path: "src" }, { entries: [1, 2] }, "listed", "src", "2 entries", "researching"]
  ] as const)("the supported %s call has an independent expectation", (flowName, input, value, verb, subject, result, phase) => {
    const meaning = journalMeaning([event(1, opened), event(2, started, { flowName, input }), event(3, settled, { flowName, outcome: "success", value })])
    expect(meaning.lines[0]).toMatchObject({ verb, subject, result })
    expect(meaning.bands).toEqual([{ seq: 1, phase }])
  })
})
