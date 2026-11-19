import { describe, expect, it } from "vitest"
import type { RunRecord, TargetResult } from "../../src/contract/RunRecord.ts"
import {
  firstLine,
  linesOf,
  noRecord,
  noRecordLabel,
  nothingPassed,
  ranAgain,
  ranAgainLines,
  reasonsIn,
  whyNoRecord,
  withReasons
} from "../../src/native/index.ts"
import { refusedAt } from "./repo.ts"

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
  it("ends a reason at the frame of the display a person gets", () => {
    const output =
      "◇  Running //:a\n//:a  failed  2ms  it broke\n│\n└  1 targets: 0 hit, 0 ran, 1 failed, 0 skipped (3ms)\n"
    expect(reasonsIn(output).get("//:a")).toBe("it broke")
  })

  it("are read from its plain output, one per failed target", () => {
    expect([...reasonsIn(plain)]).toEqual([
      ["//typescript:compiler", `host binary "go" is declared in S.Host({ bins }) but is not present on PATH`],
      ["//packages:runtime-dist", "command failed (exit 127): /bin/sh -c cd packages/runtime\n$ tsc -p [REDACTED]"]
    ])
    expect(reasonsIn("//a:b  ran  3ms\nall good").size).toBe(0)
  })

  it("keep what a failed command printed under its line, up to the next target", () => {
    const output = [
      "//:a  failed  1ms  command failed (exit 7): /bin/sh -c bash -e -c 'sh check.sh'",
      "the check failed",
      "more",
      "//:b  failed  1ms  command failed (exit 127): /bin/sh -c bash -e -c 'docker run x'",
      "bash: line 1: docker: command not found",
      "//:c  ran  1ms",
      "not part of anything",
      "code: targets_failed"
    ].join("\n")
    expect(withReasons([result("//:a", "failed"), result("//:b", "failed")], output)).toEqual([
      { ...result("//:a", "failed", "the check failed"), exitCode: 7, command: "bash -e -c 'sh check.sh'" },
      {
        ...result("//:b", "failed", "`docker` is not installed on this machine"),
        exitCode: 127,
        command: "bash -e -c 'docker run x'"
      }
    ])
  })

  it("give a failed command's exit code, command and the line that says what failed, never the rest of its output", () => {
    const printed = JSON.stringify({
      _tag: "smithers-build/ExecError",
      argv: ["bash", "-e", "-c", "./deploy --token=abc123"],
      code: "exit_status",
      cwd: ".",
      exitCode: 2,
      stderr: "deploy refused\nsecond line\n",
      stdout: "private output\n"
    })
    expect(withReasons([result("//:a", "failed")], `//:a  failed  1ms  ${printed}`)).toEqual([{
      ...result("//:a", "failed", "deploy refused"),
      exitCode: 2,
      command: "./deploy [withheld]"
    }])
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

describe("a run with no run record", () => {
  it("gives the message of the error smthrs printed, else its last line", () => {
    const error =
      "smthrs: remote cache off: no credentials\ncode: no_package\nmessage: no package at //packages/ci\nretryable: false\n"
    expect(whyNoRecord(error)).toBe("no package at //packages/ci")
    expect(whyNoRecord("first\nhost binary go is not on the PATH\n\n")).toBe("host binary go is not on the PATH")
    expect(whyNoRecord("")).toBe("smthrs ci wrote no run record")
    expect(whyNoRecord(" \n ")).toBe("smthrs ci wrote no run record")
  })

  it("withholds a credential before it cuts the line, so no part of one is left", () => {
    const token = `ghp_${"a".repeat(36)}`
    const why = whyNoRecord(`message: ${"x".repeat(190)} ${token}\n`)
    expect(why).not.toContain("ghp_")
    expect(whyNoRecord(`could not reach ${token}\n`)).toBe("could not reach [withheld]")
  })

  it("is one failed result with a label no target has", () => {
    expect(noRecord("message: broken PACKAGE.ts")).toEqual({
      label: noRecordLabel,
      status: "failed",
      key: "",
      durationMs: 0,
      error: "broken PACKAGE.ts"
    })
    expect(noRecordLabel).toBe("(smthrs)")
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
      "2/3 abc1234 normal: //:f failed: no reason was given"
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

describe("a target that ran again with an unchanged key", () => {
  const keyed = (label: string, status: TargetResult["status"], key: string): TargetResult => ({
    ...result(label, status),
    key
  })
  const passedWith = new Map([["//:a", "k1"], ["//:b", "k2"], ["//:c", "k3"], ["//:d", "k4"], ["//:e", ""]])

  it("is one that ran and passed with the key it passed with before", () => {
    const results = [
      keyed("//:a", "ran", "k1"),
      keyed("//:b", "hit", "k2"),
      keyed("//:c", "ran", "changed"),
      keyed("//:d", "failed", "k4"),
      keyed("//:e", "ran", ""),
      keyed("//:new", "ran", "k9")
    ]
    expect(ranAgain(passedWith, results)).toEqual(["//:a"])
    expect(ranAgain(new Map(), results)).toEqual([])
  })

  it("is named on one line, the first five and how many more", () => {
    expect(ranAgainLines("2/3 abc1234 normal", [])).toEqual([])
    expect(ranAgainLines("2/3 abc1234 normal", ["//:a"])).toEqual([
      "2/3 abc1234 normal: 1 ran again though its key did not change: //:a"
    ])
    const many = ["a", "b", "c", "d", "e", "f", "g"].map((name) => `//:${name}`)
    expect(ranAgainLines("2/3 abc1234 normal", many)).toEqual([
      "2/3 abc1234 normal: 7 ran again though their keys did not change: //:a //:b //:c //:d //:e +2"
    ])
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
})
