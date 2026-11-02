import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { describe, expect, it } from "vitest"
import { assertNoDivergence, firstDivergence } from "../src/Divergence.ts"
import type { JournalEntryLike } from "../src/EngineSubject.vibe"
import { expectJournal } from "../src/JournalAssertions.ts"
import { ExactlyOnceUnsupportedError, FixtureDivergenceError, JournalAssertionError } from "../src/TestingError.ts"

const entries: ReadonlyArray<JournalEntryLike> = [
  { index: 0, stepKey: "read", kind: "step", outcome: "completed", value: { idempotencyKey: "read-1" } },
  { index: 1, stepKey: "review", kind: "effect", outcome: "completed", value: { idempotencyKey: "review-1" } },
  { index: 2, stepKey: "publish", kind: "effect", outcome: "aborted", value: { idempotencyKey: "publish-1" } }
]

const exit = <E>(effect: Effect.Effect<void, E>) => Effect.runPromiseExit(effect)

describe("JournalAssertions", () => {
  it("accepts every supported assertion", async () => {
    await Effect.runPromise(
      Effect.gen(function*() {
        const journal = expectJournal(entries)
        yield* journal.executed("read")
        yield* journal.executedInOrder(["read", "publish"])
        yield* journal.terminal("aborted")
        yield* journal.effect("review").atLeastOnce()
        yield* journal.effect("review").journaledAtMostOnce()
        yield* journal.effect("review").idempotencyKey("review-1")
      })
    )
    expect(expectJournal(entries).prefix(1)).toEqual(entries.slice(0, 2))
  })

  it("fails unsupported journal assertions", async () => {
    const journal = expectJournal(entries)
    const missing = await Effect.runPromise(journal.executed("missing").pipe(Effect.flip))
    expect(missing).toBeInstanceOf(JournalAssertionError)
    expect(missing.code).toBe("step_not_executed")
    expect((await exit(journal.executedInOrder(["review", "read"])))._tag).toBe("Failure")
    expect((await exit(journal.terminal("completed")))._tag).toBe("Failure")
    expect((await exit(journal.effect("missing").atLeastOnce()))._tag).toBe("Failure")
    expect((await exit(journal.effect("review").idempotencyKey("wrong")))._tag).toBe("Failure")
    expect((await exit(journal.effect("review").journaledAtMostOnce()))._tag).toBe("Success")
    expect((await exit(expectJournal([...entries, entries[1]!]).effect("review").journaledAtMostOnce()))._tag).toBe(
      "Failure"
    )
  })

  it("refuses exactly-once claims", async () => {
    const result = await exit(expectJournal(entries).effect("review").exactlyOnce())
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(result.cause.reasons).toEqual([
        expect.objectContaining({ error: expect.any(ExactlyOnceUnsupportedError) })
      ])
    }
  })
})

describe("Divergence", () => {
  it("keeps failed proxy inspection in the declared divergence channel", async () => {
    const revoked = Proxy.revocable({}, {})
    revoked.revoke()
    const assertion = assertNoDivergence(
      [{ ...entries[0]!, value: revoked.proxy }],
      [{ ...entries[0]!, value: {} }]
    )
    expect(Effect.isEffect(assertion)).toBe(true)
    expect(await Effect.runPromise(Effect.flip(assertion))).toBeInstanceOf(FixtureDivergenceError)
    await Effect.runPromise(assertNoDivergence(
      [{ ...entries[0]!, value: revoked.proxy }],
      [{ ...entries[0]!, value: revoked.proxy }]
    ))
  })

  it("reports a throwing array accessor through the declared failure channel", async () => {
    let reads = 0
    const value = Object.defineProperty([], "0", {
      enumerable: true,
      get: () => {
        reads++
        throw new Error("array accessor escaped")
      }
    })
    const assertion = assertNoDivergence([{ ...entries[0]!, value }], [{ ...entries[0]!, value: [1] }])
    expect(Effect.isEffect(assertion)).toBe(true)
    const error = await Effect.runPromise(Effect.flip(assertion))
    expect(error).toBeInstanceOf(FixtureDivergenceError)
    expect(error.field).toBe("value")
    expect(reads).toBe(0)
  })

  it("detects a value changing from undefined to its ordinary tagged record", async () => {
    const error = await Effect.runPromise(Effect.flip(assertNoDivergence(
      [{ ...entries[0]!, value: undefined }],
      [{ ...entries[0]!, value: { _tag: "Undefined" } }]
    )))
    expect(error).toBeInstanceOf(FixtureDivergenceError)
    expect(error.field).toBe("value")
  })

  it("attributes an outcome difference", () => {
    const actual = [...entries.slice(0, 2), { ...entries[2]!, outcome: "failed" as const }]
    expect(Option.getOrThrow(firstDivergence(entries, actual))).toEqual({
      index: 2,
      field: "outcome",
      expected: "aborted",
      actual: "failed"
    })
  })

  it("attributes a canonical value difference", () => {
    const actual = [
      { ...entries[0]!, value: { idempotencyKey: "read-2", nested: { b: 2, a: 1 } } },
      ...entries.slice(1)
    ]
    expect(Option.getOrThrow(firstDivergence(entries, actual))).toEqual({
      index: 0,
      field: "value",
      expected: { idempotencyKey: "read-1" },
      actual: { idempotencyKey: "read-2", nested: { b: 2, a: 1 } }
    })
  })

  it("returns none for equal journals and fails assertions with the typed divergence", async () => {
    expect(firstDivergence(entries, [...entries])).toEqual(Option.none())
    const result = await exit(assertNoDivergence(entries, [{ ...entries[0]!, kind: "other" }, ...entries.slice(1)]))
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(result.cause.reasons).toEqual([
        expect.objectContaining({ error: expect.any(FixtureDivergenceError) })
      ])
    }
  })
})
