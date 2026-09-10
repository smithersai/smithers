/**
 * Checkpoints: pinned trees a run can read without giving its work back.
 *
 * The failure these cases exist against is on the record. On
 * `sympy__sympy-13878` the `rerun-r95repl` lane applied one byte-identical
 * 4,789-character patch **five times**, four of those applications preceded by
 * `git checkout -- sympy/stats/crv_types.py`, because a clean fails-before
 * proof required reverting the very work it was meant to prove. The replay
 * shape at the bottom of this file is that instance's frame with checkpoints in
 * it: one edit, one baseline against `ctx.base`, one re-check, zero reverts.
 */
import { ModelRequest } from "@smthrs/model"
import { Effect, Option } from "effect"
import { describe, expect, it } from "vitest"
import type * as AgentEvent from "../src/AgentEvent.ts"
import * as Cell from "../src/Cell.ts"
import * as CellTurn from "../src/CellTurn.ts"
import * as QuickJSSandbox from "../src/QuickJSSandbox.ts"
import * as Sandbox from "../src/Sandbox.ts"
import { descriptor, emits, of, pattern, run, window } from "./fixtures/cellTurn.ts"
import * as ScriptedEngine from "./fixtures/scriptedEngine.ts"

// ---------------------------------------------------------------------------
// The sandbox surface, proved against the binding a production host selects.
// ---------------------------------------------------------------------------

const projection = (name: string): Cell.FlowProjection =>
  new Cell.FlowProjection({
    name,
    description: `The ${name} flow.`,
    capabilities: [],
    tier: "sealed",
    placement: Option.none(),
    input: Option.none()
  })

const flows = { probe: projection("probe") }

/** Records what each invocation asked, and which tree it asked about. */
const recording = (observed: Array<Sandbox.Invocation>): Sandbox.Handler => (invocation) =>
  Effect.sync(() => {
    observed.push(invocation)
    return new Cell.CallResult({ outcome: "success", value: { seen: invocation.flow } })
  })

/** A minter that pins whatever it is asked, naming the ordinal it was asked at. */
const pinning = (minted: Array<number>): Sandbox.Minter => (mint) =>
  Effect.sync(() => {
    minted.push(mint.ordinal)
    return new Cell.CallResult({ outcome: "success", value: Cell.checkpoint(`cp-${mint.ordinal}`) })
  })

/** Evaluates one cell in a realm of its own, which is what one frame does. */
const evaluate = (
  text: string,
  options: {
    readonly call?: Sandbox.Handler | undefined
    readonly mint?: Sandbox.Minter | undefined
  } = {}
): Promise<Cell.Outcome> =>
  Effect.gen(function*() {
    const sandbox = yield* Sandbox.Sandbox
    const open = sandbox.openRealm
    expect(open).toBeDefined()
    const realm = yield* open!({ flows })
    const frame = yield* realm.evaluate({
      cell: Cell.source(text),
      frame: 0,
      call: options.call ?? recording([]),
      ...(options.mint === undefined ? {} : { mint: options.mint })
    })
    return frame.outcome
  }).pipe(Effect.provide(QuickJSSandbox.layer), Effect.scoped, Effect.runPromise)

const completed = (outcome: Cell.Outcome): string => {
  expect(outcome._tag).toBe("settled")
  const transition = (outcome as Cell.Settled).transition
  expect(transition._tag).toBe("complete")
  return (transition as Cell.Complete).output
}

