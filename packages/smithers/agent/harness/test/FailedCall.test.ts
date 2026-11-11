/**
 * A completion written before the failure it follows existed.
 *
 * A cell is authored blind: the whole program, `ctx.done` included, is written
 * before any call in it settles, and a failed call resolves `{ ok: false }`
 * instead of throwing. A cell that requests work and completes in one program
 * therefore claims the request succeeded whatever the request did. A TUI
 * coordinator did exactly this: `agent.delegate` failed with "Three workers
 * are active", the same cell's `ctx.done("Delegated the estimation system
 * design to codex sol.")` ran anyway, and the user was told work was running
 * that never started.
 */
import { ModelRequest } from "@smthrs/model"
import { Option } from "effect"
import { describe, expect, it } from "vitest"
import * as CellTurn from "../src/CellTurn.ts"
import * as FailedCall from "../src/FailedCall.ts"
import { descriptor, emits, of, pattern, run, window } from "./fixtures/cellTurn.ts"
import type * as ScriptedEngine from "./fixtures/scriptedEngine.ts"

const delegate = descriptor("agent.delegate", { tier: "irreversible" })
const read = descriptor("read")

const seatsFull: ScriptedEngine.CallStep = {
  _tag: "Failure",
  message: "Flow agent.delegate failed: Three workers are active; wait for a completion"
}
const accepted: ScriptedEngine.CallStep = { _tag: "Success", value: { id: "design", status: "requested" } }

/** Requests work and completes in the same cell, the way the coordinator is taught to. */
const requestAndClaim = (claim: string) =>
  `await ctx.call("agent.delegate", { id: "design", title: "Design", prompt: "design it" })
   ctx.done(${JSON.stringify(claim)})`

const requesting = (
  cells: ReadonlyArray<string>,
  calls: ReadonlyArray<ScriptedEngine.CallStep>,
  overrides: { readonly maxFrames?: number } = {}
) =>
  run({
    state: CellTurn.make({
      session: "session-1",
      seat: "cerebras:test-model",
      modelParams: ModelRequest.GenerationParams.make(),
      layers: ["layer-a"],
      capabilityEnvelope: ["fs:read:**"].map(pattern),
      placement: Option.none(),
      contextWindow: window,
      maxFrames: overrides.maxFrames ?? cells.length,
      repeatCap: 0,
      // The coordinator's own arming: every other completion demand is off.
      unmovedCap: 0,
      narrowingCap: 0,
      unresolvedCap: 0,
      claimCap: 0
    }),
    flows: [delegate, read],
    script: cells.map(emits),
    calls
  })

const answer = (events: Awaited<ReturnType<typeof run>>["events"]) => of(events, "resolved")[0]?.message.content

describe("CellTurn completion over a failed call", () => {
  it("hands back a completion its own cell wrote before the call it follows failed", async () => {
    const { events, model } = await requesting(
      [
        requestAndClaim("Delegated the design."),
        `ctx.done("Not delegated: three workers are active.")`
      ],
      [seatsFull]
    )

    expect(of(events, "failed-call-demanded")).toEqual([
      expect.objectContaining({
        failures: [{
          flow: "agent.delegate",
          message: "Flow agent.delegate failed: Three workers are active; wait for a completion"
        }],
        nextFrame: 1
      })
    ])
    // The next frame reads the failure it never saw.
    const handedBack = JSON.stringify(model.recorder.requests[1]?.messages)
    expect(handedBack).toContain(FailedCall.heading)
    expect(handedBack).toContain("Three workers are active")
    expect(answer(events)).toEqual([
      expect.objectContaining({ text: "Not delegated: three workers are active." })
    ])
  })

  it("never lets the blind claim stand as the answer, even with no frame to answer in", async () => {
    const { events } = await requesting([requestAndClaim("Delegated the design.")], [seatsFull])

    // No frame left to hand back: the failure is stated in the answer itself,
    // because the claim was written before the failure existed.
    const text = JSON.stringify(answer(events))
    expect(text).toContain("agent.delegate failed")
    expect(text).toContain("Three workers are active")
    expect(of(events, "failed-call-demanded")).toEqual([])
  })

  it("asks once: a second blind claim over a fresh failure keeps its answer and states the failure", async () => {
    const { events } = await requesting(
      [requestAndClaim("Delegated the design."), requestAndClaim("Delegated the design again."), `ctx.done("x")`],
      [seatsFull, seatsFull]
    )

    expect(of(events, "failed-call-demanded")).toHaveLength(1)
    const text = JSON.stringify(answer(events))
    expect(text).toContain("Delegated the design again.")
    expect(text).toContain("Three workers are active")
  })

  it("says nothing when the call it follows succeeded", async () => {
    const { events } = await requesting([requestAndClaim("Requested the design.")], [accepted])

    expect(of(events, "failed-call-demanded")).toEqual([])
    expect(answer(events)).toEqual([expect.objectContaining({ text: "Requested the design." })])
  })

  it("says nothing when the completion already carries the failure the cell branched on", async () => {
    const { events } = await requesting(
      [
        `const r = await ctx.call("agent.delegate", { id: "design", title: "Design", prompt: "design it" })
         ctx.done(r.ok === false ? "Not delegated: " + r.error.message : "Requested the design.")`
      ],
      [seatsFull]
    )

    expect(of(events, "failed-call-demanded")).toEqual([])
    expect(JSON.stringify(answer(events))).toContain("Not delegated: ")
    expect(JSON.stringify(answer(events))).not.toContain(FailedCall.stated)
  })

  it("states a failure whose own envelope the cell never reads, whatever else in the cell says ok or error", async () => {
    const delegating = `await ctx.call("agent.delegate", { id: "design", title: "Design", prompt: "design it" })`
    const readOk: ScriptedEngine.CallStep = { _tag: "Success", value: { text: "a" } }
    const cells: ReadonlyArray<readonly [string, ReadonlyArray<ScriptedEngine.CallStep>]> = [
      // Another call's envelope is branched on; the failed one is not.
      [
        `const f = await ctx.call("read", { path: "a" })
         if (f.ok) console.log(f.value)
         ${delegating}
         ctx.done("Delegated the design.")`,
        [readOk, seatsFull]
      ],
      [`${delegating}\nctx.done("Delegated the design. ok")`, [seatsFull]],
      [`${delegating}\n// r.ok\nctx.done("Delegated the design.")`, [seatsFull]],
      [`const log = console\n${delegating}\nlog.error("x")\nctx.done("Delegated the design.")`, [seatsFull]]
    ]
    for (const [cell, calls] of cells) {
      const { events } = await requesting([cell], calls)
      const text = JSON.stringify(answer(events))
      expect(text, cell).toContain(FailedCall.stated)
      expect(text, cell).toContain("Three workers are active")
    }
  })

  it("says nothing about a failure an earlier frame already showed the model", async () => {
    const { events } = await requesting(
      [
        `await ctx.call("agent.delegate", { id: "design", title: "Design", prompt: "design it" })
         console.log("asked")`,
        `ctx.done("Not delegated.")`
      ],
      [seatsFull]
    )

    expect(of(events, "failed-call-demanded")).toEqual([])
    expect(answer(events)).toEqual([expect.objectContaining({ text: "Not delegated." })])
  })
})

