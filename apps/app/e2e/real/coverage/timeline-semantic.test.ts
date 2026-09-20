import { describe, expect, test } from "bun:test"
import { journalMeaning, assertSuccessfulEdit, requireLaterPhase, TimelineEvidenceError } from "../run-inspection/semantic"
import { moduleMeaning, moduleRows } from "../run-inspection/module-evidence"
import type { JournalRow } from "../run-inspection/semantic"
import { demandInventory, deployedHeaderSource, HEADER_SOURCES, liveInspectionFact, reloadBootFact, repositoryRoot } from "../run-inspection/revisions"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

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

  test("interleaved module frames retain their recorded order", () => {
    const rows = [moduleFact(1, opened, {}), moduleFact(2, started, { flowName: "read", input: { path: "one.txt" } }),
      moduleFact(3, opened, {}, "b"), moduleFact(4, started, { flowName: "read", input: { path: "two.txt" } }, "b"),
      moduleFact(5, opened, {}), moduleFact(6, started, { flowName: "read", input: { path: "three.txt" } })]
    expect(moduleMeaning(rows).lines.map(line => line.subject)).toEqual(["one.txt", "two.txt", "three.txt"])
  })

  test("anonymous module calls settle only within the recorded step", () => {
    const rows = [moduleFact(1, opened, {}), moduleFact(2, started, { flowName: "read", input: { path: "one.txt" } }),
      moduleFact(3, opened, {}, "b"), moduleFact(4, started, { flowName: "read", input: { path: "two.txt" } }, "b"),
      moduleFact(5, settled, { flowName: "read", outcome: "success", value: { startLine: 1, endLine: 2 } }, "b")]
    expect(moduleMeaning(rows).status).toBe("Reading one.txt")
  })

  test("a mismatched module execution is unsupported evidence", () => {
    const row = moduleFact(1, opened, {})
    expect(() => moduleRows([{ ...row, payload: { ...row.payload, executionId: "another" } }])).toThrow(TimelineEvidenceError)
  })

  test("a nested native call is represented by its owning step facts, not borrowed by the outer run", () => {
    const callId = `cell-call-v1:${"a".repeat(64)}`
    const rows = [moduleFact(1, opened, {}), moduleFact(2, started, { callId, flowName: "read", input: { path: "README.md" } }),
      { ...event(3, "control.engine.event", { version: 1, eventType: "flows.harness.call-fact.v1", executionId: "child-a", generation: 0,
        sourceSequence: 0, sourceId: `call-fact-v1:${callId}:invoked`, payload: { version: 1, phase: "invoked", callId, flowName: "read",
          identity: { runId: "child-a/session#0", cell: "cell", frame: 0, ordinal: 0, declaration: "read", layers: [] }, input: { path: "README.md" } }
      }), runId: "run-1" },
      moduleFact(4, settled, { callId, flowName: "read", outcome: "success", value: { startLine: 1, endLine: 4 } })]
    expect(moduleMeaning(rows).lines.map(line => [line.subject, line.result])).toEqual([["README.md", "4 lines"]])
  })
})

/*
 * The journal a repinned production host actually wrote.
 *
 * Its coding hosts were repinned to `c9935981` on 2026-09-20 and the module
 * subject recorded twenty-four `flows.harness.step-fact.v1` facts for the two
 * `repository/research` steps of `repository-jobs/issues`. The run also
 * finished in under seven seconds, which is what the live claim beside these
 * rows had been resting on. The excerpt is anonymised; identities are not.
 */
