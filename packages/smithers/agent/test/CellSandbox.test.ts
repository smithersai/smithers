/**
 * A cell's flow call, executed through the outer workspace sandbox.
 *
 * This is the seam Phase B wires: the model answers with a cell, the cell calls
 * a flow, `CellTurn`'s call handler hands the call to `EngineLike.call`, and the
 * sandboxed runner turns it into a workspace transaction keyed by
 * `@smthrs/plan`'s step-key compiler. Nothing here stubs the middle — the file
 * that lands on the host is the one the cell's flow wrote.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as Cell from "@smthrs/harness/Cell"
import * as CellTurn from "@smthrs/harness/CellTurn"
import * as ContextWindow from "@smthrs/harness/ContextWindow"
import * as EngineLike from "@smthrs/harness/EngineLike"
import { HarnessError } from "@smthrs/harness/HarnessError"
import * as QuickJSSandbox from "@smthrs/harness/QuickJSSandbox"
import * as Sandbox from "@smthrs/harness/Sandbox"
import * as Steering from "@smthrs/harness/Steering"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import * as Descriptor from "@smthrs/registry/Descriptor"
import { Effect, Option, Stream } from "effect"
import type * as Crypto from "effect/Crypto"
import { describe, expect, it } from "vitest"
import * as FlowEngineLike from "../src/FlowEngineLike.ts"
import * as InMemoryWorkspaceSandbox from "../src/InMemoryWorkspaceSandbox.ts"
import { layer as scriptedCompletionJudge } from "../src/ScriptedJudge.ts"
import * as WorkspaceSandbox from "../src/WorkspaceSandbox.ts"

const decoder = new TextDecoder()

const encoder = new TextEncoder()

const cell = `const written = await ctx.call("fs/write", { path: "notes/todo.md", text: "done" })
ctx.done(written)`

const descriptor = (
  name: string,
  effects: Descriptor.FlowDescriptor["effects"]
): Descriptor.FlowDescriptor =>
  new Descriptor.FlowDescriptor({
    name,
    description: `The ${name} flow.`,
    body: new Descriptor.BodyRefModule({ path: `/flows/${name}/flow.ts` }),
    input: new Descriptor.SchemaRefNone(),
    output: new Descriptor.SchemaRefNone(),
    model: Option.none(),
    flows: [],
    capabilities: [],
    effects,
    placement: Option.none(),
    modelInvocable: true,
    path: `/flows/${name}`,
    frontmatter: {},
    provenance: new Descriptor.Provenance({ source: "test", root: "/flows" })
  })

const writeFlow = descriptor("fs/write", {
  reads: [],
  writes: ["notes/todo.md"],
  mode: "hermetic",
  onConflict: "serialize",
  tier: "sealed"
})

/** The same flow, declaring a write it does not perform and hiding the one it does. */
const misdeclaredFlow = descriptor("fs/write", {
  reads: [],
  writes: ["notes/other.md"],
  mode: "hermetic",
  onConflict: "serialize",
  tier: "sealed"
})

/**
 * A flow implementation that actually writes, through the transactional
 * `Workspace` the sandbox provides — never through a host filesystem.
 */
const writer: FlowEngineLike.WorkspaceCallRunner = {
  run: (call) =>
    Effect.gen(function*() {
      const workspace = yield* WorkspaceSandbox.Workspace
      const input = call.input as { readonly path: string; readonly text: string }
      yield* workspace.writeFile(input.path, encoder.encode(input.text)).pipe(
        Effect.mapError((cause) =>
          new HarnessError({ code: "engine_failed", message: "the workspace refused the write", cause })
        )
      )
      return new Cell.CallResult({ outcome: "success", value: `wrote ${input.path}` })
    })
}

const state = CellTurn.make({
  session: "session-sandbox",
  seat: "anthropic:test-model",
  modelParams: ModelRequest.GenerationParams.make(),
  layers: ["layer-a"],
  capabilityEnvelope: [],
  placement: Option.none(),
  contextWindow: ContextWindow.make({
    modelId: "test-model",
    segments: [
      { kind: "system", zone: "prefix", content: [ModelRequest.SystemPart.make({ text: "cell contract" })] },
      { kind: "transcript", zone: "tail", content: [ModelRequest.Message.user("write the file")] }
    ]
  }),
  maxFrames: 2
})

