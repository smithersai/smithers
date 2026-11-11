import { describe, expect, it } from "vitest"
import {
  ahead,
  bestLandable,
  doomed,
  evidence,
  fixBriefs,
  maxOf,
  minOf,
  plan,
  prefixLength,
  renderEvent,
  settle,
  shortestFailed,
  wantsCi
} from "../src/index.ts"
import { mainIds, play, standard, statuses } from "./support/Scenario.ts"

/** The policy's decision after the trace, as a trace line; `wait` for none. */
const decision = (...lines: ReadonlyArray<string>): string => {
  const { config, state } = play(...lines)
  const event = plan(config, state)
  return event === undefined ? "wait" : renderEvent(event)
}

const serial = "config required=1 maxAttempts=1 maxBatch=4 maxRuns=1 window=3 defaultDuration=60"

describe("plan: starting runs", () => {
  it("waits when nothing is queued", () => {
    expect(decision(standard)).toBe("wait")
  })

  it("starts a batch of up to maxBatch, then speculates on the next batch", () => {
    const queued = [standard, "enqueue 1 0", "enqueue 2 0", "enqueue 3 0"]
    expect(decision(...queued)).toBe("start 2")
    expect(decision(...queued, "plan")).toBe("start 3")
    expect(decision(...queued, "plan", "plan")).toBe("wait")
  })

  it("treats a maxBatch of 0 as 1", () => {
    expect(decision("config required=1 maxAttempts=1 maxBatch=0 maxRuns=1", "enqueue 1 0", "enqueue 2 0")).toBe(
      "start 1"
    )
  })

  it("starts nothing with no run slot", () => {
    expect(decision("config required=1 maxAttempts=1 maxBatch=1 maxRuns=0", "enqueue 1 0")).toBe("wait")
  })

  it("lets a pending run started under an older order keep its slot", () => {
    const lines = [standard, "enqueue 1 0", "plan", "enqueue 2 9"]
    const { config, state } = play(...lines)
    expect(prefixLength(state, state.runs[0]!)).toBeUndefined()
    expect(plan(config, state)).toBeUndefined()
    expect(decision(...lines, "result 0 1 pass 1", "result 0 2 pass 1")).toBe("land 0")
  })
})

describe("plan: landing", () => {
  it("lands a complete green run", () => {
    expect(decision(standard, "enqueue 1 0", "plan", "result 0 1 pass 1", "result 0 2 pass 1")).toBe("land 0")
  })

  it("lands the longest landable run, and the earlier one on a tie", () => {
    const both = [
      standard,
      "enqueue 1 0",
      "enqueue 2 0",
      "enqueue 3 0",
      "start 1",
      "start 3",
      "result 0 1 pass 1",
      "result 0 2 pass 1",
      "result 1 1 pass 1",
      "result 1 2 pass 1"
    ]
    expect(decision(...both)).toBe("land 1")
    const { config, state } = play(...both)
    expect(bestLandable(config, state)?.id).toBe(1)
    const tie = play(standard, "enqueue 1 0", "start 1", "result 0 1 pass 1", "result 0 2 pass 1")
    const twin = { ...tie.state.runs[0]!, id: 9 }
    expect(bestLandable(tie.config, { ...tie.state, runs: [...tie.state.runs, twin] })?.id).toBe(0)
  })
})

describe("plan: failures", () => {
  it("blames a lone failing change at its first failed check", () => {
    expect(decision(standard, "enqueue 1 0", "plan", "result 0 2 fail 1")).toBe("blame 0")
  })

  it("bisects a failing batch down to the change that breaks it", () => {
    const failing = [serial, "enqueue 1 0", "enqueue 2 0", "enqueue 3 0", "enqueue 4 0", "plan", "result 0 1 fail 1"]
    expect(decision(serial, "enqueue 1 0", "enqueue 2 0", "enqueue 3 0", "enqueue 4 0")).toBe("start 4")
    expect(shortestFailed(play(...failing).state)).toBe(4)
    expect(decision(...failing)).toBe("start 2")
    const firstHalf = [...failing, "plan", "result 1 1 pass 1"]
    expect(decision(...firstHalf)).toBe("land 1")
    const secondHalf = [...firstHalf, "plan"]
    expect(mainIds(play(...secondHalf).state)).toEqual([1, 2])
    expect(shortestFailed(play(...secondHalf).state)).toBe(2)
    expect(decision(...secondHalf)).toBe("start 1")
    const third = [...secondHalf, "plan", "result 2 1 pass 1", "plan"]
    expect(mainIds(play(...third).state)).toEqual([1, 2, 3])
    expect(decision(...third)).toBe("blame 0")
    const blamed = play(...third, "plan")
    expect(statuses(blamed.state)).toEqual({ 1: "merged", 2: "merged", 3: "merged", 4: "fixing" })
    expect(plan(blamed.config, blamed.state)).toBeUndefined()
  })

  it("puts a change out once its fix also fails and no attempt is left", () => {
    const { state } = play(
      serial,
      "enqueue 4 0",
      "plan",
      "result 0 1 fail 1",
      "plan",
      "fixed 4 1",
      "plan",
      "plan",
      "result 1 1 fail 1",
      "plan"
    )
    expect(state.changes[0]!.status).toMatchObject({ _tag: "unmergeable", reason: { kind: "attemptsExhausted" } })
  })

  it("cancels a run longer than a prefix known to fail", () => {
    const lines = [
      "config required=1 maxAttempts=1 maxBatch=2 maxRuns=3 window=1 defaultDuration=1",
      "enqueue 1 0",
      "enqueue 2 0",
      "enqueue 3 0",
      "enqueue 4 0",
      "plan",
      "plan",
      "result 0 1 fail 1"
    ]
    const { state } = play(...lines)
    expect(state.runs.map((entry) => entry.batch.length)).toEqual([2, 4])
    expect(doomed(state, state.runs[1]!)).toBe(true)
    expect(doomed(state, state.runs[0]!)).toBe(false)
    expect(decision(...lines)).toBe("cancel 1")
    expect(decision(...lines, "plan")).toBe("start 1")
  })

  it("cancels a failed run that is no longer a prefix of the ready order", () => {
    const lines = [standard, "enqueue 1 0", "enqueue 2 0", "plan", "result 0 1 fail 1", "enqueue 3 9"]
    const { state } = play(...lines)
    expect(doomed(state, state.runs[0]!)).toBe(true)
    expect(decision(...lines)).toBe("cancel 0")
  })
})

