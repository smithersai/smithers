import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import { type TargetResult, verdictOf } from "../../src/contract/RunRecord.vibe"
import {
  failedAsBefore,
  failureMark,
  type LastFailures,
  noProgress,
  remember,
  type RerunTally
} from "../../src/replay/Failures.ts"
import { maxReruns } from "../../src/replay/index.vibe"
import { type Execute, settle } from "../../src/replay/Replay.vibe"

const result = (label: string, status: TargetResult["status"]): TargetResult => ({
  label,
  status,
  key: "k",
  durationMs: 1
})

/** Runs targets by a script: each call answers with the next status for each target. */
const scripted = (statuses: Readonly<Record<string, ReadonlyArray<TargetResult["status"]>>>) => {
  const calls: Array<ReadonlyArray<string>> = []
  const seen = new Map<string, number>()
  const execute: Execute<never> = (targets) =>
    Effect.sync(() => {
      const labels = targets ?? Object.keys(statuses)
      calls.push(labels)
      return labels.map((label) => {
        const index = seen.get(label) ?? 0
        seen.set(label, index + 1)
        const script = statuses[label] ?? []
        return result(label, script[Math.min(index, script.length - 1)] ?? "ran")
      })
    })
  return { calls, execute }
}

const settled = <R>(execute: Execute<R>, first: ReadonlyArray<TargetResult>) =>
  Effect.runPromise(settle(execute, first, maxReruns, first.length) as Effect.Effect<ReadonlyArray<TargetResult>>)

describe("settle", () => {
  it("does not run again a target stopped for making no progress", async () => {
    const { calls, execute } = scripted({ a: ["failed"], b: ["ran"] })
    const stalled = { ...result("a", "failed"), error: noProgress(10) }
    const [a] = await settled(execute, [stalled, result("b", "ran")])
    expect(calls).toEqual([])
    expect(a?.error).toBe(noProgress(10))
  })

  it("reruns a target that keeps failing ten times, for eleven attempts", async () => {
    const { calls, execute } = scripted({ a: ["failed"] })
    const [a] = await settled(execute, [result("a", "failed")])
    expect(calls).toHaveLength(10)
    expect(a?.attempts).toHaveLength(11)
    expect(a?.status).toBe("failed")
    expect(verdictOf(a!)).toBe("fail")
  })

  it("stops rerunning a target once it passes, and calls it flaky", async () => {
    const { calls, execute } = scripted({ a: ["failed", "failed", "ran"] })
    const [a] = await settled(execute, [result("a", "failed")])
    expect(calls).toHaveLength(3)
    expect(a?.attempts?.map((attempt) => attempt.passed)).toEqual([false, false, false, true])
    expect(a?.status).toBe("ran")
    expect(verdictOf(a!)).toBe("flaky")
  })

  it("reruns nothing when nothing failed", async () => {
    const { calls, execute } = scripted({})
    await settled(execute, [result("a", "ran"), result("b", "hit")])
    expect(calls).toEqual([])
  })

  it("runs what waited on a target that turned out flaky", async () => {
    const { calls, execute } = scripted({ a: ["ran"], b: ["ran"] })
    const results = await settled(execute, [result("a", "failed"), result("b", "skipped")])
    expect(calls).toEqual([["a"], ["b"]])
    expect(results.map((entry) => [entry.label, entry.status])).toEqual([["a", "ran"], ["b", "ran"]])
  })

  it("keeps a target blocked when only an unrelated failure recovered", async () => {
    const { calls, execute } = scripted({ a: ["ran"], b: ["failed"] })
    const blocked = { ...result("c", "skipped"), blockedBy: "b" }
    const results = await settled(execute, [result("a", "failed"), result("b", "failed"), blocked])
    expect(calls.flat()).not.toContain("c")
    expect(results[2]?.status).toBe("skipped")
  })

  it("stops at its bound: with no round left, what waited on a flaky target stays skipped", async () => {
    const { calls, execute } = scripted({ a: ["ran"], b: ["ran"] })
    const results = await Effect.runPromise(
      settle(execute, [result("a", "failed"), result("b", "skipped")], maxReruns, 0) as Effect.Effect<
        ReadonlyArray<TargetResult>
      >
    )
    expect(calls).toEqual([["a"]])
    expect(results.map((entry) => [entry.label, entry.status])).toEqual([["a", "ran"], ["b", "skipped"]])
    expect(verdictOf(results[0]!)).toBe("flaky")
  })

  it("leaves a waiting target skipped when what it waited on really failed", async () => {
    const { calls, execute } = scripted({ a: ["failed"] })
    const results = await settled(execute, [result("a", "failed"), result("b", "skipped")])
    expect(calls.every((labels) => labels.join() === "a")).toBe(true)
    expect(results[1]?.status).toBe("skipped")
    expect(results[1]?.skipReason).toBe("dependency-failed")
  })

  it("gives a failed attempt only to what ran again", async () => {
    const { calls, execute } = scripted({ a: ["failed"], b: ["failed"] })
    const stalled = { ...result("a", "failed"), error: noProgress(10) }
    const [a, b] = await settled(execute, [stalled, result("b", "failed")])
    expect(calls.every((labels) => labels.join() === "b")).toBe(true)
    expect(a?.attempts).toHaveLength(1)
    expect(b?.attempts).toHaveLength(11)
  })
})

