import { describe, expect, it } from "vitest"
import {
  before,
  blame,
  cancel,
  complete,
  empty,
  exhaustedDetail,
  failuresOf,
  green,
  inOrder,
  isTerminal,
  land,
  live,
  part,
  ready,
  record,
  run,
  sameTree,
  start,
  step,
  strip,
  tree
} from "../src/index.ts"
import { mainIds, play, standard, statuses } from "./support/Scenario.ts"

describe("enqueue", () => {
  it("adds a queued change at revision 0 with the next arrival number", () => {
    const { state } = play(standard, "enqueue 7 3", "enqueue 9 1")
    expect(state.changes).toEqual([
      { id: 7, priority: 3, seq: 0, rev: 0, attempts: 0, status: { _tag: "queued" } },
      { id: 9, priority: 1, seq: 1, rev: 0, attempts: 0, status: { _tag: "queued" } }
    ])
    expect(state.nextSeq).toBe(2)
  })

  it("refuses an id the queue has seen, whatever its status", () => {
    const before = play(standard, "enqueue 7 3", "withdraw 7").state
    expect(step(play(standard).config, before, { _tag: "enqueue", id: 7, priority: 9 })).toBe(before)
  })
})

describe("withdraw", () => {
  it("ends a queued change and a change being fixed", () => {
    const { state } = play(
      standard,
      "enqueue 1 0",
      "enqueue 2 0",
      "start 1",
      "result 0 1 fail 5",
      "blame 0",
      "withdraw 1",
      "withdraw 2"
    )
    expect(statuses(state)).toEqual({ 1: "withdrawn", 2: "withdrawn" })
  })

  it("leaves a merged change merged", () => {
    const { state } = play(
      standard,
      "enqueue 1 0",
      "start 1",
      "result 0 1 pass 5",
      "result 0 2 pass 5",
      "land 0",
      "withdraw 1"
    )
    expect(statuses(state)).toEqual({ 1: "merged" })
    expect(mainIds(state)).toEqual([1])
  })

  it("stops a run that contains the withdrawn change from landing", () => {
    const { config, state } = play(
      standard,
      "enqueue 1 0",
      "enqueue 2 0",
      "start 2",
      "result 0 1 pass 5",
      "result 0 2 pass 5",
      "withdraw 2"
    )
    expect(live(state, state.runs[0]!)).toBeUndefined()
    expect(land(config, state, 0)).toBe(state)
  })
})

describe("result", () => {
  it("records the first result of a required check and its duration", () => {
    const { state } = play(standard, "enqueue 1 0", "start 1", "result 0 2 pass 40")
    expect(state.runs[0]!.results).toEqual([{ check: 2, verdict: "pass" }])
    expect(state.history).toEqual([{ check: 2, duration: 40 }])
  })

  it("ignores a second result for the same check: the first one stands", () => {
    const first = play(standard, "enqueue 1 0", "start 1", "result 0 2 pass 40")
    expect(step(first.config, first.state, { _tag: "result", run: 0, check: 2, verdict: "fail", duration: 1 })).toBe(
      first.state
    )
  })

  it("ignores a check that is not required and a run the queue does not hold", () => {
    const first = play(standard, "enqueue 1 0", "start 1")
    expect(play(standard, "enqueue 1 0", "start 1", "result 0 3 pass 1").state).toEqual(first.state)
    expect(play(standard, "enqueue 1 0", "start 1", "result 5 1 pass 1").state).toEqual(first.state)
  })

  it("changes only the run it names", () => {
    const { state } = play(standard, "enqueue 1 0", "enqueue 2 0", "start 1", "start 2", "result 1 1 fail 3")
    expect(state.runs.map((entry) => entry.results.length)).toEqual([0, 1])
  })
})

describe("record", () => {
  it("keeps at most the window of samples per check, dropping the oldest of that check", () => {
    const history = [{ check: 1, duration: 10 }, { check: 2, duration: 99 }, { check: 1, duration: 20 }]
    expect(record(2, history, 1, 30)).toEqual([
      { check: 2, duration: 99 },
      { check: 1, duration: 20 },
      { check: 1, duration: 30 }
    ])
    expect(record(3, history, 1, 30)).toEqual([...history, { check: 1, duration: 30 }])
  })

  it("keeps nothing with a window of 0", () => {
    expect(record(0, [], 1, 30)).toEqual([])
  })
})

