/**
 * The addressable-context cases: PROGRAM changes 1, 5 and 8.
 *
 * Everything here answers one measured failure class of the r90 SWE-bench wave:
 * a run that already paid for bytes and could not get them back. What remains
 * of it is the boundary parse that answers an unparseable cell inside its own
 * frame instead of ending it, and the observation a throw carries. The ledger's
 * recall-by-ordinal half and the state manifest went with the surface that had
 * nowhere else to keep a result.
 */
import { Capability } from "@smthrs/kernel"
import { ModelRequest } from "@smthrs/model"
import { Option } from "effect"
import { describe, expect, it } from "vitest"
import * as AgentEvent from "../src/AgentEvent.ts"
import * as Cell from "../src/Cell.ts"
import * as CellTurn from "../src/CellTurn.ts"
import * as CellValidation from "../src/CellValidation.ts"
import {
  descriptor,
  emits,
  of,
  type Options as RunOptions,
  prose,
  run as runCellTurn,
  window
} from "./fixtures/cellTurn.ts"
import * as ScriptedModel from "./fixtures/scriptedModel.ts"

const lister = descriptor("fs/list", { capabilities: ["fs:read:**"] })

const state = (
  overrides: { readonly maxFrames?: number; readonly revalidations?: number } = {}
): CellTurn.State =>
  CellTurn.make({
    session: "session-1",
    seat: "anthropic:test-model",
    modelParams: ModelRequest.GenerationParams.make(),
    layers: ["layer-a"],
    capabilityEnvelope: [new Capability.CapabilityPattern({ action: "fs:read", resource: "**" })],
    placement: Option.none(),
    contextWindow: window,
    maxFrames: overrides.maxFrames ?? 4,
    ...(overrides.revalidations === undefined ? {} : { revalidations: overrides.revalidations })
  })

/** The shared driver, starting from this suite's {@link state} unless a case supplies one. */
const run = (options: Omit<RunOptions, "state" | "flows"> & { readonly state?: CellTurn.State | undefined }) =>
  runCellTurn({ ...options, flows: [lister], state: options.state ?? state() })

/** The trailing frame block: the one user message appended after the transcript. */
const frameBlock = (model: ScriptedModel.Fixture, index: number): string =>
  model.recorder.requests[index]?.messages.at(-1)?.content
    .flatMap((part) => part.type === "text" ? [part.text] : []).join("\n") ?? ""

describe("CellValidation", () => {
  it("reports the offending line of a syntax error, and only when it has one to quote", () => {
    const quoted = CellValidation.validate(Cell.source(`const a = 1\nconst b = )\n`)).rejected
    expect(quoted?.message).toBe("The cell did not compile — line 2, column 11: Unexpected token\n  const b = )")
    // A compiler that points past the last token names a blank line, and a
    // quoted blank line reads like a truncation, so it is left out.
    const blank = CellValidation.validate(Cell.source(`const a = 1\nif (a) {\n  return null\n`)).rejected
    expect(blank?.message).toBe("The cell did not compile — line 4, column 1: Unexpected token")
  })

  it("refuses module syntax and non-erasable TypeScript before anything runs", () => {
    expect(CellValidation.validate(Cell.source(`import "node:fs"`)).rejected?.code)
      .toBe("imports_forbidden")
    expect(CellValidation.validate(Cell.source(`enum E { a }`, "typescript")).rejected?.code)
      .toBe("compile_failed")
  })
})