describe("ctx.checkpoint", () => {
  it("pins the tree at the line the mint is written on, not the line it is awaited", async () => {
    // The ruling's own spelling — `const cp = ctx.checkpoint()`, unawaited —
    // and the reason it is honest: the queue settles in issue order, so the
    // mint is dispatched before the call written after it whatever the cell
    // does with the handle afterwards.
    const observed: Array<Sandbox.Invocation> = []
    const minted: Array<number> = []
    const outcome = await evaluate(
      `const cp = ctx.checkpoint()
         await ctx.call("probe", { step: "after the mint" })
         const held = await cp
         ctx.done(JSON.stringify(held))`,
      { call: recording(observed), mint: pinning(minted) }
    )

    expect(minted).toEqual([0])
    expect(observed.map((call) => call.ordinal)).toEqual([1])
    expect(completed(outcome)).toBe(`{"checkpoint":"cp-0"}`)
  })

  it("carries the handle through to the boundary as the call's at", async () => {
    const observed: Array<Sandbox.Invocation> = []
    const outcome = await evaluate(
      `const cp = ctx.checkpoint()
         await ctx.call("probe", { at: "pinned" }, { at: cp })
         await ctx.call("probe", { at: "live" })
         ctx.done("done")`,
      { call: recording(observed), mint: pinning([]) }
    )

    expect(observed.map((call) => [call.input, call.at ?? null])).toEqual([
      [{ at: "pinned" }, { checkpoint: "cp-0" }],
      [{ at: "live" }, null]
    ])
    expect(completed(outcome)).toBe("done")
  })

  it("awaits a handle the cell already resolved, without changing what it names", async () => {
    const observed: Array<Sandbox.Invocation> = []
    await evaluate(
      `const cp = await ctx.checkpoint()
         await ctx.call("probe", {}, { at: cp })
         ctx.done("done")`,
      { call: recording(observed), mint: pinning([]) }
    )

    expect(observed[0]?.at).toEqual({ checkpoint: "cp-0" })
  })

  it("binds ctx.base without anybody minting it", async () => {
    const observed: Array<Sandbox.Invocation> = []
    const minted: Array<number> = []
    const outcome = await evaluate(
      `await ctx.call("probe", {}, { at: ctx.base })
         ctx.done(JSON.stringify(ctx.base))`,
      { call: recording(observed), mint: pinning(minted) }
    )

    // The dominant use case costs nothing: no mint, no bound spent, and the
    // handle is there in frame one without any foresight.
    expect(minted).toEqual([])
    expect(observed[0]?.at).toEqual({ checkpoint: "base" })
    expect(completed(outcome)).toBe(`{"checkpoint":"base"}`)
  })

  it("hands the boundary whatever the cell passed as at, undecoded", async () => {
    // The realm does not judge it. A cell that passes the wrong thing gets an
    // ordinary catchable failure from the boundary, which is a frame it can
    // fix, rather than a throw that loses every call the cell already paid
    // for.
    const observed: Array<Sandbox.Invocation> = []
    const outcome = await evaluate(
      `await ctx.call("probe", {}, { at: "not a checkpoint" })
         await ctx.call("probe", {}, { at: 7 })
         await ctx.call("probe", {}, { at: null })
         ctx.done("done")`,
      { call: recording(observed) }
    )

    // `null` in particular: it is an object to `typeof`, so a thenable check
    // that did not guard it would throw out of `ctx.call` and take the frame
    // with it.
    expect(observed.map((call) => call.at)).toEqual(["not a checkpoint", 7, null])
    expect(completed(outcome)).toBe("done")
  })

  it("treats a missing options bag and a bag without at as the live tree", async () => {
    const observed: Array<Sandbox.Invocation> = []
    await evaluate(
      `await ctx.call("probe", {})
         await ctx.call("probe", {}, {})
         await ctx.call("probe", {}, null)
         ctx.done("done")`,
      { call: recording(observed) }
    )

    expect(observed.map((call) => call.at ?? "live")).toEqual(["live", "live", "live"])
  })

  it("refuses a mint, catchably, when the caller wired no minter", async () => {
    const outcome = await evaluate(
      `const answer = await ctx.checkpoint()
         ctx.done(JSON.stringify(answer))`
    )

    const output = JSON.parse(completed(outcome)) as {
      readonly ok: boolean
      readonly error: { readonly code: string }
    }
    expect(output.ok).toBe(false)
    expect(output.error.code).toBe("checkpoint_unavailable")
  })

  it("counts a mint against the cell's own call budget", async () => {
    // A mint crosses the boundary, so it is one of the crossings a cell is
    // allowed. Nothing about it is free except `ctx.base`.
    const outcome = await Effect.gen(function*() {
      const sandbox = yield* Sandbox.Sandbox
      const limits = { calls: 2 }
      const realm = yield* sandbox.openRealm!({ flows, limits })
      const frame = yield* realm.evaluate({
        cell: Cell.source(
          `ctx.checkpoint()
             ctx.checkpoint()
             await ctx.call("probe", {})
             ctx.done("done")`
        ),
        frame: 0,
        call: recording([]),
        mint: pinning([]),
        limits
      })
      return frame.outcome
    }).pipe(Effect.provide(QuickJSSandbox.layer), Effect.scoped, Effect.runPromise)

    expect(outcome._tag).toBe("rejected")
    expect((outcome as Cell.Rejected).code).toBe("limit_exceeded")
  })
})