describe("plan: runs the queue no longer needs", () => {
  const blamed = [standard, "enqueue 1 0", "plan", "result 0 2 fail 1", "plan"]

  it("keeps the run that blamed a change while that change is being fixed", () => {
    const { config, state } = play(...blamed)
    expect(evidence(state, state.runs[0]!)).toBe(true)
    expect(doomed(state, state.runs[0]!)).toBe(false)
    expect(plan(config, state)).toBeUndefined()
    expect(wantsCi(config, state, state.runs[0]!)).toBe(true)
  })

  it("cancels it once the fix arrives, then tests the new revision", () => {
    expect(decision(...blamed, "fixed 1 1")).toBe("cancel 0")
    expect(decision(...blamed, "fixed 1 1", "plan")).toBe("start 1")
  })

  it("cancels a run whose change was withdrawn", () => {
    expect(decision(standard, "enqueue 1 0", "plan", "withdraw 1")).toBe("cancel 0")
  })
})

describe("settle", () => {
  it("applies decisions until the queue has to wait", () => {
    const { config, state } = play(standard, "enqueue 1 0", "enqueue 2 0", "enqueue 3 0")
    const settled = settle(config, 10, state)
    expect(settled.runs.map((entry) => entry.batch.length)).toEqual([2, 3])
    expect(plan(config, settled)).toBeUndefined()
  })

  it("stops when its fuel runs out", () => {
    const { config, state } = play(standard, "enqueue 1 0", "enqueue 2 0", "enqueue 3 0")
    expect(settle(config, 1, state).runs).toHaveLength(1)
    expect(settle(config, 0, state)).toBe(state)
  })
})

describe("what the world must be doing", () => {
  it("CI runs pending runs and stops for a finished or failed batch", () => {
    const pendingRun = play(standard, "enqueue 1 0", "enqueue 2 0", "plan")
    expect(wantsCi(pendingRun.config, pendingRun.state, pendingRun.state.runs[0]!)).toBe(true)
    const failedBatch = play(standard, "enqueue 1 0", "enqueue 2 0", "plan", "result 0 1 fail 1")
    expect(wantsCi(failedBatch.config, failedBatch.state, failedBatch.state.runs[0]!)).toBe(false)
    const done = play(standard, "enqueue 1 0", "plan", "result 0 1 pass 1", "result 0 2 pass 1")
    expect(wantsCi(done.config, done.state, done.state.runs[0]!)).toBe(false)
  })

  it("a fix brief names the revision, the attempt, the failures so far and who is ahead", () => {
    const { state } = play(
      standard,
      "enqueue 2 5",
      "enqueue 3 0",
      "start 1",
      "result 0 2 fail 1",
      "blame 0",
      "start 1",
      "result 1 1 fail 1",
      "result 1 2 fail 1",
      "blame 1"
    )
    expect(statuses(state)).toEqual({ 2: "fixing", 3: "fixing" })
    expect(fixBriefs(state)).toEqual([
      { id: 2, rev: 0, attempt: 1, failures: [2], ahead: [] },
      { id: 3, rev: 0, attempt: 1, failures: [1, 2], ahead: [{ id: 2, fixing: true }] }
    ])
  })

  it("ahead lists unfinished changes that land first, queued or being fixed", () => {
    const { state } = play(standard, "enqueue 1 0", "enqueue 2 3", "enqueue 3 0", "enqueue 4 0", "withdraw 4")
    expect(ahead(state, state.changes[2]!)).toEqual([{ id: 2, fixing: false }, { id: 1, fixing: false }])
    expect(ahead(state, state.changes[1]!)).toEqual([])
  })
})

describe("minOf and maxOf", () => {
  it("minOf is the smallest, or nothing for an empty list", () => {
    expect(minOf([3, 1, 2])).toBe(1)
    expect(minOf([])).toBeUndefined()
  })

  it("maxOf is the largest, or 0 for an empty list", () => {
    expect(maxOf([3, 1, 2])).toBe(3)
    expect(maxOf([])).toBe(0)
  })
})