describe("the module journal the repinned production host recorded", () => {
  const recorded = JSON.parse(readFileSync(
    resolve(repositoryRoot(), "apps/app/e2e/real/run-inspection/module-journal.fixture.json"), "utf8"
  )) as { readonly rows: ReadonlyArray<JournalRow> }

  test("the recorded step facts fold into one frame per invocation and claim nothing else", () => {
    const meaning = moduleMeaning(recorded.rows)
    expect(moduleRows(recorded.rows)).toHaveLength(recorded.rows.length)
    expect(meaning.frames).toHaveLength(2)
    // Neither research step called a tool, so the strip says the phase it can
    // prove and the card draws no line. Absence is absence.
    expect(meaning.bands).toEqual([{ phase: "unrecorded", seq: 72 }, { phase: "unrecorded", seq: 248 }])
    expect(meaning.lines).toEqual([])
    expect(meaning.pins).toEqual([{ seq: 439, label: "completed" }])
    expect(meaning.status).toBe("Finished.")
    expect(meaning.goals).toEqual([])
  })

  test("each frame is placed by the invocation that recorded it", () => {
    const meaning = moduleMeaning(recorded.rows)
    expect(meaning.frames.every(frame => frame.node.startsWith("step:"))).toBe(true)
    // Both invocations opened their own frame one; only the recorded scope tells them apart.
    expect(meaning.frames.map(frame => frame.node.endsWith("/frame-1"))).toEqual([true, true])
    expect(new Set(meaning.frames.map(frame => frame.node)).size).toBe(2)
    expect(moduleMeaning(recorded.rows, 100).frames).toHaveLength(1)
    expect(moduleMeaning(recorded.rows, 250).status).toBe("Thinking")
  })

  test("a run that finished before the first comparable boundary exercised no live claim", () => {
    expect(liveInspectionFact([], { status: "completed", seq: 439 })).toMatchObject({
      _tag: "LiveInspectionUnexercised", reason: "run-terminal-before-first-sample",
      samples: 0, firstSampleStatus: "completed", sampledAtSeq: 439
    })
  })

  test("one live boundary is not the growth the live claim is about", () => {
    expect(liveInspectionFact([{ status: "running", seq: 120 }], { status: "completed", seq: 439 })).toMatchObject({
      _tag: "LiveInspectionUnexercised", reason: "run-terminal-before-second-sample",
      samples: 1, firstSampleStatus: "running", sampledAtSeq: 120
    })
  })

  test("two live boundaries are the claim, and only then is it made", () => {
    expect(liveInspectionFact([{ status: "running", seq: 120 }, { status: "running", seq: 240 }])).toEqual({
      _tag: "LiveInspectionObserved", samples: 2, firstSampleStatus: "running", sampledAtSeq: 120
    })
  })
})

describe("the deployed header source comparison", () => {
  test.each(["", "HEAD", "main", "eb20827c", `${"a".repeat(39)}g`, "../../etc/passwd"])(
    "%p is not a revision this comparison will read", revision => {
      expect(() => deployedHeaderSource(revision)).toThrow("Invalid deployed frontend revision")
    })

  test("the demand inventory names every payload and marks the ones nothing recorded", () => {
    const inventory = demandInventory([
      event(1, settled, { flowName: "write", callId: "a", outcome: "failure", message: "read only" }),
      event(2, settled, { flowName: "read", callId: "b", outcome: "success", value: {} }),
      event(3, "control.agent.read-only-demand-issued"),
      event(4, "control.agent.steering-drained", { messages: [{ role: "user", text: "continue" }] })
    ])
    expect(inventory).toEqual([
      { name: "call-rejection", observed: 1, _tag: "Exercised" },
      { name: "read-only-demand", observed: 1, _tag: "Exercised" },
      { name: "narrow-only-demand", observed: 0, _tag: "Unexercised" },
      { name: "narrowed-demand", observed: 0, _tag: "Unexercised" },
      { name: "steering-delivery", observed: 1, _tag: "Exercised" },
      { name: "sufficiency-observed", observed: 0, _tag: "Unexercised" },
      { name: "permission-required", observed: 0, _tag: "Unexercised" }
    ])
    expect(demandInventory([event(1, "constructor")]).every(entry => entry._tag === "Unexercised")).toBe(true)
  })

  test("every declared header source exists under the resolved repository root", () => {
    expect(HEADER_SOURCES.length).toBeGreaterThan(0)
    for (const path of HEADER_SOURCES) expect(existsSync(resolve(repositoryRoot(), path))).toBe(true)
  })
})

