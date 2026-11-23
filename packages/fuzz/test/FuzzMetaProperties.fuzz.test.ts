import { Fuzz, FuzzSimulation } from "@smthrs/fuzz"
import { Arbitrary, Clock, Duration, Effect, Exit, Schema } from "effect"
import { expect, it } from "vitest"

const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "100"))
const pureExecutions = Math.max(25, Math.min(baseExecutions, 150))
const ioExecutions = Math.max(15, Math.min(Math.ceil(baseExecutions / 3), 50))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")
const int = (minimum: number, maximum: number) =>
  Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum, maximum })))
const seeds = int(-2147483648, 2147483647)
const words = Arbitrary.array(int(0, 31), { maxLength: 10 })

const check = async <A, E>(
  arb: Arbitrary.Arbitrary<A>,
  property: (input: A) => Effect.Effect<boolean, E>,
  executions = pureExecutions
) => {
  const report = await Effect.runPromise(Fuzz.run(arb, property, { seed, executions }))
  expect(report._tag, Fuzz.formatReport(report)).toBe("Passed")
}

it("repeats every generated input and feedback-guided search decision for a seed", () =>
  check(seeds, (trialSeed) =>
    Effect.gen(function*() {
      const search = Effect.gen(function*() {
        const trace: Array<ReadonlyArray<number>> = []
        const report = yield* Fuzz.run(words, (xs) =>
          Effect.gen(function*() {
            trace.push([...xs])
            yield* Fuzz.score("sum", xs.reduce((sum, n) => sum + n, 0))
            yield* Fuzz.observe(xs.length % 2 === 0 ? "even" : "odd")
            return true
          }), { seed: trialSeed, executions: 18 })
        return { trace, report }
      })
      const first = yield* search
      expect(first.trace).toHaveLength(18)
      expect(first.report._tag).toBe("Passed")
      expect(yield* search).toEqual(first)
      return true
    })))

it("bounds shrink evaluations, preserves failure, and reaches the first failing length", () =>
  check(
    Arbitrary.all({ trialSeed: seeds, threshold: int(1, 4), budget: int(0, 12) }),
    (input) =>
      Effect.gen(function*() {
        for (const limit of [input.budget, 128]) {
          let calls = 0
          const accepts = (xs: ReadonlyArray<number>) => xs.length < input.threshold
          const report = yield* Fuzz.run(words, (xs) => {
            calls++
            return accepts(xs)
          }, {
            seed: input.trialSeed,
            executions: 128,
            maxShrinks: limit
          })
          if (report._tag !== "Falsified") return false
          const finding = report.findings[0]
          expect(calls).toBeLessThanOrEqual(finding.execution + limit + 1)
          expect(accepts(finding.input)).toBe(false)
          expect(finding.input.length).toBeLessThanOrEqual(finding.initialInput.length)
          expect(finding.shrinks).toBeLessThanOrEqual(limit)
          if (limit === 128) expect(finding.input.length).toBe(input.threshold)
          expect(finding.replay).toBeDefined()
          const replayed = yield* Fuzz.run(words, accepts, { replay: finding.replay })
          if (replayed._tag !== "Falsified") return false
          expect(replayed.findings[0].input).toEqual(finding.input)
        }
        return true
      })
  ))

it("replays fiber interleavings and advances virtual time only to outstanding deadlines", () =>
  check(
    Arbitrary.all({
      delays: Arbitrary.array(int(1, 7), { minLength: 2, maxLength: 7 }),
      tape: Arbitrary.array(int(0, 255), { minLength: 1, maxLength: 8 })
    }),
    ({ delays, tape }) =>
      Effect.gen(function*() {
        const run = Effect.gen(function*() {
          let cursor = 0
          const wakes: Array<{ id: number; at: number }> = []
          const program = Effect.gen(function*() {
            const clock = yield* Clock.Clock
            expect(yield* clock.currentTimeMillis).toBe(0)
            yield* Effect.forEach(delays, (delay, id) =>
              Effect.gen(function*() {
                yield* clock.sleep(Duration.millis(delay))
                wakes.push({ id, at: yield* clock.currentTimeMillis })
              }), { concurrency: "unbounded" })
            expect(yield* clock.monotonicTimeNanos).toBe(BigInt(Math.max(...delays)) * 1_000_000n)
          })
          const result = yield* FuzzSimulation.execution().run(Effect.exit(program), {
            next: () => tape[cursor++ % tape.length]!
          })
          if (result._tag !== "Completed") throw new Error(result._tag)
          if (Exit.isFailure(result.exit)) return yield* Effect.failCause(result.exit.cause)
          return wakes
        })
        const first = yield* run
        expect(first.map(({ at }) => at)).toEqual([...delays].sort((a, b) => a - b))
        expect([...first].sort((a, b) => a.id - b.id)).toEqual(delays.map((at, id) => ({ id, at })))
        expect(yield* run).toEqual(first)
        return true
      }),
    ioExecutions
  ))

const text = Arbitrary.array(
  Arbitrary.schema(Schema.Literals(["a", "\nkind input\n", "\0", "\"", "\\", "😀", "\ud800"])),
  { maxLength: 8 }
).pipe(Arbitrary.map((parts) => parts.join("")))

it("restores serialized corpus entries into a fresh store and replays across revisions", () =>
  check(
    Arbitrary.all({ value: text, revision: text, trialSeed: seeds }),
    ({ value, revision, trialSeed }) =>
      Effect.gen(function*() {
        const store = Fuzz.memoryCorpus()
        const id = "meta/corpus"
        const original = Fuzz.target(Schema.Literal(value), () => false, { id, revision })
        const first = yield* Fuzz.runTarget(original, { seed: trialSeed, executions: 1 }).pipe(
          Effect.provideService(Fuzz.Corpus, store)
        )
        if (first._tag !== "Falsified") return false
        expect(first.findings[0].saved).toBe("Value")
        const restored = Fuzz.memoryCorpus()
        const entries = yield* store.load(id)
        expect(entries.filter((entry) => entry.kind === "Failure")).toHaveLength(1)
        for (const entry of entries) yield* restored.save(id, { ...entry })
        const seen: Array<string> = []
        const fresh = Fuzz.target(Schema.String, (current) => {
          seen.push(current)
          return current !== value
        }, {
          id,
          revision: revision + "/next"
        })
        const replay = yield* Fuzz.runTarget(fresh, { executions: 0, seed: trialSeed }).pipe(
          Effect.provideService(Fuzz.Corpus, restored)
        )
        if (replay._tag !== "Falsified") return false
        expect(replay.stats.regressions).toBe(1)
        expect(replay.stats.executions).toBe(0)
        expect(replay.findings[0].input).toBe(value)
        expect(seen.length).toBeGreaterThan(0)
        expect(new Set(seen)).toEqual(new Set([value]))
        return true
      }),
    ioExecutions
  ))
