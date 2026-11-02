/**
 * The stable codes the journal vocabulary hands a consumer, and the ordering
 * it reads its answers from.
 *
 * `.effect(key)` used to filter on `stepKey` alone, so an ordinary step
 * satisfied an effect assertion; `idempotencyKey` used to raise
 * `missing_idempotency_key` for an effect that never ran and
 * `idempotency_key_mismatch` for an entry carrying no key at all; and
 * `terminal` read the last array element while `prefix` answered by
 * `entry.index`.
 */
import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import type { JournalEntryLike } from "../src/EngineSubject.vibe"
import { expectJournal } from "../src/JournalAssertions.ts"
import type { JournalAssertionError } from "../src/TestingError.ts"

const codeOf = (effect: Effect.Effect<void, JournalAssertionError>) =>
  Effect.runPromise(Effect.flip(effect)).then((error) => error.code)

const errorOf = (effect: Effect.Effect<void, JournalAssertionError>) => Effect.runPromise(Effect.flip(effect))

const step = (stepKey: string, index: number, value?: unknown): JournalEntryLike => ({
  index,
  stepKey,
  kind: "step",
  outcome: "completed",
  ...(value === undefined ? {} : { value })
})

const effectEntry = (stepKey: string, index: number, value?: unknown): JournalEntryLike => ({
  index,
  stepKey,
  kind: "effect",
  outcome: "completed",
  ...(value === undefined ? {} : { value })
})

describe("effect assertions answer about effect entries only", () => {
  const mixed = [
    step("publish", 0),
    effectEntry("publish", 1, { idempotencyKey: "publish-1" })
  ]

  it("refuses an ordinary step that shares the effect's key", async () => {
    const stepsOnly = [step("publish", 0)]
    expect(await codeOf(expectJournal(stepsOnly).effect("publish").atLeastOnce())).toBe("effect_kind_mismatch")
  })

  it("reports effect_not_executed when no entry carries the key at all", async () => {
    expect(await codeOf(expectJournal(mixed).effect("absent").atLeastOnce())).toBe("effect_not_executed")
  })

  it("counts only the effect entry for journaledAtMostOnce", async () => {
    const twoStepsOneEffect = [step("publish", 0), step("publish", 1), effectEntry("publish", 2)]
    const exit = await Effect.runPromiseExit(expectJournal(twoStepsOneEffect).effect("publish").journaledAtMostOnce())
    expect(exit._tag).toBe("Success")
    const twice = [effectEntry("publish", 0), effectEntry("publish", 1)]
    expect(await codeOf(expectJournal(twice).effect("publish").journaledAtMostOnce())).toBe(
      "effect_journaled_more_than_once"
    )
  })

  it("refuses a step-only journal in journaledAtMostOnce", async () => {
    // Zero effect entries is trivially "at most once", so this used to pass
    // while the engine journaled no effect under the key at all.
    const stepsOnly = [step("publish", 0)]
    const error = await errorOf(expectJournal(stepsOnly).effect("publish").journaledAtMostOnce())
    expect(error.code).toBe("effect_kind_mismatch")
    expect(error.actual).toEqual(["step"])
  })

  it("still satisfies journaledAtMostOnce when the key appears nowhere", async () => {
    const exit = await Effect.runPromiseExit(expectJournal(mixed).effect("absent").journaledAtMostOnce())
    expect(exit._tag).toBe("Success")
  })

  it("reads the idempotency key off the effect entry, not the step entry", async () => {
    const exit = await Effect.runPromiseExit(expectJournal(mixed).effect("publish").idempotencyKey("publish-1"))
    expect(exit._tag).toBe("Success")
  })
})

describe("idempotency outcomes carry three distinguishable codes", () => {
  it("separates an effect that never ran", async () => {
    expect(await codeOf(expectJournal([]).effect("publish").idempotencyKey("publish-1"))).toBe("effect_not_executed")
  })

  it("separates an entry that carries no idempotency key", async () => {
    const noKey = [effectEntry("publish", 0, { payload: 1 })]
    expect(await codeOf(expectJournal(noKey).effect("publish").idempotencyKey("publish-1"))).toBe(
      "missing_idempotency_key"
    )
  })

  it("treats a primitive effect value as carrying no idempotency key", async () => {
    const primitive = [effectEntry("publish", 0, "not-a-record")]
    const error = await errorOf(expectJournal(primitive).effect("publish").idempotencyKey("publish-1"))
    expect(error.code).toBe("missing_idempotency_key")
    expect(error.expected).toBe("publish-1")
  })

  it("refuses an ordinary step in the idempotency-key assertion", async () => {
    const ordinary = [step("publish", 0, { idempotencyKey: "publish-1" })]
    const error = await errorOf(expectJournal(ordinary).effect("publish").idempotencyKey("publish-1"))
    expect(error.code).toBe("effect_kind_mismatch")
    expect(error.expected).toBe("effect")
    expect(error.actual).toEqual(["step"])
  })

  it("separates an entry that carries a different idempotency key", async () => {
    const wrongKey = [effectEntry("publish", 0, { idempotencyKey: "publish-2" })]
    const error = await errorOf(expectJournal(wrongKey).effect("publish").idempotencyKey("publish-1"))
    expect(error.code).toBe("idempotency_key_mismatch")
    expect(error.actual).toBe("publish-2")
  })
})

describe("failures name the keys the journal actually holds", () => {
  it("reports the present step keys rather than an empty array", async () => {
    const journal = [step("read", 0), effectEntry("publish", 1)]
    const missing = await errorOf(expectJournal(journal).executed("absent"))
    expect(missing.actual).toEqual(["read", "publish"])
    const absentEffect = await errorOf(expectJournal(journal).effect("absent").atLeastOnce())
    expect(absentEffect.actual).toEqual(["read", "publish"])
  })
})

describe("ordering is read from entry.index, not from array position", () => {
  const shuffled = [
    { ...step("publish", 2), outcome: "aborted" as const },
    step("read", 0),
    step("review", 1)
  ]

  it("takes the terminal entry from the highest index", async () => {
    const exit = await Effect.runPromiseExit(expectJournal(shuffled).terminal("aborted"))
    expect(exit._tag).toBe("Success")
  })

  it("walks executedInOrder in index order", async () => {
    const exit = await Effect.runPromiseExit(expectJournal(shuffled).executedInOrder(["read", "review", "publish"]))
    expect(exit._tag).toBe("Success")
  })

  it("returns prefix entries in index order", () => {
    expect(expectJournal(shuffled).prefix(1).map((entry) => entry.stepKey)).toEqual(["read", "review"])
  })

  it("fails terminal on an empty journal", async () => {
    expect(await codeOf(expectJournal([]).terminal("completed"))).toBe("terminal_status_mismatch")
  })

  it("matches executedInOrder as a subsequence, not as the whole journal", async () => {
    const exit = await Effect.runPromiseExit(expectJournal(shuffled).executedInOrder(["read", "publish"]))
    expect(exit._tag).toBe("Success")
  })
})