describe("CellTurn in-frame revalidation", () => {
  it("answers a cell that does not parse inside its own frame instead of ending it", async () => {
    const { events, model } = await run({
      script: [
        emits(`const a = 1\nif (a) {\n  ctx.done("unbalanced")`),
        emits(`ctx.done("recovered")`)
      ]
    })

    // One frame, two model calls, and the run's own answer at the end of it.
    expect(of(events, "turn-opened")).toHaveLength(1)
    expect(model.recorder.requests).toHaveLength(2)
    const rejected = of(events, "cell-rejected-in-frame")
    expect(rejected.map((event) => [event.attempt, event.code])).toEqual([[1, "compile_failed"]])
    expect(rejected[0]?.message).toContain("line 3")
    expect(of(events, "cell-settled").map((event) => event.outcome._tag)).toEqual(["settled"])
    expect(resolvedText(events)).toBe("recovered")
  })

  it("re-asks against the same prefix and names why the frame is not lost", async () => {
    const { model } = await run({
      script: [
        prose("no cell at all"),
        emits(`ctx.done("recovered")`)
      ]
    })

    const first = model.recorder.requests[0]?.messages ?? []
    const second = model.recorder.requests[1]?.messages ?? []
    // Everything the first request carried is still the prefix of the second,
    // which is what makes the re-ask cost cached input plus its own output.
    expect(JSON.stringify(second.slice(0, first.length - 1)))
      .toBe(JSON.stringify(first.slice(0, first.length - 1)))
    expect(JSON.stringify(second)).toContain("This reply is not a frame.")
  })

  it("ends the frame once the cap on in-frame answers is spent", async () => {
    const { events, model } = await run({
      script: [
        prose("no cell"),
        prose("still no cell"),
        emits(`ctx.done("recovered")`)
      ]
    })

    expect(of(events, "cell-rejected-in-frame")).toHaveLength(1)
    expect(of(events, "cell-settled").map((event) => event.outcome._tag)).toEqual(["rejected", "settled"])
    expect(of(events, "turn-opened")).toHaveLength(2)
    expect(model.recorder.requests).toHaveLength(3)
  })

  it("journals what the run was armed with", async () => {
    const { events } = await run({
      script: [emits(`ctx.done("done")`)]
    })

    expect(of(events, "discipline-armed")[0]?.revalidations).toBe(CellTurn.defaultRevalidations)
  })
})

describe("CellTurn honest observations", () => {
  it("states the elision when a reply is too long to echo back whole", async () => {
    const filler = `const note = "${"z".repeat(12_000)}"\n`
    const { model } = await run({
      script: [
        emits(`${filler}throw new Error("boom")`),
        emits(`ctx.done("done")`)
      ]
    })

    const conversation = JSON.stringify(model.recorder.requests[1]?.messages ?? [])
    expect(conversation).toContain("bytes elided from the middle.")
    expect(conversation).toContain("the reply is not re-read in full")
    expect(conversation).not.toContain("z".repeat(9_000))
  })

  it("measures the echo ceiling in the bytes it is stated in and not in code units", async () => {
    // 3,000 astral characters: 6,000 UTF-16 code units, under the 8,192 echo
    // ceiling, and 12,000 UTF-8 bytes, over it. Measured in code units this
    // reply was echoed back whole and the run paid input price for half again
    // the ceiling it declared.
    const filler = `const note = "${"\u{1F600}".repeat(3_000)}"\n`
    expect(filler.length).toBeLessThan(8_192)
    expect(new TextEncoder().encode(filler).byteLength).toBeGreaterThan(8_192)
    const { model } = await run({
      script: [
        emits(`${filler}throw new Error("boom")`),
        emits(`ctx.done("done")`)
      ]
    })

    const conversation = JSON.stringify(model.recorder.requests[1]?.messages ?? [])
    expect(conversation).toContain("bytes elided from the middle.")
    expect(conversation).toContain("the reply is not re-read in full")
  })

  it("names the realm's bindings when a cell threw reading a path that is not there", async () => {
    const { model } = await run({
      state: state({ maxFrames: 3 }),
      script: [
        emits(`const probe = { tests: null }`),
        emits(`ctx.done(probe.tests.verification)`),
        emits(`ctx.done("done")`)
      ]
    })

    const observations = JSON.stringify(model.recorder.requests[2]?.messages ?? [])
    expect(observations).toContain("If `verification` was meant to come from a name an earlier cell bound")
    expect(observations).toContain("the names your realm holds: probe")
  })

  it("says so plainly when a cell threw such a path and the realm holds nothing", async () => {
    const { model } = await run({
      script: [
        emits(`ctx.flows.absent.name`),
        emits(`ctx.done("done")`)
      ]
    })

    expect(JSON.stringify(model.recorder.requests[1]?.messages ?? []))
      .toContain("your realm holds no names yet")
  })

  it("adds nothing to a throw that is not a property read", async () => {
    const { model } = await run({
      script: [
        emits(`throw new RangeError("off by one")`),
        emits(`ctx.done("done")`)
      ]
    })

    const observations = JSON.stringify(model.recorder.requests[1]?.messages ?? [])
    expect(observations).toContain("off by one")
    expect(observations).not.toContain("meant to come from a name an earlier cell bound")
  })
})

const resolvedText = (events: ReadonlyArray<AgentEvent.AgentEvent>): string => {
  const part = of(events, "resolved")[0]?.message.content[0]
  return part?.type === "text" ? part.text : ""
}
