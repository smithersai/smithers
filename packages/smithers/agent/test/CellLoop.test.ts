/**
 * The cell loop on the real durable engine.
 *
 * Everything asserted here is the engine's own behaviour: each flow call a cell
 * makes is its own keyed activity, a park re-enters the frame by re-executing
 * the cell source, and boundaries that already settled replay instead of
 * running again.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as Capability from "@smthrs/capability/Capability"
import * as Permission from "@smthrs/capability/Permission"
import { FlowEngine } from "@smthrs/engine"
import { Flow, FlowRuntime } from "@smthrs/flow"
import type * as AgentEvent from "@smthrs/harness/AgentEvent"
import * as Cell from "@smthrs/harness/Cell"
import * as CellTurn from "@smthrs/harness/CellTurn"
import * as ContextWindow from "@smthrs/harness/ContextWindow"
import * as EngineLike from "@smthrs/harness/EngineLike"
import { HarnessError } from "@smthrs/harness/HarnessError"
import * as Plan from "@smthrs/harness/Plan"
import * as QuickJSSandbox from "@smthrs/harness/QuickJSSandbox"
import * as Sandbox from "@smthrs/harness/Sandbox"
import * as Steering from "@smthrs/harness/Steering"
import * as Model from "@smthrs/model/Model"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import type * as Route from "@smthrs/model/Route"
import { Node } from "@smthrs/plan"
import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Checkpoints from "@smthrs/std/Checkpoints"
import { Cause, Deferred, Effect, Exit, Layer, Option, Schema, Scope, Stream } from "effect"
import type * as Crypto from "effect/Crypto"
import { describe, expect, it } from "vitest"
import type * as Budget from "../src/Budget.ts"
import * as FlowEngineLike from "../src/FlowEngineLike.ts"
import type * as QuotaPolicy from "../src/QuotaPolicy.ts"
import * as Safety from "./Safety.ts"

const prepared: Route.PreparedRequest = {
  routeId: "route-a",
  protocolId: "test-protocol",
  method: "POST",
  url: "https://example.invalid/v1/messages",
  publicHeaders: { "content-type": "application/json" },
  body: new TextEncoder().encode("{}"),
  bodyText: "{}"
}

const route: FlowEngineLike.RouteResolver = { prepare: () => Effect.succeed(prepared) }

const cell = `const listed = await ctx.call("fs/list", { path: "." })
const written = await ctx.call("fs/write", { path: listed[0], text: "done" })
ctx.done(written)`

/** A model that records every provider call and replies with exactly one cell. */
const cellModel = (calls: Array<string>): Model.Model =>
  Model.make({
    stream: (request) =>
      Stream.suspend(() => {
        calls.push(request.modelId)
        return Stream.fromIterable([
          ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "cell" }),
          ModelEvent.ModelEvent.TextDelta({
            type: "text-delta",
            id: "cell",
            text: "```cell\n" + cell + "\n```"
          }),
          ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: "cell" }),
          ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
        ])
      })
  })

const compactionModel = (requests: Array<ModelRequest.ModelRequest>): Model.Model =>
  Model.make({
    stream: (request) =>
      Stream.suspend(() => {
        requests.push(request)
        const text = requests.length === 1 ? "durable compacted summary" : "```cell\n" + cell + "\n```"
        return Stream.fromIterable([
          ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "text" }),
          ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "text", text }),
          ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: "text" }),
          ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
        ])
      })
  })

const descriptor = (name: string, tier: Descriptor.EffectTier): Descriptor.FlowDescriptor =>
  new Descriptor.FlowDescriptor({
    name,
    description: `The ${name} flow.`,
    body: new Descriptor.BodyRefModule({ path: `/flows/${name}/flow.ts` }),
    input: new Descriptor.SchemaRefNone(),
    output: new Descriptor.SchemaRefNone(),
    model: Option.none(),
    flows: [],
    capabilities: [],
    effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier },
    placement: Option.none(),
    modelInvocable: true,
    path: `/flows/${name}`,
    frontmatter: {},
    provenance: new Descriptor.Provenance({ source: "test", root: "/flows" })
  })

const flows = [descriptor("fs/list", "sealed"), descriptor("fs/write", "irreversible")]

