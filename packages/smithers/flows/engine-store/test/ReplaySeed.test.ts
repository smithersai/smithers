/**
 * `internal/ReplaySeed`: what one round of a run answers its replay from, the
 * run's attempt rows read at once.
 */
import { describe, expect, it } from "@effect/vitest"
import type { AttemptStore } from "@smthrs/run-store"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Option from "effect/Option"
import { prunedPrefixScanLimit } from "../src/internal/AttemptProbe.vibe"
import * as ReplaySeed from "../src/internal/ReplaySeed.vibe"

const row = (stepKeyDigest: string, attempt: number, state = "succeeded"): AttemptStore.Attempt => ({
  runId: "run",
  stepKeyDigest,
  attempt,
  state,
  startedAtMs: attempt * 10,
  meta: {}
})

describe("ReplaySeed.make", () => {
  it("answers a key's survivors and rows from the rows it was read with, whatever their order", () => {
    const seed = ReplaySeed.make([row("b", 3), row("a", 1), row("b", 1, "failed"), row("b", 2, "failed")])
    expect(seed.size).toBe(4)
    expect(seed.survivors("b")).toEqual(Option.some({ earliestAttempt: 1, earliestStartedAtMs: 10, latest: 3 }))
    expect(seed.survivors("a")).toEqual(Option.some({ earliestAttempt: 1, earliestStartedAtMs: 10, latest: 1 }))
    expect(seed.take("b", 3)).toEqual(Option.some(row("b", 3)))
  })

  it("answers a key it holds no row for as having none: the round began without one", () => {
    const seed = ReplaySeed.make([row("a", 1)])
    expect(seed.survivors("fresh")).toEqual(Option.none())
    expect(seed.take("fresh", 1)).toEqual(Option.none())
    expect(seed.take("a", 2)).toEqual(Option.none())
  })

  it("gives a key's rows once: its dispatch is about to write it, so later asks go to the store", () => {
    const seed = ReplaySeed.make([row("a", 1, "failed")])
    expect(seed.take("a", 1)).toEqual(Option.some(row("a", 1, "failed")))
    expect(seed.take("a", 2)).toBeUndefined()
    expect(seed.survivors("a")).toBeUndefined()
    expect(seed.take("fresh", 1)).toEqual(Option.none())
    expect(seed.survivors("fresh")).toBeUndefined()
  })

  it("applies the pruned-prefix tolerance the store's probe applies", () => {
    const pruned = prunedPrefixScanLimit + 1
    const seed = ReplaySeed.make([
      row("pruned", pruned),
      row("kept", prunedPrefixScanLimit),
      row("gap", 1),
      row("gap", 3)
    ])
    expect(seed.survivors("pruned")).toEqual(Option.none())
    expect(Option.getOrThrow(seed.survivors("kept")!).earliestAttempt).toBe(prunedPrefixScanLimit)
    expect(Option.getOrThrow(seed.survivors("gap")!).latest).toBe(1)
  })

  it("sends every question to the store when it holds no rows", () => {
    const seed = ReplaySeed.make(undefined)
    expect(seed.size).toBe(0)
    expect(seed.survivors("a")).toBeUndefined()
    expect(seed.take("a", 1)).toBeUndefined()
  })
})

describe("ReplaySeed.once", () => {
  it.effect("reads once for every ask, concurrent first asks included", () =>
    Effect.gen(function*() {
      let reads = 0
      const release = yield* Deferred.make<void>()
      const seeded = ReplaySeed.once(
        Effect.andThen(
          Deferred.await(release),
          Effect.sync(() => {
            reads++
            return ReplaySeed.make([row("a", 1)])
          })
        )
      )
      const first = yield* Effect.forkChild(seeded, { startImmediately: true })
      const second = yield* Effect.forkChild(seeded, { startImmediately: true })
      yield* Deferred.succeed(release, undefined)
      const seeds = [yield* Fiber.join(first), yield* Fiber.join(second), yield* seeded]
      expect(reads).toBe(1)
      expect(seeds[1]).toBe(seeds[0])
      expect(seeds[2]).toBe(seeds[0])
    }))
})
