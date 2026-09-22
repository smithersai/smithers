import * as Flow from "@smthrs/core/Flow"
import type { Action } from "@smthrs/flow"
import * as Schema from "effect/Schema"
import { describe, expectTypeOf, it } from "vitest"
import * as Node from "../src/Node.ts"

interface BodyError {
  readonly _tag: "BodyError"
}

const BodyFailure = Schema.Struct({ _tag: Schema.Literal("BodyError") })

describe("Flow types", () => {
  it("exports consumer-nameable make options from the public Flow module", () => {
    const options: Flow.MakeOptions<typeof Schema.String, typeof Schema.Number, typeof BodyFailure, never> = {
      name: "types/options",
      input: Schema.String,
      output: Schema.Number,
      error: BodyFailure,
      body: (input) => Node.succeed(input.length) as Node.Node<number, BodyError>
    }
    const flow = Flow.make(options)

    expectTypeOf(flow).toEqualTypeOf<
      Flow.Flow<typeof Schema.String, typeof Schema.Number, typeof BodyFailure, never>
    >()
  })

  it("infers body input from the sibling input schema and calls in the declared shape", () => {
    const Input = Schema.Struct({ id: Schema.String, count: Schema.Number })
    const Output = Schema.Struct({ accepted: Schema.Boolean })
    const flow = Flow.make({
      name: "types/body",
      input: Input,
      output: Output,
      body: (input) => {
        expectTypeOf(input).toEqualTypeOf<typeof Input.Type>()
        return Node.succeed({ accepted: input.count > 0 })
      }
    })

    expectTypeOf(flow.call({ id: "a", count: 1 })).toEqualTypeOf<Node.Node<typeof Output.Type, never, never>>()

    // @ts-expect-error count must be a number
    flow.call({ id: "a", count: "1" })
  })

  it("keeps input schemas invariant in both assignability directions", () => {
    const A = Schema.Struct({ a: Schema.String })
    const AB = Schema.Struct({ a: Schema.String, b: Schema.Number })
    const flowA = Flow.make({
      name: "types/a",
      input: A,
      output: Schema.Void,
      body: () => Node.succeed(undefined)
    })
    const flowAB = Flow.make({
      name: "types/ab",
      input: AB,
      output: Schema.Void,
      body: () => Node.succeed(undefined)
    })

    // @ts-expect-error Flow input schemas are invariant
    const acceptsAB: Flow.Flow<typeof AB, typeof Schema.Void, typeof Schema.Never, never> = flowA
    // @ts-expect-error Flow input schemas are invariant
    const acceptsA: Flow.Flow<typeof A, typeof Schema.Void, typeof Schema.Never, never> = flowAB

    expectTypeOf(acceptsAB).toEqualTypeOf<Flow.Flow<typeof AB, typeof Schema.Void, typeof Schema.Never, never>>()
    expectTypeOf(acceptsA).toEqualTypeOf<Flow.Flow<typeof A, typeof Schema.Void, typeof Schema.Never, never>>()
  })

  it("uses Flow.Any for heterogeneous concrete flow collections", () => {
    const text = Flow.make({
      name: "types/text",
      input: Schema.String,
      output: Schema.Number,
      body: (input) => Node.succeed(input.length)
    })
    const toggle = Flow.make({
      name: "types/toggle",
      input: Schema.Boolean,
      output: Schema.String,
      body: (input) => Node.succeed(String(input))
    })
    const flows: ReadonlyArray<Flow.Any> = [text, toggle]

    expectTypeOf(flows).toMatchTypeOf<ReadonlyArray<Flow.Any>>()
    expectTypeOf<Flow.Input<typeof text>>().toEqualTypeOf<string>()
    expectTypeOf<Flow.Output<typeof toggle>>().toEqualTypeOf<string>()
    expectTypeOf<Flow.Error<typeof text>>().toEqualTypeOf<never>()
  })

  it("defaults the schemas a signature omits and owes its action's requirement", () => {
    const declared = Flow.make({ name: "types/declared" })

    expectTypeOf(declared).toEqualTypeOf<
      Flow.Flow<
        typeof Schema.Void,
        typeof Schema.Unknown,
        typeof Schema.Never,
        Action.Requirement<string>
      >
    >()
    expectTypeOf(declared.call(undefined)).toEqualTypeOf<
      Node.Node<unknown, never, Action.Requirement<string>>
    >()
    // A signature with a body carries no action to implement.
    expectTypeOf(
      Flow.make({ name: "types/bodied", body: () => Node.succeed("value") }).action
    ).toEqualTypeOf<
      Action.Declared<
        string,
        Flow.Payload<typeof Schema.Void>,
        typeof Schema.Unknown,
        typeof Schema.Never,
        never
      > | undefined
    >()
  })

  it("wraps a non-struct payload and passes a struct one through", () => {
    const Input = Schema.Struct({ id: Schema.String })

    expectTypeOf<Flow.Payload<typeof Input>["Type"]>().toEqualTypeOf<{ readonly id: string }>()
    expectTypeOf<Flow.Payload<typeof Schema.String>["Type"]>().toEqualTypeOf<{ readonly input: string }>()
  })
})