/**
 * The permission requirement, in the encoded form a durable error may carry.
 *
 * An activity's failure is journaled through its schema, so anything travelling
 * in `HarnessError.cause` has to be JSON. The controller decodes it back.
 */
const permission = Schema.encodeUnknownSync(Permission.PermissionRequired)(
  new Permission.PermissionRequired({
    requestId: "perm-write",
    capability: Capability.make("fs:write", "**"),
    tier: "irreversible",
    meta: {}
  })
)

/**
 * A runner that records every call it actually executes.
 *
 * The first attempt at the irreversible write reports a permission
 * requirement; the grant is what changes between attempts, exactly as a real
 * grant store would.
 */
const runner = (
  executed: Array<string>,
  grant: { value: boolean }
): FlowEngineLike.CallRunner => ({
  authorize: (call) =>
    Effect.suspend(() => {
      if (call.flowName !== "fs/write" || grant.value) return Effect.void
      grant.value = true
      return Effect.fail(
        new HarnessError({ code: "engine_failed", message: "permission required", cause: permission })
      )
    }),
  run: (call) =>
    Effect.suspend(() => {
      executed.push(`${call.flowName}#${call.identity.frame}:${call.identity.ordinal}`)
      return Effect.succeed(
        new Cell.CallResult({
          outcome: "success",
          value: call.flowName === "fs/list" ? ["alpha.md"] : `wrote ${(call.input as { path: string }).path}`
        })
      )
    })
})

const state = CellTurn.make({
  session: "session-1",
  seat: "anthropic:test-model",
  modelParams: ModelRequest.GenerationParams.make(),
  layers: ["layer-a"],
  capabilityEnvelope: [],
  placement: Option.none(),
  contextWindow: ContextWindow.make({
    modelId: "test-model",
    segments: [
      { kind: "system", zone: "prefix", content: [ModelRequest.SystemPart.make({ text: "cell contract" })] },
      { kind: "transcript", zone: "tail", content: [ModelRequest.Message.user("write the first file")] }
    ]
  }),
  maxFrames: 4
})

type Outcome =
  | { readonly _tag: "completed"; readonly value: unknown }
  | { readonly _tag: "failed"; readonly error: unknown }
  | { readonly _tag: "suspended" }

const classify = (exit: Exit.Exit<unknown, unknown>): Outcome =>
  Exit.isSuccess(exit)
    ? { _tag: "completed", value: exit.value }
    : Cause.hasInterruptsOnly(exit.cause)
    ? { _tag: "suspended" }
    : { _tag: "failed", error: Cause.squash(exit.cause) }

/**
 * The one flow every `drive` execution registers. Its body is inert: the
 * behaviour under test is the `execute` handed to `register`.
 */
const driveFlow = Flow.make("agent/test/cell-loop", {
  payload: {},
  success: Schema.Unknown,
  error: Schema.Unknown,
  body: () => Node.succeed(undefined)
})

const awaitParked = (
  engine: FlowRuntime.FlowRuntime["Service"],
  flow: typeof driveFlow,
  attempts = 100
): Effect.Effect<void, FlowRuntime.FlowExecutionNotFound> =>
  Effect.gen(function*() {
    const polled = yield* engine.poll(flow, "exec-1")
    if (Option.isSome(polled) && polled.value._tag === "Suspended") return
    if (attempts <= 0) throw new Error("the engine never published the parked execution")
    yield* Effect.yieldNow
    return yield* awaitParked(engine, flow, attempts - 1)
  })

const drive = <A, E>(
  body: Effect.Effect<
    A,
    E,
    | Crypto.Crypto
    | FlowRuntime.FlowRuntime
    | FlowRuntime.FlowInstance
    | Budget.Budget
    | QuotaPolicy.QuotaClassifier
  >,
  options: { readonly resume?: boolean } = {}
): Promise<Outcome> =>
  Effect.gen(function*() {
    const engine = yield* FlowRuntime.FlowRuntime
    const scope = yield* Effect.scope
    const flow = driveFlow
    let settled = Deferred.makeUnsafe<Outcome>()
    yield* engine.register(flow, () =>
      Effect.onExit(body, (exit) => Effect.asVoid(Deferred.succeed(settled, classify(exit))))).pipe(
        Scope.provide(scope)
      )
    yield* engine.execute(flow, { executionId: "exec-1", payload: {}, discard: true })
    const first = yield* Deferred.await(settled)
    if (options.resume !== true || first._tag !== "suspended") {
      return first
    }
    yield* awaitParked(engine, flow)
    settled = Deferred.makeUnsafe<Outcome>()
    yield* engine.resume(flow, "exec-1")
    return yield* Deferred.await(settled)
  }).pipe(
    Effect.provide(Layer.mergeAll(FlowEngine.layerMemory, NodeCrypto.layer, Safety.layer)),
    Effect.scoped,
    Effect.runPromise
  )

