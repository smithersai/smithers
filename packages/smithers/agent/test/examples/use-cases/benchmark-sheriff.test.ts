import { afterAll, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BenchmarkSheriff, layer } from "../../../examples/use-cases/benchmark-sheriff.vibe"
import * as Kit from "../../../examples/use-cases/kit.ts"

const directory = mkdtempSync(join(tmpdir(), "benchmark-sheriff-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

const baseline = [
  { name: "parse", valueMs: 100 },
  { name: "render", valueMs: 200 },
  { name: "lex", valueMs: 100 },
  { name: "gone", valueMs: 50 }
]

/**
 * A runner that reports `measured` and records the command and directory it
 * was given, and an analyst that writes one finding per regression it is
 * handed, recording the threshold and the benchmarks it saw.
 */
const script = (measured: ReadonlyArray<{ readonly name: string; readonly valueMs: number }>) => {
  const ran: Array<string> = []
  const analyzed: Array<string> = []
  const answer: Kit.Script = (asked) => {
    const run = /Run the following benchmark command and capture the results:\n\nCommand: (.*)\nWorking directory: (.*)/
      .exec(asked)
    if (run !== null) {
      ran.push(`${run[1]} in ${run[2]}`)
      return { benchmarks: measured, raw: measured.map((m) => `${m.name} ${m.valueMs}ms`).join("\n") }
    }
    const analyze = /The following benchmarks regressed beyond the (.+)% threshold:\n\n(.+)/.exec(asked)
    if (analyze !== null) {
      const regressions: ReadonlyArray<{ readonly name: string; readonly deltaPercent: number }> = JSON.parse(
        analyze[2]!
      )
      analyzed.push(`${analyze[1]}%: ${regressions.map((r) => `${r.name} +${r.deltaPercent}%`).join(", ")}`)
      return {
        findings: regressions.map((r) => ({
          benchmark: r.name,
          likelyCause: `${r.name} allocates more per call`,
          severity: r.deltaPercent >= 10 ? "high" : "low"
        })),
        summary: `${regressions.length} regressions explained`
      }
    }
    return undefined
  }
  return { answer, ran, analyzed }
}

it.effect("asks the analyst only about benchmarks at or past the threshold", () =>
  Effect.gen(function*() {
    const { analyzed, answer, ran } = script([
      { name: "parse", valueMs: 120 },
      { name: "render", valueMs: 210 },
      { name: "lex", valueMs: 104 },
      { name: "extra", valueMs: 10 }
    ])
    const output = yield* Kit.run(BenchmarkSheriff, { baseline }, {
      filename: join(directory, "regressed.sqlite"),
      executionId: "benchmark-sheriff-regressed",
      script: answer,
      actions: layer
    })

    // The defaults reach the runner; the diff skips `gone` (not measured),
    // `lex` (4%) and `extra` (no baseline), and counts `render` at exactly 5%.
    expect(ran).toEqual(["npm run bench in ."])
    expect(analyzed).toEqual(["5%: parse +20%, render +5%"])
    expect(output).toEqual({
      status: "regressed",
      regressionCount: 2,
      summary: "2 benchmark(s) exceeded the 5% threshold",
      analysis: {
        findings: [
          { benchmark: "parse", likelyCause: "parse allocates more per call", severity: "high" },
          { benchmark: "render", likelyCause: "render allocates more per call", severity: "low" }
        ],
        summary: "2 regressions explained"
      }
    })
  }))

it.effect("settles clean without the analyst when nothing moved past the threshold", () =>
  Effect.gen(function*() {
    const { analyzed, answer, ran } = script([{ name: "parse", valueMs: 120 }, { name: "render", valueMs: 150 }])
    const output = yield* Kit.run(
      BenchmarkSheriff,
      { command: "pnpm bench", cwd: "packages/parser", baseline, thresholdPercent: 30 },
      {
        filename: join(directory, "clean.sqlite"),
        executionId: "benchmark-sheriff-clean",
        script: answer,
        actions: layer
      }
    )

    expect(ran).toEqual(["pnpm bench in packages/parser"])
    expect(analyzed).toEqual([])
    expect(output).toEqual({ status: "clean", regressionCount: 0, summary: "All benchmarks within the 30% threshold" })
  }))