/** One model frame answering with the cell above, then nothing more to say. */
const cellEvents = Stream.fromIterable([
  ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "cell" }),
  ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "cell", text: "```cell\n" + cell + "\n```" }),
  ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: "cell" }),
  ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
])

/**
 * Drives one cell turn against a real workspace sandbox.
 *
 * The engine port is `EngineLike` itself rather than the durable binding: this
 * asserts the sandbox seam, and interposing the flow engine would assert the
 * engine's replay rules a second time instead.
 */
const turn = (
  sandbox: WorkspaceSandbox.Service,
  flow: Descriptor.FlowDescriptor
): Effect.Effect<ReadonlyArray<string>, HarnessError | Sandbox.SandboxError, Crypto.Crypto> =>
  Effect.gen(function*() {
    const calls = yield* FlowEngineLike.sandboxed(sandbox, writer, { layers: ["layer-a"] })
    const port = EngineLike.makeNoop({
      sealStep: () => cellEvents,
      call: (call) => calls.run(call),
      // Every frame journals its workspace measurement through this boundary,
      // so a host that runs the loop has to answer it even when the frame
      // completes without continuing.
      record: (boundary) => boundary.execute
    })
    const messages: Array<string> = []
    yield* CellTurn.run({ state, flows: [flow] }).pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          if (event._tag === "cell-call-settled") messages.push(`${event.flowName}:${event.result.outcome}`)
        })
      ),
      Effect.provide(QuickJSSandbox.layer),
      Effect.provide(scriptedCompletionJudge),
      Effect.provideService(Steering.Source, Steering.makeNoop()),
      Effect.provideService(EngineLike.EngineLike, port)
    )
    return messages
  })

describe("a cell call through the workspace sandbox", () => {
  it("materializes the file the cell's flow wrote", async () => {
    const outcome = await Effect.runPromise(
      Effect.gen(function*() {
        const sandbox = yield* InMemoryWorkspaceSandbox.make({ "notes/todo.md": "old" })
        const settled = yield* turn(sandbox.service, writeFlow)
        return { settled, files: yield* sandbox.files }
      }).pipe(Effect.provide(NodeCrypto.layer))
    )

    expect(outcome.settled).toEqual(["fs/write:success"])
    const written = outcome.files.find((file) => file.path === "notes/todo.md")
    expect(written).toBeDefined()
    expect(decoder.decode(written!.content)).toBe("done")
  })

  it("keys the transaction with the compiler the persisted plan uses", async () => {
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const sandbox = yield* InMemoryWorkspaceSandbox.make()
        const outcomes: Array<WorkspaceSandbox.CacheOutcome> = []
        const observing = WorkspaceSandbox.make({
          execute: (execution) =>
            sandbox.service.execute(execution).pipe(
              Effect.tap((result) =>
                Effect.sync(() => {
                  if (result._tag === "Accepted") outcomes.push(result.cache)
                })
              )
            ),
          materialize: sandbox.service.materialize
        })
        yield* turn(observing, writeFlow)
        return outcomes
      }).pipe(Effect.provide(NodeCrypto.layer))
    )

    expect(observed).toHaveLength(1)
    expect(observed[0]!.status).toBe("miss")
    // The key is an `@smthrs/keys` Key, which is what makes the sandbox's cache
    // and the persisted plan's node keys the same namespace.
    expect(observed[0]!.status === "miss" ? observed[0]!.key : "").toMatch(/^key1_[0-9a-f]{64}$/)
  })

  it("refuses a call that writes outside what the cell declared, and keeps the host untouched", async () => {
    const outcome = await Effect.runPromise(
      Effect.gen(function*() {
        const sandbox = yield* InMemoryWorkspaceSandbox.make({ "notes/todo.md": "old" })
        const settled = yield* turn(sandbox.service, misdeclaredFlow)
        return { settled, files: yield* sandbox.files }
      }).pipe(Effect.provide(NodeCrypto.layer))
    )

    // The refusal is an ordinary call failure that RESOLVES, so the cell runs
    // to its own end and completes on the first frame carrying the failure
    // envelope as its answer. Nothing is retried and nothing is written.
    expect(outcome.settled).toEqual(["fs/write:failure"])
    const untouched = outcome.files.find((file) => file.path === "notes/todo.md")
    expect(decoder.decode(untouched!.content)).toBe("old")
  })
})