/** Runs the cell loop as the body of one real durable flow execution. */
const loop = (options: {
  readonly model: Model.Model
  readonly calls: FlowEngineLike.CallRunner
  readonly state?: CellTurn.State | undefined
  readonly steering?: Steering.Source | undefined
}) =>
  Effect.gen(function*() {
    const port = yield* FlowEngineLike.make({ model: options.model, route, calls: options.calls })
    const events: Array<AgentEvent.AgentEvent> = []
    yield* CellTurn.run({ state: options.state ?? state, flows }).pipe(
      Stream.runForEach((event) => Effect.sync(() => events.push(event))),
      Effect.provide(QuickJSSandbox.layer),
      Effect.provideService(Steering.Source, options.steering ?? Steering.makeNoop()),
      Effect.provideService(EngineLike.EngineLike, port)
    )
    return events.map((event) => event._tag)
  }).pipe(Effect.provide(Safety.layer))

describe("the cell loop on the durable engine", () => {
  it("runs each call in a cell as its own keyed activity, not one opaque cell activity", async () => {
    const providerCalls: Array<string> = []
    const executed: Array<string> = []
    const outcome = await drive(
      loop({ model: cellModel(providerCalls), calls: runner(executed, { value: true }) })
    )

    const tags = outcome._tag === "completed" ? outcome.value as ReadonlyArray<string> : []
    expect(tags.filter((tag) => tag === "cell-call-started")).toHaveLength(2)
    expect(tags).toContain("resolved")
    // Two boundaries, each recorded under its own identity.
    expect(executed).toEqual(["fs/list#0:0", "fs/write#0:1"])
    expect(providerCalls).toEqual(["test-model"])
  })

  it("reconstructs a timed-out frame at its bridge frontier after a durable park", async () => {
    const executed: Array<unknown> = []
    const answers: Array<string> = []
    let modelCalls = 0
    let first = true
    const model = Model.make({
      stream: () =>
        Stream.suspend(() => {
          const text = modelCalls++ === 0
            ? `var progress = 0
             await ctx.call("fs/list", "read")
             progress = 1
             await ctx.call("fs/list", "wait")
             progress = 2
             await ctx.call("fs/write", "irreversible")`
            : "ctx.done(String(progress))"
          return Stream.fromIterable([
            ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "cell" }),
            ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "cell", text: "```cell\n" + text + "\n```" }),
            ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: "cell" }),
            ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
          ])
        })
    })
    const calls: FlowEngineLike.CallRunner = {
      authorize: () => Effect.void,
      run: (call) =>
        Effect.gen(function*() {
          executed.push(call.input)
          if (first && call.input === "read") yield* Effect.sleep(50)
          if (first && call.input === "wait") yield* Effect.never
          return new Cell.CallResult({ outcome: "success", value: call.input })
        })
    }
    const outcome = await drive(
      Effect.gen(function*() {
        const port = yield* FlowEngineLike.make({ model, route, calls })
        yield* CellTurn.run({ state, flows, limits: { totalMs: 500, callMs: 5000 } }).pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              if (event._tag === "resolved") {
                const part = event.message.content[0]
                if (part?.type === "text") answers.push(part.text)
              }
            })
          ),
          Effect.provide(QuickJSSandbox.layer),
          Effect.provideService(Steering.Source, Steering.makeNoop()),
          Effect.provideService(EngineLike.EngineLike, port)
        )
        if (first) {
          first = false
          yield* port.suspend(new EngineLike.SuspendReason({ code: "waiting-input", message: "replay" }))
        }
      }),
      { resume: true }
    )
    expect(outcome._tag).toBe("completed")
    expect(answers).toEqual(["1", "1"])
    expect(executed).toEqual(["read", "wait"])
    expect(modelCalls).toBe(2)
  })

  it("parks mid-cell, then resumes by replaying the settled prefix exactly once", async () => {
    const providerCalls: Array<string> = []
    const executed: Array<string> = []
    const grant = { value: false }
    const outcome = await drive(
      loop({ model: cellModel(providerCalls), calls: runner(executed, grant) }),
      { resume: true }
    )

    expect(outcome._tag).toBe("completed")
    // The provider was called once: the resumed attempt replayed the sealed
    // model frame instead of asking again.
    expect(providerCalls).toEqual(["test-model"])
    // The first call is a replay hit, so the runner ran it once across both
    // attempts; the second call ran exactly once, after the grant.
    expect(executed).toEqual(["fs/list#0:0", "fs/write#0:1"])
  })

  it("produces the same transition interrupted-and-resumed as it does uninterrupted", async () => {
    const straight = await drive(
      loop({ model: cellModel([]), calls: runner([], { value: true }) })
    )
    const parked = await drive(
      loop({ model: cellModel([]), calls: runner([], { value: false }) }),
      { resume: true }
    )

    expect(parked).toEqual(straight)
  })

  it("journals the turn-boundary steering drain and replays it after a park", async () => {
    // Frame 0 continues; frame 1 parks on the irreversible write's permission,
    // so the resume re-executes frame 0 — including its steering drain.
    const continueCell = `console.log("frame one")`
    const requests: Array<ModelRequest.ModelRequest> = []
    const scripted = Model.make({
      stream: (request) =>
        Stream.suspend(() => {
          const index = requests.length
          requests.push(request)
          const source = index === 0 ? continueCell : cell
          return Stream.fromIterable([
            ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "cell" }),
            ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "cell", text: "```cell\n" + source + "\n```" }),
            ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: "cell" }),
            ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
          ])
        })
    })
    // A source with the replay-divergence trap armed: the first live drain
    // returns the insert, any later live drain returns nothing.
    const drains: Array<string> = []
    const steering = Steering.make({
      read: () => Effect.succeed(Steering.empty()),
      drain: (input) =>
        Effect.succeed({
          inserts: drains.length === 0 ? [ModelRequest.Message.user("steer: keep it short")] : [],
          seatChanges: [],
          remaining: Steering.empty(),
          queued: false,
          duplicate: false
        }).pipe(Effect.tap(() => Effect.sync(() => drains.push(input.boundary))))
    })
    const executed: Array<string> = []
    const outcome = await drive(
      loop({
        model: scripted,
        calls: runner(executed, { value: false }),
        steering
      }),
      { resume: true }
    )

    expect(outcome._tag).toBe("completed")
    // One live drain per completed frame across both attempts: the resumed
    // run replays frame zero's record, then drains its completing frame.
    expect(drains).toHaveLength(2)
    expect(new Set(drains).size).toBe(2)
    // Both sealed model steps replayed, so the provider saw each frame once —
    // an unjournaled drain would rebuild frame 1's context without the insert,
    // re-key the sealed step, and call the provider a third time.
    expect(requests).toHaveLength(2)
    const frameOneText =
      requests[1]?.messages.flatMap((message) =>
        message.content.flatMap((part) => part.type === "text" ? [part.text] : [])
      ).join("\n") ?? ""
    expect(frameOneText).toContain("frame one")
    expect(frameOneText).toContain("steer: keep it short")
    expect(executed).toEqual(["fs/list#1:0", "fs/write#1:1"])
  })

  it("replays a sealed compaction and rebuilds the compacted request after a park", async () => {
    const requests: Array<ModelRequest.ModelRequest> = []
    const grant = { value: false }
    const crowded = ContextWindow.make({
      modelId: "test-model",
      segments: [
        { kind: "system", zone: "prefix", content: [ModelRequest.SystemPart.make({ text: "cell contract" })] },
        ...["one", "two", "three", "four", "five", "six"].map((label) => ({
          kind: "transcript" as const,
          zone: "tail" as const,
          content: [ModelRequest.Message.user(`${label}: ${"detail ".repeat(6_000)}`)]
        }))
      ]
    })
    const compactingState = CellTurn.make({
      session: "session-1",
      seat: "anthropic:test-model",
      modelParams: ModelRequest.GenerationParams.make(),
      layers: ["layer-a"],
      capabilityEnvelope: [],
      placement: Option.none(),
      contextWindow: crowded,
      contextWindowTokens: 40_000,
      maxFrames: 4
    })
    const outcome = await drive(
      loop({
        model: compactionModel(requests),
        calls: runner([], grant),
        state: compactingState
      }),
      { resume: true }
    )

    expect(outcome._tag).toBe("completed")
    expect(requests).toHaveLength(2)
    const replayedTags = outcome._tag === "completed" ? outcome.value as ReadonlyArray<string> : []
    expect(replayedTags).toContain("compaction-settled")
    const mainText =
      requests[1]?.messages.flatMap((message) =>
        message.content.flatMap((part) => part.type === "text" ? [part.text] : [])
      ).join("\n") ?? ""
    expect(mainText).toContain("durable compacted summary")
    expect(mainText).not.toContain("one:")
  })
})

