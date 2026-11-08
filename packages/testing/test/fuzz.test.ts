import { assert, describe, it } from "../src/Vitest.ts"
import * as InternalFuzz from "../src/internal/fuzz.ts"
import { makeMethods } from "../src/internal/FuzzRegistration.ts"
import { Arbitrary, Clock, Effect, Ref, Schema } from "effect"
import { Fuzz } from "@smthrs/fuzz"
import { FuzzSimulation } from "@smthrs/fuzz"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import * as V from "vitest"

const Small = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1000 }))

const temporary = () => fs.mkdtempSync(path.join(os.tmpdir(), "effect-fuzz-"))

describe("fuzz session switch", () => {
  it("selects tests by EFFECT_FUZZ", () => {
    assert.isUndefined(InternalFuzz.session({}, "parser"))
    assert.isUndefined(InternalFuzz.session({ EFFECT_FUZZ: "" }, "parser"))
    assert.isUndefined(InternalFuzz.session({ EFFECT_FUZZ: "bank" }, "parser"))
    assert.deepStrictEqual(InternalFuzz.session({ EFFECT_FUZZ: "1" }, "parser"), {})
    assert.deepStrictEqual(
      InternalFuzz.session({
        EFFECT_FUZZ: "pars",
        EFFECT_FUZZ_DURATION: "2 minutes",
        EFFECT_FUZZ_EXECUTIONS: "500",
        EFFECT_FUZZ_SEED: "42"
      }, "parser"),
      { duration: "2 minutes", executions: 500, seed: 42 }
    )
    assert.deepStrictEqual(InternalFuzz.session({ EFFECT_FUZZ: "1", EFFECT_FUZZ_SEED: "night" }, "x"), {
      seed: "night"
    })
  })

  it("raises the timeout to the duration plus cleanup, or removes it for execution budgets", () => {
    assert.strictEqual(InternalFuzz.sessionTimeout({}), 40_000)
    assert.strictEqual(InternalFuzz.sessionTimeout({ duration: "1 minute" }), 90_000)
    assert.strictEqual(InternalFuzz.sessionTimeout({ executions: 10 }), 0)
    assert.strictEqual(InternalFuzz.sessionTimeout({ plateau: 10 }), 0)
    assert.strictEqual(InternalFuzz.sessionTimeout({ duration: "1 second", executions: 10 }), 31_000)
  })
})

describe("fuzz file corpus", () => {
  it("puts failures beside the test file and inputs in the cache", () => {
    assert.deepStrictEqual(InternalFuzz.corpusDirectories("/repo/src/Bank.test.ts", "/repo"), {
      failures: "/repo/src/__fuzz__/Bank.test.ts",
      inputs: "/repo/node_modules/.cache/effect-fuzz/src/Bank.test.ts"
    })
  })

  it.effect("saves and loads entries by kind and key", () =>
    Effect.gen(function*() {
      const root = temporary()
      const store = InternalFuzz.fileCorpus({ failures: path.join(root, "f"), inputs: path.join(root, "i") })
      assert.deepStrictEqual(yield* store.load("a b/c"), [])
      yield* store.save("a b/c", { kind: "Input", key: "2", text: "input" })
      yield* store.save("a b/c", { kind: "Failure", key: "1", text: "failure" })
      yield* store.save("a b/c", { kind: "Failure", key: "1", text: "shrunk" })
      const [directory] = fs.readdirSync(path.join(root, "f"))
      fs.writeFileSync(path.join(root, "f", directory, "0.tmp"), "partial")
      assert.deepStrictEqual(yield* store.load("a b/c"), [
        { kind: "Failure", key: "1", text: "shrunk" },
        { kind: "Input", key: "2", text: "input" }
      ])
      assert.isTrue(fs.existsSync(path.join(root, "f", directory, "1")))
      assert.match(directory, /^a-b-c-[0-9a-f]{16}$/)
    }))

  it.effect("reports file system failures as Corpus errors", () =>
    Effect.gen(function*() {
      const root = temporary()
      const file = path.join(root, "file")
      fs.writeFileSync(file, "")
      const store = InternalFuzz.fileCorpus({ failures: file, inputs: file })
      const saveError = yield* Effect.flip(store.save("t", { kind: "Failure", key: "1", text: "x" }))
      assert.deepStrictEqual([saveError.reason, saveError.message.includes("cannot save Failure 1 of t")], [
        "Corpus",
        true
      ])
      const dir = path.join(root, "dir")
      const unreadable = InternalFuzz.fileCorpus({ failures: dir, inputs: dir })
      // Replace the target directory with a file.
      yield* unreadable.save("t", { kind: "Failure", key: "1", text: "x" })
      const [target] = fs.readdirSync(dir)
      fs.rmSync(path.join(dir, target), { recursive: true })
      fs.writeFileSync(path.join(dir, target), "")
      const loadError = yield* Effect.flip(unreadable.load("t"))
      assert.deepStrictEqual([loadError.reason, loadError.message.includes("cannot read the corpus of t")], [
        "Corpus",
        true
      ])
    }))
})

