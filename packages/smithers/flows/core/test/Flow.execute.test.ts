/**
 * The sugar, run.
 *
 * A signature is only useful if the action it declares is the action a host
 * implements and the flow beside it is the flow an engine drives. So these
 * cases execute the lowered value for real: `Interpreter.layer` over the
 * in-memory `FlowEngine`, with the implementation attached the way a harness
 * attaches one, through `action.toLayer`.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import { Action, Interpreter } from "@smthrs/flow"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import * as Flow from "../src/Flow.ts"
import * as Node from "../src/Node.ts"

const run = (
  flow: { readonly execute: (payload: any, options: { readonly executionId: string }) => Effect.Effect<any, any, any> },
  payload: unknown,
  executionId: string,
  ...layers: ReadonlyArray<Layer.Layer<any, any, any>>
): Promise<unknown> =>
  Effect.runPromise(
    flow.execute(payload, { executionId }).pipe(
      Effect.provide(
        Layer.mergeAll(Interpreter.layer(flow as never), ...layers).pipe(
          Layer.provideMerge(Action.layerImplementations),
          Layer.provideMerge(FlowEngine.layerMemory),
          Layer.provideMerge(NodeCrypto.layer)
        ) as Layer.Layer<any, never, never>
      ),
      Effect.scoped
    ) as Effect.Effect<unknown, unknown, never>
  )

describe("a lowered signature executes", () => {
  it("reaches the implementation a host attached to its action", async () => {
    const signature = Flow.make({
      name: "core/execute-struct",
      input: Schema.Struct({ text: Schema.String }),
      output: Schema.String
    })
    const seen: Array<unknown> = []

    const result = await run(
      signature.flow,
      { text: "written" },
      "execution-struct",
      signature.action!.toLayer((payload) => {
        seen.push(payload)
        return Effect.succeed(payload.text.toUpperCase())
      })
    )

    expect(seen).toEqual([{ text: "written" }])
    expect(result).toBe("WRITTEN")
  })

  it("carries a non-struct input through the wrapper and back", async () => {
    const signature = Flow.make({
      name: "core/execute-scalar",
      input: Schema.String,
      output: Schema.Number
    })
    const seen: Array<unknown> = []

    const result = await run(
      signature.flow,
      { input: "written" },
      "execution-scalar",
      signature.action!.toLayer((payload) => {
        seen.push(payload)
        return Effect.succeed(payload.input.length)
      })
    )

    expect(seen).toEqual([{ input: "written" }])
    expect(result).toBe(7)
  })

  it("runs the body a signature declared without any implementation attached", async () => {
    const signature = Flow.make({
      name: "core/execute-body",
      input: Schema.String,
      output: Schema.String,
      body: (input) => Node.succeed(`${input}!`)
    })

    expect(await run(signature.flow, { input: "written" }, "execution-body")).toBe("written!")
  })
})
