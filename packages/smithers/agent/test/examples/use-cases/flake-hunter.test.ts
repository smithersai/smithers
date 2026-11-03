import { afterAll, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FlakeHunter, layer } from "../../../examples/use-cases/flake-hunter.vibe"
import * as Kit from "../../../examples/use-cases/kit.vibe"

const directory = mkdtempSync(join(tmpdir(), "flake-hunter-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

/**
 * A runner whose attempt fails when its number is in `failing`, and an analyst
 * that derives its flake rate from the evidence it is handed. Every request
 * the analyst sees is recorded in `analyzed`, every runner request in `ran`.
 */
const script = (failing: ReadonlyArray<number>) => {
  const ran: Array<string> = []
  const analyzed: Array<{ readonly passes: number; readonly failures: number; readonly signatures: unknown }> = []
  const answer: Kit.Script = (asked) => {
    const attempt = /Run attempt (\d+) of \d+\.\n\nCommand: .*\nPrevious outcome: (\w+)/.exec(asked)
    if (attempt !== null) {
      const n = Number(attempt[1])
      const fail = failing.includes(n)
      ran.push(`${n} after ${attempt[2]}`)
      return {
        attempt: n,
        outcome: fail ? "fail" : "pass",
        exitCode: fail ? 1 : 0,
        durationMs: 100 * n,
        stdout: "",
        stderr: fail ? "Error: timed out waiting for port 5432" : "",
        signature: fail ? "timed out waiting for port 5432" : ""
      }
    }
    const evidence = /Evidence: (.+)/.exec(asked)
    if (evidence !== null) {
      const { failures, passes, totalRuns, uniqueSignatures } = JSON.parse(evidence[1]!)
      analyzed.push({ passes, failures, signatures: uniqueSignatures })
      return {
        classification: "flaky",
        confidence: 0.8,
        flakeRate: failures / totalRuns,
        rootCauseCandidates: ["database container starts after the test"],
        recommendation: "Wait for the port before running the suite.",
        summary: `${failures} of ${totalRuns} runs failed.`
      }
    }
    return undefined
  }
  return { answer, ran, analyzed }
}

it.effect("hands divergent runs to the analyst and returns its report", () =>
  Effect.gen(function*() {
    const { analyzed, answer, ran } = script([2])
    const report = yield* Kit.run(FlakeHunter, { command: "pnpm test db", runs: 3 }, {
      filename: join(directory, "divergent.sqlite"),
      executionId: "flake-hunter-divergent",
      script: answer,
      actions: layer
    })

    // Three attempts in order, each told the outcome before it.
    expect(ran).toEqual(["1 after none", "2 after pass", "3 after fail"])
    // The analyst ran once, on evidence the flow packed from those runs.
    expect(analyzed).toEqual([{ passes: 2, failures: 1, signatures: ["", "timed out waiting for port 5432"] }])
    expect(report.classification).toBe("flaky")
    expect(report.flakeRate).toBeCloseTo(1 / 3)
  }))

it.effect("reports a consistent failure without asking the analyst", () =>
  Effect.gen(function*() {
    const { analyzed, answer, ran } = script([1, 2, 3])
    const report = yield* Kit.run(FlakeHunter, { command: "pnpm test db", runs: 3 }, {
      filename: join(directory, "consistent-fail.sqlite"),
      executionId: "flake-hunter-consistent-fail",
      script: answer,
      actions: layer
    })

    expect(ran).toHaveLength(3)
    expect(analyzed).toEqual([])
    expect(report).toEqual({
      classification: "consistent-fail",
      confidence: 1,
      flakeRate: 1,
      rootCauseCandidates: [],
      recommendation: "Test fails consistently with signature: timed out waiting for port 5432",
      summary: "3 runs, all failed. No flakiness detected."
    })
  }))

it.effect("reruns five times when no run count is given", () =>
  Effect.gen(function*() {
    const { analyzed, answer, ran } = script([])
    const report = yield* Kit.run(FlakeHunter, { command: "pnpm test db" }, {
      filename: join(directory, "default-runs.sqlite"),
      executionId: "flake-hunter-default-runs",
      script: answer,
      actions: layer
    })

    expect(ran).toEqual(["1 after none", "2 after pass", "3 after pass", "4 after pass", "5 after pass"])
    expect(analyzed).toEqual([])
    expect(report.classification).toBe("consistent-pass")
    expect(report.summary).toBe("5 runs, all passed. No flakiness detected.")
  }))