describe("fuzz targets", () => {
  const run = <A>(target: Fuzz.Target<A, never, never>) =>
    Fuzz.runTarget(target, { seed: 1, executions: 3_000 }).pipe(Effect.provideService(Fuzz.Corpus, Fuzz.memoryCorpus()))

  it.effect("all-Schema inputs save failures as values", () =>
    Effect.gen(function*() {
      const tuple = InternalFuzz.makeTarget([Small, Small], ([a, b]: [number, number]) => a + b < 1500, {
        id: "tuple",
        revision: "1"
      })
      const tupleReport = yield* run(tuple)
      assert.strictEqual(tupleReport._tag === "Falsified" && tupleReport.findings[0].saved, "Value")
      const record = InternalFuzz.makeTarget({ n: Small }, ({ n }: { n: number }) => n < 500, {
        id: "record",
        revision: "1"
      })
      const recordReport = yield* run(record)
      assert.deepStrictEqual(recordReport._tag === "Falsified" && recordReport.findings[0].input, { n: 500 })
    }))

  it.effect("inputs with an Arbitrary save failures as tapes", () =>
    Effect.gen(function*() {
      const small = Arbitrary.schema(Small)
      const tuple = InternalFuzz.makeTarget([small, Small], ([a]: [number, number]) => a < 500, {
        id: "t",
        revision: "1"
      })
      const tupleReport = yield* run(tuple)
      assert.strictEqual(tupleReport._tag === "Falsified" && tupleReport.findings[0].saved, "Tape")
      const record = InternalFuzz.makeTarget({ a: small, b: Small }, ({ a }: { a: number }) => a < 500, {
        id: "r",
        revision: "1"
      })
      const recordReport = yield* run(record)
      assert.deepStrictEqual(recordReport._tag === "Falsified" && recordReport.findings[0].input.a, 500)
    }))
})

describe("fuzz runner", () => {
  it.effect("replays only, searches in a session, and fails on findings", () =>
    Effect.gen(function*() {
      const store = Fuzz.memoryCorpus()
      const logs: Array<string> = []
      const passing = Fuzz.target(Small, () => true, { id: "passing", revision: "1" })
      yield* InternalFuzz.runFuzz(passing, store, { size: 5 }, undefined, (line) => Effect.sync(() => logs.push(line)))
      assert.deepStrictEqual([logs, yield* store.load("passing")], [[], []])
      yield* InternalFuzz.runFuzz(passing, store, { size: 5 }, { seed: 1, executions: 200 }, (line) =>
        Effect.sync(() =>
          logs.push(line)
        ))
      assert.match(logs[0], /^Fuzzed passing: 200 execution\(s\), \d+ corpus input\(s\), features .*Executions$/)
      assert.isTrue((yield* store.load("passing")).length > 0)

      const failing = Fuzz.target(Small, (n) =>
        n < 500, { id: "failing", revision: "1" })
      const found = yield* Effect.flip(
        InternalFuzz.runFuzz(failing, store, undefined, { seed: 1, executions: 2_000 }, () =>
          Effect.void)
      )
      assert.include(found.message, "ReturnedFalse")
      // The saved failure now fails a plain run too.
      const replayed = yield* Effect.flip(InternalFuzz.runFuzz(failing, store, undefined, undefined, () => Effect.void))
      assert.include(replayed.message, "Input: 500")
      const fixed = Fuzz.target(Small, () => true, { id: "failing", revision: "1" })
      yield* InternalFuzz.runFuzz(fixed, store, undefined, undefined, (line) => Effect.sync(() => logs.push(line)))
      assert.strictEqual(logs[1], "Replayed 1 saved failure(s) of failing; skipped 0 stale tape(s)")
    }))
})

describe("fuzz exhausted sessions", () => {
  it.effect("an all-discarded session fails instead of reporting a passing test", () =>
    Effect.gen(function*() {
      const target = Fuzz.target(Arbitrary.filter(Arbitrary.schema(Small), () => false), () => true, {
        id: "exhausted",
        revision: "1"
      })
      const error = yield* Effect.flip(InternalFuzz.runFuzz(
        target,
        Fuzz.memoryCorpus(),
        undefined,
        { executions: 10 },
        () => Effect.void
      ))
      assert.include(error.message, "all 10 executions were discarded")
    }))
})