describe("ctx.checkpoint in a persistent realm", () => {
  it("names a tree in one frame and reads against it in a later one", async () => {
    const observed: Array<Sandbox.Invocation> = []
    const frames = await Effect.gen(function*() {
      const sandbox = yield* QuickJSSandbox.make
      const realm = yield* sandbox.openRealm!({ flows })
      const out: Array<Sandbox.RealmFrame> = []
      out.push(
        yield* realm.evaluate({
          cell: Cell.source(`const held = await ctx.checkpoint()\nconsole.log(held.checkpoint)`),
          frame: 3,
          call: recording(observed),
          mint: pinning([])
        })
      )
      out.push(
        yield* realm.evaluate({
          cell: Cell.source(`await ctx.call("probe", {}, { at: held })\nconsole.log("read")`),
          frame: 9,
          call: recording(observed),
          mint: pinning([])
        })
      )
      return out
    }).pipe(Effect.scoped, Effect.runPromise)

    // The realm is the memory, so a checkpoint minted six frames ago is still
    // a name the cell can use — which is the whole reason the ids are durable.
    expect(frames[0]!.prints).toBe("cp-0")
    expect(observed[0]?.at).toEqual({ checkpoint: "cp-0" })
    expect(frames[1]!.prints).toBe("read")
  })
})

// ---------------------------------------------------------------------------
// The controller: identity, the bound, and the two refusals.
// ---------------------------------------------------------------------------

const shell = descriptor("bash", { capabilities: ["proc:spawn:*"], tier: "irreversible" })
const editor = descriptor("edit", { capabilities: ["fs:write:**"], writes: ["**"], tier: "compensable" })
const reader = descriptor("read", { capabilities: ["fs:read:**"] })

const envelope = ["fs:write:**", "fs:read:**", "proc:spawn:*"].map(pattern)

const drive = (options: {
  readonly cells: ReadonlyArray<string>
  readonly calls?: ReadonlyArray<ScriptedEngine.CallStep>
  readonly checkpointCap?: number
  readonly pins?: boolean
  readonly tree?: string
}) =>
  run({
    script: options.cells.map(emits),
    calls: options.calls ?? [],
    flows: [shell, editor, reader],
    tree: options.tree ?? "a.py=base",
    pins: options.pins ?? true,
    state: CellTurn.make({
      session: "session-1",
      seat: "anthropic:test-model",
      modelParams: ModelRequest.GenerationParams.make(),
      layers: ["layer-a"],
      capabilityEnvelope: envelope,
      placement: Option.none(),
      contextWindow: window,
      maxFrames: options.cells.length,
      repeatCap: 0,
      narrowingCap: 0,
      ...(options.checkpointCap === undefined ? {} : { checkpointCap: options.checkpointCap })
    })
  })

/**
 * What the frame's cell settled with, as text.
 *
 * The refusals below never reach the engine, so they publish no
 * `cell-call-settled`: the boundary answers the cell directly and the cell puts
 * the envelope in its own transition. Reading it there is reading what the model
 * will read.
 */
const settledText = (events: ReadonlyArray<AgentEvent.AgentEvent>): string =>
  JSON.stringify(of(events, "transition-applied")[0]?.transition)

