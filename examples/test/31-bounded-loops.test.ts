import { expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { audit, main, repair, settle, shadow, tune, wordy } from "../src/31-bounded-loops.ts"

it.effect("repairs every violation and stops when the next scan is clean", () =>
  Effect.gen(function*() {
    const result = yield* repair

    // One repairing round and one confirming rescan.
    expect(result.iterations).toBe(2)
    expect(result.remaining).toEqual([])
    expect(result.settled).toEqual([
      { key: "retries", value: 3 },
      { key: "timeoutMs", value: 30_000 },
      { key: "concurrency", value: 4 }
    ])
  }))

it.effect("pages with the settings that moved away from the baseline", () =>
  Effect.gen(function*() {
    const repaired = yield* repair
    const result = yield* audit(repaired.settled)

    expect(result.drifted).toBe(true)
    expect(result.paged).toEqual(["retries", "timeoutMs"])
  }))

it.effect("skips the alert when the config matches the baseline", () =>
  Effect.gen(function*() {
    const result = yield* audit([
      { key: "retries", value: 9 },
      { key: "timeoutMs", value: 90_000 },
      { key: "concurrency", value: 4 }
    ])

    expect(result.drifted).toBe(false)
    expect(result.paged).toEqual([])
  }))

it.effect("pages when the snapshot carries a setting the baseline never approved", () =>
  Effect.gen(function*() {
    const result = yield* audit([
      { key: "retries", value: 9 },
      { key: "timeoutMs", value: 90_000 },
      { key: "concurrency", value: 4 },
      { key: "unapprovedSetting", value: 100 }
    ])

    expect(result.drifted).toBe(true)
    expect(result.paged).toEqual(["unapprovedSetting"])
  }))

it.effect("pages when an approved setting is missing from the snapshot", () =>
  Effect.gen(function*() {
    const result = yield* audit([
      { key: "retries", value: 9 },
      { key: "timeoutMs", value: 90_000 }
    ])

    expect(result.drifted).toBe(true)
    expect(result.paged).toEqual(["concurrency"])
  }))

it.effect("pages only the setting whose value changed", () =>
  Effect.gen(function*() {
    const result = yield* audit([
      { key: "retries", value: 9 },
      { key: "timeoutMs", value: 60_000 },
      { key: "concurrency", value: 4 }
    ])

    expect(result.drifted).toBe(true)
    expect(result.paged).toEqual(["timeoutMs"])
  }))

it.effect("keeps the best summary rather than the last one", () =>
  Effect.gen(function*() {
    const result = yield* tune

    // The search ran every candidate, so the last one was scored and rejected
    // in favour of the shorter second one.
    expect(result.iterations).toBe(wordy.length)
    expect(result.best).toBe("repaired")
    expect(result.best).not.toBe(wordy[wordy.length - 1])
    expect(result.converged).toBe(false)
  }))

it.effect("quarantines the failed shadow and returns the primary answer", () =>
  Effect.gen(function*() {
    const result = yield* shadow

    expect(result.primary).toBe("config repaired")
    expect(result.quarantined).toBe(true)
    expect(result.delta).toBeUndefined()
  }))

it.effect("stops the ralph loop when the body reports itself done", () =>
  Effect.gen(function*() {
    const result = yield* settle

    expect(result.turns).toBe(3)
    expect(result.exhausted).toBe(false)
  }))

it.effect("runs the whole story", () =>
  Effect.gen(function*() {
    const result = yield* main

    expect(result.repair.remaining).toEqual([])
    expect(result.audit.drifted).toBe(true)
    expect(result.tune.converged).toBe(false)
    expect(result.shadow.quarantined).toBe(true)
    expect(result.settle.turns).toBe(3)
  }))
