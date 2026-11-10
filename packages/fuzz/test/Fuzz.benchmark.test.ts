import { assert, describe, it } from "@effect/vitest"
import { Arbitrary, Effect, Schema } from "effect"
import { Fuzz } from "../src/index.ts"

const byte = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 }))
const bytes = Arbitrary.schema(Schema.Array(byte))

const stage = (name: string) => Effect.fn(name)(function*() {})
const header = stage("header")
const version = stage("version")
const flags = stage("flags")

// A parser with a four-byte magic number. Each matched byte enters a new span, which is all the guidance it gets.
const parse = Effect.fn("parse")(function*(input: ReadonlyArray<number>) {
  if (input[0] !== 0x46) return true
  yield* header()
  if (input[1] !== 0x55) return true
  yield* version()
  if (input[2] !== 0x5a) return true
  yield* flags()
  return input[3] !== 0x21
})

describe("Fuzz benchmark", () => {
  it.effect("checkEffect misses the magic number in 100,000 runs", () =>
    Effect.gen(function*() {
      const result = yield* Arbitrary.checkEffect(bytes, parse, { runs: 100_000, seed: 1 })
      assert.strictEqual(result._tag, "Passed")
    }), 120_000)

  it.effect("Fuzz.run finds the magic number from span feedback", () =>
    Effect.gen(function*() {
      const report = yield* Fuzz.run(bytes, parse, { executions: 400_000, seed: 1, size: 10 })
      assert.strictEqual(report._tag, "Falsified")
      if (report._tag === "Falsified") {
        assert.deepStrictEqual(report.findings[0].input.slice(0, 4), [0x46, 0x55, 0x5a, 0x21])
        assert.isTrue(report.findings[0].execution < 400_000)
      }
    }), 120_000)
})
