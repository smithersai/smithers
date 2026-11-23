import * as MergeQueue from "@smthrs/merge-queue"
import { it } from "@smthrs/testing/Vitest"
import { Schema } from "effect"
import { describe, expect } from "vitest"

const checkStateInvariants = (config: MergeQueue.Config, state: MergeQueue.State) => {
  // 1. Change IDs are strictly unique
  const seenIds = new Set<number>()
  for (const ch of state.changes) {
    expect(seenIds.has(ch.id)).toBe(false)
    seenIds.add(ch.id)
    expect(ch.rev).toBeGreaterThanOrEqual(0)
    expect(ch.attempts).toBeGreaterThanOrEqual(0)
    expect(ch.attempts).toBeLessThanOrEqual(config.maxAttempts)
  }

  // 2. Run IDs are strictly unique and < nextRun
  const seenRuns = new Set<number>()
  for (const r of state.runs) {
    expect(seenRuns.has(r.id)).toBe(false)
    seenRuns.add(r.id)
    expect(r.id).toBeLessThan(state.nextRun)
    expect(r.batch.length).toBeGreaterThan(0)
  }

  // 3. No change is landed twice in main or landed[]
  const landedIds = new Set<number>()
  for (const l of state.landed) {
    for (const part of l.batch) {
      expect(landedIds.has(part.id)).toBe(false)
      landedIds.add(part.id)
    }
  }

  // 4. Every landed change in changes[] is marked terminal ("landed")
  for (const ch of state.changes) {
    if (landedIds.has(ch.id)) {
      expect(ch.status._tag).toBe("merged")
    }
  }

  // 5. History never exceeds window per check
  const counts = new Map<number, number>()
  for (const s of state.history) {
    counts.set(s.check, (counts.get(s.check) ?? 0) + 1)
  }
  for (const [, count] of counts) {
    expect(count).toBeLessThanOrEqual(config.window)
  }

  // 6. If pushingRun(state) is defined, it must exist in runs and match state.pushing
  const activePush = MergeQueue.pushingRun(state)
  if (activePush !== undefined) {
    expect(seenRuns.has(activePush.id)).toBe(true)
    expect(activePush.id).toBe(state.pushing)
  }
}

const OpSchema = Schema.Union([
  Schema.Struct({
    op: Schema.Literal("enqueue"),
    id: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 12 })),
    priority: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 }))
  }),
  Schema.Struct({
    op: Schema.Literal("withdraw"),
    id: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 12 }))
  }),
  Schema.Struct({
    op: Schema.Literal("result"),
    runIdx: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8 })),
    check: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 })),
    verdict: Schema.Literals(["pass", "fail"]),
    duration: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 }))
  }),
  Schema.Struct({
    op: Schema.Literal("fixed"),
    id: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 12 })),
    attempt: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 4 }))
  }),
  Schema.Struct({
    op: Schema.Literal("gaveUp"),
    id: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 12 })),
    attempt: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 4 }))
  }),
  Schema.Struct({
    op: Schema.Literal("foreign"),
    id: Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 110 }))
  }),
  Schema.Struct({
    op: Schema.Literal("land")
  }),
  Schema.Struct({
    op: Schema.Literal("settle")
  })
])

describe("@smthrs/merge-queue Lean-kernel stateful fuzz", () => {
  it.fuzz(
    "arbitrary event sequences interleaved with plan/settle preserve every queue safety invariant and terminal monotonicity",
    [
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 })),
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4 })),
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4 })),
      Schema.Array(OpSchema).check(Schema.isMaxLength(40))
    ],
    ([numChecks, maxBatch, maxRuns, ops]) => {
      const config: MergeQueue.Config = {
        required: Array.from({ length: numChecks }, (_, i) => i),
        maxAttempts: 2,
        maxBatch,
        maxRuns,
        window: 4,
        defaultDuration: 100
      }

      let state = MergeQueue.empty
      const terminalBefore = new Map<number, MergeQueue.Status["_tag"]>()
      checkStateInvariants(config, state)

      for (const action of ops) {
        if (action.op === "settle") {
          state = MergeQueue.settle(config, 32, state)
        } else if (action.op === "land") {
          const targetRun = state.pushing ?? (state.runs.length > 0 ? state.runs[0]!.id : 0)
          state = MergeQueue.step(config, state, { _tag: "land", run: targetRun })
        } else if (action.op === "result") {
          const run = state.runs.length > 0 ? state.runs[action.runIdx % state.runs.length]!.id : action.runIdx
          state = MergeQueue.step(config, state, {
            _tag: "result",
            run,
            check: action.check % numChecks,
            verdict: action.verdict,
            duration: action.duration
          })
        } else if (action.op === "gaveUp") {
          state = MergeQueue.step(config, state, {
            _tag: "gaveUp",
            id: action.id,
            attempt: action.attempt,
            detail: "fuzz gave up"
          })
        } else if (action.op === "enqueue") {
          state = MergeQueue.step(config, state, { _tag: "enqueue", id: action.id, priority: action.priority })
        } else if (action.op === "withdraw") {
          state = MergeQueue.step(config, state, { _tag: "withdraw", id: action.id })
        } else if (action.op === "fixed") {
          state = MergeQueue.step(config, state, { _tag: "fixed", id: action.id, attempt: action.attempt })
        } else {
          state = MergeQueue.step(config, state, { _tag: "foreign", id: action.id })
        }

        // Terminal statuses NEVER revert once reached
        for (const ch of state.changes) {
          const prev = terminalBefore.get(ch.id)
          if (prev !== undefined) {
            expect(ch.status._tag).toBe(prev)
          } else if (MergeQueue.isTerminal(ch.status)) {
            terminalBefore.set(ch.id, ch.status._tag)
          }
        }
        checkStateInvariants(config, state)

        // Running plan once and stepping it must always keep invariants
        const planned = MergeQueue.plan(config, state)
        if (planned !== undefined) {
          state = MergeQueue.step(config, state, planned)
          checkStateInvariants(config, state)
        }
      }

      // Compaction preserves queue semantics on the active frontier (Compact.lean)
      const compacted = MergeQueue.pruned(state)
      expect(compacted.main).toEqual(state.main)
      expect(compacted.pushing).toBe(state.pushing)
      expect(MergeQueue.pushingRun(compacted)).toEqual(MergeQueue.pushingRun(state))
      expect(MergeQueue.plan(config, compacted)).toEqual(MergeQueue.plan(config, state))
      return true
    }
  )

  it.fuzz(
    "bisectStep is always strictly positive and bounded by gap for valid gap/free inputs",
    [
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 })),
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 64 }))
    ],
    ([gap, free]) => {
      const step = MergeQueue.bisectStep(gap, free)
      expect(step).toBeGreaterThanOrEqual(1)
      expect(step).toBeLessThanOrEqual(gap)
      return true
    }
  )
})
