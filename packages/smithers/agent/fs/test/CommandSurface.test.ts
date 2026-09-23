import { Cause, Effect, Layer, Option } from "effect"
import { execFileSync } from "node:child_process"
import { describe, expect, it } from "vitest"
import * as Command from "../src/Command.ts"
import * as FlowInvoker from "../src/FlowInvoker.ts"
import { invalidModule, makeRoute, specialModule } from "./helpers.ts"

const errorOf = <E>(exit: { readonly _tag: string; readonly cause?: unknown }): E => {
  if (exit._tag !== "Failure") throw new Error("expected failure")
  const found = Cause.findErrorOption(exit.cause as never)
  if (Option.isNone(found)) throw new Error("expected typed error")
  return found.value as E
}

describe("Command surface", () => {
  it("advertises only executable model-visible modules in stable order", async () => {
    const surface = await Effect.runPromise(Command.make([
      makeRoute("z-hidden", undefined, { modelInvocable: false }),
      makeRoute("markdown", undefined, { kind: "markdown" }),
      makeRoute("skill", undefined, { kind: "skill" }),
      makeRoute("nested/visible"),
      makeRoute("alpha")
    ]))

    expect(surface.list()).toEqual([
      { name: "alpha", description: "alpha description" },
      { name: "nested/visible", description: "nested/visible description" }
    ])
    expect(Object.isFrozen(surface.list())).toBe(true)
    expect(Object.isFrozen(surface)).toBe(true)
  })

  it("round-trips listed slash names and schema-decodes flags", async () => {
    const surface = await Effect.runPromise(Command.make([makeRoute("nested/visible")]))
    const slash = await Effect.runPromise(
      surface.parse("nested/visible --number 42 --enabled --tags one --tags two")
    )
    const spaced = await Effect.runPromise(surface.parse("nested visible --number=7"))

    expect(slash.route.name).toBe("nested/visible")
    expect(slash.input).toEqual({ enabled: true, number: 42, tags: ["one", "two"] })
    expect(spaced.input).toEqual({ number: 7 })
    expect(Object.isFrozen(slash.input)).toBe(true)
  })

  it("invokes decoded input and encodes output", async () => {
    const surface = await Effect.runPromise(Command.make([makeRoute("review")]))
    const seen: Array<FlowInvoker.Invocation> = []
    const invoker = FlowInvoker.make({
      invoke: (invocation) =>
        Effect.sync(() => {
          seen.push(invocation)
          return { accepted: true, number: (invocation.input as { readonly number: number }).number }
        })
    })
    const output = await Effect.runPromise(
      surface.execute("review --number 42").pipe(Effect.provide(Layer.succeed(FlowInvoker.FlowInvoker, invoker)))
    )

    expect(output).toEqual({ accepted: true, number: 42 })
    expect(seen).toHaveLength(1)
    expect(Object.isFrozen(seen[0])).toBe(true)
  })

  it("snapshots programmatic input before loading and requires an exact name", async () => {
    const surface = await Effect.runPromise(Command.make([makeRoute("nested/visible")]))
    const observed: Array<unknown> = []
    const invoker = FlowInvoker.make({
      invoke: ({ input }) =>
        Effect.sync(() => {
          observed.push(input)
          return { accepted: true, number: (input as { readonly number: number }).number }
        })
    })
    const program = surface.call("nested/visible", { number: 1 }).pipe(
      Effect.provide(Layer.succeed(FlowInvoker.FlowInvoker, invoker))
    )
    const source = { number: 1 }
    const pending = Effect.runPromise(
      surface.call("nested/visible", source).pipe(Effect.provide(Layer.succeed(FlowInvoker.FlowInvoker, invoker)))
    )
    source.number = 2

    expect(await Effect.runPromise(program)).toEqual({ accepted: true, number: 1 })
    expect(await pending).toEqual({ accepted: true, number: 1 })
    expect(observed).toEqual([{ number: 1 }, { number: 1 }])
    expect(Object.isFrozen(observed[0])).toBe(true)

    const typo = await Effect.runPromise(Effect.exit(
      surface.call("nested/visible/typo", { number: 1 }).pipe(
        Effect.provide(Layer.succeed(FlowInvoker.FlowInvoker, invoker))
      )
    ))
    expect(errorOf<{ readonly code: string }>(typo).code).toBe("unknown_command")
    const invalidName = await Effect.runPromise(Effect.exit(
      surface.call(1 as never, { number: 1 } as never).pipe(
        Effect.provide(Layer.succeed(FlowInvoker.FlowInvoker, invoker))
      )
    ))
    expect(errorOf<{ readonly code: string }>(invalidName).code).toBe("unknown_command")
  })

  it("returns typed decode, encode, and load failures without input disclosure", async () => {
    const surface = await Effect.runPromise(Command.make([
      makeRoute("review"),
      makeRoute("invalid", invalidModule)
    ]))
    const badInput = await Effect.runPromise(Effect.exit(surface.parse("review --number TOP-SECRET")))
    expect(errorOf<{ readonly code: string; readonly description: string }>(badInput)).toMatchObject({
      code: "decode_failed"
    })
    expect(JSON.stringify(errorOf(badInput))).not.toContain("TOP-SECRET")

    const invalid = await Effect.runPromise(Effect.exit(surface.parse("invalid --number 1")))
    expect(errorOf<{ readonly code: string }>(invalid).code).toBe("load_failed")

    const badOutput = await Effect.runPromise(Effect.exit(
      surface.execute("review --number 1").pipe(
        Effect.provide(FlowInvoker.layerNoop({ invoke: () => Effect.succeed({ accepted: "yes", number: 1 }) }))
      )
    ))
    expect(errorOf<{ readonly code: string }>(badOutput).code).toBe("encode_failed")
  })

  it("loads paths containing URL structural characters", async () => {
    const routeModule = new URL("../src/Route.ts", import.meta.url).href
    const descriptorModule = new URL("../../registry/src/Descriptor.ts", import.meta.url).href
    const script = `
      import { Effect, Option } from "effect"
      import * as Descriptor from ${JSON.stringify(descriptorModule)}
      import * as Route from ${JSON.stringify(routeModule)}
      const sourcePath = ${JSON.stringify(specialModule)}
      const route = {
        name: "special", segments: ["special"], kind: "module", sourcePath,
        description: Option.none(),
        input: new Descriptor.SchemaRefModule({ path: sourcePath, field: "input" }),
        output: new Descriptor.SchemaRefModule({ path: sourcePath, field: "output" }),
        capabilities: [], effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
        modelInvocable: true, placement: Option.none(), ui: Option.none()
      }
      const flow = await Effect.runPromise(Route.load(route))
      process.stdout.write(flow.description)
    `
    expect(execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
      encoding: "utf8"
    })).toBe("Special path fixture.")
  })
})