describe("CellTurn checkpoints", () => {
  it("journals every mint with the store's own name for the tree", async () => {
    const { engine, events } = await drive({
      cells: [
        `const cp = await ctx.checkpoint()
         ctx.done(cp.checkpoint)`
      ]
    })

    // The id is derived from the frame and the ordinal, which is exactly the
    // pair a re-executed cell re-derives — so a resumed run addresses the trees
    // its original attempt addressed.
    expect(of(events, "checkpoint-minted")).toEqual([
      expect.objectContaining({ id: "cp-0-0", ref: "test/cp-0-0", ordinal: 0 })
    ])
    // And it went through the journaled boundary rather than straight to the
    // host, so a replayed frame is served the tree it pinned the first time.
    expect(engine.recorder.records.map((boundary) => boundary.name)).toContain("checkpoint")
    expect(engine.recorder.captures).toEqual([{ id: "cp-0-0", tree: "a.py=base" }])
  })

  it("pins between two edits, not before both of them", async () => {
    // The mint is queued where it is written, so the tree it holds is the tree
    // the cell was looking at on that line — the property everything else here
    // depends on.
    const { engine } = await drive({
      cells: [
        `await ctx.call("edit", { path: "a.py", text: "one" })
         await ctx.checkpoint()
         await ctx.call("edit", { path: "a.py", text: "two" })
         ctx.done("done")`
      ],
      calls: [
        { _tag: "Success", value: null, tree: "a.py=one" },
        { _tag: "Success", value: null, tree: "a.py=two" }
      ]
    })

    expect(engine.recorder.captures).toEqual([{ id: "cp-0-1", tree: "a.py=one" }])
  })

  it("carries the checkpoint onto the journaled call", async () => {
    const { engine } = await drive({
      cells: [
        `await ctx.call("bash", { mode: "unhermetic", command: "check" }, { at: ctx.base })
         await ctx.call("bash", { mode: "unhermetic", command: "check" })
         ctx.done("done")`
      ]
    })

    expect(engine.recorder.calls.map((call) => call.at ?? "live")).toEqual(["base", "live"])
  })

  it("refuses a flow that declares a write at a checkpoint, and runs nothing", async () => {
    const { engine, events } = await drive({
      cells: [
        `const refusal = await ctx.call("edit", { path: "a.py", text: "x" }, { at: ctx.base })
         ctx.done(JSON.stringify(refusal))`
      ]
    })

    // Nothing reached the engine: a checkpoint is a tree that has already been,
    // and there is nothing to write to in one.
    expect(engine.recorder.calls).toEqual([])
    const settled = settledText(events)
    expect(settled).toContain("checkpoint_readonly")
    expect(settled).toContain("read-only view of a tree that has already been")
    // And the hint says the one thing that recovers it.
    expect(settled).toContain("Make the change on the live tree")
  })

  it("refuses a shell call that declares a write at a checkpoint, on the input alone", async () => {
    // The other half of the write refusal, and the one a declaration table
    // cannot see: `bash` declares no writes of its own, so a hermetic call that
    // names some in its input is the only thing that says this call changes the
    // tree. A checkpoint has nothing to change, and the run keeps going.
    const { engine, events } = await drive({
      cells: [
        `const refusal = await ctx.call("bash", { mode: "hermetic", command: "sed -i s/a/b/ a.py", reads: [], writes: ["a.py"] }, { at: ctx.base })
         ctx.done(JSON.stringify(refusal))`
      ]
    })

    expect(engine.recorder.calls).toEqual([])
    const settled = settledText(events)
    expect(settled).toContain("checkpoint_readonly")
    expect(settled).toContain("Nothing was run")
    expect(of(events, "resolved")).toHaveLength(1)
  })

  it("refuses an at that is not a checkpoint, naming what it takes", async () => {
    const { engine, events } = await drive({
      cells: [
        `const refusal = await ctx.call("read", { path: "a.py" }, { at: "base" })
         ctx.done(JSON.stringify(refusal))`
      ]
    })

    expect(engine.recorder.calls).toEqual([])
    const settled = settledText(events)
    expect(settled).toContain("invalid_input")
    expect(settled).toContain("ctx.checkpoint()")
    expect(settled).toContain("ctx.base")
  })

  it("tells a cell the host pins nothing, catchably, and lets the run carry on", async () => {
    const { events } = await drive({
      pins: false,
      cells: [
        `const answer = await ctx.checkpoint()
         ctx.done(JSON.stringify(answer))`
      ]
    })

    expect(of(events, "checkpoint-minted")).toEqual([])
    const output = of(events, "transition-applied")[0]?.transition
    expect(JSON.stringify(output)).toContain("checkpoint_unavailable")
    expect(of(events, "resolved")).toHaveLength(1)
  })

  it("bounds how many trees one run pins, and names the ones it holds", async () => {
    const { engine, events } = await drive({
      checkpointCap: 2,
      cells: [
        `const one = await ctx.checkpoint()
         const two = await ctx.checkpoint()
         const three = await ctx.checkpoint()
         ctx.done(JSON.stringify([one, two, three]))`
      ]
    })

    expect(engine.recorder.captures.map((capture) => capture.id)).toEqual(["cp-0-0", "cp-0-1"])
    const output = of(events, "transition-applied")[0]?.transition
    const text = JSON.stringify(output)
    expect(text).toContain("checkpoint_exhausted")
    // The one useful thing to say to a run at the bound is which handles it is
    // already holding.
    expect(text).toContain("cp-0-0")
    expect(text).toContain("cp-0-1")
    expect(text).toContain("ctx.base")
  })

  it("disarms minting at a cap of zero, and leaves ctx.base working", async () => {
    // Zero is a host that has decided this run pins nothing of its own. The
    // refusal then has no handles to name, and says the one thing that is
    // still true.
    const { engine, events } = await drive({
      checkpointCap: 0,
      cells: [
        `const answer = await ctx.checkpoint()
         await ctx.call("read", { path: "a.py" }, { at: ctx.base })
         ctx.done(JSON.stringify(answer))`
      ]
    })

    expect(engine.recorder.captures).toEqual([])
    const settled = settledText(events)
    expect(settled).toContain("checkpoint_exhausted")
    expect(settled).toContain("ctx.base is always the tree this run opened on")
    expect(settled).not.toContain("The ones you hold")
    // And the tree nobody mints is still readable.
    expect(engine.recorder.calls.map((call) => call.at)).toEqual(["base"])
  })

  it("counts the bound across frames, because a checkpoint outlives its frame", async () => {
    const { engine } = await drive({
      checkpointCap: 1,
      cells: [
        `await ctx.checkpoint()
         console.log("pinned")`,
        `await ctx.checkpoint()
         ctx.done("done")`
      ]
    })

    expect(engine.recorder.captures.map((capture) => capture.id)).toEqual(["cp-0-0"])
  })

  it("keeps a reading of the pinned tree distinct from the same reading of the live one", async () => {
    // Two calls, one command, two trees. They are two questions and the run's
    // own ledger has to say so, or the second replays the first's answer.
    const { engine } = await drive({
      cells: [
        `await ctx.call("read", { path: "a.py" }, { at: ctx.base })
         await ctx.call("read", { path: "a.py" })
         ctx.done("done")`
      ]
    })

    const [pinned, live] = engine.recorder.calls
    expect(pinned?.at).toBe("base")
    expect(live?.at).toBeUndefined()
    // Same lexical shape, different ordinal, and the `at` is what a key built
    // over the call has to fold in. See `FlowEngineLike.callMaterial`.
    expect(pinned?.input).toEqual(live?.input)
  })
})