const cellCall = (input: Schema.Json, tier: Descriptor.EffectTier = "sealed"): Cell.Call =>
  new Cell.Call({
    flowName: "fs/list",
    input,
    capabilities: [],
    effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier },
    placement: Option.none(),
    identity: new Cell.CallIdentity({
      session: "session-1",
      frame: 0,
      cell: "cell-digest",
      ordinal: 0,
      declaration: "declaration-digest",
      layers: []
    })
  })

/** The same call, reissued from somewhere else in the run. */
const reissued = (
  call: Cell.Call,
  where: { readonly frame: number; readonly cell: string; readonly ordinal: number }
): Cell.Call =>
  new Cell.Call({
    ...call,
    identity: new Cell.CallIdentity({ ...call.identity, ...where })
  })

/** A runner that records every call it actually executes, and counts them. */
const counting = (executed: Array<string>): FlowEngineLike.CallRunner => ({
  run: (call) =>
    Effect.sync(() => {
      executed.push(`${call.flowName}#${call.identity.frame}:${call.identity.ordinal}`)
      return new Cell.CallResult({ outcome: "success", value: executed.length })
    })
})

describe("the port's capture seam", () => {
  const request = { id: "cp-0-0", identity: { session: "session-1", frame: 0, boundary: "cell-digest" } }

  it("reports nothing pinned when the composition holds no checkpoint store", async () => {
    const outcome = await drive(Effect.gen(function*() {
      const port = yield* FlowEngineLike.make({ model: cellModel([]), route })
      return Option.isNone(yield* port.capture(request))
    }))

    expect(outcome).toMatchObject({ _tag: "completed", value: true })
  })

  it("carries the store's own name for the tree back to the controller", async () => {
    const outcome = await drive(
      Effect.gen(function*() {
        const port = yield* FlowEngineLike.make({ model: cellModel([]), route })
        const pinned = yield* port.capture(request)
        return Option.getOrUndefined(pinned)?.ref
      }).pipe(
        Effect.provideService(
          Checkpoints.Checkpoints,
          Checkpoints.make({
            capture: (id) => Effect.succeed(new Checkpoints.Snapshot({ id, ref: `stash-${id}` })),
            materialize: (_id, use) =>
              use({ id: "cp-0-0", host: "/host", guest: "/guest", root: "/work", guestRoot: "/work" })
          })
        )
      )
    )

    expect(outcome).toMatchObject({ _tag: "completed", value: "stash-cp-0-0" })
  })

  it("reads a store that failed as nothing pinned, because that is what happened", async () => {
    const outcome = await drive(
      Effect.gen(function*() {
        const port = yield* FlowEngineLike.make({ model: cellModel([]), route })
        return Option.isNone(yield* port.capture(request))
      }).pipe(Effect.provideService(Checkpoints.Checkpoints, Checkpoints.makeNoop()))
    )

    expect(outcome).toMatchObject({ _tag: "completed", value: true })
  })
})