describe("a failure seen in the run before", () => {
  const failing = (label: string, error: string, exitCode = 1): TargetResult => ({
    ...result(label, "failed"),
    error,
    exitCode
  })
  const settledWith = (
    execute: Execute<never>,
    first: ReadonlyArray<TargetResult>,
    last: LastFailures,
    tally: RerunTally = { count: 0, ms: 0 }
  ) => Effect.runPromise(settle(execute, first, 1, first.length, last, tally))

  it("is not run again when the step fails the same way: twice the same is broken", async () => {
    const { calls, execute } = scripted({ a: ["failed"], b: ["failed"] })
    const last: LastFailures = new Map()
    remember(last, [failing("a", "expected 2, got 3")])
    const [a, b] = await settledWith(execute, [failing("a", "expected 2, got 3"), failing("b", "other")], last)
    expect(calls).toEqual([["b"]])
    expect(a?.attempts).toHaveLength(1)
    expect(verdictOf(a!)).toBe("fail")
    expect(b?.attempts).toHaveLength(2)
  })

  it("is run again when the exit code or the first line of the error differs", async () => {
    const { calls, execute } = scripted({ a: ["failed"], b: ["failed"] })
    const last: LastFailures = new Map()
    remember(last, [failing("a", "expected 2, got 3"), failing("b", "killed", 137)])
    await settledWith(execute, [failing("a", "expected 2, got 4"), failing("b", "killed", 1)], last)
    expect(calls).toEqual([["a", "b"]])
  })

  it("is told apart by exit code and first error line, whatever follows and whatever color it has", () => {
    expect(failureMark({ error: "\u001b[31mboom\u001b[0m\nat line 3", exitCode: 2 })).toBe(
      failureMark({ error: "boom\nat line 9", exitCode: 2 })
    )
    expect(failureMark({ error: "boom", exitCode: 2 })).not.toBe(failureMark({ error: "boom", exitCode: 3 }))
    expect(failureMark({ error: "boom" })).not.toBe(failureMark({ error: "boom", exitCode: 0 }))
    expect(failureMark({})).toBe(failureMark({ error: "" }))
  })

  it("is forgotten when the step passes, and kept when the step did not run", () => {
    const last: LastFailures = new Map()
    remember(last, [failing("a", "boom"), failing("b", "boom"), failing("c", "boom")])
    remember(last, [result("a", "ran"), result("b", "skipped"), result("c", "hit")])
    expect([...last.keys()]).toEqual(["b"])
    expect(failedAsBefore(last, failing("b", "boom"))).toBe(true)
    expect(failedAsBefore(last, failing("a", "boom"))).toBe(false)
    // A step that passes is never taken for a failure seen before.
    expect(failedAsBefore(last, { ...result("b", "ran"), error: "boom", exitCode: 1 })).toBe(false)
  })

  it("includes the first execution of a recovered step's dependants in measured time", async () => {
    const firstRuns = { ms: 100 }
    const tally = { count: 0, ms: 0 }
    const first = [failing("a", "one"), { ...result("b", "skipped"), blockedBy: "a" }]
    const execute: Execute<never> = (labels) =>
      Effect.andThen(
        Effect.sleep("20 millis"),
        Effect.succeed(
          (labels ?? []).map((label) => result(label, "ran"))
        )
      )
    const results = await Effect.runPromise(settle(execute, first, 1, first.length, new Map(), tally, firstRuns))
    expect(results.map((target) => target.status)).toEqual(["ran", "ran"])
    expect(tally.count).toBe(1)
    expect(tally.ms).toBeGreaterThanOrEqual(19)
    expect(firstRuns.ms).toBeGreaterThanOrEqual(119)
  })

  it("counts what ran again and how long that took", async () => {
    const { execute } = scripted({ a: ["failed"], b: ["ran"], c: ["ran"] })
    const tally: RerunTally = { count: 0, ms: 0 }
    const first = [failing("a", "one"), failing("b", "two"), result("c", "skipped")]
    await settledWith(execute, first, new Map(), tally)
    // a and b ran again; c, which waited on them, ran for the first time and is no rerun.
    expect(tally.count).toBe(2)
    expect(tally.ms).toBeGreaterThanOrEqual(0)
  })
})