describe("fuzz registration", () => {
  const calls = { effect: 0, effectVoid: 0, sync: 0, syncVoid: 0, simulated: 0 }
  it.effect.fuzz("an Effect fuzz test with no saved failures passes", [Small], ([n]) =>
    Effect.sync(() => {
      calls.effect++
      return n >= 0
    }))
  it.effect.fuzz("a void Effect fuzz test passes", { n: Small }, ({ n }) =>
    Effect.sync(() => {
      calls.effectVoid++
      assert.isAtLeast(n, 0)
    }), {
    id: "named",
    revision: "2"
  })
  it.fuzz("a synchronous fuzz test passes", [Small], ([n]) => {
    calls.sync++
    return n >= 0
  })
  it.fuzz("a void synchronous fuzz test passes", [Arbitrary.schema(Small)], () => {
    calls.syncVoid++
  })
  // The simulation, not TestClock, owns Clock and Scheduler: sleeps and timeouts run in virtual time.
  it.effect.fuzz(
    "an Effect fuzz test under the simulation sleeps in virtual time",
    [Small],
    () =>
      Effect.gen(function*() {
        calls.simulated++
        yield* Effect.sleep("1 millis")
        const timedOut = yield* Effect.exit(Effect.timeout(Effect.sleep("1 minute"), "1 second"))
        return timedOut._tag === "Failure" && (yield* Clock.currentTimeMillis) === 1_001
      }),
    { fuzz: { execution: FuzzSimulation.execution() } }
  )
  it("ran every registered callback", () => {
    for (const [name, count] of Object.entries(calls)) assert.isAbove(count, 0, name)
  })
})

describe("fuzz registration that must fail", () => {
  // Registered through `it.fails`: a registration that installed a no-op test would pass and fail this file.
  const expectFailure = makeMethods(V.it.fails as unknown as V.TestAPI)
  expectFailure.fuzz("a failing synchronous fuzz test fails", [Small], ([n]) => n < 0)
  expectFailure.effect.fuzz("a failing Effect fuzz test fails", [Small], ([n]) => Effect.succeed(n < 0))
  expectFailure.fuzz("an it.fuzz callback returning an Effect fails", [Small], () => Effect.succeed(true) as never)
})

describe("fuzz corpus directories", () => {
  it.effect("distinct test ids never share a directory", () =>
    Effect.gen(function*() {
      const root = temporary()
      const failures = path.join(root, "failures")
      const store = InternalFuzz.fileCorpus({ failures, inputs: path.join(root, "inputs") })
      const ids = ["parse: x", "parse x", "parse-x", "", ".", ".."]
      for (const id of ids) yield* store.save(id, { kind: "Failure", key: "k", text: id })
      for (const id of ids) assert.deepStrictEqual(yield* store.load(id), [{ kind: "Failure", key: "k", text: id }])
      // Nothing escapes the failures directory.
      assert.deepStrictEqual(fs.readdirSync(root), ["failures"])
      assert.strictEqual(fs.readdirSync(failures).length, ids.length)
    }))
})

describe("fuzz runner with an execution driver", () => {
  const Amount = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))
  const conserves = Effect.fnUntraced(function*([a, b]: readonly [number, number]) {
    const balance = yield* Ref.make(100)
    const paid = yield* Ref.make(0)
    const withdraw = Effect.fnUntraced(function*(amount: number) {
      const current = yield* Ref.get(balance)
      if (current < amount) return
      yield* Ref.set(balance, current - amount)
      yield* Ref.update(paid, (total) => total + amount)
    })
    yield* Effect.all([withdraw(a), withdraw(b)], { concurrency: 2 })
    return (yield* Ref.get(balance)) + (yield* Ref.get(paid)) === 100
  })

  it.effect("a saved schedule race fails the next plain run", () =>
    Effect.gen(function*() {
      const store = Fuzz.memoryCorpus()
      const target = Fuzz.target(Schema.Tuple([Amount, Amount]), conserves, { id: "race", revision: "1" })
      const options: Fuzz.Options = { execution: FuzzSimulation.execution() }
      const found = yield* Effect.flip(
        InternalFuzz.runFuzz(target, store, options, { seed: 1, executions: 10_000 }, () => Effect.void)
      )
      assert.include(found.message, "ReturnedFalse")
      const replayed = yield* Effect.flip(InternalFuzz.runFuzz(target, store, options, undefined, () => Effect.void))
      assert.include(replayed.message, "ReturnedFalse")
    }))
})