describe("cell call identity", () => {
  it("shares one sealed result across frames and cells, because that is what sealed means", async () => {
    const executed: Array<string> = []
    const outcome = await drive(Effect.gen(function*() {
      const port = yield* FlowEngineLike.make({ model: cellModel([]), route, calls: counting(executed) })
      const first = yield* port.call(cellCall({ path: "." }))
      // A different frame, a different cell, a different ordinal — but the same
      // sealed declaration and the same arguments.
      const elsewhere = yield* port.call(
        reissued(cellCall({ path: "." }), { frame: 3, cell: "another-cell-digest", ordinal: 7 })
      )
      return [first.value, elsewhere.value]
    }))

    expect(outcome).toMatchObject({ _tag: "completed", value: [1, 1] })
    expect(executed).toEqual(["fs/list#0:0"])
  })

  it("keys a reading of a pinned tree apart from the same reading of the live one", async () => {
    // The whole of a fails-before proof is that these two are different
    // questions. Sealed means "reusable wherever the same declaration appears
    // with the same arguments", and the tree a call reads is one of its
    // arguments — so a sealed read taken at a checkpoint must not replay as a
    // read of the tree as it stands.
    const executed: Array<string> = []
    const outcome = await drive(Effect.gen(function*() {
      const port = yield* FlowEngineLike.make({ model: cellModel([]), route, calls: counting(executed) })
      const live = yield* port.call(cellCall({ path: "." }))
      const pinned = yield* port.call(
        new Cell.Call({ ...cellCall({ path: "." }), at: "cp-0-0" })
      )
      return [live.value, pinned.value]
    }))

    expect(outcome).toMatchObject({ _tag: "completed", value: [1, 2] })
    expect(executed).toEqual(["fs/list#0:0", "fs/list#0:0"])
  })

  it("refuses to alias a sealed reading of a pinned tree with the same reading of the live one", async () => {
    const executed: Array<string> = []
    const outcome = await drive(Effect.gen(function*() {
      const port = yield* FlowEngineLike.make({ model: cellModel([]), route, calls: counting(executed) })
      const pinned = yield* port.call(new Cell.Call({ ...cellCall({ path: "." }), at: "base" }))
      // Same sealed declaration, same arguments, same everything a content
      // address sees — except the tree. "The same command against the tree this
      // run opened on" is not the same question as "the same command against
      // the tree as it stands", and the second is exactly the reading a
      // fails-before proof depends on. Aliasing them would serve the baseline's
      // answer to the check that decides the run.
      const live = yield* port.call(
        reissued(cellCall({ path: "." }), { frame: 0, cell: "cell-digest", ordinal: 1 })
      )
      return [pinned.value, live.value]
    }))

    expect(outcome).toMatchObject({ _tag: "completed", value: [1, 2] })
    expect(executed).toEqual(["fs/list#0:0", "fs/list#0:1"])
  })

  it("refuses to alias two irreversible calls that differ only in where they were issued", async () => {
    const executed: Array<string> = []
    const outcome = await drive(Effect.gen(function*() {
      const port = yield* FlowEngineLike.make({ model: cellModel([]), route, calls: counting(executed) })
      const first = yield* port.call(cellCall({ path: "." }, "irreversible"))
      // Identical declaration and arguments, issued at the next ordinal. An
      // irreversible effect is never shared on content, so this runs again —
      // the opposite of the sealed case above, and deliberately so.
      const next = yield* port.call(
        reissued(cellCall({ path: "." }, "irreversible"), { frame: 0, cell: "cell-digest", ordinal: 1 })
      )
      return [first.value, next.value]
    }))

    expect(outcome).toMatchObject({ _tag: "completed", value: [1, 2] })
    expect(executed).toEqual(["fs/list#0:0", "fs/list#0:1"])
    // Replaying an irreversible boundary after a crash is the journal's job,
    // not a content cache's: `parks mid-cell, then resumes by replaying the
    // settled prefix exactly once` is where that property is proven.
  })

  it("never shares an irreversible effect across sessions", async () => {
    const executed: Array<string> = []
    const outcome = await drive(Effect.gen(function*() {
      const port = yield* FlowEngineLike.make({ model: cellModel([]), route, calls: counting(executed) })
      const mine = cellCall({ path: "." }, "irreversible")
      const theirs = new Cell.Call({
        ...mine,
        identity: new Cell.CallIdentity({ ...mine.identity, session: "session-2" })
      })
      return [(yield* port.call(mine)).value, (yield* port.call(theirs)).value]
    }))

    expect(outcome).toMatchObject({ _tag: "completed", value: [1, 2] })
    expect(executed).toHaveLength(2)
  })

  it("treats a call resolved under a different layer set as a different call", async () => {
    const executed: Array<string> = []
    const outcome = await drive(Effect.gen(function*() {
      const port = yield* FlowEngineLike.make({ model: cellModel([]), route, calls: counting(executed) })
      const plain = cellCall({ path: "." })
      const layered = new Cell.Call({
        ...plain,
        identity: new Cell.CallIdentity({ ...plain.identity, layers: ["layer-a"] })
      })
      return [(yield* port.call(plain)).value, (yield* port.call(layered)).value]
    }))

    expect(outcome).toMatchObject({ _tag: "completed", value: [1, 2] })
    expect(executed).toHaveLength(2)
  })
})

