import { describe, expect, it } from "vitest"
import type { RunRecord, TargetResult } from "../../src/contract/RunRecord.ts"
import { firstLine, linesOf, nothingPassed, reasonsIn, withReasons } from "../../src/native/index.ts"

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

const plain = [
  "smthrs: remote cache off: no credentials",
  `//typescript:compiler  failed  1ms  host binary "go" is declared in S.Host({ bins }) but is not present on PATH`,
  "//packages:runtime-dist  failed  414ms  command failed (exit 127): /bin/sh -c cd packages/runtime",
  "$ tsc -p [REDACTED]",
  "code: targets_failed"
].join("\n")

describe("firstLine", () => {
  it("is the first line that says something, without control characters, at most 200 characters", () => {
    expect(firstLine("\n  \n  first \u001b[31mred\u0007\nsecond")).toBe("first  [31mred")
    expect(firstLine("x".repeat(300))).toHaveLength(200)
    expect(firstLine(" \n")).toBe("")
  })
})

describe("the reasons smthrs prints", () => {
  it("are read from its plain output, one per failed target", () => {
    expect([...reasonsIn(plain)]).toEqual([
      ["//typescript:compiler", `host binary "go" is declared in S.Host({ bins }) but is not present on PATH`],
      ["//packages:runtime-dist", "command failed (exit 127): /bin/sh -c cd packages/runtime"]
    ])
    expect(reasonsIn("//a:b  ran  3ms\nall good").size).toBe(0)
  })

  it("are added to a failed target whose record has none, and to nothing else", () => {
    const results = [
      result("//typescript:compiler", "failed"),
      result("//packages:runtime-dist", "failed", "the record's own reason"),
      result("//packages:unlisted", "failed"),
      result("//packages:runtime-published", "ran")
    ]
    expect(withReasons(results, `${plain}\n//packages:runtime-published  failed  1ms  not really`)).toEqual([
      result(
        "//typescript:compiler",
        "failed",
        `host binary "go" is declared in S.Host({ bins }) but is not present on PATH`
      ),
      results[1],
      results[2],
      results[3]
    ])
  })
})

describe("linesOf", () => {
  it("says what one run did, then why its first targets failed", () => {
    const results = [
      result("//:a", "ran"),
      result("//:b", "hit"),
      result("//:c", "hit"),
      result("//:d", "skipped"),
      result("//:e", "failed", "exit 1\nmore"),
      result("//:f", "failed")
    ]
    expect(linesOf("2/3 abc1234 normal", results, 12_400)).toEqual([
      "2/3 abc1234 normal: 1 ran, 2 from the cache, 2 failed, 1 skipped in 12 s",
      "2/3 abc1234 normal: //:e failed: exit 1",
      "2/3 abc1234 normal: //:f failed: smthrs gave no reason"
    ])
  })

  it("names a target that failed and then passed", () => {
    const flaky: TargetResult = {
      ...result("//:flaky", "ran"),
      attempts: [{ passed: false, durationMs: 1 }, { passed: true, durationMs: 1 }]
    }
    expect(linesOf("3/3 abc1234 baseline", [flaky, result("//:a", "ran")], 1_000)).toEqual([
      "3/3 abc1234 baseline: 2 ran, 0 from the cache, 0 failed, 0 skipped in 1 s",
      "3/3 abc1234 baseline: //:flaky failed, then passed when run again"
    ])
  })

  it("names five failed targets and counts the rest", () => {
    const failed = ["a", "b", "c", "d", "e", "f", "g"].map((name) => result(`//:${name}`, "failed", "exit 1"))
    const lines = linesOf("1/1 abc1234 baseline", failed, 0)
    expect(lines).toHaveLength(7)
    expect(lines[0]).toBe("1/1 abc1234 baseline: 0 ran, 0 from the cache, 7 failed, 0 skipped in 0 s")
    expect(lines[5]).toBe("1/1 abc1234 baseline: //:e failed: exit 1")
    expect(lines[6]).toBe("1/1 abc1234 baseline: and 2 more failed")
  })
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
    expect(nothingPassed([older, newest])).toBe(
      "no target passed at any of the 2 replayed commits. At bbbbbbb, //:a failed: host binary missing"
    )
    expect(nothingPassed([older])).toBe(
      "no target passed at any of the 1 replayed commit. At aaaaaaa, //:a failed: old reason"
    )
  })

  it("says so when no target ran at all", () => {
    const { commit: _commit, ...unnamed } = record("", [])
    expect(nothingPassed([unnamed])).toBe(
      "no target passed at any of the 1 replayed commit. At , the patterns selected no target that ran"
    )
  })
})
