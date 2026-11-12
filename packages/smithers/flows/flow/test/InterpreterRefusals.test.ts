import { expect, it } from "@effect/vitest"
import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Node, Planned } from "@smthrs/plan"
import { Cause, Effect, Exit, Layer, Option } from "effect"
import { withCrypto } from "./Crypto.ts"
import { layerWired, makeInstance } from "./MemoryFlowRuntime.ts"

const host = Flow.make("InterpreterRefusals/host", { payload: {}, body: () => Node.succeed(undefined) })
const drive = (node: Parameters<typeof Interpreter.interpret>[0], implementations = Layer.empty) =>
  withCrypto(
    Interpreter.interpret(node, {}).pipe(
      Effect.provideService(FlowRuntime.FlowInstance, makeInstance(host, "refusals")),
      Effect.provide(layerWired(implementations)),
      Effect.timeout("500 millis")
    )
  )

for (
  const [label, node] of [
    ["self-reference", Node.succeed(Planned.make("root"))],
    [
      "mutual references",
      Node.all({
        left: Node.succeed(Planned.make("root.all.right")),
        right: Node.succeed(Planned.make("root.all.left"))
      })
    ]
  ] as const
) {
  it(`refuses ${label} before dispatch instead of waiting on its own result`, async () => {
    const exit = await Effect.runPromiseExit(drive(node))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.squash(exit.cause)).toMatchObject({
        _tag: "@smthrs/flow/InterpreterError",
        code: "incomplete_graph",
        message: expect.stringMatching(/cycl/i)
      })
    }
  })
}

it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "\ud800"])(
  "names the node whose payload has no canonical representation: %s",
  async (value) => {
    const exit = await Effect.runPromiseExit(drive(Node.all({
      valid: Node.succeed({ value: 1 }),
      invalid: Node.succeed({ nested: [value] })
    })))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause)
      expect(error).toMatchObject({
        _tag: "@smthrs/flow/InterpreterError",
        code: "uncanonical_payload",
        node: "root.all.invalid",
        message: expect.stringContaining("canonical JSON")
      })
      expect(Interpreter.refusalCode(exit.cause)).toEqual(Option.some("uncanonical_payload"))
    }
  }
)

it("retains a plan identity refusal for invalid non-payload metadata", async () => {
  const exit = await Effect.runPromiseExit(withCrypto(
    Interpreter.interpret(Node.succeed(1), {}, { resolveLayers: () => ["\ud800"] }).pipe(
      Effect.provideService(FlowRuntime.FlowInstance, makeInstance(host, "bad-layer")),
      Effect.provide(layerWired(Layer.empty))
    )
  ))
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) {
    expect(Cause.squash(exit.cause)).toMatchObject({
      code: "incomplete_graph",
      node: "root",
      message: expect.stringContaining("Cannot identify recorded plan")
    })
  }
})

it("refuses a cycle in an untaken branch before dispatching an independent action", async () => {
  let calls = 0
  const work = Action.make("InterpreterRefusals/work", { payload: {} })
  const node = Node.all({
    work: work.call({}),
    choice: Node.succeed(true).pipe(Node.branch({
      if: (value) => value,
      then: () => Node.succeed("safe"),
      else: () => Node.succeed(Planned.make<string>("root.all.choice.else"))
    }))
  })
  const exit = await Effect.runPromiseExit(withCrypto(
    Interpreter.interpret(node).pipe(
      Effect.provideService(FlowRuntime.FlowInstance, makeInstance(host, "hidden-cycle")),
      Effect.provide(layerWired(work.toLayer(() => Effect.sync(() => void calls++))))
    )
  ))
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) {
    expect(Cause.squash(exit.cause)).toBeInstanceOf(Interpreter.InterpreterError)
    expect(Cause.squash(exit.cause)).toMatchObject({
      code: "incomplete_graph",
      message: expect.stringMatching(/cycl/i)
    })
  }
  expect(calls).toBe(0)
})

it("does not coerce a thrown object while rendering a graph-build refusal", async () => {
  let reads = 0
  const thrown = Object.defineProperty(Object.create(null), Symbol.toPrimitive, {
    get() {
      reads++
      throw new Error("conversion must not run")
    }
  })
  const flow = Flow.make("InterpreterRefusals/throws", {
    payload: {},
    body: (): Node.Node<void> => {
      throw thrown
    }
  })
  const exit = await Effect.runPromiseExit(drive(flow))
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) {
    expect(Cause.squash(exit.cause)).toMatchObject({
      _tag: "@smthrs/flow/InterpreterError",
      code: "incomplete_graph"
    })
  }
  expect(reads).toBe(0)
})