describe("FlowEngineLike.call", () => {
  it("reports an unkeyable call as a typed harness failure", async () => {
    const outcome = await drive(Effect.gen(function*() {
      const port = yield* FlowEngineLike.make({
        model: cellModel([]),
        route,
        calls: runner([], { value: true })
      })
      const valid = cellCall(null)
      const nonSerializable = { ...valid, input: { value: undefined } } as unknown as Cell.Call
      return yield* port.call(nonSerializable)
    }))

    expect(outcome).toMatchObject({
      _tag: "failed",
      error: { code: "engine_failed", message: "Cell call fs/list #0 is not serializable" }
    })
  })

  it("reports an input that decodes but cannot be canonically keyed as a typed harness failure", async () => {
    const executed: Array<string> = []
    // A lone surrogate is a perfectly ordinary JavaScript string, so the call
    // decodes as JSON — and it has no UTF-8 form, so it has no canonical
    // serialization and therefore no key. That is a second, distinct refusal
    // from the `undefined` one above, and it must arrive typed rather than as
    // a defect, because the cell boundary can only catch what is typed.
    const outcome = await drive(Effect.gen(function*() {
      const port = yield* FlowEngineLike.make({
        model: cellModel([]),
        route,
        calls: counting(executed)
      })
      return yield* port.call(cellCall({ path: "\uD800" }))
    }))

    expect(outcome).toMatchObject({
      _tag: "failed",
      error: { code: "engine_failed", message: "Cell call fs/list #0 could not be keyed" }
    })
    // The boundary never opened, so the runner never ran.
    expect(executed).toEqual([])
  })

  it("keys placement into a sealed call and needs no authorize hook", async () => {
    const executed: Array<string> = []
    // A runner with no authorize hook: nothing to check before the boundary.
    const plain: FlowEngineLike.CallRunner = {
      run: (call) =>
        Effect.sync(() => {
          executed.push(`${call.flowName}:${Option.getOrElse(call.placement, () => "none")}`)
          return new Cell.CallResult({ outcome: "success", value: executed.length })
        })
    }
    const outcome = await drive(Effect.gen(function*() {
      const port = yield* FlowEngineLike.make({ model: cellModel([]), route, calls: plain })
      const unplaced = yield* port.call(cellCall({ path: "." }))
      const placed = yield* port.call(
        new Cell.Call({ ...cellCall({ path: "." }), placement: Option.some("local") })
      )
      const replayed = yield* port.call(cellCall({ path: "." }))
      return [unplaced.value, placed.value, replayed.value]
    }))

    // Placement is part of the sealed identity, so the placed call is a
    // different step; the third call repeats the first and replays it.
    expect(outcome).toMatchObject({ _tag: "completed", value: [1, 2, 1] })
    expect(executed).toEqual(["fs/list:none", "fs/list:local"])
  })

  it("refuses to run without the runner the path it was asked for needs", async () => {
    const withoutCalls = await drive(Effect.gen(function*() {
      const port = yield* FlowEngineLike.make({ model: cellModel([]), route })
      return yield* port.call(cellCall({ path: "." }))
    }))
    expect(withoutCalls).toMatchObject({
      _tag: "failed",
      error: { message: "No cell-call runner is configured" }
    })

    const withoutChildren = await drive(Effect.gen(function*() {
      const port = yield* FlowEngineLike.make({ model: cellModel([]), route })
      return yield* Stream.runCollect(
        port.splice(
          new Plan.Batch({
            children: [
              new Plan.Child({
                flowName: "fs/list",
                callId: "call-1",
                args: {},
                capabilities: [],
                effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
                placement: Option.none()
              })
            ]
          })
        )
      )
    }))
    expect(withoutChildren).toMatchObject({
      _tag: "failed",
      error: { message: "No child runner is configured" }
    })
  })
})