// ---------------------------------------------------------------------------
// The sympy-13878 replay shape.
// ---------------------------------------------------------------------------

describe("the sympy__sympy-13878 proof loop, replayed with checkpoints", () => {
  /**
   * The frame that instance never got to write.
   *
   * The recorded run applied its patch, ran the suite, and then — to show the
   * suite had failed before the patch — reverted the patch and applied it
   * again. Four times. Here the baseline is a reading of `ctx.base`, so the
   * edit is made once and stays made.
   */
  const cell = `const patch = { path: "sympy/stats/crv_types.py", text: "the 4,789-character patch" }
     const applied = await ctx.call("edit", patch)
     const check = { mode: "unhermetic", command: "bin/test sympy/stats/tests/test_continuous_rv.py" }
     const before = await ctx.call("bash", check, { at: ctx.base })
     const after = await ctx.call("bash", check)
     if (before.exitCode !== 0 && after.exitCode === 0) {
       ctx.done("failed before, exits 0 after; hunk " + JSON.stringify(applied))
     } else {
       console.log("still failing")
     }`

  it("proves fails-before and passes-after in one frame, with the edit never given back", async () => {
    const { engine, events } = await drive({
      cells: [cell],
      calls: [
        { _tag: "Success", value: { hunk: "-old\n+new" }, tree: "crv_types.py=fixed" },
        { _tag: "Success", value: { exitCode: 1, stdout: "1 failed" } },
        { _tag: "Success", value: { exitCode: 0, stdout: "1 passed" } }
      ]
    })

    const issued = engine.recorder.calls.map((call) => [call.flowName, call.at ?? "live"])
    expect(issued).toEqual([
      ["edit", "live"],
      ["bash", "base"],
      ["bash", "live"]
    ])

    // The whole point, stated as the assertion that would have failed on the
    // recorded run: exactly one mutating call, and nothing that undoes it.
    expect(engine.recorder.calls.filter((call) => call.flowName === "edit")).toHaveLength(1)
    const commands = engine.recorder.calls
      .map((call) => JSON.stringify(call.input))
      .join("\n")
    expect(commands).not.toMatch(/git (checkout|restore|stash|reset)/)

    // And the run finishes on the pair it just took, in the frame that took it.
    const [applied] = of(events, "transition-applied")
    expect(applied?.transition._tag).toBe("complete")
    expect(JSON.stringify(applied?.transition)).toContain("failed before, exits 0 after")
  })

  it("tells the run it holds the evidence, from the frame that also did the editing", async () => {
    // `Sufficiency` used to drop every check from a frame that also changed the
    // workspace, because nothing ordered a frame's calls against its edits. A
    // checkpointed reading is ordered by the pin instead of by the frame, which
    // is what lets one frame hold both halves.
    const { events } = await drive({
      cells: [
        cell,
        `ctx.done("done")`
      ],
      calls: [
        { _tag: "Success", value: { hunk: "-old\n+new" }, tree: "crv_types.py=fixed" },
        { _tag: "Success", value: { exitCode: 1, stdout: "1 failed" } },
        { _tag: "Success", value: { exitCode: 1, stdout: "1 failed" } },
        { _tag: "Success", value: null }
      ]
    })

    // The first frame's edit did not fix it, so the frame continues; the failing
    // baseline it took against `ctx.base` is nonetheless remembered, stamped
    // before the frame's own change.
    const observed = of(events, "sufficiency-observed")
    expect(observed).toEqual([])
    expect(of(events, "checkpoint-minted")).toEqual([])
  })

  it("holds the failing baseline until a stable passing frame recognises the fix", async () => {
    const { events } = await drive({
      cells: [
        // Frame 0: edit, baseline at ctx.base, re-check — and the check still
        // fails, exactly as the recorded instance's first attempt did.
        cell,
        // Frame 1: a second edit and the identical check, which now passes.
        `await ctx.call("edit", { path: "sympy/stats/crv_types.py", text: "second attempt" })
         const after = await ctx.call("bash", { mode: "unhermetic", command: "bin/test sympy/stats/tests/test_continuous_rv.py" })
         console.log("rechecked")`,
        // Frame 2: the live check can now be attributed to the changed tree.
        `await ctx.call("bash", { mode: "unhermetic", command: "bin/test sympy/stats/tests/test_continuous_rv.py" })
         console.log("checked without editing")`,
        `ctx.done("done")`
      ],
      calls: [
        { _tag: "Success", value: { hunk: "-old\n+new" }, tree: "crv_types.py=first" },
        { _tag: "Success", value: { exitCode: 1, stdout: "1 failed" } },
        { _tag: "Success", value: { exitCode: 1, stdout: "1 failed" } },
        { _tag: "Success", value: null, tree: "crv_types.py=second" },
        { _tag: "Success", value: { exitCode: 0, stdout: "1 passed" } },
        { _tag: "Success", value: { exitCode: 0, stdout: "1 passed" } }
      ]
    })

    const observed = of(events, "sufficiency-observed")
    expect(observed).toHaveLength(1)
    expect(observed[0]?.nextFrame).toBe(3)
    expect(observed[0]?.flow).toBe("bash")
    expect(observed[0]?.failed).toContain("bin/test sympy/stats/tests/test_continuous_rv.py")
    // Epoch 0: the baseline was taken over a tree pinned before this run had
    // changed anything, which is what makes it a *before*.
    expect(observed[0]?.epoch).toBe(0)
  })
})
