import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import { type TargetResult, verdictOf } from "../../src/contract/RunRecord.ts"
import { maxReruns } from "../../src/replay/index.ts"
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

  it("leaves a waiting target skipped when what it waited on really failed", async () => {
    const { calls, execute } = scripted({ a: ["failed"] })
    const results = await settled(execute, [result("a", "failed"), result("b", "skipped")])
    expect(calls.every((labels) => labels.join() === "a")).toBe(true)
    expect(results[1]?.status).toBe("skipped")
    expect(results[1]?.skipReason).toBe("dependency-failed")
  })
})
