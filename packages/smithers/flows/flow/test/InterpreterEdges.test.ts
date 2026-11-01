/**
 * Edges of the body interpreter the rest of the suite runs through without
 * pinning: the plan paging boundaries, the refusal that names a cycle, the
 * shape of the values the walk builds, the attempt count a node settles with,
 * and how a join treats its losers, its journal, and the waiting
 * classification beside it.
 */
import { describe, expect, it } from "@effect/vitest"
import type { Crypto } from "@smthrs/crypto"
import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Node, Planned } from "@smthrs/plan"
import { Cause, Deferred, Effect, Exit, Layer, Schema } from "effect"
import { OutcomeValueTypeId } from "../src/internal/OutcomeMarker.ts"
import { withCrypto } from "./Crypto.ts"
import { layerWired, makeInstance, makeMemoryState, type MemoryState } from "./MemoryFlowRuntime.ts"

/** Succeeds with `value`. */
const Value = Action.make("edges/value", {
  payload: { name: Schema.String, value: Schema.Number },
  success: Schema.Number
})

/** Never settles until interrupted. */
const Block = Action.make("edges/block", { payload: { name: Schema.String }, success: Schema.Number })

/** Waits until a {@link Block} has started, then succeeds with 9. */
const Hold = Action.make("edges/hold", { payload: {}, success: Schema.Number })

/** Parks: interrupts itself, as a suspended dispatch does. */
const Park = Action.make("edges/park", { payload: {}, success: Schema.Number })

/** Dies: a defect, not a decision. */
const Crash = Action.make("edges/crash", { payload: {}, success: Schema.Number })

/** Reports the given attempts as dispatches the engine underneath made. */
const Attempts = Action.make("edges/attempts", {
  payload: { attempts: Schema.Array(Schema.Number) },
  success: Schema.Number
})

/** Answers which blocked members were interrupted, once `expected` of them were or a hundred turns passed. */
const Probe = Action.make("edges/probe", {
  payload: { after: Schema.Number, expected: Schema.Number },
  success: Schema.Array(Schema.String)
})

const host = Flow.make("edges/host", { payload: {}, body: () => Node.succeed(undefined) })

const tracing = () => {
  const interrupted: Array<string> = []
  const blocked = Deferred.makeUnsafe<void>()
  const layer = Layer.mergeAll(
    Value.toLayer(({ value }) => Effect.succeed(value)),
    Block.toLayer(({ name }) =>
      Deferred.succeed(blocked, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() => Effect.sync(() => interrupted.push(name)))
      )
    ),
    Hold.toLayer(() => Deferred.await(blocked).pipe(Effect.as(9))),
    Park.toLayer(() => Effect.interrupt),
    Crash.toLayer(() => Effect.die("crashed")),
    Attempts.toLayer(({ attempts }) =>
      Effect.forEach(
        attempts,
        (attempt, index) => Action.reportDispatch({ outcome: "executed", stepKeyDigest: `edge-${index}`, attempt }),
        { discard: true }
      ).pipe(Effect.as(attempts.length))
    ),
    Probe.toLayer(({ expected }) =>
      Effect.gen(function*() {
        for (let turn = 0; turn < 100 && interrupted.length < expected; turn++) yield* Effect.yieldNow
        return [...interrupted]
      })
    )
  )
  return { interrupted, layer }
}

type Needs = Crypto.Crypto | FlowRuntime.FlowInstance | FlowRuntime.FlowRuntime | Action.Implementations

