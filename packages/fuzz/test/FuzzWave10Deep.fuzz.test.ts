import { Arbitrary, Cause, Deferred, Effect, Fiber, Ref, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { Fuzz, FuzzSimulation } from "../src/index.ts"

const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261210")
const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "100")
const fastExec = Math.max(25, Math.min(Math.ceil(baseExecutions / 3), 60))

describe("@smthrs/fuzz Wave 10 deep meta-fuzzing", () => {
  it("Fuzz.formatReport renders every Passed, Exhausted, ReplayMismatch, Falsified & Flaky report shape cleanly", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        failureKind: Schema.Literals([
          "ReturnedFalse",
          "PropertyErrorPlain",
          "PropertyErrorCause",
          "DiedError",
          "DiedString",
          "Deadlock"
        ]),
        recheckKind: Schema.Literals(["Passed", "Limited", "ReturnedFalse"]),
        withFeedback: Schema.Boolean,
        withCodecError: Schema.Boolean,
        savedTape: Schema.Boolean,
        replayMismatchSig: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ failureKind, recheckKind, withFeedback, withCodecError, savedTape, replayMismatchSig }) =>
          Effect.sync(() => {
            const baseStats: Fuzz.Stats = {
              executions: 10,
              seed: 123,
              features: withFeedback ? { structural: 2, spans: 5 } : { structural: 2 },
              corpus: 2,
              discards: 0,
              regressions: 0,
              stale: 0,
              stoppedBy: replayMismatchSig ? "Replay" : "Executions"
            }

            expect(Fuzz.formatReport({ _tag: "Passed", stats: baseStats })).toBeUndefined()
            expect(Fuzz.formatReport({ _tag: "Exhausted", stats: baseStats })).toContain("Fuzzing exhausted")
            expect(Fuzz.formatReport({ _tag: "ReplayMismatch", stats: baseStats })).toContain("Fuzz replay cannot regenerate")

            const failure: Fuzz.Failure<unknown> = failureKind === "ReturnedFalse"
              ? { _tag: "ReturnedFalse" }
              : failureKind === "PropertyErrorPlain"
                ? { _tag: "PropertyError", error: { code: "bad" } }
                : failureKind === "PropertyErrorCause"
                  ? { _tag: "PropertyError", error: Cause.fail("boom") }
                  : failureKind === "DiedError"
                    ? { _tag: "Died", defect: new Error("crash") }
                    : failureKind === "DiedString"
                      ? { _tag: "Died", defect: "raw-defect" }
                      : { _tag: "Deadlock" }

            const recheck: Fuzz.Outcome<unknown> = recheckKind === "Passed"
              ? { _tag: "Passed" }
              : recheckKind === "Limited"
                ? { _tag: "Limited" }
                : { _tag: "ReturnedFalse" }

            const finding: Fuzz.Finding<unknown, unknown> = {
              input: { x: 1 },
              initialInput: { x: 1 },
              execution: 1,
              signature: "sig-actual",
              shrinks: 2,
              failure,
              replay: replayMismatchSig ? "fuzz1:WzAsMSxmYWxzZSwxLCJBQUFBIiwxLCIiLFtdLCJzaWctb3RoZXIiXQ" : "fuzz1:tok",
              ...(withCodecError ? { codecError: "cannot encode" } : {}),
              saved: savedTape ? "Tape" : "None"
            }

            const falsifiedMsg = Fuzz.formatReport({
              _tag: "Falsified",
              findings: [finding],
              flaky: [{ ...finding, recheck }],
              stats: baseStats
            })
            expect(falsifiedMsg).toContain("Fuzzing found 1 failure(s) and 1 flaky failure(s)")
            expect(falsifiedMsg).toContain(withFeedback ? "spans" : "structural exploration")
            if (withCodecError) expect(falsifiedMsg).toContain("cannot encode")
            if (savedTape) expect(falsifiedMsg).toContain("Saved as a generator tape")

            const flakyOnlyMsg = Fuzz.formatReport({
              _tag: "Flaky",
              flaky: [{ ...finding, recheck }],
              stats: baseStats
            })
            expect(flakyOnlyMsg).toContain("FLAKY")
            return true
          }),
        { seed, executions: fastExec }
      )
    )
    expect(report._tag, Fuzz.formatReport(report)).toBe("Passed")
  }, 60_000)

  it("Fuzz.target, runTarget, memoryCorpus, observe/score, replay, Exhausted, Flaky & FuzzSimulation concurrency uphold exact engine contracts", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        mode: Schema.Literals([
          "target-pass-and-plateau",
          "target-fail-codec-and-replay",
          "target-bad-codec-tape",
          "target-multi-findings",
          "exhausted",
          "flaky",
          "sim-deadlock",
          "sim-limited",
          "sim-concurrent-fibers",
          "float-tape"
        ]),
        innerSeed: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 500 })))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ mode, innerSeed }) =>
          Effect.gen(function*() {
            const store = Fuzz.memoryCorpus()

            if (mode === "target-pass-and-plateau") {
              const t = Fuzz.target(
                Schema.Struct({ n: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 100 }))) }),
                ({ n }) =>
                  Effect.gen(function*() {
                    yield* Fuzz.observe(n > 50 ? "high" : "low")
                    yield* Fuzz.score("dist", n)
                    return n >= 0
                  }),
                { id: "w10/pass", revision: "r1" }
              )
              const r = yield* Fuzz.runTarget(t, { seed: innerSeed, executions: 20, minExecutions: 5, plateau: 5 }).pipe(
                Effect.provideService(Fuzz.Corpus, store)
              )
              expect(r._tag).toBe("Passed")
              return true
            }

            if (mode === "target-fail-codec-and-replay" || mode === "target-bad-codec-tape") {
              const t = Fuzz.target(
                Arbitrary.schema(Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 10 })))),
                (n) => Effect.succeed(n < 0),
                mode === "target-fail-codec-and-replay"
                  ? {
                      id: `w10/${mode}`,
                      revision: "r1",
                      codec: {
                        id: "num-v1",
                        encode: (v) => String(v),
                        decode: (s) => Number(s)
                      }
                    }
                  : {
                      id: `w10/${mode}`,
                      revision: "r1",
                      codec: {
                        id: "broken-v1",
                        encode: () => {
                          throw new Error("encode-boom")
                        },
                        decode: () => 0
                      }
                    }
              )
              const r = yield* Fuzz.runTarget(t, { seed: innerSeed, executions: 8, maxShrinks: 10 }).pipe(
                Effect.provideService(Fuzz.Corpus, store)
              )
              expect(r._tag).toBe("Falsified")
              if (r._tag === "Falsified") {
                const replayToken = r.findings[0]?.replay
                if (replayToken !== undefined) {
                  const replayed = yield* Fuzz.runTarget(t, { replay: replayToken })
                  expect(replayed._tag).toBe("Falsified")
                }
              }
              // Second run replays saved corpus entry
              const r2 = yield* Fuzz.runTarget(t, { seed: innerSeed + 1, executions: 4 }).pipe(
                Effect.provideService(Fuzz.Corpus, store)
              )
              expect(r2._tag).toBe("Falsified")
              return true
            }

            if (mode === "target-multi-findings") {
              const r = yield* Fuzz.run(
                Arbitrary.schema(Schema.Literals(["a", "b"])),
                (x) => (x === "a" ? Effect.fail("err-a") : Effect.die(new Error("die-b"))),
                { seed: innerSeed, executions: 12, maxFindings: 2, maxShrinks: 4 }
              )
              expect(r._tag).toBe("Falsified")
              return true
            }

            if (mode === "exhausted") {
              const neverArb = Arbitrary.schema(Schema.Int).pipe(Arbitrary.filter(() => false))
              const r = yield* Fuzz.run(neverArb, () => Effect.succeed(true), { seed: innerSeed, executions: 5 })
              expect(r._tag).toBe("Exhausted")
              return true
            }

            if (mode === "flaky") {
              let calls = 0
              const r = yield* Fuzz.run(
                Arbitrary.schema(Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 3 })))),
                () =>
                  Effect.sync(() => {
                    calls += 1
                    return calls !== 1
                  }),
                { seed: innerSeed, executions: 4 }
              )
              expect(r._tag === "Flaky" || r._tag === "Passed").toBe(true)
              return true
            }

            if (mode === "sim-deadlock") {
              const r = yield* Fuzz.run(
                Arbitrary.schema(Schema.Literals([1, 2])),
                () => Effect.never as Effect.Effect<boolean>,
                { seed: innerSeed, executions: 2, execution: FuzzSimulation.execution({ maxSteps: 50 }) }
              )
              expect(r._tag).toBe("Falsified")
              if (r._tag === "Falsified") {
                expect(r.findings[0]?.failure._tag).toBe("Deadlock")
              }
              return true
            }

            if (mode === "sim-limited") {
              const loop: Effect.Effect<boolean> = Effect.yieldNow.pipe(Effect.andThen(Effect.suspend(() => loop)))
              const r = yield* Fuzz.run(
                Arbitrary.schema(Schema.Literals([1, 2])),
                () => loop,
                { seed: innerSeed, executions: 2, execution: FuzzSimulation.execution({ maxSteps: 20 }) }
              )
              expect(r._tag).toBe("Exhausted")
              return true
            }

            if (mode === "sim-concurrent-fibers") {
              const r = yield* Fuzz.run(
                Arbitrary.schema(Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 5 })))),
                (n) =>
                  Effect.gen(function*() {
                    const ref = yield* Ref.make(0)
                    const gate = yield* Deferred.make<void>()
                    const f1 = yield* Effect.forkChild(
                      Effect.sleep("5 millis").pipe(
                        Effect.andThen(Ref.update(ref, (x) => x + n)),
                        Effect.andThen(Deferred.succeed(gate, undefined))
                      )
                    )
                    const f2 = yield* Effect.forkChild(
                      Deferred.await(gate).pipe(Effect.andThen(Ref.update(ref, (x) => x * 2)))
                    )
                    yield* Fiber.join(f1)
                    yield* Fiber.join(f2)
                    const total = yield* Ref.get(ref)
                    return total === n * 2
                  }),
                { seed: innerSeed, executions: 8, execution: FuzzSimulation.execution({ maxSteps: 200 }) }
              )
              expect(r._tag).toBe("Passed")
              return true
            }

            // float-tape: exercises tape nextDoubleUnsafe & clone/snapshot
            const r = yield* Fuzz.run(
              Arbitrary.schema(Schema.Struct({ f: Schema.Finite, g: Schema.Finite })),
              ({ f, g }) => Effect.succeed(Number.isFinite(f) && Number.isFinite(g)),
              { seed: innerSeed, executions: 10 }
            )
            expect(r._tag).toBe("Passed")
            return true
          }),
        { seed: seed + 1, executions: fastExec }
      )
    )
    expect(report._tag, Fuzz.formatReport(report)).toBe("Passed")
  }, 60_000)
})
