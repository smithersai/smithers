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
import * as EngineLike from "../src/EngineLike.ts"
import * as Frame from "../src/internal/frame.ts"
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
    return Cell.CallResult.new({ outcome: "success", value: { seen: invocation.flow } })
  })

/** A minter that pins whatever it is asked, naming the ordinal it was asked at. */
const pinning = (minted: Array<number>): Sandbox.Minter => (mint) =>
  Effect.sync(() => {
    minted.push(mint.ordinal)
    return Cell.CallResult.new({ outcome: "success", value: Cell.checkpoint(`cp-${mint.ordinal}`) })
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
  readonly repeatCap?: number
  readonly records?: Map<string, unknown>
}) =>
  run({
    script: options.cells.map(emits),
    ...(options.records === undefined ? {} : { records: options.records }),
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
      repeatCap: options.repeatCap ?? 0,
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
    const records = new Map<string, unknown>()
    const cells = [
      `const cp = await ctx.checkpoint()
       await ctx.call("read", { path: "a.py" }, { at: cp })
       ctx.done(cp.checkpoint)`
    ]
    const first = await drive({ cells, records })

    // The id is derived from the frame and the ordinal, which is exactly the
    // pair a re-executed cell re-derives — so a resumed run addresses the trees
    // its original attempt addressed.
    const minted = of(first.events, "checkpoint-minted")
    expect(minted).toEqual([
      expect.objectContaining({ id: "cp-0-0", ref: "test/cp-0-0", ordinal: 0 })
    ])
    expect(first.engine.recorder.captures).toEqual([{ id: "cp-0-0", tree: "a.py=base" }])
    expect(first.engine.recorder.calls.map((call) => call.at)).toEqual(["cp-0-0"])

    // The same frame re-executed over the same journal after the tree moved.
    // The mint went through the journaled boundary rather than straight to
    // the host, so the resumed frame is served the tree it pinned the first
    // time: the host captures nothing, the journal names the same tree, and
    // the read at it is replayed under the same boundaries rather than issued
    // against the tree as it now stands.
    const second = await drive({ cells, records, tree: "a.py=moved" })
    expect(second.engine.recorder.captures).toEqual([])
    expect(of(second.events, "checkpoint-minted")).toEqual(minted)
    expect(second.engine.recorder.calls).toEqual([])
    const boundaries = (attempt: typeof first) =>
      attempt.engine.recorder.records.map((boundary) => JSON.stringify([boundary.name, boundary.identity]))
    expect(first.engine.recorder.records.map((boundary) => boundary.name)).toContain("checkpoint")
    // The same keys, though not in the same order: a resumed frame reads its
    // attempt marker before it runs the cell rather than after.
    expect(boundaries(second).sort()).toEqual(boundaries(first).sort())
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

  it.each(["cp-3-0", "cp-99-0", "unknown"])("refuses an unminted checkpoint handle %s", async (id) => {
    const { engine, events } = await drive({
      cells: [
        `const answer = await ctx.call("read", { path: "a.py" }, { at: { checkpoint: ${JSON.stringify(id)} } })
         ctx.done(JSON.stringify(answer))`
      ]
    })

    expect(engine.recorder.calls).toEqual([])
    expect(settledText(events)).toContain("checkpoint_unavailable")
    expect(settledText(events)).toContain("This run has not pinned that checkpoint")
    expect(of(events, "resolved")).toHaveLength(1)
  })

  it("refuses a checkpoint handle from an earlier run", async () => {
    const earlier = await drive({ cells: [`await ctx.checkpoint(); ctx.done("done")`] })
    const id = of(earlier.events, "checkpoint-minted")[0]!.id
    const { engine, events } = await drive({
      cells: [
        `const answer = await ctx.call("read", { path: "a.py" }, { at: { checkpoint: ${JSON.stringify(id)} } })
         ctx.done(JSON.stringify(answer))`
      ]
    })

    expect(engine.recorder.calls).toEqual([])
    expect(settledText(events)).toContain("checkpoint_unavailable")
    expect(settledText(events)).toContain("This run has not pinned that checkpoint")
    expect(of(events, "resolved")).toHaveLength(1)
  })

  it("does not authorize a checkpoint when pinning failed", async () => {
    const { engine, events } = await drive({
      pins: false,
      cells: [
        `await ctx.checkpoint()
         const answer = await ctx.call("read", { path: "a.py" }, { at: { checkpoint: "cp-0-0" } })
         ctx.done(JSON.stringify(answer))`
      ]
    })

    expect(of(events, "checkpoint-minted")).toEqual([])
    expect(engine.recorder.calls).toEqual([])
    expect(settledText(events)).toContain("checkpoint_unavailable")
    expect(settledText(events)).toContain("This run has not pinned that checkpoint")
    expect(of(events, "resolved")).toHaveLength(1)
  })

  it("accepts a checkpoint the same run minted in an earlier frame", async () => {
    const { engine } = await drive({
      cells: [
        `const held = await ctx.checkpoint()
         console.log(held.checkpoint)`,
        `await ctx.call("read", { path: "a.py" }, { at: held })
         ctx.done("done")`
      ]
    })

    expect(engine.recorder.captures.map((capture) => capture.id)).toEqual(["cp-0-0"])
    expect(engine.recorder.calls.map((call) => call.at)).toEqual(["cp-0-0"])
  })

  it("keeps a successful checkpoint from a frame that later raises", async () => {
    const { engine, events } = await drive({
      cells: [
        `const held = await ctx.checkpoint()
         throw new Error("after pin")`,
        `await ctx.call("read", { path: "a.py" }, { at: held })
         ctx.done("done")`
      ]
    })

    expect(of(events, "checkpoint-minted")).toHaveLength(1)
    expect(engine.recorder.calls.map((call) => call.at)).toEqual(["cp-0-0"])
    expect(of(events, "resolved")).toHaveLength(1)
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
    // One command, two trees. They are two questions and the run's own ledger
    // has to say so: asked in consecutive frames under a repeat cap of one, a
    // ledger that keyed them alike would read the second frame as a repeat.
    const after = (second: string) =>
      drive({
        repeatCap: 1,
        cells: [
          `await ctx.call("read", { path: "a.py" }, { at: ctx.base })
           console.log("pinned")`,
          second,
          `ctx.done("done")`
        ]
      })
    const { engine, events } = await after(`await ctx.call("read", { path: "a.py" })
       console.log("live")`)

    expect(of(events, "repeat-demanded")).toEqual([])
    const [pinned, live] = engine.recorder.calls
    expect(pinned?.at).toBe("base")
    expect(live?.at).toBeUndefined()
    // Same lexical shape, and the `at` is what a key built over the call has
    // to fold in. See `callMaterial` in `@smthrs/agent`'s `FlowEngineLike`.
    expect(pinned?.input).toEqual(live?.input)

    // The control: the same pinned reading asked again is a repeat.
    const repeated = await after(`await ctx.call("read", { path: "a.py" }, { at: ctx.base })
       console.log("pinned again")`)
    expect(of(repeated.events, "repeat-demanded")).toHaveLength(1)
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

  it("remembers the failing baseline from the frame that also did the editing, stamped before its change", () => {
    // `Sufficiency` used to drop every check from a frame that also changed the
    // workspace, because nothing ordered a frame's calls against its edits. A
    // checkpointed reading is ordered by the pin instead of by the frame, which
    // is what lets one frame hold the *before* half. The frame is the cell
    // above: edit, baseline at `ctx.base`, re-check on the live tree.
    const check = { mode: "unhermetic", command: "bin/test sympy/stats/tests/test_continuous_rv.py" }
    const subject = "bash:bin/test sympy/stats/tests/test_continuous_rv.py"
    const settled = (changes: Partial<Frame.ObservedCall>): Frame.ObservedCall => ({
      flow: "bash",
      ok: true,
      summary: "",
      ordinal: 0,
      mutates: false,
      remote: false,
      signature: subject,
      subject,
      at: undefined,
      input: check,
      value: null,
      message: undefined,
      invalidProbe: undefined,
      declared: false,
      failing: false,
      passing: false,
      ...changes
    })
    const frame = (live: Partial<Frame.ObservedCall>) =>
      Frame.account({
        state: CellTurn.make({
          session: "session-1",
          seat: "anthropic:test-model",
          modelParams: ModelRequest.GenerationParams.make(),
          layers: [],
          capabilityEnvelope: [],
          placement: Option.none(),
          contextWindow: window,
          maxFrames: 3
        }),
        calls: [
          settled({ flow: "edit", ordinal: 0, mutates: true, signature: "edit", subject: "edit", input: {} }),
          settled({
            ordinal: 1,
            signature: `${subject}@base`,
            at: "base",
            value: { exitCode: 1 },
            failing: true
          }),
          settled({ ordinal: 2, ...live })
        ],
        opened: Option.some(new EngineLike.Observation({ digest: "old", paths: 1, complete: true })),
        closed: Option.some(new EngineLike.Observation({ digest: "fixed", paths: 1, complete: true })),
        minted: [],
        bindings: [],
        captures: []
      })

    // The live re-check reported no exit status, so the baseline is the one
    // failure the frame remembers, at epoch 0: before the frame's own edit.
    const baseline = frame({ value: { stdout: "collection error" } })
    expect(baseline.facts.mutations).toBe(1)
    expect(baseline.facts.failures.map((failure) => [failure.signature, failure.epoch])).toEqual([[subject, 0]])

    // A live re-check that failed too settled after the edit, so it read the
    // tree the frame closed on and restamps the same check at epoch 1.
    const failedAgain = frame({ value: { exitCode: 1 }, failing: true })
    expect(failedAgain.facts.failures.map((failure) => [failure.signature, failure.epoch])).toEqual([[subject, 1]])
  })

  it("holds the failing baseline against the frame that fixes it, which recognises the fix", async () => {
    const { events } = await drive({
      cells: [
        // Frame 0: edit, baseline at ctx.base, re-check. The live re-check
        // reports no exit status, so the pinned baseline is the only failure
        // this frame can remember.
        cell,
        // Frame 1: a second edit and the identical check, which now passes.
        // The check settles after the edit, so it is a reading of the tree the
        // frame closed on and the pair is complete here rather than a frame on.
        `await ctx.call("edit", { path: "sympy/stats/crv_types.py", text: "second attempt" })
         const after = await ctx.call("bash", { mode: "unhermetic", command: "bin/test sympy/stats/tests/test_continuous_rv.py" })
         console.log("rechecked")`,
        `ctx.done("done")`
      ],
      calls: [
        { _tag: "Success", value: { hunk: "-old\n+new" }, tree: "crv_types.py=first" },
        { _tag: "Success", value: { exitCode: 1, stdout: "1 failed" } },
        { _tag: "Success", value: { stdout: "collection error" } },
        { _tag: "Success", value: null, tree: "crv_types.py=second" },
        { _tag: "Success", value: { exitCode: 0, stdout: "1 passed" } }
      ]
    })

    const observed = of(events, "sufficiency-observed")
    expect(observed).toHaveLength(1)
    expect(observed[0]?.nextFrame).toBe(2)
    expect(observed[0]?.flow).toBe("bash")
    expect(observed[0]?.failed).toContain("bin/test sympy/stats/tests/test_continuous_rv.py")
    // Epoch 0: the baseline was taken over a tree pinned before this run had
    // changed anything, which is what makes it a *before*.
    expect(observed[0]?.epoch).toBe(0)
  })
})
