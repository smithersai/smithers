import { Context, Effect, Option } from "effect"
import * as FastCheck from "fast-check"
import { expect, it } from "vitest"
import { effectProperty } from "../test-utils/effect-property.mjs"

const Ambient = Context.Service<number>("test/property/ambient")

it("retains examples, deterministic seeds, ambient services and per-example cleanup", async () => {
  const sample = async () => {
    let body!: () => Effect.Effect<void, unknown>
    const seen: Array<number> = []
    let released = 0
    effectProperty((_name, run) => { body = run })(
      "context",
      [FastCheck.integer({ min: 0, max: 1000 })],
      ([value]) => Effect.gen(function*() {
        expect(Option.getOrThrow(yield* Effect.serviceOption(Ambient))).toBe(42)
        yield* Effect.addFinalizer(() => Effect.sync(() => { released++ }))
        seen.push(value)
      }).pipe(Effect.scoped),
      { fastCheck: { seed: 12345, numRuns: 20, examples: [[321]] } }
    )
    await Effect.runPromise(body().pipe(Effect.provideService(Ambient, 42)))
    expect(released).toBe(seen.length)
    expect(seen[0]).toBe(321)
    return seen
  }
  expect(await sample()).toEqual(await sample())
})

it("reports the shrunk counterexample and seed when an Effect property fails", async () => {
  let body!: () => Effect.Effect<void, unknown>
  effectProperty((_name, run) => { body = run })(
    "failure",
    [FastCheck.integer({ min: 1, max: 1000 })],
    ([value]) => Effect.sync(() => { expect(value).toBe(0) }),
    { fastCheck: { seed: 12345, numRuns: 20 } }
  )
  await expect(Effect.runPromise(body())).rejects.toThrow(/seed: 12345[\s\S]*Counterexample: \[1\]/)
})
