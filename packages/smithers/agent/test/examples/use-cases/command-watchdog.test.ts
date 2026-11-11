import { afterAll, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CommandWatchdog, layer } from "../../../examples/use-cases/command-watchdog.vibe"
import * as Kit from "../../../examples/use-cases/kit.vibe"

const directory = mkdtempSync(join(tmpdir(), "command-watchdog-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

/**
 * A runner whose run exits 1 when its iteration is in `failing`, a detector
 * that calls a run notable when its exit code differs from the run before,
 * and a reporter that builds its report from the runs and reasons it is
 * handed. Every request is recorded in order.
 */
const script = (failing: ReadonlyArray<number>) => {
  const turns: Array<string> = []
  const answer: Kit.Script = (asked) => {
    const run = /Run iteration (\d+) of the watched command\.\n\nCommand: .*\nPrevious exit code: (\w+)/.exec(asked)
    if (run !== null) {
      const n = Number(run[1])
      turns.push(`run ${n} after exit ${run[2]}`)
      const exitCode = failing.includes(n) ? 1 : 0
      return {
        exitCode,
        durationMs: 100 * n,
        outputSignature: exitCode === 0 ? "ok" : "ECONNREFUSED",
        stdoutTail: "",
        iterationNum: n
      }
    }
    const detect =
      /Check iteration (\d+) of .*\n\nCommand: .*\nDuration threshold: (.+)\nCurrent run: (.+)\nPrevious run: (.+)/
        .exec(asked)
    if (detect !== null) {
      const current = JSON.parse(detect[3]!)
      const previous = detect[4] === "none" ? undefined : JSON.parse(detect[4]!)
      turns.push(`detect ${detect[1]} at ${detect[2]}: ${current.exitCode} vs ${previous?.exitCode ?? "none"}`)
      const changed = previous !== undefined && previous.exitCode !== current.exitCode
      return {
        notable: changed,
        reasons: changed ? [`exit code ${previous.exitCode} -> ${current.exitCode}`] : [],
        exitCodeChanged: changed,
        durationDeltaPercent: 0,
        signatureChanged: changed,
        diffSummary: changed ? `signature ${previous.outputSignature} -> ${current.outputSignature}` : ""
      }
    }
    const report =
      /Report on the watched command\.\n\nCommand: (.*)\nNotable: .*\nReasons: (.+)\nDiff summary: (.*)\nRuns: (.+)/
        .exec(asked)
    if (report !== null) {
      const runs: ReadonlyArray<{ readonly iterationNum: number }> = JSON.parse(report[4]!)
      turns.push(`report on runs ${runs.map((r) => r.iterationNum).join(",")}`)
      return {
        status: "escalated",
        anomalies: JSON.parse(report[2]!),
        runCount: runs.length,
        summary: `${report[1]}: ${report[3]}`
      }
    }
    return undefined
  }
  return { answer, turns }
}

it.effect("escalates at the first notable run and reports every run so far", () =>
  Effect.gen(function*() {
    const { answer, turns } = script([3])
    const report = yield* Kit.run(CommandWatchdog, { command: "curl -f localhost:8080/health", maxRuns: 5 }, {
      filename: join(directory, "escalated.sqlite"),
      executionId: "command-watchdog-escalated",
      script: answer,
      actions: layer
    })

    // Each run is told the previous exit code; each detect sees that run and
    // the one before; the third run's change stops the loop before run four.
    expect(turns).toEqual([
      "run 1 after exit none",
      "detect 1 at 25%: 0 vs none",
      "run 2 after exit 0",
      "detect 2 at 25%: 0 vs 0",
      "run 3 after exit 0",
      "detect 3 at 25%: 1 vs 0",
      "report on runs 1,2,3"
    ])
    expect(report).toEqual({
      status: "escalated",
      anomalies: ["exit code 0 -> 1"],
      runCount: 3,
      summary: "curl -f localhost:8080/health: signature ok -> ECONNREFUSED"
    })
  }))

it.effect("settles steady without a reporter when no run is notable", () =>
  Effect.gen(function*() {
    const { answer, turns } = script([])
    const report = yield* Kit.run(CommandWatchdog, { command: "make check", maxRuns: 2, thresholdPercent: 10 }, {
      filename: join(directory, "steady.sqlite"),
      executionId: "command-watchdog-steady",
      script: answer,
      actions: layer
    })

    expect(turns).toEqual([
      "run 1 after exit none",
      "detect 1 at 10%: 0 vs none",
      "run 2 after exit 0",
      "detect 2 at 10%: 0 vs 0"
    ])
    expect(report).toEqual({
      status: "steady",
      anomalies: [],
      runCount: 2,
      summary: "make check ran 2 times with no notable anomalies"
    })
  }))

it.effect("runs five rounds when no bound is given", () =>
  Effect.gen(function*() {
    const { answer, turns } = script([])
    const report = yield* Kit.run(CommandWatchdog, { command: "make check" }, {
      filename: join(directory, "default-bound.sqlite"),
      executionId: "command-watchdog-default-bound",
      script: answer,
      actions: layer
    })

    expect(turns.filter((turn) => turn.startsWith("run "))).toHaveLength(5)
    expect(report.runCount).toBe(5)
    expect(report.status).toBe("steady")
  }))
