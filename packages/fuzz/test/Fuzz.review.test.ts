import { assert, describe, it } from "@effect/vitest"
import { Arbitrary, Duration, Effect, Schema } from "effect"
import { Fuzz } from "../src/index.ts"
import * as Format from "../src/internal/fuzz/format.ts"

const json: Fuzz.Codec<number> = { id: "json", encode: JSON.stringify, decode: JSON.parse }
const stored = (store: Fuzz.Store) => Effect.provideService(Fuzz.Corpus, store)
const bySize = (f: (size: number) => number, shrunk?: number): Arbitrary.Arbitrary<number> => {
  const arbitrary = Arbitrary.schema(Schema.Int)
  return Object.create(arbitrary, {
    gen: {
      value: {
        minCost: 0,
        generate: (context: Parameters<typeof arbitrary.gen.generate>[0]) => ({
          _tag: "Generated" as const,
          value: f(context.size),
          shrinks: context.shrinks && shrunk !== undefined
            ? Effect.succeed({ _tag: "Generated" as const, value: shrunk })
            : undefined
        })
      }
    }
  })
}

describe("Fuzz Fable regressions", () => {
  it.effect("repeated flaky candidates retain the first diagnostic and continue searching", () =>
    Effect.gen(function*() {
      let calls = 0
      const report = yield* Fuzz.run(bySize((size) => size), () => ++calls % 2 === 0, {
        executions: 3,
        maxShrinks: 0
      })
      assert.strictEqual(report._tag, "Flaky")
      if (report._tag !== "Flaky") return
      assert.strictEqual(report.flaky.length, 1)
      assert.strictEqual(report.flaky[0].input, 0)
      assert.deepStrictEqual([report.stats.executions, calls], [3, 6])
    }))

  it.effect("F1: a flaky failure does not hide a later confirmed failure with the same signature", () =>
    Effect.gen(function*() {
      // Deterministic generation makes the second search input distinct from the first.
      const sized = bySize((size) => size)
      let calls = 0
      const report = yield* Fuzz.run(sized, () => ++calls === 2, {
        seed: 1,
        executions: 10,
        maxShrinks: 0
      })
      assert.strictEqual(report._tag, "Falsified")
      if (report._tag !== "Falsified") return
      assert.deepStrictEqual(report.findings.map((finding) => [finding.signature, finding.input, finding.execution]), [
        ["ReturnedFalse", 3, 2]
      ])
      assert.deepStrictEqual(report.flaky.map((finding) => [finding.input, finding.recheck._tag]), [[0, "Passed"]])
      assert.strictEqual(calls, 4)
    }))

  it.effect("repeated flaky candidates do not reset the plateau budget", () =>
    Effect.gen(function*() {
      let calls = 0
      const report = yield* Fuzz.run(Arbitrary.Constant(0), () => ++calls % 2 === 0, {
        seed: 1,
        size: 0,
        executions: 1_000,
        plateau: 10,
        feedback: []
      })
      assert.strictEqual(report._tag, "Flaky")
      assert.strictEqual(report.stats.stoppedBy, "Plateau")
      assert.isBelow(report.stats.executions, 1_000)
    }))

  for (const values of [true, false]) {
    it.effect(`F3: a later ${values ? "value" : "tape"} failure retains a fixed regression of the same signature`, () =>
      Effect.gen(function*() {
        const store = Fuzz.memoryCorpus()
        const options = { id: "retain", revision: "1", ...(values ? { codec: json } : {}) }
        const tapes = bySize((size) => size === 0 ? 1 : 2)
        const first = Fuzz.target(values ? Arbitrary.Constant(1) : tapes, (n) => n !== 1, options)
        yield* Fuzz.runTarget(first, { executions: 1 }).pipe(stored(store))
        const old = (yield* store.load("retain")).filter((entry) => entry.kind === "Failure")
        assert.strictEqual(old.length, 1)
        // Value fixtures outlive generator changes; tapes keep the same deterministic generator.
        const arbitrary = values ? Arbitrary.Constant(2) : tapes
        const second = Fuzz.target(arbitrary, (n) => n !== 2, options)
        yield* Fuzz.runTarget(second, { seed: 1, executions: 2_000 }).pipe(stored(store))
        const failures = (yield* store.load("retain")).filter((entry) => entry.kind === "Failure")
        assert.strictEqual(failures.length, 2)
        assert.isTrue(failures.some((entry) => entry.key === old[0].key && entry.text === old[0].text))
        {
          const regressed = Fuzz.target(values ? Arbitrary.Constant(0) : tapes, (n) => n !== 1, options)
          const replayed = yield* Fuzz.runTarget(regressed, { executions: 0 }).pipe(stored(store))
          assert.strictEqual(replayed._tag === "Falsified" && replayed.findings[0].input, 1)
          assert.strictEqual(replayed.stats.regressions, 2)
        }
        const both = Fuzz.target(arbitrary, () => false, options)
        const deduplicated = yield* Fuzz.runTarget(both, { executions: 1, maxFindings: 2 }).pipe(stored(store))
        assert.strictEqual(deduplicated._tag === "Falsified" && deduplicated.findings.length, 1)
        assert.strictEqual(deduplicated.stats.executions, 1)
      }))
  }

  it.effect("F4: an encoding failure keeps the finding and saves a replayable tape", () =>
    Effect.gen(function*() {
      const store = Fuzz.memoryCorpus()
      const target = Fuzz.target(Arbitrary.Constant(1), () => false, {
        id: "unencodable",
        revision: "1",
        codec: {
          ...json,
          encode: () => {
            throw new Error("cannot encode this value")
          }
        }
      })
      const report = yield* Fuzz.runTarget(target, { executions: 1 }).pipe(stored(store))
      assert.strictEqual(report._tag, "Falsified")
      if (report._tag !== "Falsified") return
      assert.deepStrictEqual([report.findings[0].input, report.findings[0].signature, report.findings[0].saved], [
        1,
        "ReturnedFalse",
        "Tape"
      ])
      assert.isString(report.findings[0].replay)
      assert.include(Fuzz.formatReport(report)!, "cannot encode this value")
      const failures = (yield* store.load("unencodable")).filter((entry) => entry.kind === "Failure")
      assert.strictEqual(failures.length, 1)
      assert.isUndefined(Format.decodeEntry(failures[0].text).codec)
      const replayed = yield* Fuzz.runTarget(target, { executions: 0 }).pipe(stored(store))
      assert.strictEqual(replayed._tag === "Falsified" && replayed.findings[0].saved, "Tape")
    }))

  it.effect("F4: DurationFromNanos infinity retains its schema finding with a corpus", () =>
    Effect.gen(function*() {
      const target = Fuzz.target(Schema.DurationFromNanos, (duration) => Duration.isFinite(duration), {
        id: "duration",
        revision: "1"
      })
      const report = yield* Fuzz.runTarget(target, { seed: 1, executions: 100 }).pipe(stored(Fuzz.memoryCorpus()))
      assert.strictEqual(report._tag, "Falsified")
      if (report._tag !== "Falsified") return
      assert.isFalse(Duration.isFinite(report.findings[0].input))
      assert.strictEqual(report.findings[0].saved, "Tape")
      assert.include(Fuzz.formatReport(report)!, "codec cannot encode")
    }))

  it.effect("F5: an unconfirmed failure never becomes a regression fixture", () =>
    Effect.gen(function*() {
      const store = Fuzz.memoryCorpus()
      let calls = 0
      const target = Fuzz.target(Arbitrary.Constant(0), () => ++calls % 2 === 0, {
        id: "flaky",
        revision: "1",
        codec: json
      })
      const report = yield* Fuzz.runTarget(target, { executions: 1 }).pipe(stored(store))
      assert.strictEqual(report._tag, "Flaky")
      assert.deepStrictEqual((yield* store.load("flaky")).filter((entry) => entry.kind === "Failure"), [])
      const plain = yield* Fuzz.runTarget(target, { executions: 0 }).pipe(stored(store))
      assert.deepStrictEqual([plain._tag, plain.stats.regressions, calls], ["Passed", 0, 2])
    }))

  it.effect("F5: a failure that becomes flaky after shrinking leaves no regression fixture", () =>
    Effect.gen(function*() {
      const store = Fuzz.memoryCorpus()
      const arbitrary = bySize(() => 10, 0)
      let zeroes = 0
      const target = Fuzz.target(arbitrary, (n) => n === 0 && ++zeroes % 2 === 0, {
        id: "shrunk-flaky",
        revision: "1",
        codec: json
      })
      const report = yield* Fuzz.runTarget(target, { seed: 1, executions: 1, size: 100 }).pipe(stored(store))
      assert.strictEqual(report._tag === "Flaky" && report.flaky[0].shrinks, 1)
      assert.deepStrictEqual((yield* store.load("shrunk-flaky")).filter((entry) => entry.kind === "Failure"), [])
    }))
})
