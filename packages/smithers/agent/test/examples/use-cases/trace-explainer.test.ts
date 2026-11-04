import { afterAll, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Kit from "../../../examples/use-cases/kit.vibe"
import { layer, TraceExplainer } from "../../../examples/use-cases/trace-explainer.vibe"

const directory = mkdtempSync(join(tmpdir(), "trace-explainer-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

const spans = [
  { name: "plan", durationMs: 400, tokenCount: 1000, failed: false, children: ["fetch", "review"] },
  { name: "fetch", durationMs: 2600, failed: true, error: "ETIMEDOUT" },
  { name: "review", durationMs: 1000, tokenCount: 3000, failed: false }
]

/**
 * An ingester that returns `spans` for any source it is told, an analyzer
 * that names the slowest span and the largest token user among the spans it
 * is handed (or answers off-schema when `brokenAnalysis`), and a reporter
 * that explains the bottleneck it is handed. Every request is recorded.
 */
const script = (brokenAnalysis = false) => {
  const turns: Array<string> = []
  const answer: Kit.Script = (asked) => {
    const ingest = /Ingest the traces at (.+) and normalize their spans\./.exec(asked)
    if (ingest !== null) {
      turns.push(`ingest ${ingest[1]}`)
      return {
        spans,
        totalDurationMs: 4000,
        totalTokens: 4000,
        failedSpanCount: spans.filter((s) => s.failed).length
      }
    }
    const analyze =
      /Analyze these spans\.\n\nTotal duration \(ms\): (\d+)\nTotal tokens: (\d+)\nFailed spans: (\d+)\nSpans: (.+)/
        .exec(asked)
    if (analyze !== null) {
      const seen: ReadonlyArray<{ readonly name: string; readonly durationMs: number; readonly tokenCount?: number }> =
        JSON.parse(analyze[4]!)
      turns.push(`analyze ${seen.length} spans, ${analyze[3]} failed`)
      if (brokenAnalysis) return { bottleneck: "fetch" }
      const slowest = [...seen].sort((a, b) => b.durationMs - a.durationMs)[0]!
      const hog = [...seen].sort((a, b) => (b.tokenCount ?? 0) - (a.tokenCount ?? 0))[0]!
      return {
        bottleneck: { spanName: slowest.name, reason: "latency", impact: `${slowest.durationMs} of ${analyze[1]} ms` },
        hotPath: ["plan", slowest.name],
        failureSummary: `${analyze[3]} span failed`,
        tokenHogs: [{
          spanName: hog.name,
          tokenCount: hog.tokenCount ?? 0,
          percentOfTotal: ((hog.tokenCount ?? 0) / Number(analyze[2])) * 100
        }]
      }
    }
    const report =
      /Write the optimization report for this trace analysis\.\n\nBottleneck: (.+)\nHot path: (.+)\nFailure summary: (.+)\nToken hogs: (.+)\n/
        .exec(asked)
    if (report !== null) {
      const bottleneck = JSON.parse(report[1]!)
      const [hog] = JSON.parse(report[4]!)
      turns.push(`report on ${bottleneck.spanName}`)
      return {
        title: `${bottleneck.spanName} dominates the trace`,
        bottleneckExplanation: `${bottleneck.spanName}: ${bottleneck.impact}`,
        optimizations: [{
          target: hog.spanName,
          suggestion: "trim the context",
          estimatedSaving: `${hog.percentOfTotal}% of tokens`
        }],
        summary: `${report[3]}; hot path ${JSON.parse(report[2]!).join(" > ")}`
      }
    }
    return undefined
  }
  return { answer, turns }
}

it.effect("ingests, analyzes and reports in order, each step reading the last", () =>
  Effect.gen(function*() {
    const { answer, turns } = script()
    const report = yield* Kit.run(TraceExplainer, { traceFile: "runs/42/trace.json", traceDir: "runs" }, {
      filename: join(directory, "explained.sqlite"),
      executionId: "trace-explainer-explained",
      script: answer,
      actions: layer
    })

    // `traceFile` wins over `traceDir`.
    expect(turns).toEqual(["ingest runs/42/trace.json", "analyze 3 spans, 1 failed", "report on fetch"])
    expect(report).toEqual({
      title: "fetch dominates the trace",
      bottleneckExplanation: "fetch: 2600 of 4000 ms",
      optimizations: [{ target: "review", suggestion: "trim the context", estimatedSaving: "75% of tokens" }],
      summary: "1 span failed; hot path plan > fetch"
    })
  }))

it.effect("reads the trace directory, else the current one", () =>
  Effect.gen(function*() {
    const fromDir = script()
    yield* Kit.run(TraceExplainer, { traceDir: "runs" }, {
      filename: join(directory, "from-dir.sqlite"),
      executionId: "trace-explainer-from-dir",
      script: fromDir.answer,
      actions: layer
    })
    const fromCwd = script()
    yield* Kit.run(TraceExplainer, {}, {
      filename: join(directory, "from-cwd.sqlite"),
      executionId: "trace-explainer-from-cwd",
      script: fromCwd.answer,
      actions: layer
    })

    expect(fromDir.turns[0]).toBe("ingest runs")
    expect(fromCwd.turns[0]).toBe("ingest .")
  }))

it.effect("fails without a report when the analysis is off-schema", () =>
  Effect.gen(function*() {
    const { answer, turns } = script(true)
    const exit = yield* Effect.exit(Kit.run(TraceExplainer, {}, {
      filename: join(directory, "broken-analysis.sqlite"),
      executionId: "trace-explainer-broken-analysis",
      script: answer,
      actions: layer
    }))

    expect(Exit.isFailure(exit)).toBe(true)
    expect(turns).toContain("analyze 3 spans, 1 failed")
    expect(turns.some((turn) => turn.startsWith("report"))).toBe(false)
  }))