describe("FailedCall", () => {
  const failed = { flow: "agent.delegate", ok: false, message: "Flow agent.delegate failed: seats full" }

  it("reads a cell as written for a failure only when it reads an envelope's ok or error", () => {
    for (const source of ["r.ok", "r?.error.message", "r . ok", `r["ok"]`, "const { ok, error } = r"]) {
      expect(FailedCall.inspects(source)).toBe(true)
    }
    for (const source of [`console.error("x")`, "await ctx.call('a', {})", "const okay = 1", "if (a == b) {}"]) {
      expect(FailedCall.inspects(source)).toBe(false)
    }
  })

  it("reads only the envelope of a call to the named flow, through the program's own bindings", () => {
    const bound = `const r = await ctx.call("a", {})`
    const reading = [
      `${bound}\nif (!r.ok) {}`,
      `(await ctx.call("a", {})).ok`,
      `${bound}\nconst all = [r]\nall[0].error`,
      `const { ok } = await ctx.call("a", {})`,
      `${bound}\nlet ok\n;({ ok } = r)`,
      `const all = [await ctx.call("a", {})]\nfor (const { error } of all) {}`,
      `${bound}\nr["ok"]`,
      `${bound}\n;(r as { ok: boolean }).ok`,
      `${bound}\nr!.error.message`,
      // A flow computed at run time may be the one that failed.
      `const r = await ctx.call(name, {})\nr.ok`
    ]
    for (const source of reading) expect(FailedCall.inspects(source, "a"), source).toBe(true)
    const blind = [
      `const f = await ctx.call("b", {})\nf.ok\nawait ctx.call("a", {})`,
      `await ctx.call("a", {})\nctx.done("r.ok")`,
      `await ctx.call("a", {})\n// r.ok`,
      `await ctx.call("a", {})\nconst log = console\nlog.error("x")`,
      `const { value, ...rest } = await ctx.call("a", {})\nrest[0]`,
      `const f = await ctx.call("b", {})\nconst { ok } = f\nawait ctx.call("a", {})`,
      `let x\nx = await ctx.call("a", {})\nfor (const y of [x]) {}`,
      // A call made outside the cell is never another call's envelope.
      `const f = await ctx.call("b", {})\nf.ok`,
      "r.ok("
    ]
    for (const source of blind) expect(FailedCall.inspects(source, "a"), source).toBe(false)
  })

  it("names every failed call a blind claim was written before, and none that succeeded", () => {
    const ok = { flow: "ui.publish", ok: true, message: undefined }
    expect(FailedCall.find([ok, failed], "Delegated.", "")).toEqual([
      { flow: "agent.delegate", message: "Flow agent.delegate failed: seats full" }
    ])
    expect(FailedCall.find([failed], "Delegated.", "if (r.ok === false) {}")).toEqual([])
    expect(FailedCall.find([failed], "Not delegated: seats full", "")).toEqual([])
    // A branch on one call's envelope spares only that call.
    const other = { flow: "tab.read", ok: false, message: undefined }
    expect(
      FailedCall.find([other, failed], "Delegated.", `const r = await ctx.call("agent.delegate", {})\nif (r.ok) {}`)
    ).toEqual([{ flow: "tab.read", message: "" }])
  })

  it("reports a failure the flow gave no reason for, whatever the claim says", () => {
    const silent = [{ flow: "tab.read", ok: false, message: undefined }]
    const [found] = FailedCall.find(silent, "Read it.", "")
    expect(found).toEqual({ flow: "tab.read", message: "" })
    expect(FailedCall.state("Read it.", [found!])).toBe(`Read it.\n\n${FailedCall.stated}\n- tab.read failed`)
  })

  it("leaves a claim with nothing to state untouched, and states failures under an empty claim alone", () => {
    expect(FailedCall.state("Requested.", [])).toBe("Requested.")
    expect(FailedCall.state("  ", [failed as FailedCall.Failure])).toBe(
      `${FailedCall.stated}\n- agent.delegate failed: seats full`
    )
  })
})
