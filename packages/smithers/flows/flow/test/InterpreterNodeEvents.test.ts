/**
 * What a driven graph tells its runtime about itself: the plan it recorded,
 * and the scheduled/settled pair every node in it produces.
 *
 * The records are the only evidence a monitor has that a node exists, so the
 * properties asserted here are the ones a monitor depends on. The plan's node
 * list is the graph that was built. Every record is addressed by an identity a
 * resumed walk re-derives byte for byte, which is what lets a journal keyed by
 * `(run, source, sequence)` hold one row per node across a resume instead of
 * one per attempt to observe it. And a node whose dispatches were all served
 * from durable records says so, instead of claiming it rebuilt them.
 */
import { describe, expect, it } from "@effect/vitest"
import { Action, Flow, FlowRuntime, Graph, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Layer, Schema } from "effect"
import type * as Crypto from "effect/Crypto"
import { withCrypto } from "./Crypto.ts"
import { layerWired, makeInstance, makeMemoryState, type MemoryState } from "./MemoryFlowRuntime.ts"

const Read = Action.make("node-events/read", {
  payload: { path: Schema.String },
  success: Schema.Struct({ value: Schema.Number })
})

const Double = Action.make("node-events/double", {
  payload: { value: Schema.Number },
  success: Schema.Number
})

const Fallible = Action.make("node-events/fallible", {
  payload: { fail: Schema.Boolean },
  success: Schema.Number,
  error: Schema.String
})

/**
 * A step standing in for a node that drives several dispatches.
 *
 * A real engine reports one dispatch per `actionExecute`, and today the
 * interpreter's action node drives exactly one — a retry keeps one step key,
 * because the attempt is folded into no key. So the aggregation the
 * settlement performs is exercised from the seam itself: the body reports the
 * dispatches, which is what an engine underneath it would have reported.
 */
const Chatty = Action.make("node-events/chatty", {
  payload: { dispatches: Schema.Number },
  success: Schema.Number
})

const implementations = Layer.mergeAll(
  Read.toLayer(({ path }) => Effect.succeed({ value: path.length })),
  Double.toLayer(({ value }) => Effect.succeed(value * 2)),
  Fallible.toLayer(({ fail }) => fail ? Effect.fail("refused") : Effect.succeed(1)),
  Chatty.toLayer(({ dispatches }) =>
    Effect.forEach(
      Array.from({ length: dispatches }, (_, index) => index),
      (index) =>
        Action.reportDispatch({
          outcome: "executed",
          stepKeyDigest: `digest-${index}`,
          attempt: index + 1
        }),
      { discard: true }
    ).pipe(Effect.as(dispatches))
  )
)

const Chats = Flow.make("node-events/chats", {
  payload: { dispatches: Schema.Number },
  success: Schema.Number,
  body: ({ dispatches }) => Chatty.call({ dispatches }).pipe(Node.map((value) => value))
})

/** Read something, double what it said, and map the result. */
const Chain = Flow.make("node-events/chain", {
  payload: { path: Schema.String },
  success: Schema.Number,
  body: ({ path }) =>
    Read.call({ path }).pipe(
      Node.bindPlanned((result) => Double.call({ value: result.value })),
      Node.map((doubled) => doubled + 1)
    )
})

const Refused = Flow.make("node-events/refused", {
  payload: {},
  success: Schema.Number,
  error: Schema.String,
  body: () =>
    Fallible.call({ fail: true }).pipe(
      Node.bindPlanned((value) => Double.call({ value })),
      Node.map((value) => value + 1)
    )
})

const drive = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    Crypto.Crypto | FlowRuntime.FlowInstance | FlowRuntime.FlowRuntime | Action.Implementations
  >,
  memory: MemoryState
) =>
  withCrypto(
    effect.pipe(
      Effect.provideService(
        FlowRuntime.FlowInstance,
        makeInstance(Chain as unknown as Flow.Any, "node-events-run")
      ),
      Effect.provide(layerWired(implementations, memory))
    )
  )

/** The records one walk produced, in the order the runtime received them. */
const records = (memory: MemoryState, from = 0) => memory.nodeRecords.slice(from).map((entry) => entry.record)

const settledOf = (memory: MemoryState, from = 0) =>
  records(memory, from).filter((record) => record._tag === "NodeSettled")

const scheduledOf = (memory: MemoryState, from = 0) =>
  records(memory, from).filter((record) => record._tag === "NodeScheduled")

