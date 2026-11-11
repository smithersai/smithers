import { assert, describe, it } from "@effect/vitest"
import { Arbitrary, Cause, Data, Deferred, Effect, Exit, Fiber, Schema, Tracer } from "effect"
import { Fuzz } from "../src/index.ts"
import * as Format from "../src/internal/fuzz/format.ts"

class Boom extends Data.TaggedError("Boom")<{ readonly n: number }> {}
class Bust extends Data.TaggedError("Bust")<{}> {}

const Int = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1000 }))
const ints = Arbitrary.schema(Int)
const intArrays = Arbitrary.schema(Schema.Array(Int))

const fuzz = <A, E = never, R = never>(
  arbitrary: Arbitrary.Arbitrary<A>,
  property: (value: A) => boolean | Effect.Effect<boolean, E, R>,
  options?: Fuzz.Options
) => Fuzz.run(arbitrary, property, { seed: 1, executions: 2_000, ...options })

const firstFinding = <A, E>(report: Fuzz.Report<A, E>): Fuzz.Finding<A, E> => {
  assert.strictEqual(report._tag, "Falsified")
  return (report as Fuzz.Falsified<A, E>).findings[0]
}

/** A store that records every save, to observe what the engine persists and when. */
const recordingStore = () => {
  const inner = Fuzz.memoryCorpus()
  const saves: Array<Fuzz.StoredEntry> = []
  const store: Fuzz.Store = {
    load: inner.load,
    save: (target, entry) => Effect.andThen(Effect.sync(() => saves.push(entry)), inner.save(target, entry))
  }
  return { store, saves }
}

const withStore = (store: Fuzz.Store) => Effect.provideService(Fuzz.Corpus, store)