/** One process over `state`, as `instance`, whose runtime reports every cancellation it is asked for. */
const drive = <A, E>(
  effect: Effect.Effect<A, E, Needs>,
  options: {
    readonly layer?: Layer.Layer<never, never, FlowRuntime.FlowRuntime | Action.Implementations>
    readonly state?: MemoryState
    readonly instance?: FlowRuntime.FlowInstance["Service"]
    readonly interrupts?: Array<string>
    readonly nodeRecordBytes?: (record: FlowRuntime.NodeRecord) => number
  } = {}
) => {
  const reporting = Layer.effect(FlowRuntime.FlowRuntime)(Effect.gen(function*() {
    const runtime = yield* FlowRuntime.FlowRuntime
    const measure = options.nodeRecordBytes
    return {
      ...runtime,
      interrupt: (flow: Flow.Any, executionId: string) =>
        Effect.sync(() => options.interrupts?.push(executionId)).pipe(
          Effect.andThen(runtime.interrupt(flow, executionId))
        ),
      ...(measure === undefined ? {} : {
        nodeRecordBytes: (record: FlowRuntime.NodeRecord) => Effect.succeed(measure(record))
      })
    }
  }))
  return withCrypto(
    effect.pipe(
      Effect.provideService(FlowRuntime.FlowInstance, options.instance ?? makeInstance(host, "edges")),
      Effect.provide(
        reporting.pipe(
          Layer.provideMerge(layerWired(options.layer ?? tracing().layer, options.state ?? makeMemoryState()))
        )
      )
    )
  )
}

/**
 * What a restarted process finds: every recorded dispatch but the ones that
 * ended interrupted, and every journaled deferred.
 */
const restarted = (state: MemoryState): MemoryState => ({
  actions: new Map(
    [...state.actions].filter(([, exit]) =>
      !(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) &&
      !(Exit.isSuccess(exit) && exit.value._tag === "Complete" && Exit.isFailure(exit.value.exit) &&
        Cause.hasInterruptsOnly(exit.value.exit.cause))
    )
  ),
  deferredResults: new Map(state.deferredResults),
  nodeRecords: []
})

const pagesOf = (state: MemoryState) =>
  state.nodeRecords.map((entry) => entry.record).filter((record) =>
    record._tag === "PlanRecorded" || record._tag === "SubgraphAppended"
  )

const dataField = (value: unknown) => ({ value, writable: true, enumerable: true, configurable: true })
const marker = (value: unknown) => ({ value, writable: false, enumerable: false, configurable: false })

describe("Interpreter plan pages", () => {
  const Leaf = Flow.make("edges/leaf", { payload: {}, success: Schema.Number, body: () => Node.succeed(1) })

  it.effect("admits a page whose encoded record is exactly maximumPageBytes", () =>
    Effect.gen(function*() {
      const state = makeMemoryState()
      const result = yield* drive(Interpreter.interpret(Leaf, {}), {
        state,
        nodeRecordBytes: () => Interpreter.maximumPageBytes
      })
      expect(result.value).toBe(1)
      expect(pagesOf(state)).toHaveLength(1)
    }))

  it.effect("starts a fresh page for a node's dependencies when none fits beside its summary", () =>
    Effect.gen(function*() {
      const state = makeMemoryState()
      // Two summaries fill a page exactly, and one dependency more overflows
      // it: `root` is seated beside `root.flow`, and its one dependency has to
      // go to a page of its own that re-seats it.
      const half = Interpreter.maximumPageBytes / 2
      const result = yield* drive(Interpreter.interpret(Leaf, {}), {
        state,
        nodeRecordBytes: (record) =>
          record._tag === "PlanRecorded" || record._tag === "SubgraphAppended"
            ? record.nodes.reduce((total, node) => total + half + node.dependsOn.length, 0)
            : 0
      })
      expect(result.value).toBe(1)
      const pages = pagesOf(state)
      expect(pages.map((page) => page.nodes.map((node) => [node.id, node.dependsOn]))).toEqual([
        [["root.flow", []], ["root", []]],
        [["root", ["root.flow"]]]
      ])
      expect(pages.map((page) => page.pages)).toEqual([2, 2])
    }))

  it.effect("refuses a node too large for a page of its own even with nothing after it on the page", () =>
    Effect.gen(function*() {
      const state = makeMemoryState()
      // `root.flow` is a leaf: no dependency and no incoming edge would
      // otherwise reach the budget after it is seated.
      const error = yield* drive(Effect.flip(Interpreter.interpret(Leaf, {})), {
        state,
        nodeRecordBytes: (record) =>
          (record._tag === "PlanRecorded" || record._tag === "SubgraphAppended") &&
            record.nodes.some((node) => node.id === "root.flow")
            ? Interpreter.maximumPageBytes + 1
            : 0
      })
      expect(error).toBeInstanceOf(Interpreter.InterpreterError)
      expect(error).toMatchObject({ code: "node_record_too_large", flow: Leaf._tag, node: "root.flow" })
      expect(state.nodeRecords).toEqual([])
    }))
})