describe("start", () => {
  it("tests the first ready changes, by priority and then arrival, on the target's tree", () => {
    const { state } = play(standard, "enqueue 1 0", "enqueue 2 5", "enqueue 3 5", "start 2")
    expect(ready(state).map((change) => change.id)).toEqual([2, 3, 1])
    expect(state.runs).toEqual([{ id: 0, base: [], batch: [{ id: 2, rev: 0 }, { id: 3, rev: 0 }], results: [] }])
    expect(state.nextRun).toBe(1)
  })

  it("refuses a count of 0 and a count above the ready changes", () => {
    const { config, state } = play(standard, "enqueue 1 0")
    expect(start(config, state, 0)).toBe(state)
    expect(start(config, state, 2)).toBe(state)
  })

  it("refuses a tree that a run already tests", () => {
    const { config, state } = play(standard, "enqueue 1 0", "start 1")
    expect(start(config, state, 1)).toBe(state)
  })

  it("refuses when the run limit is reached, and counts only pending runs", () => {
    const full = play(standard, "enqueue 1 0", "enqueue 2 0", "enqueue 3 0", "start 1", "start 2")
    expect(start(full.config, full.state, 3)).toBe(full.state)
    const failedOne = play(
      standard,
      "enqueue 1 0",
      "enqueue 2 0",
      "enqueue 3 0",
      "start 1",
      "start 2",
      "result 1 1 fail 1",
      "start 3"
    )
    expect(failedOne.state.runs.map((entry) => entry.id)).toEqual([0, 1, 2])
  })
})

describe("land", () => {
  const greenRun = [standard, "enqueue 1 0", "enqueue 2 0", "start 2", "result 0 1 pass 10", "result 0 2 pass 20"]

  it("moves the target onto exactly the tested tree and records the landing", () => {
    const { state } = play(...greenRun, "land 0")
    expect(state.main).toEqual([{ id: 1, rev: 0 }, { id: 2, rev: 0 }])
    expect(statuses(state)).toEqual({ 1: "merged", 2: "merged" })
    expect(state.runs).toEqual([])
    expect(state.landed).toEqual([{
      run: 0,
      base: [],
      batch: [{ id: 1, rev: 0 }, { id: 2, rev: 0 }],
      results: [{ check: 1, verdict: "pass" }, { check: 2, verdict: "pass" }]
    }])
  })

  it("refuses a partial result, however much has passed", () => {
    const { config, state } = play(...greenRun.slice(0, 5))
    expect(complete(config, state.runs[0]!.results)).toBe(false)
    expect(land(config, state, 0)).toBe(state)
  })

  it("refuses a complete result with a failure", () => {
    const { config, state } = play(...greenRun.slice(0, 5), "result 0 2 fail 20")
    expect(complete(config, state.runs[0]!.results)).toBe(true)
    expect(land(config, state, 0)).toBe(state)
  })

  it("refuses a run the queue does not hold", () => {
    const { config, state } = play(...greenRun)
    expect(land(config, state, 4)).toBe(state)
  })

  it("never treats an empty set of required checks as green", () => {
    const { config, state } = play("config required= maxAttempts=1 maxBatch=1 maxRuns=1", "enqueue 1 0", "start 1")
    expect(green(config, [])).toBe(false)
    expect(land(config, state, 0)).toBe(state)
  })

  it("lands a longer run after a shorter one: the trees are the same", () => {
    const { state } = play(
      standard,
      "enqueue 1 0",
      "enqueue 2 0",
      "start 1",
      "start 2",
      "result 0 1 pass 1",
      "result 0 2 pass 1",
      "result 1 1 pass 1",
      "result 1 2 pass 1",
      "land 0",
      "land 1"
    )
    expect(mainIds(state)).toEqual([1, 2])
    expect(state.landed.map((landing) => [landing.base.length, landing.batch.length])).toEqual([[0, 1], [1, 1]])
  })

  it("refuses a run whose tree the target has already passed", () => {
    const { config, state } = play(
      standard,
      "enqueue 1 0",
      "enqueue 2 0",
      "start 1",
      "start 2",
      "result 0 1 pass 1",
      "result 0 2 pass 1",
      "result 1 1 pass 1",
      "result 1 2 pass 1",
      "land 1"
    )
    expect(mainIds(state)).toEqual([1, 2])
    expect(land(config, state, 0)).toBe(state)
  })
})