describe("Interpreter node events", () => {
  it.effect("records the graph that was built, with its edges and their reasons", () =>
    Effect.gen(function*() {
      const memory = makeMemoryState()
      yield* drive(Interpreter.interpret(Chain, { path: "abcd" }), memory)

      const plan = records(memory).filter((record) => record._tag === "PlanRecorded")
      expect(plan).toHaveLength(1)
      const graph = Graph.build(Chain, { path: "abcd" })
      expect(plan[0]!.nodes.map((node) => node.id)).toEqual(Graph.nodes(graph).map((node) => node.id))
      expect(plan[0]!.nodeCount).toBe(Graph.nodes(graph).length)
      // Every edge, grouped by the node it arrives at, because that is how a
      // page carries them: a page never names an edge whose destination is on
      // another page.
      const edge = (value: { readonly from: string; readonly to: string; readonly reason: string }) =>
        `${value.from}->${value.to}:${value.reason}`
      expect(plan[0]!.edges.map(edge).sort()).toEqual(Graph.edges(graph).map(edge).sort())
      expect(plan[0]!.nodes.map((node) => node.tier)).toEqual(
        Graph.nodes(graph).map((node) => node.draft.material.kind)
      )
    }))

  it.effect("settles every node of a completed walk as built, after the nodes it depends on", () =>
    Effect.gen(function*() {
      const memory = makeMemoryState()
      yield* drive(Interpreter.interpret(Chain, { path: "abcd" }), memory)

      const graph = Graph.build(Chain, { path: "abcd" })
      const settled = settledOf(memory)
      expect(settled.every((record) => record.outcome === "built")).toBe(true)
      expect([...settled].map((record) => record.nodeId).sort()).toEqual(
        Graph.nodes(graph).map((node) => node.id).sort()
      )
      const order = settled.map((record) => record.nodeId)
      for (const node of Graph.nodes(graph)) {
        for (const dependency of node.dependencies) {
          expect(order.indexOf(dependency)).toBeLessThan(order.indexOf(node.id))
        }
      }
      // One scheduled record per settled one: a node is announced once.
      expect(scheduledOf(memory).map((record) => record.nodeId).sort()).toEqual(order.slice().sort())
    }))

  it.effect("names the tag a node dispatches, and nothing where a node dispatches nothing", () =>
    Effect.gen(function*() {
      const memory = makeMemoryState()
      yield* drive(Interpreter.interpret(Chain, { path: "abcd" }), memory)

      const scheduled = scheduledOf(memory)
      expect(
        scheduled.filter((record) => record.kind === "ActionCall").map((record) => record.action).sort()
      ).toEqual(["node-events/double", "node-events/read"])
      // A merge — a node that joins other nodes rather than dispatching —
      // carries no tag at all.
      expect(scheduled.filter((record) => record.kind === "Map").every((record) => record.action === undefined))
        .toBe(true)
      expect(scheduled.some((record) => record.action === undefined)).toBe(true)
    }))

  it.effect("settles a failing node and its cone as failed, and what it stranded as skipped", () =>
    Effect.gen(function*() {
      const memory = makeMemoryState()
      yield* drive(Effect.exit(Interpreter.interpret(Refused, {})), memory)

      const settled = settledOf(memory)
      const failed = settled.filter((record) => record.outcome === "failed")
      // The action that raised is first, and every node that propagated it
      // failed too: their computations did raise, and calling them skipped
      // would claim they were never reached.
      expect(failed[0]!.action).toBe("node-events/fallible")
      const skipped = settled.filter((record) => record.outcome === "skipped")
      expect(skipped.map((record) => record.action)).toEqual(["node-events/double"])
      expect(skipped[0]!.attempts).toBe(0)
      expect(settled).toHaveLength(Graph.nodes(Graph.build(Refused, {})).length)
    }))

  it.effect("addresses a resumed walk's records exactly as the first walk addressed them", () =>
    Effect.gen(function*() {
      const memory = makeMemoryState()
      yield* drive(Interpreter.interpret(Chain, { path: "abcd" }), memory)
      const first = records(memory).map((record) => record.sourceId)
      const length = memory.nodeRecords.length
      yield* drive(Interpreter.interpret(Chain, { path: "abcd" }), memory)

      // A journal keyed by (run, source, sequence) collapses the second walk
      // onto the first walk's rows exactly because these agree.
      expect(records(memory, length).map((record) => record.sourceId)).toEqual(first)
      expect(new Set(first).size).toBe(first.length)
    }))

  it.effect("settles a node whose dispatches all replayed as clean", () =>
    Effect.gen(function*() {
      const memory = makeMemoryState()
      yield* drive(Interpreter.interpret(Chain, { path: "abcd" }), memory)
      const length = memory.nodeRecords.length
      yield* drive(Interpreter.interpret(Chain, { path: "abcd" }), memory)

      const settled = settledOf(memory, length)
      // Exactly the two dispatching nodes are clean; the nodes that dispatch
      // nothing recomputed and say `built`, because they did.
      expect(settled.filter((record) => record.outcome === "clean").map((record) => record.action).sort())
        .toEqual(["node-events/double", "node-events/read"])
      expect(settledOf(memory, 0).slice(0, settled.length).every((record) => record.outcome === "built")).toBe(true)
    }))

  it.effect("pages a graph too large for one record", () =>
    Effect.gen(function*() {
      const memory = makeMemoryState()
      const wide = Flow.make("node-events/wide", {
        payload: {},
        success: Schema.Array(Schema.Number),
        body: () => {
          const members: Record<string, Node.Node<number>> = {}
          for (let index = 0; index < 48; index++) {
            members[`member-with-a-long-enough-name-to-page-${index}`] = Node.succeed(index)
          }
          return Node.map(Node.all(members), (joined) => Object.values(joined) as ReadonlyArray<number>)
        }
      })
      yield* drive(Interpreter.interpret(wide, {}), memory)

      const pages = records(memory).filter((record) =>
        record._tag === "PlanRecorded" || record._tag === "SubgraphAppended"
      )
      expect(pages.length).toBeGreaterThan(1)
      expect(pages[0]!._tag).toBe("PlanRecorded")
      expect(pages.slice(1).every((page) => page._tag === "SubgraphAppended")).toBe(true)
      // Paging loses nothing: the pages together are the whole graph, and each
      // page is small enough for a journal entry to hold.
      const paged = pages.flatMap((page) => page.nodes.map((node) => node.id))
      expect(paged).toEqual(Graph.nodes(Graph.build(wide, {})).map((node) => node.id))
      expect(paged).toHaveLength(pages[0]!._tag === "PlanRecorded" ? pages[0]!.nodeCount : 0)
      const edgeIds = (edges: ReadonlyArray<FlowRuntime.EdgeSummary>) => edges.map((edge) =>
        JSON.stringify([edge.from, edge.to, edge.reason])).sort()
      expect(edgeIds(pages.flatMap((page) => page.edges))).toEqual(edgeIds(Graph.edges(Graph.build(wide, {}))))
      for (const page of pages) {
        expect(new TextEncoder().encode(JSON.stringify(page)).byteLength).toBeLessThanOrEqual(
          Interpreter.maximumPageBytes
        )
      }
      expect(new Set(pages.map((page) => page.sourceId)).size).toBe(pages.length)
    }))

  it.effect("bounds Unicode pages including their record envelope and re-derives them on replay", () =>
    Effect.gen(function*() {
      const unicode = Flow.make("node-events/" + "界".repeat(40), {
        payload: {},
        success: Schema.Array(Schema.Number),
        body: () =>
          Node.all(
            Object.fromEntries(
              Array.from({ length: 32 }, (_, index) => [`界😀${"語".repeat(20)}-${index}`, Node.succeed(index)])
            )
          )
            .pipe(Node.map((values) => Object.values(values)))
      })
      const memory = makeMemoryState()
      yield* drive(Interpreter.interpret(unicode, {}), memory)
      const first = records(memory).filter((row) => row._tag === "PlanRecorded" || row._tag === "SubgraphAppended")
      expect(first.length).toBeGreaterThan(1)
      for (const page of first) {
        expect(new TextEncoder().encode(JSON.stringify(page)).byteLength).toBeLessThanOrEqual(
          Interpreter.maximumPageBytes
        )
      }
      const replay = makeMemoryState()
      yield* drive(Interpreter.interpret(unicode, {}), replay)
      expect(records(replay).filter((row) => row._tag === "PlanRecorded" || row._tag === "SubgraphAppended")).toEqual(
        first
      )
    }))

  it.effect("refuses before writing when the runtime envelope exhausts the page budget", () =>
    Effect.gen(function*() {
      const memory = makeMemoryState()
      const result = yield* drive(
        Effect.result(
          Interpreter.interpret(Chain, { path: "abcd" }).pipe(
            Effect.updateService(FlowRuntime.FlowRuntime, (runtime) => ({
              ...runtime,
              nodeRecordBytes: (record: FlowRuntime.NodeRecord) =>
                Effect.succeed(
                  new TextEncoder().encode(JSON.stringify(record)).byteLength + Interpreter.maximumPageBytes
                )
            }))
          )
        ),
        memory
      )
      expect(result._tag).toBe("Failure")
      expect(records(memory)).toEqual([])
    }))

  it.effect("refuses a 400-way fan-in before recording any partial plan or dispatching", () =>
    Effect.gen(function*() {
      const wide = Flow.make("node-events/oversized", {
        payload: {},
        success: Schema.Array(Schema.Number),
        body: () =>
          Node.all(
            Object.fromEntries(
              Array.from(
                { length: 400 },
                (_, index) => [`member-with-a-long-enough-name-to-page-${index}`, Node.succeed(index)]
              )
            )
          )
            .pipe(Node.map((values) => Object.values(values)))
      })
      const memory = makeMemoryState()
      const error = yield* drive(Effect.flip(Interpreter.interpret(wide, {})), memory)
      expect(error).toBeInstanceOf(Interpreter.InterpreterError)
      expect(error).toMatchObject({ code: "node_record_too_large", flow: wide._tag })
      expect(records(memory)).toEqual([])
    }))

  it.effect("drives the same graph against a runtime that records nothing", () =>
    Effect.gen(function*() {
      const memory = makeMemoryState()
      const value = yield* withCrypto(
        Interpreter.interpret(Chain, { path: "abcd" }).pipe(
          Effect.flatMap((interpretation) => Effect.succeed(interpretation.value)),
          Effect.provideService(
            FlowRuntime.FlowInstance,
            makeInstance(Chain as unknown as Flow.Any, "node-events-silent")
          ),
          Effect.updateService(FlowRuntime.FlowRuntime, (runtime) => ({ ...runtime, recordNode: undefined })),
          Effect.provide(layerWired(implementations, memory))
        )
      )

      expect(value).toBe(9)
      expect(memory.nodeRecords).toEqual([])
    }))
})