describe("Interpreter refusals", () => {
  it.effect("names the first node a dependency cycle blocks, not the first node of the graph", () =>
    Effect.gen(function*() {
      const node = Node.all({
        free: Node.succeed(0),
        left: Node.succeed(Planned.make("root.all.right")),
        right: Node.succeed(Planned.make("root.all.left"))
      })
      const error = yield* drive(Effect.flip(Interpreter.interpret(node)))
      expect(error).toMatchObject({
        code: "incomplete_graph",
        node: "root.all.left",
        message: expect.stringContaining(`blocking "root.all.left"`)
      })
    }))
})

describe("Interpreter values", () => {
  it.effect("settles a payload record as writable, configurable data fields on a null prototype", () =>
    Effect.gen(function*() {
      const result = yield* drive(Interpreter.interpret(Node.succeed({ answer: 42 })))
      expect(Object.getPrototypeOf(result.value)).toBe(null)
      expect(Object.getOwnPropertyDescriptor(result.value, "answer")).toEqual(dataField(42))
    }))

  it.effect("keeps a resolved outcome's marker fixed and hidden", () =>
    Effect.gen(function*() {
      const result = yield* drive(Interpreter.interpret(Flow.done({ answer: 42 })))
      expect(Object.getOwnPropertyDescriptor(result.value, OutcomeValueTypeId)).toEqual(marker("Done"))
    }))

  it.effect("joins an All into exactly its members, as writable, configurable data fields", () =>
    Effect.gen(function*() {
      const result = yield* drive(Interpreter.interpret(Node.all({ a: Node.succeed(1), b: Node.succeed(2) })))
      expect(Reflect.ownKeys(result.value as object)).toEqual(["a", "b"])
      expect(Object.getOwnPropertyDescriptor(result.value, "a")).toEqual(dataField(1))
      expect(Object.getOwnPropertyDescriptor(result.value, "b")).toEqual(dataField(2))
    }))

  it.effect("marks the outcome a handoff settles with as fixed and hidden", () =>
    Effect.gen(function*() {
      const Target = Flow.make("edges/target", {
        payload: { count: Schema.Number },
        success: Schema.Number,
        body: ({ count }) => Node.succeed(count)
      })
      const result = yield* drive(Interpreter.interpret(Target.to({ count: 2 })))
      expect(result.value).toEqual({ _tag: "To", flow: Target._tag, payload: { count: 2 } })
      expect(Object.getOwnPropertyDescriptor(result.value, OutcomeValueTypeId)).toEqual(marker("To"))
    }))

  it.effect("settles a node with the highest attempt its dispatches reported, whatever order they came in", () =>
    Effect.gen(function*() {
      const state = makeMemoryState()
      yield* drive(Interpreter.interpret(Attempts.call({ attempts: [3, 1] })), { state })
      const settled = state.nodeRecords.map((entry) => entry.record).find((record) => record._tag === "NodeSettled")
      expect(settled).toMatchObject({ nodeId: "root", outcome: "built", attempts: 3 })
    }))
})

