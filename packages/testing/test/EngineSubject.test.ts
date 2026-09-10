import { Effect } from "effect"
import * as EngineSubject from "../src/EngineSubject.ts"
import * as TestingError from "../src/TestingError.ts"
import { describe, expect, it } from "../src/Vitest.ts"

describe("EngineSubject", () => {
  it("is a distinct port from the harness EngineLike it used to share a name with", () => {
    // The harness port is what the built-in harness *consumes* (seal/splice/
    // suspend). The testing port is the conformance *subject* (run/result/
    // interrupt/resume/journal). Neither structurally satisfies the other, so
    // they must never be exported under one ambiguous name again.
    const subject = EngineSubject.makeNoop()
    expect(Object.keys(subject).sort()).toEqual(
      ["interrupt", "journal", "name", "restart", "result", "resume", "run"].filter((key) => key in subject).sort()
    )
    expect("sealStep" in subject).toBe(false)
    expect("splice" in subject).toBe(false)
    expect("suspend" in subject).toBe(false)
    expect(EngineSubject.EngineSubject.key).not.toBe("@smthrs/harness/EngineLike")
    expect(EngineSubject.EngineSubject.key).toBe("flows/testing/EngineSubject")
  })

  // Every operation, not only `result`: a noop subject whose `run` silently
  // succeeded would let a pin report a pass against no engine at all.
  it.effect("fails every unavailable operation with a typed, stable-coded error naming it", () =>
    Effect.gen(function*() {
      const subject = EngineSubject.makeNoop()
      const operations: Record<string, Effect.Effect<unknown, TestingError.EngineSubjectError>> = {
        run: subject.run({ flow: { name: "none", steps: [] }, payload: undefined }),
        result: subject.result("nope"),
        interrupt: subject.interrupt("nope"),
        resume: subject.resume("nope"),
        journal: subject.journal("nope")
      }
      for (const [operation, effect] of Object.entries(operations)) {
        const error = yield* Effect.flip(effect)
        expect(error._tag, operation).toBe("EngineUnavailableError")
        expect(error.code, operation).toBe("engine_unavailable")
        expect((error as { readonly message: string }).message, operation).toContain(operation)
      }
      expect(Object.keys(operations)).toHaveLength(5)
    }))

  it.effect("keeps an override and leaves the rest unavailable", () =>
    Effect.gen(function*() {
      const subject = EngineSubject.makeNoop({
        name: "overridden",
        journal: () => Effect.succeed([])
      })
      expect(subject.name).toBe("overridden")
      expect(yield* subject.journal("any")).toEqual([])
      expect((yield* Effect.flip(subject.result("any"))).code).toBe("engine_unavailable")
    }))

  it.effect("provides the same subject through its layer", () =>
    Effect.gen(function*() {
      const provided = yield* EngineSubject.EngineSubject.pipe(
        Effect.provide(EngineSubject.layerNoop({ name: "layered" }))
      )
      expect(provided.name).toBe("layered")
      const direct = yield* EngineSubject.EngineSubject.pipe(
        Effect.provide(EngineSubject.layer(EngineSubject.makeNoop({ name: "direct" })))
      )
      expect(direct.name).toBe("direct")
    }))

  it("carries every subject failure in one closed typed union", () => {
    const errors: ReadonlyArray<TestingError.EngineSubjectError> = [
      new TestingError.EngineUnavailableError({ message: "no subject" }),
      new TestingError.CapabilityOperationError({ capability: "rewind", operation: "rewind", message: "no subject" }),
      new TestingError.TransactionCommitError({ boundary: "frame" }),
      new TestingError.RewindFailureError({ executionId: "e1", frame: 1, boundary: "resume" })
    ]
    expect(errors.map((error) => error.code)).toEqual([
      "engine_unavailable",
      "capability_operation_failed",
      "transaction_commit_failed",
      "rewind_failed"
    ])
  })
})