describe("blame", () => {
  const failing = [standard, "enqueue 1 0", "start 1", "result 0 2 fail 5"]

  it("sends the only suspect to a fix agent at the first failure, before the run ends", () => {
    const { config, state } = play(...failing, "blame 0")
    expect(complete(config, state.runs[0]!.results)).toBe(false)
    expect(state.changes[0]).toMatchObject({ attempts: 1, rev: 0, status: { _tag: "fixing", run: 0 } })
  })

  it("keeps streaming the blaming run's later failures to the fix agent", () => {
    const { state } = play(...failing, "blame 0", "result 0 1 fail 7")
    expect(failuresOf(state, state.changes[0]!)).toEqual([2, 1])
  })

  it("gives a fix agent nothing when the blaming run is gone", () => {
    const { state } = play(...failing, "blame 0", "cancel 0")
    expect(failuresOf(state, state.changes[0]!)).toEqual([])
    expect(failuresOf(state, { ...state.changes[0]!, status: { _tag: "queued" } })).toEqual([])
  })

  it("puts the change out with a reason when no fix attempt is left", () => {
    const { state } = play(
      "config required=1,2 maxAttempts=0 maxBatch=1 maxRuns=1",
      "enqueue 1 0",
      "start 1",
      "result 0 2 fail 5",
      "blame 0"
    )
    expect(state.changes[0]!.status).toEqual({
      _tag: "unmergeable",
      reason: { kind: "attemptsExhausted", detail: exhaustedDetail, failures: [2], attempts: 0 }
    })
  })

  it("refuses a run with more than one suspect, a run with no failure and an unknown run", () => {
    const two = play(standard, "enqueue 1 0", "enqueue 2 0", "start 2", "result 0 1 fail 1")
    expect(blame(two.config, two.state, 0)).toBe(two.state)
    const clean = play(standard, "enqueue 1 0", "start 1", "result 0 1 pass 1")
    expect(blame(clean.config, clean.state, 0)).toBe(clean.state)
    expect(blame(clean.config, clean.state, 3)).toBe(clean.state)
  })

  it("blames the one change left after the changes before it landed", () => {
    const { state } = play(
      standard,
      "enqueue 1 0",
      "enqueue 2 0",
      "start 1",
      "start 2",
      "result 1 1 fail 1",
      "blame 1",
      "result 0 1 pass 1",
      "result 0 2 pass 1",
      "land 0",
      "blame 1"
    )
    expect(statuses(state)).toEqual({ 1: "merged", 2: "fixing" })
  })
})

describe("fixed", () => {
  const blamed = [standard, "enqueue 1 4", "start 1", "result 0 2 fail 5", "blame 0"]

  it("queues the new revision in the change's old place", () => {
    const { state } = play(...blamed, "fixed 1 1")
    expect(state.changes[0]).toEqual({ id: 1, priority: 4, seq: 0, rev: 1, attempts: 1, status: { _tag: "queued" } })
  })

  it("refuses an answer for another attempt and for a change that is not being fixed", () => {
    const before = play(...blamed).state
    expect(play(...blamed, "fixed 1 0").state).toEqual(before)
    expect(play(...blamed, "fixed 2 1").state).toEqual(before)
    const queued = play(standard, "enqueue 1 0").state
    expect(play(standard, "enqueue 1 0", "fixed 1 0").state).toEqual(queued)
  })

  it("makes the old revision's run useless: it is not live any more", () => {
    const { state } = play(...blamed, "fixed 1 1")
    expect(live(state, state.runs[0]!)).toBeUndefined()
  })
})

describe("gaveUp", () => {
  const blamed = [standard, "enqueue 1 0", "start 1", "result 0 2 fail 5", "blame 0"]

  it("puts the change out with the agent's words and the failures it worked from", () => {
    const { state } = play(...blamed, "gaveup 1 1 needs a rewrite on the new parser")
    expect(state.changes[0]!.status).toEqual({
      _tag: "unmergeable",
      reason: { kind: "agentVerdict", detail: "needs a rewrite on the new parser", failures: [2], attempts: 1 }
    })
  })

  it("refuses a verdict without words, for another attempt, or for a change that is not being fixed", () => {
    const before = play(...blamed).state
    expect(play(...blamed, "gaveup 1 1").state).toEqual(before)
    expect(play(...blamed, "gaveup 1 0 words").state).toEqual(before)
    expect(play(...blamed, "gaveup 2 1 words").state).toEqual(before)
  })
})

