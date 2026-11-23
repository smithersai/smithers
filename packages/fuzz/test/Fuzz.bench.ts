import { Arbitrary, Data, Effect, Schema } from "effect"
import { describe, test } from "vitest"
import { Fuzz } from "../src/index.ts"

class Boom extends Data.TaggedError("Boom")<{ readonly n: number }> {}

const Int = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000 }))
const ints = Arbitrary.schema(Int)
const intArrays = Arbitrary.schema(Schema.Array(Int))
const structs = Arbitrary.schema(
  Schema.Struct({
    id: Int,
    tag: Schema.Literals(["alpha", "beta", "gamma"]),
    values: Schema.Array(Int)
  })
)

describe("@smthrs/fuzz", () => {
  test("Fuzz.run passing property (200 executions over structured inputs)", async ({ bench }) => {
    const program = Fuzz.run(
      structs,
      (value) => value.id >= 0 && value.values.length >= 0,
      { seed: 42, executions: 200 }
    )
    await bench("Fuzz.run 200 passing", async () => {
      await Effect.runPromise(program)
    }).run({ iterations: 15, warmupIterations: 3, time: 0, warmupTime: 0 })
  })

  test("Fuzz.run falsify + shrink integer property", async ({ bench }) => {
    const program = Fuzz.run(
      ints,
      (n) => n < 500,
      { seed: 7, executions: 1_000, maxFindings: 1 }
    )
    await bench("Fuzz.run shrink int", async () => {
      await Effect.runPromise(program)
    }).run({ iterations: 15, warmupIterations: 3, time: 0, warmupTime: 0 })
  })

  test("Fuzz.run falsify + shrink Effect typed error on arrays", async ({ bench }) => {
    const program = Fuzz.run(
      intArrays,
      (xs) => xs.length >= 3 && xs[0]! > 50 ? Effect.fail(new Boom({ n: xs[0]! })) : Effect.succeed(true),
      { seed: 13, executions: 1_000, maxFindings: 1 }
    )
    await bench("Fuzz.run shrink array Effect", async () => {
      await Effect.runPromise(program)
    }).run({ iterations: 15, warmupIterations: 3, time: 0, warmupTime: 0 })
  })

  test("Fuzz.memoryCorpus save + load", async ({ bench }) => {
    const corpus = Fuzz.memoryCorpus()
    const target = "bench-target"
    let counter = 0
    await bench("memoryCorpus save+load", async () => {
      await Effect.runPromise(
        Effect.gen(function*() {
          yield* corpus.save(target, {
            kind: "Failure",
            key: `entry-${counter++}`,
            text: JSON.stringify({ signature: "ReturnedFalse", seed: 42, input: counter })
          })
          return yield* corpus.load(target)
        })
      )
    }).run({ time: 120, warmupTime: 30 })
  })
})
