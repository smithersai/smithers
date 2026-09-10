/**
 * An MCP tool reached the way a cell reaches it.
 *
 * `McpFlows.test.ts` runs a projected binding directly, which proves the
 * adapter talks to a server but skips the two gates a real call passes first:
 * the capability decision the cell boundary makes from the descriptor's
 * declaration, and the registry resolution `@smthrs/harness` `CellCalls`
 * performs before it dispatches. Both were where MCP tools actually failed.
 *
 * The declaration used to be the bare `"*"`. The boundary reads a declared
 * capability with `Capability.parse`, which takes an exact
 * `namespace:operation:resource` and answers `None` for anything else, and a
 * declaration it cannot parse counts as refused. Every MCP tool therefore
 * answered `capability_refused` before it ran, under every envelope including
 * an unrestricted one. The decision below is computed with the same two
 * functions `CellTurn` calls, against a real server over a real process.
 */
import { NodeServices } from "@effect/platform-node"
import type * as AgentEvent from "@smthrs/harness/AgentEvent"
import * as Cell from "@smthrs/harness/Cell"
import * as CellCalls from "@smthrs/harness/CellCalls"
import * as CellTurn from "@smthrs/harness/CellTurn"
import * as ContextWindow from "@smthrs/harness/ContextWindow"
import * as EngineLike from "@smthrs/harness/EngineLike"
import * as FlowBinding from "@smthrs/harness/FlowBinding"
import * as QuickJSSandbox from "@smthrs/harness/QuickJSSandbox"
import * as Steering from "@smthrs/harness/Steering"
import { Capability } from "@smthrs/kernel"
import { ModelEvent, ModelRequest } from "@smthrs/model"
import * as Registry from "@smthrs/registry/Registry"
import { Effect, Option, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as McpFlows from "../src/McpFlows.ts"
import * as FixtureServer from "./fixtures/FixtureServer.ts"

const execute = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect)

/** A real MCP server in its own process: one `add` tool, nothing else. */
const connected = Effect.provide(
  McpFlows.connected({
    server: "fixture",
    command: process.execPath,
    args: ["-e", FixtureServer.source, "single-tool"]
  }),
  NodeServices.layer
)

/** A capability pattern written the way an envelope declares one. */
const pattern = (declared: string): Capability.CapabilityPattern => {
  const parts = declared.split(":")
  return new Capability.CapabilityPattern({
    action: `${parts[0]}:${parts[1]}` as Capability.PatternAction,
    resource: parts.slice(2).join(":")
  })
}

const unrestricted = [new Capability.CapabilityPattern({ action: "*", resource: "*" })]
const readOnly = [pattern("fs:read:**")]

/** One model frame that emits a fenced cell, then settles. */
const emits = (cell: string): ReadonlyArray<ModelEvent.ModelEvent> => [
  ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "cell" }),
  ModelEvent.ModelEvent.TextDelta({
    type: "text-delta",
    id: "cell",
    text: "Calling the tool.\n\n```cell\n" + cell + "\n```"
  }),
  ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: "cell" }),
  ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
]

/**
 * One cell turn, with the envelope under test and the real MCP catalog.
 *
 * The engine is a stub in everything except the one operation this asks about:
 * `call` is the production `CellCalls` resolver over the connected server, so a
 * call that gets past the boundary reaches the real tool in its own process,
 * and a call the boundary refuses never reaches `call` at all.
 */
const turn = (
  envelope: ReadonlyArray<Capability.CapabilityPattern>
): Promise<ReadonlyArray<AgentEvent.AgentEvent>> =>
  Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const source = yield* connected
    const catalog = yield* FlowBinding.catalog([source])
    const registry = FlowBinding.registry(Registry.makeNoop(), catalog)
    const descriptor = yield* registry.get("mcp/fixture/add")
    const resolver = CellCalls.make({ registry, catalog })
    const engine = EngineLike.makeNoop({
      sealStep: () =>
        Stream.fromIterable(
          emits(`const answer = await ctx.call("mcp/fixture/add", { a: 2, b: 3 })\nctx.done(answer)`)
        ),
      call: (call) => resolver.run(call),
      // Single pass, so journaling a controller read is running it.
      record: (boundary) => boundary.execute
    })

    return yield* CellTurn.run({
      state: CellTurn.make({
        session: "mcp-cell-turn",
        seat: "test:model",
        modelParams: ModelRequest.GenerationParams.make(),
        layers: [],
        capabilityEnvelope: envelope,
        placement: Option.none(),
        contextWindow: ContextWindow.make({
          modelId: "test-model",
          segments: [
            { kind: "system", zone: "prefix", content: [ModelRequest.SystemPart.make({ text: "cell contract" })] },
            { kind: "transcript", zone: "tail", content: [ModelRequest.Message.user("add two and three")] }
          ]
        }),
        maxFrames: 1,
        readOnlyCap: 0,
        approvalChannel: false
      }),
      flows: [descriptor]
    }).pipe(
      Stream.runCollect,
      Effect.provide(EngineLike.layer(engine)),
      Effect.provide(QuickJSSandbox.layer),
      Effect.provide(Steering.layerNoop())
    )
  })))