describe("cancel", () => {
  it("forgets the run and nothing else", () => {
    const before = play(standard, "enqueue 1 0", "enqueue 2 0", "start 1", "start 2").state
    const after = cancel(before, 0)
    expect(after.runs.map((entry) => entry.id)).toEqual([1])
    expect({ ...after, runs: before.runs }).toEqual(before)
  })
})

describe("order", () => {
  const change = (id: number, priority: number, seq: number) =>
    ({ id, priority, seq, rev: 0, attempts: 0, status: { _tag: "queued" } }) as const

  it("puts higher priority first and earlier arrival first among equals", () => {
    expect(before(change(1, 5, 9), change(2, 1, 0))).toBe(true)
    expect(before(change(1, 1, 0), change(2, 1, 1))).toBe(true)
    expect(before(change(1, 1, 1), change(2, 1, 0))).toBe(false)
    expect(inOrder([change(1, 0, 0), change(2, 5, 3), change(3, 5, 1)]).map((entry) => entry.id)).toEqual([3, 2, 1])
  })

  it("is stable: changes it cannot tell apart keep the order they were given in", () => {
    expect(inOrder([change(1, 2, 4), change(2, 2, 4)]).map((entry) => entry.id)).toEqual([1, 2])
    expect(inOrder([change(2, 2, 4), change(1, 2, 4)]).map((entry) => entry.id)).toEqual([2, 1])
  })
})

describe("helpers", () => {
  it("strip returns what a tree adds to the target, or nothing when it does not extend it", () => {
    const a = { id: 1, rev: 0 }
    const b = { id: 2, rev: 0 }
    expect(strip([a], [a, b])).toEqual([b])
    expect(strip([a], [a])).toEqual([])
    expect(strip([a, b], [a])).toBeUndefined()
    expect(strip([b], [a, b])).toBeUndefined()
    expect(strip([{ id: 1, rev: 1 }], [a, b])).toBeUndefined()
  })

  it("sameTree compares revisions in order", () => {
    const a = { id: 1, rev: 0 }
    const b = { id: 2, rev: 0 }
    expect(sameTree([a, b], [a, b])).toBe(true)
    expect(sameTree([a, b], [b, a])).toBe(false)
    expect(sameTree([a], [a, b])).toBe(false)
  })

  it("tree is the base followed by the batch, and part is a change at its revision", () => {
    expect(tree({ id: 0, base: [{ id: 1, rev: 0 }], batch: [{ id: 2, rev: 3 }], results: [] })).toEqual([
      { id: 1, rev: 0 },
      { id: 2, rev: 3 }
    ])
    expect(part({ id: 2, priority: 0, seq: 0, rev: 3, attempts: 1, status: { _tag: "queued" } })).toEqual({
      id: 2,
      rev: 3
    })
  })

  it("merged, unmergeable and withdrawn are the statuses that never change", () => {
    expect(isTerminal({ _tag: "merged" })).toBe(true)
    expect(isTerminal({ _tag: "withdrawn" })).toBe(true)
    expect(isTerminal({
      _tag: "unmergeable",
      reason: { kind: "agentVerdict", detail: "x", failures: [], attempts: 0 }
    })).toBe(true)
    expect(isTerminal({ _tag: "queued" })).toBe(false)
    expect(isTerminal({ _tag: "fixing", run: 0 })).toBe(false)
  })

  it("run applies events in order", () => {
    const { config } = play(standard)
    const state = run(config, empty, [
      { _tag: "enqueue", id: 1, priority: 0 },
      { _tag: "start", count: 1 },
      { _tag: "result", run: 0, check: 1, verdict: "pass", duration: 1 },
      { _tag: "result", run: 0, check: 2, verdict: "pass", duration: 1 },
      { _tag: "land", run: 0 },
      { _tag: "enqueue", id: 2, priority: 0 },
      { _tag: "start", count: 1 },
      { _tag: "result", run: 1, check: 1, verdict: "fail", duration: 1 },
      { _tag: "blame", run: 1 },
      { _tag: "gaveUp", id: 2, attempt: 1, detail: "no" },
      { _tag: "cancel", run: 1 },
      { _tag: "enqueue", id: 3, priority: 0 },
      { _tag: "withdraw", id: 3 },
      { _tag: "fixed", id: 3, attempt: 0 }
    ])
    expect(statuses(state)).toEqual({ 1: "merged", 2: "unmergeable", 3: "withdrawn" })
    expect(state.runs).toEqual([])
  })
})
