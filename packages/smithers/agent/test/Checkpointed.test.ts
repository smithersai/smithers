/**
 * The host half of a checkpointed call.
 *
 * The harness decides whether a call may name a checkpoint. This decides where
 * it runs when it does — and, just as importantly, what happens when the tree
 * cannot be handed back, which has to be a refusal the cell can act on rather
 * than a run that dies holding work it already paid for.
 */
import * as Cell from "@smthrs/harness/Cell"
import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Checkpoints from "@smthrs/std/Checkpoints"
import * as StdError from "@smthrs/std/StdError"
import { Effect, Layer, Option, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Checkpointed from "../src/Checkpointed.ts"
import * as FlowEngineLike from "../src/FlowEngineLike.ts"

const call = (
  flowName: string,
  input: Schema.Json,
  at?: string | undefined
): Cell.Call =>
  new Cell.Call({
    flowName,
    input,
    capabilities: [],
    effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" },
    placement: Option.none<Descriptor.Placement>(),
    identity: new Cell.CallIdentity({
      session: "session-1",
      frame: 0,
      cell: "cell-digest",
      ordinal: 0,
      declaration: "declaration-digest",
      layers: []
    }),
    ...(at === undefined ? {} : { at })
  })

/** A runner that records what it was actually handed. */
const recording = (seen: Array<Cell.Call>): FlowEngineLike.CallRunner => ({
  run: (received) =>
    Effect.sync(() => {
      seen.push(received)
      return new Cell.CallResult({ outcome: "success", value: { ran: received.flowName } })
    })
})

/** A store that hands back one directory, and records what it was asked for. */
const store = (asked: Array<string>, options: { readonly guest?: string } = {}): Checkpoints.Checkpoints =>
  Checkpoints.make({
    capture: (id) => Effect.succeed(new Checkpoints.Snapshot({ id, ref: `test/${id}` })),
    materialize: (id, use) =>
      Effect.suspend(() => {
        asked.push(id)
        return use({
          id,
          host: `/work/repo/.flows-checkpoints/${id}`,
          guest: options.guest ?? `/work/repo/.flows-checkpoints/${id}`,
          root: "/work/repo",
          guestRoot: options.guest === undefined ? "/work/repo" : "/testbed"
        })
      })
  })

/** A store that cannot hand anything back. */
const broken = (message: string): Checkpoints.Checkpoints =>
  Checkpoints.make({
    capture: () => Effect.fail(new StdError.StdError({ code: "not_found", message })),
    materialize: () => Effect.fail(new StdError.StdError({ code: "not_found", message }))
  })

const run = (
  runner: FlowEngineLike.CallRunner,
  target: Cell.Call
): Promise<Cell.CallResult> => Effect.runPromise(runner.run(target))

describe("Checkpointed.checkpointed", () => {
  it("leaves a call that names no checkpoint exactly as it was", async () => {
    const seen: Array<Cell.Call> = []
    const asked: Array<string> = []
    const result = await run(
      Checkpointed.checkpointed(store(asked), recording(seen)),
      call("bash", { command: "bin/test" })
    )

    expect(asked).toEqual([])
    expect(seen[0]?.input).toEqual({ command: "bin/test" })
    expect(result.outcome).toBe("success")
  })

  it("points a call at the tree it named, and keeps the journaled at", async () => {
    const seen: Array<Cell.Call> = []
    const asked: Array<string> = []
    await run(
      Checkpointed.checkpointed(store(asked, { guest: "/testbed/.flows-checkpoints/base" }), recording(seen)),
      call("bash", { mode: "unhermetic", command: "bin/test", container: "swebench-1" }, "base")
    )

    expect(asked).toEqual(["base"])
    // The flow is handed the relocated input; the call still carries the `at`
    // the cell wrote, so the journal records the question rather than the
    // scratch path this process happened to check it out at.
    expect(seen[0]?.input).toEqual({
      mode: "unhermetic",
      command: "bin/test",
      container: "swebench-1",
      cwd: "/testbed/.flows-checkpoints/base"
    })
    expect(seen[0]?.at).toBe("base")
    expect(seen[0]?.identity).toEqual(call("bash", {}, "base").identity)
  })

  it("refuses a flow that names what it touches rather than where it runs", async () => {
    const seen: Array<Cell.Call> = []
    const result = await run(
      Checkpointed.checkpointed(store([]), recording(seen)),
      call("apply_patch", { input: "*** Begin Patch" }, "base")
    )

    expect(seen).toEqual([])
    expect(result.code).toBe("checkpoint_unsupported")
    expect(result.message).toContain("Nothing ran")
  })

  it("refuses an absolute path rather than guessing which prefix names the tree", async () => {
    const seen: Array<Cell.Call> = []
    const result = await run(
      Checkpointed.checkpointed(store([]), recording(seen)),
      call("read", { path: "/testbed/mod.py" }, "base")
    )

    expect(seen).toEqual([])
    expect(result.code).toBe("checkpoint_unsupported")
    expect(result.message).toContain("/testbed/mod.py")
    expect(result.message).toContain("relative to the repository root")
  })

  it("refuses a path that climbs out of the checkpoint, and runs nothing", async () => {
    // The escape is one `..` wider than the checkpoint's own directory, and
    // what it reaches is the live tree — the one tree a reading taken at a
    // checkpoint may never come from. A rewritten path would have been journaled
    // under the checkpoint the cell named, and the call key folds that in, so
    // the live reading would replay as a pinned one for the rest of the run.
    const seen: Array<Cell.Call> = []
    const result = await run(
      Checkpointed.checkpointed(store([]), recording(seen)),
      call("read", { path: "../../mod.py" }, "cp-1-0")
    )

    expect(seen).toEqual([])
    expect(result.outcome).toBe("failure")
    expect(result.code).toBe("checkpoint_unsupported")
    expect(result.message).toContain("../../mod.py")
    expect(result.message).toContain("climbs back out of the checkpoint")
  })

  it("keeps the subdirectory a shell call named, on the side of the mount it named it from", async () => {
    // A check declared in `tests/` that silently ran at the repository top comes
    // back failing because the script is not there, and a cell reads that as
    // "the baseline fails". A checkpoint that manufactures a failing baseline is
    // worse than no checkpoint at all.
    const seen: Array<Cell.Call> = []
    await run(
      Checkpointed.checkpointed(store([], { guest: "/testbed/.flows-checkpoints/base" }), recording(seen)),
      call("bash", { mode: "unhermetic", command: "./runtests.py", cwd: "tests", container: "swebench-1" }, "base")
    )

    expect(seen[0]?.input).toMatchObject({ cwd: "/testbed/.flows-checkpoints/base/tests" })
  })

  it("answers a store that cannot hand the tree back as a refusal, not a failed run", async () => {
    const seen: Array<Cell.Call> = []
    const result = await run(
      Checkpointed.checkpointed(broken("no such ref"), recording(seen)),
      call("bash", { command: "bin/test" }, "cp-3-0")
    )

    // Every call the cell has already paid for survives, and the reading it
    // wanted is still available on the live tree.
    expect(seen).toEqual([])
    expect(result.outcome).toBe("failure")
    expect(result.code).toBe("checkpoint_unavailable")
    expect(result.message).toContain("no such ref")
  })

  it("carries the runner's authorize through, because authority is not a side effect", async () => {
    const authorized: Array<string> = []
    const wrapped = Checkpointed.checkpointed(store([]), {
      authorize: (target) => Effect.sync(() => void authorized.push(target.flowName)),
      run: () => Effect.succeed(new Cell.CallResult({ outcome: "success", value: null }))
    })

    expect(wrapped.authorize).toBeDefined()
    await Effect.runPromise(wrapped.authorize!(call("bash", {})))
    expect(authorized).toEqual(["bash"])
  })
})

describe("Checkpointed.decorate", () => {
  it("wraps the runner when the composition has a store", async () => {
    const seen: Array<Cell.Call> = []
    const asked: Array<string> = []
    const decorated = await Effect.runPromise(
      Checkpointed.decorate(recording(seen)).pipe(
        Effect.provide(Layer.succeed(Checkpoints.Checkpoints)(store(asked)))
      )
    )
    await run(decorated, call("read", { path: "mod.py" }, "cp-0-0"))

    expect(asked).toEqual(["cp-0-0"])
    expect(seen[0]?.input).toEqual({ path: ".flows-checkpoints/cp-0-0/mod.py" })
  })

  it("refuses a call that names a tree when the composition pins none", async () => {
    // Silence is the one answer this seam may not give. A call carrying an `at`
    // that simply ran would read the live tree while the cell believed it was
    // reading a pinned one, and a fails-before proof built on that reading
    // would be a proof of nothing.
    const seen: Array<Cell.Call> = []
    const decorated = await Effect.runPromise(Checkpointed.decorate(recording(seen)))

    const refused = await run(decorated, call("read", { path: "mod.py" }, "base"))
    expect(seen).toEqual([])
    expect(refused.code).toBe("checkpoint_unavailable")
    expect(refused.message).toContain("For a baseline, run the check before your edit, then again after it.")

    // A call that names no tree is untouched, so nothing about an unpinned host
    // changes for the calls that were always going to run on the live tree.
    const ordinary = await run(decorated, call("read", { path: "mod.py" }))
    expect(ordinary.outcome).toBe("success")
    expect(seen).toHaveLength(1)
  })

  it("carries authorize through the unpinned refusal as well", async () => {
    const wrapped = Checkpointed.unpinned({
      authorize: () => Effect.void,
      run: () => Effect.succeed(new Cell.CallResult({ outcome: "success", value: null }))
    })
    expect(wrapped.authorize).toBeDefined()
  })
})

describe("Checkpointed refusals", () => {
  it("state the one action that recovers each of them", () => {
    expect(Checkpointed.unsupported("edit").message).toContain("drop at and read the live tree")
    expect(Checkpointed.absolute("read", "/x").message).toContain("Name the path relative to the repository root")
  })

  it("are failures a cell can branch on, never thrown", () => {
    for (const refusal of [Checkpointed.unsupported("edit"), Checkpointed.absolute("read", "/x")]) {
      expect(refusal.outcome).toBe("failure")
      expect(refusal.code).toBe("checkpoint_unsupported")
      // The envelope the cell actually sees carries the hint the code owns.
      expect(JSON.stringify(Cell.callFailure(refusal))).toContain(
        Cell.callFailureHint.checkpoint_unsupported
      )
    }
  })
})

describe("a checkpointed call is a different question", () => {
  it("keys on the tree it read, so a pinned reading never replays as a live one", () => {
    const pinned = call("read", { path: "mod.py" }, "base")
    const live = call("read", { path: "mod.py" })

    // A sealed call is content-addressed on what it asked, and "the same
    // command against the tree this run opened on" is not the same question as
    // "the same command against the tree as it stands". Without the checkpoint
    // in the material the second would be served the first's answer — which is
    // exactly the reading a fails-before proof depends on.
    const pinnedBody = FlowEngineLike.callMaterial(pinned).body as Record<string, unknown>
    const liveBody = FlowEngineLike.callMaterial(live).body as Record<string, unknown>
    expect(pinnedBody["at"]).toBe("base")
    expect(liveBody).not.toHaveProperty("at")
    expect(JSON.stringify(pinnedBody)).not.toBe(JSON.stringify(liveBody))
  })

  it("leaves every key that existed before checkpoints byte-identical", () => {
    // The field spreads to nothing when absent, so no run recorded before this
    // landed re-keys and loses its journal.
    const before = FlowEngineLike.callMaterial(call("read", { path: "mod.py" }))
    expect(Object.keys(before.body as Record<string, unknown>)).not.toContain("at")
  })
})