describe("Fuzz", () => {
  describe("determinism", () => {
    it.effect("the same seed gives the same report", () =>
      Effect.gen(function*() {
        const property = (xs: ReadonlyArray<number>) => xs.length < 3 || xs[2] !== 7
        const a = yield* fuzz(intArrays, property, { executions: 5_000, maxFindings: 1 })
        const b = yield* fuzz(intArrays, property, { executions: 5_000, maxFindings: 1 })
        assert.deepStrictEqual(a, b)
        const c = yield* fuzz(intArrays, property, { executions: 5_000, seed: "other" })
        assert.notStrictEqual(JSON.stringify(c.stats), JSON.stringify({ ...a.stats, seed: "other" }))
      }), 30_000)

    it.effect("an unseeded run reports the seed it drew", () =>
      Effect.gen(function*() {
        const report = yield* Fuzz.run(ints, (n) => n !== 0)
        assert.strictEqual(typeof report.stats.seed, "number")
        assert.strictEqual(report.stats.stoppedBy, "Findings")
        const again = yield* Fuzz.run(ints, (n) => n !== 0, { seed: report.stats.seed, executions: 1_000 })
        assert.deepStrictEqual(firstFinding(again).input, firstFinding(report).input)
      }))
  })

  describe("findings", () => {
    it.effect("returning false is a finding, shrunk to the smallest failing input", () =>
      Effect.gen(function*() {
        const finding = firstFinding(yield* fuzz(ints, (n) => n < 500))
        assert.strictEqual(finding.signature, "ReturnedFalse")
        assert.deepStrictEqual(finding.failure, { _tag: "ReturnedFalse" })
        assert.strictEqual(finding.input, 500)
        assert.isTrue(finding.initialInput >= 500)
        assert.isTrue(finding.execution > 0)
        assert.strictEqual(finding.saved, "None")
      }))

    it.effect("typed failures keep their tag through shrinking", () =>
      Effect.gen(function*() {
        const finding = firstFinding(
          yield* fuzz(ints, (n) => n >= 100 ? Effect.fail(new Boom({ n })) : Effect.succeed(true))
        )
        assert.strictEqual(finding.signature, "PropertyError:Boom")
        assert.deepStrictEqual(finding.input, 100)
        assert.deepStrictEqual(finding.failure, { _tag: "PropertyError", error: new Boom({ n: 100 }) })
      }))

    it.effect("defects raised by the property are findings", () =>
      Effect.gen(function*() {
        const thrown = firstFinding(
          yield* fuzz(ints, (n) => {
            if (n > 10) throw new RangeError("too big")
            return true
          })
        )
        assert.strictEqual(thrown.signature, "Died:RangeError")
        assert.strictEqual(thrown.input, 11)
        const died = firstFinding(yield* fuzz(ints, (n) => n > 10 ? Effect.die("text defect") : Effect.succeed(true)))
        assert.strictEqual(died.signature, "Died:string")
        assert.deepStrictEqual(died.failure, { _tag: "Died", defect: "text defect" })
        const bare = firstFinding(
          yield* fuzz(ints, (n) => n > 10 ? Effect.die(Object.create(null)) : Effect.succeed(true))
        )
        assert.strictEqual(bare.signature, "Died:Object")
        const plain = firstFinding(yield* fuzz(ints, (n) => n > 10 ? Effect.fail({ n }) : Effect.succeed(true)))
        assert.strictEqual(plain.signature, "PropertyError:Object")
        const mixed = firstFinding(
          yield* fuzz(ints, (n) =>
            n > 10
              ? Effect.failCause(Cause.combine(Cause.fail(new Boom({ n })), Cause.die(new TypeError("x"))))
              : Effect.succeed(true))
        )
        assert.strictEqual(mixed.signature, "Died:TypeError")
      }))

    it.effect("distinct signatures are separate findings, repeats are deduplicated", () =>
      Effect.gen(function*() {
        const property = (n: number): Effect.Effect<boolean, Boom | Bust> =>
          n % 2 === 0 ? Effect.fail(new Boom({ n })) : n > 300 ? Effect.fail(new Bust()) : Effect.succeed(true)
        const report = yield* fuzz(ints, property, { maxFindings: 2 })
        assert.strictEqual(report._tag, "Falsified")
        if (report._tag === "Falsified") {
          assert.deepStrictEqual(report.findings.map((finding) => finding.signature).sort(), [
            "PropertyError:Boom",
            "PropertyError:Bust"
          ])
          // Shrinking keeps the signature, so Bust stays odd and above 300.
          const bust = report.findings.find((finding) => finding.signature === "PropertyError:Bust")!
          assert.isTrue(bust.input > 300 && bust.input % 2 === 1)
        }
        const once = yield* fuzz(ints, (n) => n % 2 === 0 ? Effect.fail(new Boom({ n })) : Effect.succeed(true), {
          maxFindings: 5,
          executions: 500
        })
        assert.strictEqual(once._tag === "Falsified" && once.findings.length, 1)
      }))

    it.effect("interruption raised by the property propagates", () =>
      Effect.gen(function*() {
        const exit = yield* Effect.exit(fuzz(ints, (n) => n > 5 ? Effect.interrupt : Effect.succeed(true)))
        assert.isTrue(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause))
      }))

    it.live("interrupting a run stops it and keeps what was saved", () =>
      Effect.gen(function*() {
        const store = Fuzz.memoryCorpus()
        const started = yield* Deferred.make<void>()
        let calls = 0
        const target = Fuzz.target(
          intArrays,
          () => ++calls === 200 ? Effect.as(Deferred.succeed(started, undefined), true) : Effect.succeed(true),
          { id: "interrupted", revision: "1" }
        )
        const fiber = yield* Fuzz.runTarget(target, { seed: 1, duration: "1 minute" }).pipe(
          withStore(store),
          Effect.forkChild
        )
        yield* Deferred.await(started)
        yield* Fiber.interrupt(fiber)
        const exit = yield* Fiber.await(fiber)
        assert.isTrue(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause))
        assert.isTrue((yield* store.load("interrupted")).length > 0)
      }))
  })

  describe("budget", () => {
    it.effect("executions, plateau and duration stop a passing run", () =>
      Effect.gen(function*() {
        const byExecutions = yield* fuzz(ints, () => true, { executions: 300 })
        assert.deepStrictEqual([byExecutions._tag, byExecutions.stats.stoppedBy], ["Passed", "Executions"])
        assert.strictEqual(byExecutions.stats.executions, 300)
        const byPlateau = yield* fuzz(ints, () => true, { executions: undefined, plateau: 200 })
        assert.strictEqual(byPlateau.stats.stoppedBy, "Plateau")
        const byDuration = yield* fuzz(ints, () => true, { executions: undefined, duration: "30 millis" })
        assert.strictEqual(byDuration.stats.stoppedBy, "Duration")
      }))

    it.effect("discards are counted and never kept", () =>
      Effect.gen(function*() {
        const never = Arbitrary.filter(ints, () => false)
        const report = yield* fuzz(never, () => false, { executions: 100 })
        assert.strictEqual(report._tag, "Exhausted")
        assert.include(Fuzz.formatReport(report)!, "all 100 executions were discarded")
        assert.deepStrictEqual([report.stats.discards, report.stats.corpus], [100, 0])
        const half = yield* fuzz(Arbitrary.filter(ints, (n) => n % 2 === 0), (n) => n % 2 === 0, { executions: 500 })
        assert.strictEqual(half._tag, "Passed")
        assert.isTrue(half.stats.discards > 0 && half.stats.discards < 500)
      }))

    it.effect("rejects invalid options", () =>
      Effect.gen(function*() {
        for (
          const options of [
            { executions: -1 },
            { plateau: 0 },
            { size: 1.5 },
            { maxShrinks: NaN },
            { maxFindings: 0 },
            {
              duration: "soon" as any
            }
          ]
        ) {
          const error = yield* Effect.flip(fuzz(ints, () => true, options))
          assert.strictEqual(error.reason, "Configuration")
        }
      }))

    it.effect("shrinking and replay skip candidates the filter rejects", () =>
      Effect.gen(function*() {
        const notOne = Arbitrary.filter(ints, (n) => n % 3 !== 1)
        const finding = firstFinding(yield* fuzz(notOne, (n) => n < 500))
        assert.strictEqual(finding.input, 500)
        const replayed = firstFinding(yield* Fuzz.run(notOne, (n) => n < 500, { replay: finding.replay }))
        assert.strictEqual(replayed.input, 500)
      }))

    it.effect("maxShrinks bounds shrinking", () =>
      Effect.gen(function*() {
        const none = firstFinding(yield* fuzz(ints, (n) => n < 500, { maxShrinks: 0 }))
        assert.deepStrictEqual([none.shrinks, none.input], [0, none.initialInput])
      }))
  })

  describe("replay", () => {
    it.effect(
      "a replay token reproduces the shrunk finding, and passes once the bug is fixed",
      () =>
        Effect.gen(function*() {
          const property = (xs: ReadonlyArray<number>) => !xs.includes(42)
          const finding = firstFinding(yield* fuzz(intArrays, property, { executions: 50_000 }))
          assert.deepStrictEqual(finding.input, [42])
          const replayed = firstFinding(yield* Fuzz.run(intArrays, property, { replay: finding.replay }))
          assert.deepStrictEqual(replayed.input, [42])
          assert.strictEqual(replayed.replay, finding.replay)
          const fixed = yield* Fuzz.run(intArrays, () => true, { replay: finding.replay })
          assert.deepStrictEqual([fixed._tag, fixed.stats.stoppedBy], ["Passed", "Replay"])
        }),
      30_000
    )

    it.effect("replay reports the current failure when its signature changes", () =>
      Effect.gen(function*() {
        const original = firstFinding(
          yield* fuzz(ints, (n) => n >= 100 ? Effect.fail(new Boom({ n })) : Effect.succeed(true))
        )
        const properties: ReadonlyArray<readonly [string, (n: number) => boolean | Effect.Effect<boolean, Bust>]> = [
          ["ReturnedFalse", (n) => n < 100],
          ["PropertyError:Bust", (n) => n >= 100 ? Effect.fail(new Bust()) : Effect.succeed(true)],
          ["Died:TypeError", (n) => {
            if (n >= 100) throw new TypeError("still broken")
            return true
          }]
        ]
        for (const [signature, property] of properties) {
          const report = yield* Fuzz.run(ints, property, { replay: original.replay })
          const current = firstFinding(report)
          assert.deepStrictEqual(
            [current.signature, current.input, current.execution, current.replay],
            [signature, 100, 1, original.replay]
          )
          assert.strictEqual(current.failure._tag, signature.split(":")[0])
          assert.deepStrictEqual(report._tag === "Falsified" && report.flaky, [])
          assert.include(Fuzz.formatReport(report)!, signature)
          assert.include(Fuzz.formatReport(report)!, `Replay expected PropertyError:Boom, got ${signature}`)
        }
      }))

    it.effect("replay confirms a changed signature against the current failure", () =>
      Effect.gen(function*() {
        const original = firstFinding(yield* fuzz(Arbitrary.Constant(0), () => Effect.fail(new Bust())))
        let calls = 0
        const report = yield* Fuzz.run(Arbitrary.Constant(0), () => calls++ === 0 ? false : Effect.die("changed again"), {
          replay: original.replay
        })
        assert.strictEqual(report._tag, "Flaky")
        if (report._tag !== "Flaky") return
        assert.deepStrictEqual(
          [report.flaky[0].signature, report.flaky[0].failure, report.flaky[0].recheck, calls],
          ["ReturnedFalse", { _tag: "ReturnedFalse" }, { _tag: "Died", defect: "changed again" }, 2]
        )
        assert.include(Fuzz.formatReport(report)!, "then gave Died:string")
        assert.include(Fuzz.formatReport(report)!, "Replay expected PropertyError:Bust, got ReturnedFalse")
      }))

    it.effect("formatting replay reports tolerates missing or invalid tokens", () =>
      Effect.gen(function*() {
        const original = firstFinding(yield* fuzz(Arbitrary.Constant(0), () => false))
        const report = yield* Fuzz.run(Arbitrary.Constant(0), () => false, { replay: original.replay })
        assert.strictEqual(report._tag, "Falsified")
        if (report._tag !== "Falsified") return
        assert.notInclude(Fuzz.formatReport(report)!, "Replay expected")
        for (const replay of [undefined, "invalid token"]) {
          const supplied: Fuzz.Falsified<number, never> = {
            ...report,
            findings: [{ ...report.findings[0], replay }]
          }
          const text = Fuzz.formatReport(supplied)!
          assert.include(text, "returned false")
          assert.notInclude(text, "Replay expected")
        }
      }))

    it.effect("a token that cannot regenerate reports ReplayMismatch", () =>
      Effect.gen(function*() {
        const finding = firstFinding(yield* fuzz(ints, (n) => n < 500))
        const data = Format.decodeReplay(finding.replay!)
        const broken = Format.encodeReplay({ ...data, path: [...data.path, 9_999] })
        const missing = yield* Fuzz.run(ints, (n) => n < 500, { replay: broken })
        assert.deepStrictEqual([missing._tag, missing.stats.stale], ["ReplayMismatch", 1])
        assert.include(Fuzz.formatReport(missing)!, "cannot regenerate")
        const discarded = Format.encodeReplay({ ...data, path: [] })
        const never = Arbitrary.filter(ints, () => false)
        const rejected = yield* Fuzz.run(never, () => false, { replay: discarded })
        assert.deepStrictEqual([rejected._tag, rejected.stats.stale], ["ReplayMismatch", 1])
      }))

    it.effect("an invalid token is a configuration error", () =>
      Effect.gen(function*() {
        const error = yield* Effect.flip(Fuzz.run(ints, () => true, { replay: "[0,\"1\",0,10,[],\"ReturnedFalse\"]" }))
        assert.strictEqual(error.reason, "Configuration")
      }))
  })

  describe("feedback", () => {
    it.effect("spans guide the search and still reach the installed tracer", () =>
      Effect.gen(function*() {
        const names: Array<string> = []
        const native = yield* Effect.tracer
        const tracer = Tracer.make({
          span(options) {
            names.push(options.name)
            return native.span(options)
          }
        })
        const inner = Effect.fn("inner")(function*() {})
        const outer = Effect.fn("outer")(function*(n: number) {
          if (n > 900) yield* inner()
          return true
        })
        const report = yield* fuzz(ints, outer, { executions: 300 }).pipe(Effect.withTracer(tracer))
        assert.strictEqual(report.stats.features.spans, 2)
        assert.isTrue(names.includes("inner"))
        const off = yield* fuzz(ints, outer, { executions: 300, feedback: [] })
        assert.isUndefined(off.stats.features.spans)
      }))

    it.effect("observations and scores admit inputs; outside a run they do nothing", () =>
      Effect.gen(function*() {
        yield* Fuzz.observe("outside")
        yield* Fuzz.score("outside", 1)
        // A needle random search cannot find in this budget; the score climbs to it.
        const wide = Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000_000 })))
        const needle = (n: number) => n !== 777_777_777
        const blind = yield* fuzz(wide, needle, { executions: 100_000, feedback: [] })
        assert.strictEqual(blind._tag, "Passed")
        const climbed = yield* fuzz(wide, (n) =>
          Effect.as(Fuzz.score("closeness", -Math.abs(n - 777_777_777)), needle(n)), {
          executions: 100_000,
          feedback: []
        })
        assert.strictEqual(firstFinding(climbed).input, 777_777_777)
        const observed = yield* fuzz(ints, (n) =>
          Effect.as(Fuzz.observe(n > 500 ? "high" : "low"), true), {
          executions: 300
        })
        assert.strictEqual(observed.stats.features.observations, 2)
        // Hit counts are bucketed, so repeating an observation more often is new feedback up to 128 hits.
        const repeated = yield* fuzz(
          ints,
          (n) =>
            Effect.as(Effect.forEach(Array.from({ length: n % 200 }), () => Fuzz.observe("loop")), true),
          { executions: 3_000, feedback: [] }
        )
        assert.strictEqual(repeated.stats.features.observations, 8)
      }), 30_000)

    it.effect("labels structural exploration honestly", () =>
      Effect.gen(function*() {
        const structural = Fuzz.formatReport(yield* fuzz(ints, (n) => n < 500, { feedback: [] }))!
        assert.include(structural, "Feedback: structural exploration")
        assert.notInclude(structural, "coverage")
        assert.deepStrictEqual(
          Object.keys((yield* fuzz(ints, (n) => n < 500, { feedback: [] })).stats.features).sort(),
          ["causes", "structural"]
        )
        const observed = Fuzz.formatReport(
          yield* fuzz(ints, (n) => Effect.as(Fuzz.observe("seen"), n < 500), { feedback: [] })
        )!
        assert.include(observed, "Feedback: observations")
        assert.include(observed, "Replay: fuzz1:")
        assert.isUndefined(Fuzz.formatReport(yield* fuzz(ints, () => true, { executions: 10 })))
      }))

    it.effect("formats every failure kind", () =>
      Effect.gen(function*() {
        const format = (property: (n: number) => boolean | Effect.Effect<boolean, unknown>) =>
          Effect.map(fuzz(ints, property), (report) => Fuzz.formatReport(report)!)
        assert.include(yield* format((n) => n < 5), "returned false")
        assert.include(yield* format((n) => n < 5 ? Effect.succeed(true) : Effect.fail(new Boom({ n }))), "Boom")
        assert.include(yield* format((n) => n < 5 ? Effect.succeed(true) : Effect.fail(Cause.fail("c"))), "c")
        assert.include(yield* format((n) => n < 5 ? Effect.succeed(true) : Effect.die(new Error("e"))), "Error: e")
        assert.include(yield* format((n) => n < 5 ? Effect.succeed(true) : Effect.die(7)), "7")
      }))
  })

  describe("infrastructure errors are never findings", () => {
    it.effect("a dying generator is a Generation error", () =>
      Effect.gen(function*() {
        const broken = Arbitrary.map(ints, (n) => {
          if (n > 3) throw new Error("map bug")
          return n
        })
        const error = yield* Effect.flip(fuzz(broken, () => true))
        assert.deepStrictEqual([error._tag, error.reason], ["FuzzError", "Generation"])
        assert.include(error.message, "map bug")
      }))

    it.effect("a nondeterministic generator is a Generation error", () =>
      Effect.gen(function*() {
        let calls = 0
        const flaky = Arbitrary.filter(ints, () => calls++ % 2 === 0)
        const error = yield* Effect.flip(fuzz(flaky, () => false))
        assert.strictEqual(error.reason, "Generation")
        assert.include(error.message, "not deterministic")
      }))

    it.effect("a dying shrink candidate is a Generation error", () =>
      Effect.gen(function*() {
        const shrinkBug = Arbitrary.schema(Int, {
          shrink: () => {
            throw new Error("shrink bug")
          }
        })
        const error = yield* Effect.flip(fuzz(shrinkBug, (n) => n < 500))
        assert.strictEqual(error.reason, "Generation")
        assert.include(error.message, "shrink bug")
      }))

    it.effect("a dying feedback source is a Feedback error", () =>
      Effect.gen(function*() {
        const faulty: Fuzz.Feedback = { name: "faulty", measure: () => Effect.die("feedback bug") }
        const error = yield* Effect.flip(fuzz(ints, () => true, { feedback: [faulty] }))
        assert.strictEqual(error.reason, "Feedback")
        assert.include(error.message, "faulty")
      }))

    it.effect("a dying execution driver is an Execution error", () =>
      Effect.gen(function*() {
        const faulty: Fuzz.Execution = { name: "faulty", run: () => Effect.die(new Error("driver bug")) }
        const error = yield* Effect.flip(fuzz(ints, () => true, { execution: faulty }))
        assert.strictEqual(error.reason, "Execution")
        assert.include(error.message, "driver bug")
      }))
  })

  describe("execution drivers", () => {
    // A driver that reads eight schedule words and fails when the fourth is odd, standing in for a schedule race.
    const racy: Fuzz.Execution = {
      name: "racy",
      run: (self, schedule) =>
        Effect.map(self, (exit) => {
          const words = Array.from({ length: 8 }, schedule.next)
          return words[5] % 7 === 1 ? { _tag: "Limited" } : words[3] % 64 === 1 ? { _tag: "Deadlock" } : {
            _tag: "Completed",
            exit
          }
        })
    }

    it.effect("deadlocks are findings, limited executions are discards, and schedules shrink", () =>
      Effect.gen(function*() {
        const report = yield* fuzz(ints, () => true, { execution: racy })
        const finding = firstFinding(report)
        assert.deepStrictEqual(finding.failure, { _tag: "Deadlock" })
        assert.isTrue(report.stats.discards > 0)
        const data = Format.decodeReplay(finding.replay!)
        assert.deepStrictEqual(data.input.schedule.map((word, index) => index === 3 ? word % 64 : word), [
          0,
          0,
          0,
          1,
          0,
          0,
          0,
          0
        ])
        const replayed = firstFinding(yield* Fuzz.run(ints, () => true, { execution: racy, replay: finding.replay }))
        assert.strictEqual(replayed.signature, "Deadlock")
        assert.include(Fuzz.formatReport(report)!, "deadlock")
      }))
  })

  describe("corpus", () => {
    it.effect("a store needs a target", () =>
      Effect.gen(function*() {
        const error = yield* Effect.flip(fuzz(ints, () => true).pipe(withStore(Fuzz.memoryCorpus())))
        assert.strictEqual(error.reason, "Configuration")
      }))

    it.effect("a failure is saved only after shrinking and confirmation", () =>
      Effect.gen(function*() {
        const { saves, store } = recordingStore()
        const target = Fuzz.target(Int, (n) => n < 500, { id: "order", revision: "1" })
        const finding = firstFinding(
          yield* Fuzz.runTarget(target, { seed: 1, executions: 2_000 }).pipe(withStore(store))
        )
        const failures = saves.filter((entry) => entry.kind === "Failure").map((entry) =>
          Format.decodeEntry(entry.text)
        )
        assert.strictEqual(failures.length, 1)
        assert.isTrue(failures[0].path.length > 0)
        assert.strictEqual(failures[0].value, "500")
        assert.strictEqual(finding.saved, "Value")
        assert.isTrue(saves.some((entry) => entry.kind === "Input"))
      }))

    it.effect("saved failures replay first and stop failing once the bug is fixed", () =>
      Effect.gen(function*() {
        const store = Fuzz.memoryCorpus()
        const buggy = Fuzz.target(Int, (n) => n < 500, { id: "regression", revision: "1" })
        yield* Fuzz.runTarget(buggy, { seed: 1, executions: 2_000 }).pipe(withStore(store))
        const again = yield* Fuzz.runTarget(buggy, { seed: 2, executions: 0 }).pipe(withStore(store))
        const regression = firstFinding(again)
        assert.deepStrictEqual([regression.input, regression.execution, again.stats.regressions], [500, 0, 1])
        assert.isString(regression.replay)
        const fixed = Fuzz.target(Int, () => true, { id: "regression", revision: "1" })
        const passing = yield* Fuzz.runTarget(fixed, { seed: 2, executions: 0 }).pipe(withStore(store))
        assert.deepStrictEqual([passing._tag, passing.stats.regressions, passing.stats.stoppedBy], [
          "Passed",
          1,
          "Executions"
        ])
      }))

    it.effect("a revision change invalidates tapes, never value fixtures", () =>
      Effect.gen(function*() {
        const store = Fuzz.memoryCorpus()
        const tapes = Fuzz.target(ints, (n) => n < 500, { id: "tapes", revision: "1" })
        const first = yield* Fuzz.runTarget(tapes, { seed: 1, executions: 2_000 }).pipe(withStore(store))
        assert.strictEqual(firstFinding(first).saved, "Tape")
        assert.include(Fuzz.formatReport(first)!, "replays only until the target revision changes")
        const sameRevision = yield* Fuzz.runTarget(tapes, { executions: 0 }).pipe(withStore(store))
        assert.strictEqual(firstFinding(sameRevision).input, 500)
        const bumped = Fuzz.target(ints, (n) => n < 500, { id: "tapes", revision: "2" })
        const stale = yield* Fuzz.runTarget(bumped, { seed: 1, executions: 10 }).pipe(withStore(store))
        assert.isTrue(stale.stats.stale > 1)
        assert.strictEqual(stale.stats.regressions, 0)

        const values = Fuzz.target(Int, (n) => n < 500, { id: "values", revision: "1" })
        yield* Fuzz.runTarget(values, { seed: 1, executions: 2_000 }).pipe(withStore(store))
        // The generator changed completely; the saved value still replays.
        const replaced = Fuzz.target(Arbitrary.Constant(0), (n) => n < 500, {
          id: "values",
          revision: "2",
          codec: { id: "json", encode: JSON.stringify, decode: JSON.parse }
        })
        const report = yield* Fuzz.runTarget(replaced, { executions: 0 }).pipe(withStore(store))
        const regression = firstFinding(report)
        assert.deepStrictEqual([regression.input, regression.replay, report.stats.stale], [500, undefined, 0])
        assert.notInclude(Fuzz.formatReport(report)!, "Replay:")
      }))

    it.effect("a saved tape whose shrink path disappeared is stale", () =>
      Effect.gen(function*() {
        const store = Fuzz.memoryCorpus()
        const input: Format.Input = {
          size: 0,
          bias: 2,
          nullPrototype: false,
          key: 1,
          words: [],
          scheduleKey: 0,
          schedule: []
        }
        yield* store.save("gone", {
          kind: "Failure",
          key: "x",
          text: Format.encodeEntry({ kind: "failure", revision: "1", input, signature: "ReturnedFalse", path: [5] })
        })
        const target = Fuzz.target(Arbitrary.Constant(1), () => false, { id: "gone", revision: "1" })
        const report = yield* Fuzz.runTarget(target, { executions: 0 }).pipe(withStore(store))
        assert.deepStrictEqual([report._tag, report.stats.stale], ["Passed", 1])
        const never = Fuzz.target(Arbitrary.filter(ints, () => false), () => false, { id: "gone", revision: "1" })
        const discarded = yield* Fuzz.runTarget(never, { executions: 0 }).pipe(withStore(store))
        assert.strictEqual(discarded.stats.stale, 1)
      }))

    it.effect("saved inputs rebuild the feature map", () =>
      Effect.gen(function*() {
        const store = Fuzz.memoryCorpus()
        const target = Fuzz.target(intArrays, () => true, { id: "inputs", revision: "1" })
        const first = yield* Fuzz.runTarget(target, { seed: 1, executions: 500 }).pipe(withStore(store))
        const saved = (yield* store.load("inputs")).length
        assert.strictEqual(saved, first.stats.corpus)
        const second = yield* Fuzz.runTarget(target, { seed: 1, executions: saved }).pipe(withStore(store))
        // Replaying the saved inputs rediscovers the same features without adding new entries.
        assert.deepStrictEqual(second.stats.features, first.stats.features)
      }))

    it.effect("decode problems and codec-id mismatches are Codec errors", () =>
      Effect.gen(function*() {
        const store = Fuzz.memoryCorpus()
        yield* Fuzz.runTarget(Fuzz.target(Int, (n) => n < 500, { id: "codec", revision: "1" }), {
          seed: 1,
          executions: 2_000
        }).pipe(withStore(store))
        const other = Fuzz.target(ints, () => true, {
          id: "codec",
          revision: "1",
          codec: { id: "other", encode: String, decode: Number }
        })
        assert.strictEqual((yield* Effect.flip(Fuzz.runTarget(other).pipe(withStore(store)))).reason, "Codec")
        const none = Fuzz.target(ints, () => true, { id: "codec", revision: "1" })
        assert.include((yield* Effect.flip(Fuzz.runTarget(none).pipe(withStore(store)))).message, "none")
        const undecodable = Fuzz.target(ints, () => true, {
          id: "codec",
          revision: "1",
          codec: {
            id: "json",
            encode: String,
            decode: () => {
              throw new Error("bad value")
            }
          }
        })
        assert.include((yield* Effect.flip(Fuzz.runTarget(undecodable).pipe(withStore(store)))).message, "bad value")
      }))

    it.effect("store failures and unreadable entries are Corpus errors", () =>
      Effect.gen(function*() {
        const target = Fuzz.target(ints, () => true, { id: "broken", revision: "1" })
        const failing: Fuzz.Store = {
          load: () => Effect.fail(new Fuzz.FuzzError({ reason: "Corpus", message: "disk on fire" })),
          save: () => Effect.void
        }
        assert.strictEqual((yield* Effect.flip(Fuzz.runTarget(target).pipe(withStore(failing)))).reason, "Corpus")
        const garbage = Fuzz.memoryCorpus()
        yield* garbage.save("broken", { kind: "Input", key: "k", text: "not an entry" })
        const error = yield* Effect.flip(Fuzz.runTarget(target).pipe(withStore(garbage)))
        assert.deepStrictEqual([error.reason, error.message.includes("Input k")], ["Corpus", true])
      }))
  })

  describe("boundaries", () => {
    const input: Format.Input = {
      size: 10,
      bias: 2,
      nullPrototype: false,
      key: 1,
      words: [],
      scheduleKey: 0,
      schedule: []
    }
    const token = (signature: string, path: ReadonlyArray<number> = []) =>
      Format.encodeReplay({ input, path, signature })

    it.effect("a codec value with newlines and field-looking lines replays as the same value", () =>
      Effect.gen(function*() {
        const text = "a\nb\nkind input\nvalue c"
        const raw: Fuzz.Codec<string> = { id: "raw\ncodec", encode: (value) => value, decode: (value) => value }
        const target = Fuzz.target(Arbitrary.Constant(text), (value) => value !== text, {
          id: "multiline",
          revision: "1\nkind input",
          codec: raw
        })
        const store = Fuzz.memoryCorpus()
        assert.strictEqual(
          firstFinding(yield* Fuzz.runTarget(target, { seed: 1, executions: 10 }).pipe(withStore(store))).input,
          text
        )
        const regression = yield* Fuzz.runTarget(target, { executions: 0 }).pipe(withStore(store))
        assert.deepStrictEqual([firstFinding(regression).input, regression.stats.regressions], [text, 1])
      }))

    it.effect("store defects are Corpus errors", () =>
      Effect.gen(function*() {
        const target = Fuzz.target(ints, () => true, { id: "defects", revision: "1" })
        const stores: ReadonlyArray<Fuzz.Store> = [
          {
            load: () => {
              throw new Error("load threw")
            },
            save: () => Effect.void
          },
          { load: () => Effect.die(new Error("load died")), save: () => Effect.void },
          { load: () => Effect.succeed([]), save: () => Effect.die(new Error("save died")) }
        ]
        for (const store of stores) {
          const exit = yield* Effect.exit(Fuzz.runTarget(target, { seed: 1, executions: 10 }).pipe(withStore(store)))
          assert.isTrue(Exit.isFailure(exit) && Cause.hasFails(exit.cause), "a defect escaped the FuzzError channel")
          const error = yield* Effect.flip(Fuzz.runTarget(target, { seed: 1, executions: 10 }).pipe(withStore(store)))
          assert.strictEqual(error.reason, "Corpus")
        }
      }))

    it.effect("a dying shrink pull while following a replay path is a Generation error", () =>
      Effect.gen(function*() {
        const shrinkBug = Arbitrary.schema(Int, {
          shrink: () => {
            throw new Error("lazy shrink defect")
          }
        })
        const exit = yield* Effect.exit(Fuzz.run(shrinkBug, () => false, { replay: token("ReturnedFalse", [0]) }))
        assert.isTrue(Exit.isFailure(exit) && Cause.hasFails(exit.cause), "a defect escaped the FuzzError channel")
        const error = yield* Effect.flip(Fuzz.run(shrinkBug, () => false, { replay: token("ReturnedFalse", [0]) }))
        assert.deepStrictEqual([error.reason, error.message.includes("lazy shrink defect")], ["Generation", true])
      }))

    it.effect("a replay token must name a failure", () =>
      Effect.gen(function*() {
        for (const signature of ["Passed", "Limited", "Died:", ""]) {
          const error = yield* Effect.flip(Fuzz.run(ints, () => true, { replay: token(signature) }))
          assert.strictEqual(error.reason, "Configuration", signature)
        }
      }))

    it.effect("an in-memory target never calls its codec", () =>
      Effect.gen(function*() {
        const throwing: Fuzz.Codec<number> = {
          id: "throwing",
          encode: () => {
            throw new Error("encode called")
          },
          decode: () => {
            throw new Error("decode called")
          }
        }
        const target = Fuzz.target(Arbitrary.Constant(0), () => false, { id: "memory", revision: "1", codec: throwing })
        const finding = firstFinding(yield* Fuzz.runTarget(target, { seed: 1, executions: 10 }))
        assert.deepStrictEqual([finding.signature, finding.saved], ["ReturnedFalse", "None"])
      }))
  })

  describe("confirmation", () => {
    it.effect("a finding's final input is evaluated once more before it is reported", () =>
      Effect.gen(function*() {
        let calls = 0
        const report = yield* Fuzz.run(Arbitrary.Constant(0), () => {
          calls++
          return false
        }, { seed: 1, executions: 1 })
        assert.deepStrictEqual([report._tag, calls], ["Falsified", 2])
        assert.deepStrictEqual(report._tag === "Falsified" && report.flaky, [])
      }))

    it.effect("a failure that passes on the second evaluation is flaky, never Falsified", () =>
      Effect.gen(function*() {
        let calls = 0
        const report = yield* Fuzz.run(Arbitrary.Constant(0), () => calls++ !== 0, { seed: 1, executions: 10 })
        assert.strictEqual(report._tag, "Flaky")
        if (report._tag !== "Flaky") return
        const [flaky] = report.flaky
        assert.deepStrictEqual([flaky.signature, flaky.failure, flaky.recheck], [
          "ReturnedFalse",
          { _tag: "ReturnedFalse" },
          { _tag: "Passed" }
        ])
        // The search went on: a flaky finding does not count toward maxFindings.
        assert.deepStrictEqual([report.stats.executions, report.stats.stoppedBy], [10, "Executions"])
        const text = Fuzz.formatReport(report)!
        assert.include(text, "0 failure(s) and 1 flaky failure(s)")
        assert.include(text, "FLAKY ReturnedFalse after 0 shrink(s): the same input then gave Passed")
        assert.include(text, "Then: passed")
      }))

    it.effect("a failure that changes signature keeps both outcomes, beside confirmed findings", () =>
      Effect.gen(function*() {
        let calls = 0
        const report = yield* Fuzz.run(
          Arbitrary.Constant(0),
          () => calls++ === 0 ? false : Effect.die(new RangeError("later")),
          { seed: 1, executions: 10 }
        )
        assert.strictEqual(report._tag, "Falsified")
        if (report._tag !== "Falsified") return
        assert.deepStrictEqual(report.findings.map((finding) => finding.signature), ["Died:RangeError"])
        assert.deepStrictEqual(report.flaky.map((finding) => [finding.signature, finding.recheck._tag]), [[
          "ReturnedFalse",
          "Died"
        ]])
        assert.include(Fuzz.formatReport(report)!, "1 failure(s) and 1 flaky failure(s)")
        assert.include(Fuzz.formatReport(report)!, "then gave Died:RangeError")
      }))

    it.effect("saved failures and replay tokens are confirmed too", () =>
      Effect.gen(function*() {
        const store = Fuzz.memoryCorpus()
        const deterministic = Fuzz.target(Int, (n) => n < 500, { id: "flaky-saved", revision: "1" })
        const found = firstFinding(
          yield* Fuzz.runTarget(deterministic, { seed: 1, executions: 2_000 }).pipe(withStore(store))
        )
        // Every second evaluation passes, whatever the input.
        let calls = 0
        const alternating = Fuzz.target(Int, (n) => calls++ % 2 === 1 || n < 500, { id: "flaky-saved", revision: "1" })
        const regression = yield* Fuzz.runTarget(alternating, { executions: 0 }).pipe(withStore(store))
        assert.deepStrictEqual([regression._tag, regression.stats.regressions, calls], ["Flaky", 1, 2])
        calls = 0
        const replayed = yield* Fuzz.runTarget(alternating, { replay: found.replay })
        assert.deepStrictEqual(
          [replayed._tag, replayed._tag === "Flaky" && replayed.flaky[0].recheck, calls],
          ["Flaky", { _tag: "Passed" }, 2]
        )
      }))

    it.effect("a simulated evaluation that hits its step limit on the recheck is flaky", () =>
      Effect.gen(function*() {
        let runs = 0
        const flakyDriver: Fuzz.Execution = {
          name: "flaky-driver",
          run: (self) =>
            runs++ === 0
              ? Effect.map(self, (exit) => ({ _tag: "Completed", exit }))
              : Effect.succeed({ _tag: "Limited" })
        }
        const report = yield* Fuzz.run(Arbitrary.Constant(0), () => false, {
          seed: 1,
          executions: 1,
          execution: flakyDriver
        })
        assert.deepStrictEqual(report._tag === "Flaky" && report.flaky[0].recheck, { _tag: "Limited" })
        assert.include(Fuzz.formatReport(report)!, "Then: reached the simulation step limit")
      }))
  })
})