/** Every call that actually reached the engine, in order. */
const dispatched = (
  events: ReadonlyArray<AgentEvent.AgentEvent>
): ReadonlyArray<Extract<AgentEvent.AgentEvent, { readonly _tag: "cell-call-settled" }>> =>
  events.filter((event): event is Extract<AgentEvent.AgentEvent, { readonly _tag: "cell-call-settled" }> =>
    event._tag === "cell-call-settled"
  )

/** What the cell settled the run on, as the model would read it back. */
const completion = (events: ReadonlyArray<AgentEvent.AgentEvent>): string =>
  events.flatMap((event) =>
    event._tag === "resolved"
      ? event.message.content.flatMap((part) => part.type === "text" ? [part.text] : [])
      : []
  ).join("\n")

describe("the capability declaration an MCP tool carries", () => {
  it("is written in the vocabulary the boundary parses", () => {
    // The regression in one line: every declared string must parse, or the
    // boundary refuses the call whatever the envelope says.
    for (const capability of McpFlows.capabilities) {
      expect(Option.isSome(Capability.parse(capability)), capability).toBe(true)
    }
  })
})

describe("a cell calling a real MCP tool", () => {
  it("passes the capability gate and resolves through the production resolver", async () => {
    const result = await execute(Effect.scoped(Effect.gen(function*() {
      const source = yield* connected
      const catalog = yield* FlowBinding.catalog([source])
      const registry = FlowBinding.registry(Registry.makeNoop(), catalog)
      const descriptor = yield* registry.get("mcp/fixture/add")

      // Registry resolution and dispatch, exactly as a host composes
      // it. The call carries the declaration digest the boundary re-derives,
      // so a mismatch would be refused rather than dispatched.
      const resolver = CellCalls.make({ registry, catalog })
      const settled = yield* resolver.run(
        new Cell.Call({
          flowName: "mcp/fixture/add",
          input: { a: 2, b: 3 },
          capabilities: descriptor.capabilities,
          effects: descriptor.effects,
          placement: Option.none(),
          identity: new Cell.CallIdentity({
            session: "mcp-boundary",
            frame: 0,
            cell: "cell-0",
            ordinal: 0,
            declaration: Cell.declarationDigest(descriptor),
            layers: []
          })
        })
      )
      return settled
    })))

    expect(result.outcome).toBe("success")
    expect(result.value).toEqual({ content: [{ type: "text", text: "5" }], isError: false })
  }, 30_000)
})

/**
 * The capability decision, made by the boundary rather than by this file.
 *
 * A test that re-derives the rule passes whatever the harness does, which is
 * the one thing a boundary test must not do. These two cases run
 * `CellTurn`, the code that owns the decision, over the real catalog
 * descriptor, under the two envelopes that must disagree.
 */
describe("a cell turn reaching an MCP tool", () => {
  it("dispatches the call under an unrestricted envelope", async () => {
    const events = await turn(unrestricted)
    const calls = dispatched(events)

    expect(calls).toHaveLength(1)
    expect(calls[0]?.flowName).toBe("mcp/fixture/add")
    expect(calls[0]?.result.outcome).toBe("success")
    // The real server's answer, back through the cell.
    expect(completion(events)).toContain("\"text\":\"5\"")
  }, 60_000)

  it("refuses the call under a read-only envelope, naming what it would have needed", async () => {
    const events = await turn(readOnly)

    // The refusal is the boundary's, before dispatch: nothing reached the
    // engine, so the tool never ran.
    expect(dispatched(events)).toEqual([])
    const output = completion(events)
    expect(output).toContain("capability_refused")
    expect(output).toContain("fs:write:**")
  }, 60_000)
})
