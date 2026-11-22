/** Why there is nothing to measure: no step passed in any baseline. */
import { describe, expect, it } from "vitest"
import type { RunRecord, TargetResult } from "../../src/contract/RunRecord.ts"
import { nothingPassed } from "../../src/replay/Failures.ts"
import { refusedAt } from "../native/repo.ts"

const result = (label: string, status: TargetResult["status"], error?: string): TargetResult => ({
  label,
  status,
  key: "",
  durationMs: 1,
  ...(error === undefined ? {} : { error })
})

const record = (commit: string, results: ReadonlyArray<TargetResult>): RunRecord => ({
  ok: results.every((entry) => entry.status !== "failed"),
  counts: { hit: 0, ran: 0, failed: 0, skipped: 0 },
  results,
  commit
})

describe("nothingPassed", () => {
  it("is undefined when a target ran or came from the cache in any baseline", () => {
    expect(
      nothingPassed([
        record("a".repeat(40), [result("//:a", "failed")]),
        record("b".repeat(40), [result("//:a", "ran")])
      ])
    )
      .toBeUndefined()
    expect(nothingPassed([record("a".repeat(40), [result("//:a", "hit")])])).toBeUndefined()
    expect(nothingPassed([])).toBeUndefined()
  })

  it("gives the newest commit's first failure when nothing passed at any commit", () => {
    const older = record("a".repeat(40), [result("//:a", "failed", "old reason")])
    const newest = record("b".repeat(40), [result("//:b", "skipped"), result("//:a", "failed", "host binary missing")])
    expect(nothingPassed([older, newest])).toBe(refusedAt("bbbbbbb", "//:a", "host binary missing", 2))
    expect(nothingPassed([older])).toBe(refusedAt("aaaaaaa", "//:a", "old reason"))
  })

  it("says so when nothing ran at all", () => {
    const { commit: _commit, ...unnamed } = record("", [])
    expect(nothingPassed([unnamed])).toBe(
      [
        "this repository's CI does not pass on this machine, so there is no speedup to measure. No step passed at the 1 replayed commit.",
        "At , the patterns selected nothing that ran."
      ].join("\n")
    )
  })

  it("gives the failure's step, command, exit code and fix, where they are known", () => {
    const failed: TargetResult = {
      ...result("//:lint", "failed", "lint found 3 problems"),
      exitCode: 2,
      fix: "run npm run lint"
    }
    const names = new Map([["//:lint", { step: "lint", command: "npm run lint" }]])
    expect(nothingPassed([record("c".repeat(40), [failed])], names)).toBe([
      "this repository's CI does not pass on this machine, so there is no speedup to measure. No step passed at the 1 replayed commit.",
      "First failure at ccccccc:",
      "  step     lint",
      "  command  npm run lint",
      "  exit     2",
      "  error    lint found 3 problems",
      "  fix      run npm run lint"
    ].join("\n"))
  })
})