describe("the measured post-reload boot summary", () => {
  const boot = (ms: number, kind: "navigate" | "reload" = "reload") => ({ at: new Date(ms).toISOString(), kind, ms })

  test("a run that booted nothing reports no boot time rather than a zero", () => {
    expect(reloadBootFact([])).toEqual({ _tag: "ReloadBootUnmeasured", samples: [], counts: { navigate: 0, reload: 0 } })
  })

  test("the extremes and the middle come from the values, not the order they were measured in", () => {
    const samples = [boot(9_000), boot(1_200), boot(3_400)]
    expect(reloadBootFact(samples)).toMatchObject({ _tag: "ReloadBootMeasured", minMs: 1_200, medianMs: 3_400, maxMs: 9_000 })
    // The reader hands out the live list, so summarising it must not reorder it.
    expect(samples.map(({ ms }) => ms)).toEqual([9_000, 1_200, 3_400])
  })

  test("an even count takes the middle pair's mean, and one boot is its own summary", () => {
    expect(reloadBootFact([boot(1_000), boot(2_000), boot(2_001), boot(9_000)])).toMatchObject({ minMs: 1_000, medianMs: 2_001, maxMs: 9_000 })
    expect(reloadBootFact([boot(4_100)])).toMatchObject({ minMs: 4_100, medianMs: 4_100, maxMs: 4_100 })
  })

  test("both kinds share the one budget's distribution, and the counts say what the mix was", () => {
    const fact = reloadBootFact([boot(12_000, "navigate"), boot(24_000), boot(18_000, "navigate")])
    // One bound covers a navigation and a reload alike, so one distribution is what it is chosen from.
    expect(fact).toMatchObject({ _tag: "ReloadBootMeasured", minMs: 12_000, medianMs: 18_000, maxMs: 24_000 })
    expect(fact.counts).toEqual({ navigate: 2, reload: 1 })
    expect(fact.samples.map(({ kind }) => kind)).toEqual(["navigate", "reload", "navigate"])
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

  test("an unidentified settlement cannot settle an identified pending write", () => {
    const rows = [...journal.slice(0, 5), event(6, settled, { flowName: "write", outcome: "success", value: { bytesWritten: 7 } })]
    expect(journalMeaning(rows).lines[1]?.verb).toBe("writing")
    expect(journalMeaning(rows).pins).toEqual([])
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
    expect(requireLaterPhase(journalMeaning(journal))).toEqual({ phase: "implementing", seq: 4 })
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
    expect(() => journalMeaning([event(1, "control.engine.event", { eventType: "flows.engine.run-decision", payload: {
      state: { flowName: "coding/PrepareWithWiki", result: { _tag: "Complete", value: { changes: [{}] } } }
    } })])).toThrow(TimelineEvidenceError)
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

  test("a nested path is named the way a person names the file", () => {
    const rows = [event(1, opened), event(2, started, { flowName: "read", callId: "a", input: { path: "src/deep/a.txt" } })]
    expect(journalMeaning(rows).status).toBe("Reading a.txt")
    expect(journalMeaning(rows).lines[0]).toMatchObject({ subject: "a.txt" })
  })

  test("a failed call is said in the verb its declaration chose", () => {
    const rows = [event(1, opened), event(2, started, { flowName: "read", callId: "a", input: { path: "a.txt" } }),
      event(3, settled, { flowName: "read", callId: "a", outcome: "failure", message: "no such file" })]
    expect(journalMeaning(rows).status).toBe("Failed to read a.txt")
    expect(journalMeaning(rows).lines[0]).toMatchObject({ verb: "failed to read", result: "no such file" })
  })

  test("a parsed test result reports what it measured, not its exit code", () => {
    const run = (value: Record<string, unknown>) => journalMeaning([event(1, opened),
      event(2, started, { flowName: "test", callId: "a", input: { selection: ["unit"] } }),
      event(3, settled, { flowName: "test", callId: "a", outcome: "success", value })]).lines[0]?.result
    expect(run({ parsed: true, passed: 3, failed: ["one"], exitCode: 1 })).toBe("3 passed · 1 failed")
    expect(run({ parsed: true, passed: 3, failed: [], exitCode: 2 })).toBe("3 passed · exit 2")
    // An unparsed probe counts nothing and says only what it exited with.
    expect(run({ parsed: true, passed: 3, failed: [], exitCode: 1, invalidProbe: "unreadable" })).toBe("exit 1")
  })

  test("a truncated output is a digest, not a measurement", () => {
    const meaning = journalMeaning([event(1, opened), event(2, started, { flowName: "read", callId: "a", input: { path: "a.txt" } }),
      event(3, settled, { flowName: "read", callId: "a", outcome: "success", value: { truncated: true, digest: "d", startLine: 1, endLine: 400 } })])
    expect(meaning.lines[0]?.result).toBe("")
  })
})

/*
 * `@smthrs/harness` `Cell.displayDescriptor` writes a flow's declared activity
 * and presentation beside every call it records, and the card reads that in
 * preference to anything it knows by name. A module run reaches flows this
 * suite has never seen, so an oracle that read only the names would either
 * refuse them or predict a row the card never printed.
 */
describe("a recorded call descriptor", () => {
  const descriptor = (name: string, activity: string | undefined, verb: Record<string, string>, subject: string, result: string) => ({
    name, ...(activity === undefined ? {} : { activity }), presentation: { verb, subject, result }
  })
  const inspect = descriptor("search_docs", "reads",
    { pending: "inspecting", success: "inspected", failure: "failed to inspect" }, "pattern", "matches")

  test("names a flow the compatibility table has never heard of", () => {
    const rows = [event(1, opened),
      event(2, started, { flowName: "search_docs", callId: "a", descriptor: inspect, input: { pattern: "marker" } }),
      event(3, settled, { flowName: "search_docs", callId: "a", outcome: "success", value: { matches: [1, 2] } })]
    expect(journalMeaning(rows, 2).status).toBe("Inspecting marker")
    expect(journalMeaning(rows).status).toBe("Inspected marker")
    expect(journalMeaning(rows).lines[0]).toMatchObject({ verb: "inspected", subject: "marker", result: "2 matches" })
    expect(journalMeaning(rows).bands).toEqual([{ seq: 1, phase: "researching" }])
  })

  test("outranks the compatibility table for a name it also knows", () => {
    const writes = descriptor("read", "writes", { pending: "recording", success: "recorded", failure: "failed to record" }, "path", "write")
    const rows = [event(1, opened),
      event(2, started, { flowName: "read", callId: "a", descriptor: writes, input: { path: "dir/one.txt" } }),
      event(3, settled, { flowName: "read", callId: "a", outcome: "success", value: { bytesWritten: 4 } })]
    expect(journalMeaning(rows).lines[0]).toMatchObject({ verb: "recorded", subject: "one.txt", result: "4 bytes" })
    expect(journalMeaning(rows).bands).toEqual([{ seq: 1, phase: "implementing" }])
    expect(journalMeaning(rows).pins).toEqual([{ seq: 3, label: "one.txt" }])
  })

  test("belonging to another flow is not this call's descriptor", () => {
    const rows = [event(1, opened),
      event(2, started, { flowName: "read", callId: "a", descriptor: { ...inspect, name: "search_docs" }, input: { path: "one.txt" } }),
      event(3, settled, { flowName: "read", callId: "a", outcome: "success", value: { startLine: 1, endLine: 2 } })]
    expect(journalMeaning(rows).lines[0]).toMatchObject({ verb: "read", subject: "one.txt", result: "2 lines" })
  })

  test("that declares only an activity leaves the call named rather than described", () => {
    const rows = [event(1, opened),
      event(2, started, { flowName: "search_docs", callId: "a", descriptor: { name: "search_docs", activity: "reads" }, input: { path: "dir/one.txt" } }),
      event(3, settled, { flowName: "search_docs", callId: "a", outcome: "success", value: { startLine: 1, endLine: 9 } })]
    expect(journalMeaning(rows, 2).status).toBe("Running search_docs one.txt")
    expect(journalMeaning(rows).lines[0]).toMatchObject({ verb: "search_docs", subject: "one.txt", result: "" })
    expect(journalMeaning(rows).bands).toEqual([{ seq: 1, phase: "researching" }])
  })

  test("with an unreadable presentation claims none of it", () => {
    const rows = [event(1, opened),
      event(2, started, { flowName: "search_docs", callId: "a", input: { pattern: "marker" },
        descriptor: { name: "search_docs", activity: "reads", presentation: { verb: { pending: "inspecting" }, subject: "pattern", result: "matches" } } })]
    expect(journalMeaning(rows).lines[0]).toMatchObject({ verb: "search_docs pending", subject: "marker" })
  })

  test("still fails closed when the record declares nothing at all", () => {
    expect(() => journalMeaning([event(1, opened), event(2, started, { flowName: "search_docs", input: {} })])).toThrow(TimelineEvidenceError)
  })

  test("reads a refusal as the denial it is, not the success it settled as", () => {
    const ask = descriptor("ask", "other", { pending: "asking", success: "asked", failure: "refused" }, "none", "none")
    const rows = [event(1, opened), event(2, started, { flowName: "ask", callId: "a", descriptor: ask, input: { prompt: "land it?" } }),
      event(3, settled, { flowName: "ask", callId: "a", outcome: "success", value: { approved: false } })]
    expect(journalMeaning(rows).lines[0]).toMatchObject({ verb: "refused", subject: "", result: "" })
    expect(journalMeaning(rows).bands).toEqual([{ seq: 1, phase: "blocked" }])
    expect(journalMeaning(rows).status).toBe("Asked")
  })
})