describe("the dispatch evidence a settlement carries", () => {
  it.effect("names the step keys its dispatches reported, and none where nothing dispatched", () =>
    Effect.gen(function*() {
      const memory = makeMemoryState()
      yield* drive(Interpreter.interpret(Chats, { dispatches: 3 }), memory)

      const settled = settledOf(memory)
      const chatty = settled.find((record) => record.action === "node-events/chatty")!
      // The join: an attempt record carries a step key digest and no node id,
      // so these are what say the attempts under them belong to this node.
      expect(chatty.stepKeyDigests).toEqual(["digest-0", "digest-1", "digest-2"])
      // A map dispatches nothing, so it claims nothing. An empty list is a
      // statement, not a missing answer.
      expect(
        settled.filter((record) => record.action === undefined).every((record) => record.stepKeyDigests.length === 0)
      ).toBe(true)
    }))

  it.effect("carries the highest attempt its dispatches ran as, and one where none reported", () =>
    Effect.gen(function*() {
      const memory = makeMemoryState()
      yield* drive(Interpreter.interpret(Chats, { dispatches: 3 }), memory)

      const settled = settledOf(memory)
      // The interpreter settles a node once; the count comes up from the
      // dispatches, so a node whose action ran three attempts says three.
      expect(settled.find((record) => record.action === "node-events/chatty")?.attempts).toBe(3)
      expect(settled.filter((record) => record.action === undefined).every((record) => record.attempts === 1))
        .toBe(true)
    }))

  it.effect("names at most the digest cap, so one node cannot grow the row without bound", () =>
    Effect.gen(function*() {
      const memory = makeMemoryState()
      const dispatches = Interpreter.maximumDispatchDigests + 5
      yield* drive(Interpreter.interpret(Chats, { dispatches }), memory)

      const chatty = settledOf(memory).find((record) => record.action === "node-events/chatty")!
      // A journal entry has a byte bound and a digest is 64 characters. The
      // node names the dispatches it started with rather than none, and its
      // attempt count is still the real one.
      expect(chatty.stepKeyDigests).toHaveLength(Interpreter.maximumDispatchDigests)
      expect(chatty.stepKeyDigests[0]).toBe("digest-0")
      expect(chatty.attempts).toBe(dispatches)
    }))

  it.effect("hands over what the node settled with, success or typed failure", () =>
    Effect.gen(function*() {
      const memory = makeMemoryState()
      yield* drive(Interpreter.interpret(Chain, { path: "abcd" }), memory)

      const settled = settledOf(memory)
      // Unbounded and unredacted on purpose: bounding it belongs to the
      // writer that knows where it is going, and an in-memory monitor has no
      // byte budget to respect.
      expect(settled.find((record) => record.action === "node-events/read")?.value).toEqual({ value: 4 })
      expect(settled.find((record) => record.action === "node-events/double")?.value).toBe(8)

      const refused = makeMemoryState()
      yield* drive(Effect.exit(Interpreter.interpret(Refused, {})), refused)
      const failed = settledOf(refused).find((record) => record.outcome === "failed")!
      expect(failed.value).toBe("refused")
      // A node the walk never reached settled with nothing.
      expect(settledOf(refused).find((record) => record.outcome === "skipped")?.value).toBeUndefined()
    }))
})