describe("Interpreter joins", () => {
  it.effect("interrupts a loser's inner nodes as soon as the join decides, not when the walk ends", () =>
    Effect.gen(function*() {
      const { interrupted, layer } = tracing()
      const body = Node.race({
        loser: Block.call({ name: "inner" }).pipe(Node.map((value) => value + 1)),
        winner: Value.call({ name: "winner", value: 4 })
      }).pipe(Node.bindPlanned((won) => Probe.call({ after: won, expected: 1 })))
      const result = yield* drive(Interpreter.interpret(body), { layer })
      expect(result.value).toEqual(["inner"])
      expect(interrupted).toEqual(["inner"])
    }))

  it.effect("neither journals nor cancels a child a loser opened that already completed", () =>
    Effect.gen(function*() {
      const { layer } = tracing()
      const Quick = Flow.make("edges/quick-child", {
        payload: {},
        success: Schema.Number,
        body: () => Node.succeed(5)
      })
      // The loser's child completes, then the loser blocks, and only then
      // does the winner settle.
      const race = Node.race({
        loser: Quick.child({}).pipe(Node.bindPlanned(() => Block.call({ name: "after-child" }))),
        winner: Hold.call({})
      })
      const state = makeMemoryState()
      const interrupts: Array<string> = []
      const result = yield* drive(Interpreter.interpret(race), {
        layer: Layer.mergeAll(layer, Interpreter.layer(Quick)),
        state,
        interrupts
      })
      expect(result.value).toBe(9)
      expect(state.deferredResults.get("edges/join/root")).toEqual(
        Exit.succeed({ members: ["winner"], children: [] })
      )
      expect(interrupts).toEqual([])
    }))

  it.effect("ends an any-join with a member's run-time refusal instead of waiting for another success", () =>
    Effect.gen(function*() {
      const Callee = Flow.make("edges/callee", { payload: {}, success: Schema.Number, body: () => Node.succeed(1) })
      // A serialized inline call keeps no body to splice, so its member
      // refuses as it runs, before the other member succeeds.
      const node = Node.any({ leaf: Callee.call({}), ok: Node.succeed(2) })
      const lost = { ...node, ast: JSON.parse(JSON.stringify(node.ast)) as Node.Ast }
      const error = yield* drive(Effect.flip(Interpreter.interpret(lost)))
      expect(error).toMatchObject({ code: "unsupported_call", node: "root.race.leaf" })
    }))

  it.effect("journals nothing when a member's defect ends the join", () =>
    Effect.gen(function*() {
      const state = makeMemoryState()
      const exit = yield* drive(
        Effect.exit(Interpreter.interpret(Node.race({ crash: Crash.call({}), slow: Block.call({ name: "slow" }) }))),
        { state }
      )
      expect(Exit.isFailure(exit) && exit.cause.reasons.some((reason) => reason._tag === "Die")).toBe(true)
      expect([...state.deferredResults.keys()]).toEqual([])
    }))

  it.effect("parks an any-join whose journaled member parks on replay instead of refusing the journal", () =>
    Effect.gen(function*() {
      const state = makeMemoryState()
      yield* drive(Interpreter.interpret(Node.any({ a: Node.succeed(1), b: Block.call({ name: "b" }) })), { state })
      expect(state.deferredResults.get("edges/join/root")).toEqual(Exit.succeed({ members: ["a"], children: [] }))
      const exit = yield* drive(
        Effect.exit(Interpreter.interpret(Node.any({ a: Park.call({}), b: Block.call({ name: "b" }) }))),
        { state: restarted(state) }
      )
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
    }))

  it.effect("leaves the waiting classification a sibling declared in place when it reads its journal", () =>
    Effect.gen(function*() {
      const state = makeMemoryState()
      const race = Node.race({ a: Node.succeed(1) })
      yield* drive(Interpreter.interpret(race), { state })
      const instance = makeInstance(host, "edges")
      const waiting = { reason: "approval", token: "sibling" }
      instance.waiting = waiting
      const result = yield* drive(Interpreter.interpret(race), { state: restarted(state), instance })
      expect(result.value).toBe(1)
      expect(instance.waiting).toBe(waiting)
    }))
})
