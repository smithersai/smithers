import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { expect, it } from "@effect/vitest"
import { FlowEngine } from "@smthrs/engine"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import { audit, drain, main, repair, settle, shadow, tune, wordy } from "../../examples/31-bounded-loops.vibe"

const runtime = FlowEngine.layerMemory.pipe(Layer.provideMerge(NodeCrypto.layer))

it.effect("repairs every violation and stops when the next scan is clean", () =>
  Effect.gen(function*() {
    const result = yield* repair()

    // One repairing round and one confirming rescan.
    expect(result.iterations).toBe(2)
    expect(result.remaining).toEqual([])
    expect(result.settled).toEqual([
      { key: "retries", value: 3 },
      { key: "timeoutMs", value: 30_000 },
      { key: "concurrency", value: 4 }
    ])
  }).pipe(Effect.provide(runtime)))

it.effect("repairs two different configurations on the same engine", () =>
  Effect.gen(function*() {
    const first = yield* repair(new Map([["retries", 9], ["concurrency", 2]]))
    const second = yield* repair(new Map([["timeoutMs", 90_000], ["concurrency", 16]]))

    expect(first).toEqual({
      iterations: 2,
      remaining: [],
      settled: [{ key: "retries", value: 3 }, { key: "concurrency", value: 2 }]
    })
    expect(second).toEqual({
      iterations: 2,
      remaining: [],
      settled: [{ key: "timeoutMs", value: 30_000 }, { key: "concurrency", value: 8 }]
    })
  }).pipe(Effect.provide(runtime)))

it.effect("pages with the settings that moved away from the baseline", () =>
  Effect.gen(function*() {
    const repaired = yield* repair()
    const result = yield* audit(repaired.settled)

    expect(result.drifted).toBe(true)
    expect(result.paged).toEqual(["retries", "timeoutMs"])
  }).pipe(Effect.provide(runtime)))

it.effect("skips the alert when the config matches the baseline", () =>
  Effect.gen(function*() {
    const result = yield* audit([
      { key: "retries", value: 9 },
      { key: "timeoutMs", value: 90_000 },
      { key: "concurrency", value: 4 }
    ])

    expect(result.drifted).toBe(false)
    expect(result.paged).toEqual([])
  }).pipe(Effect.provide(runtime)))

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
  }).pipe(Effect.provide(runtime)))

it.effect("pages when an approved setting is missing from the snapshot", () =>
  Effect.gen(function*() {
    const result = yield* audit([
      { key: "retries", value: 9 },
      { key: "timeoutMs", value: 90_000 }
    ])

    expect(result.drifted).toBe(true)
    expect(result.paged).toEqual(["concurrency"])
  }).pipe(Effect.provide(runtime)))

it.effect("pages only the setting whose value changed", () =>
  Effect.gen(function*() {
    const result = yield* audit([
      { key: "retries", value: 9 },
      { key: "timeoutMs", value: 60_000 },
      { key: "concurrency", value: 4 }
    ])

    expect(result.drifted).toBe(true)
    expect(result.paged).toEqual(["timeoutMs"])
  }).pipe(Effect.provide(runtime)))

it.effect("keeps the best summary rather than the last one", () =>
  Effect.gen(function*() {
    const result = yield* tune

    // The search ran every candidate, so the last one was scored and rejected
    // in favour of the shorter second one.
    expect(result.iterations).toBe(wordy.length)
    expect(result.best).toBe("repaired")
    expect(result.best).not.toBe(wordy[wordy.length - 1])
    expect(result.converged).toBe(false)
  }).pipe(Effect.provide(runtime)))

it.effect("quarantines the failed shadow and returns the primary answer", () =>
  Effect.gen(function*() {
    const result = yield* shadow

    expect(result.primary).toBe("config repaired")
    expect(result.quarantined).toBe(true)
    expect(result.delta).toBeUndefined()
  }).pipe(Effect.provide(runtime)))

it.effect("stops the lineage when the queue is empty", () =>
  Effect.gen(function*() {
    const result = yield* settle

    expect(result.turns).toBe(3)
    expect(result.exhausted).toBe(false)
  }).pipe(Effect.provide(runtime)))

it.effect("runs the whole story", () =>
  Effect.gen(function*() {
    const result = yield* main

    expect(result.repair.remaining).toEqual([])
    expect(result.audit.drifted).toBe(true)
    expect(result.tune.converged).toBe(false)
    expect(result.shadow.quarantined).toBe(true)
    expect(result.settle.turns).toBe(3)
  }).pipe(Effect.provide(runtime)))

it.effect("finishes on the last allowed round", () =>
  Effect.gen(function*() {
    expect(yield* drain(10, "queue-at-bound")).toEqual({ turns: 10, exhausted: false })
  }).pipe(Effect.provide(runtime)))

it.effect("refuses a handoff beyond maxRounds", () =>
  Effect.gen(function*() {
    const exit = yield* drain(11, "queue-over-bound").pipe(Effect.exit)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.hasDies(exit.cause)).toBe(true)
      expect(Cause.squash(exit.cause)).toMatchObject({
        _tag: "@smthrs/flow/MaxRoundsExceeded",
        maxRounds: 10,
        roundOrdinal: 10
      })
    }
  }).pipe(Effect.provide(runtime)))
