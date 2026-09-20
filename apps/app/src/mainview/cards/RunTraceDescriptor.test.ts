/**
 * The card half of the producer-to-card proof.
 *
 * Every record below was produced by the real controller and projected by the
 * real `AgentSession.trace`: `packages/smithers/agent/test/CellFlows.test.ts`
 * runs two agents over real catalogs and pins the trail as this fixture, so
 * nothing here injects the metadata the producer is supposed to emit. Change
 * the producer and that test fails before this one is ever shown the change.
 *
 * What the four cases are for: a card must read a standard flow, a custom flow
 * that declares its own words, a custom flow that takes a standard name and
 * means something else, and a flow that declares nothing — and it must tell one
 * story about each, in the band, the row and the header at once.
 */
import { describe, expect, test } from "bun:test"
import trail from "../../../../../packages/smithers/agent/test/fixtures/call-descriptor-trail.json" with { type: "json" }
import { traceFromJournal, type JournalRecord } from "./RunTrace"
import { traceStatus } from "./RunTraceStatus"

const model = (records: ReadonlyArray<unknown>) =>
  traceFromJournal({ runId: "run-1", flowId: "coding", status: "running" }, records as ReadonlyArray<JournalRecord>)

const started = (records: ReadonlyArray<unknown>, flowName: string) =>
  (records as ReadonlyArray<JournalRecord>).find((record) =>
    record.kind === "control.agent.cell-call-started" &&
    (record.payload as { flowName?: string }).flowName === flowName
  )!

const settled = (records: ReadonlyArray<unknown>, flowName: string) =>
  (records as ReadonlyArray<JournalRecord>).find((record) =>
    record.kind === "control.agent.cell-call-settled" &&
    (record.payload as { flowName?: string }).flowName === flowName
  )!

describe("a produced call reads the same way in the band, the row and the header", () => {
  test("a standard flow's own declaration is what the card reads, not its name", () => {
    const records = trail.declared
    // The producer wrote the declaration; the card did not supply one.
    expect((started(records, "read").payload as { descriptor: unknown }).descriptor).toMatchObject({
      name: "read",
      activity: "reads",
      presentation: { verb: { success: "read" }, subject: "path", result: "read" }
    })
    const fold = model(records)
    expect(fold.bands.map((band) => band.phase)).toEqual(["researching"])
    expect(fold.lines).toEqual([
      { spanId: "frame-1", frame: 1, verb: "read", subject: "alpha.md", result: "2 lines", failed: false, wrote: false }
    ])
    expect(traceStatus(fold, settled(records, "read").sequence).activity).toBe("Read alpha.md")
  })

  test("a standard flow reads the same with its declaration and without it", () => {
    // The compatibility table is a guess about journals recorded before a
    // declaration could say anything. It has to agree with what the standard
    // flows now declare, or the same run would read two ways across a rebuild.
    const records = trail.declared as ReadonlyArray<JournalRecord>
    const stripped = records.map((record) => {
      if (record.kind !== "control.agent.cell-call-started") return record
      const { descriptor: _dropped, ...payload } = record.payload as Record<string, unknown>
      return { ...record, payload }
    })
    const declared = model(records)
    const legacy = model(stripped)
    expect(legacy.lines).toEqual(declared.lines)
    expect(legacy.bands.map((band) => band.phase)).toEqual(["researching"])
    expect(traceStatus(legacy, settled(records, "read").sequence).activity).toBe("Read alpha.md")
  })

  test("a custom flow's declared words reach the row and the header", () => {
    const records = trail.declared
    const fold = model(records)
    expect(traceStatus(fold, started(records, "inspect").sequence).activity).toBe("Inspecting alpha.md")
    expect(traceStatus(fold, settled(records, "inspect").sequence).activity).toBe("Inspected alpha.md")
  })

  test("a flow named write that declares reads is researching, inspected and inspected", () => {
    const records = trail.shadowed
    const fold = model(records)
    // The reviewer's reproduction: one story, not three. A researching band,
    // an "inspected" row, and a header that agrees with both.
    expect(fold.bands.map((band) => band.phase)).toEqual(["researching"])
    expect(fold.lines).toEqual([
      { spanId: "frame-1", frame: 1, verb: "inspected", subject: "alpha.md", result: "", failed: false, wrote: false }
    ])
    expect(traceStatus(fold, settled(records, "write").sequence).activity).toBe("Inspected alpha.md")
    // It changed nothing, so it minted no write pin.
    expect(fold.milestones.filter((milestone) => milestone.tone === "brand")).toEqual([])
  })

  test("the native producer's fact says the same thing as the trail", () => {
    // The native envelope reaches the card through `uniqueCallEvents`, which
    // the fold and the header both call: one record kind in, one story out.
    const records = [
      { runId: "run-1", sequence: 0, kind: "control.agent.turn-opened", occurredAt: 0, payload: { at: 0 } },
      ...trail.native
    ]
    const fold = model(records)
    expect(fold.bands.map((band) => band.phase)).toEqual(["researching"])
    expect(fold.lines.map((line) => `${line.verb} ${line.subject}`)).toEqual(["inspecting alpha.md"])
    expect(traceStatus(fold).activity).toBe("Running mystery alpha.md")
    expect(traceStatus(fold, 1).activity).toBe("Inspecting alpha.md")
  })

  test("a flow that declared nothing is named, never described", () => {
    const records = trail.shadowed
    expect((started(records, "mystery").payload as { descriptor?: unknown }).descriptor).toBeUndefined()
    const fold = model(records)
    expect(traceStatus(fold, started(records, "mystery").sequence).activity).toBe("Running mystery alpha.md")
    expect(traceStatus(fold, settled(records, "mystery").sequence).activity).toBe("Finished mystery alpha.md")
    // Unknown stays unknown: no activity, so the frame's phase came from the
    // call beside it rather than from a guess about this one.
    expect(fold.lines.map((line) => line.verb)).toEqual(["inspected"])
  })
})
