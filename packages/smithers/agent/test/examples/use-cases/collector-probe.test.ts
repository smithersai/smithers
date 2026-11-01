import { afterAll, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CollectorProbe, layer } from "../../../examples/use-cases/collector-probe.vibe"
import * as Kit from "../../../examples/use-cases/kit.ts"

const directory = mkdtempSync(join(tmpdir(), "collector-probe-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

/**
 * An invoker whose call `n` takes `latencies[n - 1]` ms, a collector that
 * averages the latencies it is handed, and a detector that flags latency more
 * than 25% over the baseline it is handed, critical at double. Every request
 * is recorded in order with what it was handed.
 */
const script = (latencies: ReadonlyArray<number>) => {
  const turns: Array<string> = []
  const answer: Kit.Script = (asked) => {
    const invoke = /record the call's telemetry \(iteration (\d+)\)\.\n\nEndpoint: (.*)\nPayload: (.*)\nBaselines: (.*)/
      .exec(asked)
    if (invoke !== null) {
      const n = Number(invoke[1])
      turns.push(`invoke ${n} ${invoke[2]} ${invoke[3]} ${invoke[4]}`)
      return {
        callId: `call-${n}`,
        model: "claude-sonnet-5-5",
        inputTokens: 100,
        outputTokens: 50,
        latencyMs: latencies[n - 1]!,
        costUsd: 0.01,
        qualityScore: 0.95,
        timestamp: `2026-10-14T00:0${n}:00Z`
      }
    }
    const collect = /Aggregate the telemetry of these invocations\.\n\nInvocations: (.+)\nPrevious aggregates: (.+)/
      .exec(asked)
    if (collect !== null) {
      const invocations: ReadonlyArray<{ readonly callId: string; readonly latencyMs: number }> = JSON.parse(
        collect[1]!
      )
      const previous = JSON.parse(collect[2]!)
      turns.push(`collect ${invocations.map((i) => i.callId).join(",")} after ${previous?.meanLatencyMs ?? "null"}`)
      const mean = invocations.reduce((sum, i) => sum + i.latencyMs, 0) / invocations.length
      return {
        samples: invocations.map((i) => ({
          callId: i.callId,
          latencyMs: i.latencyMs,
          costUsd: 0.01,
          qualityScore: 0.95
        })),
        aggregates: {
          meanLatencyMs: mean,
          p95LatencyMs: Math.max(...invocations.map((i) => i.latencyMs)),
          meanCostUsd: 0.01,
          meanQuality: 0.95,
          totalInvocations: invocations.length
        },
        summary: `${invocations.length} calls`
      }
    }
    const detect =
      /Compare the current aggregates with the baselines\.\n\nAggregates: (.+)\nBaselines: (.+)\nPrevious anomalies: (.+)/
        .exec(asked)
    if (detect !== null) {
      const { meanLatencyMs } = JSON.parse(detect[1]!)
      const { latencyMs } = JSON.parse(detect[2]!)
      const previous: ReadonlyArray<unknown> = JSON.parse(detect[3]!)
      turns.push(`detect ${meanLatencyMs} vs ${latencyMs} after ${previous.length}`)
      const deltaPercent = Math.round(((meanLatencyMs - latencyMs) / latencyMs) * 100)
      const drift = deltaPercent > 25
      const severity = deltaPercent >= 100 ? "critical" : "warning"
      return {
        driftDetected: drift,
        anomalies: drift
          ? [{
            metric: "latency",
            direction: "up",
            deltaPercent,
            baselineValue: latencyMs,
            currentValue: meanLatencyMs,
            severity
          }]
          : [],
        shouldAlert: drift,
        summary: drift ? `latency up ${deltaPercent}%` : "within thresholds"
      }
    }
    return undefined
  }
  return { answer, turns }
}

it.effect("keeps probing while drift persists and stops at the first quiet round", () =>
  Effect.gen(function*() {
    const { answer, turns } = script([900, 100, 100])
    const report = yield* Kit.run(
      CollectorProbe,
      { endpoint: "https://agent.invalid/v1/run", payload: { q: "ping" } },
      {
        filename: join(directory, "drift-clears.sqlite"),
        executionId: "collector-probe-drift-clears",
        script: answer,
        actions: layer
      }
    )

    // The collector sees every call so far and the previous round's
    // aggregates; the detector sees the anomalies of earlier rounds. The
    // second round's mean is back within 25%, so no third round runs.
    expect(turns).toEqual([
      `invoke 1 https://agent.invalid/v1/run {"q":"ping"} {"quality":0.92,"costUsd":0.02,"latencyMs":500}`,
      "collect call-1 after null",
      "detect 900 vs 500 after 0",
      `invoke 2 https://agent.invalid/v1/run {"q":"ping"} {"quality":0.92,"costUsd":0.02,"latencyMs":500}`,
      "collect call-1,call-2 after 900",
      "detect 500 vs 500 after 1"
    ])
    expect(report).toEqual({
      overallStatus: "degraded",
      totalInvocations: 2,
      iterationsRun: 2,
      anomaliesDetected: 1,
      alerts: [{ metric: "latency", message: "latency drifted up by 80% (500 -> 900)", severity: "warning" }],
      recommendations: [
        "Review model configuration for quality regression",
        "Check upstream latency contributors",
        "Consider adjusting cost thresholds if usage patterns changed"
      ],
      summary: "Collector probe ran 2 iterations over 2 invocations. 1 drift events detected."
    })
  }))

it.effect("reports critical after the bound when drift never clears", () =>
  Effect.gen(function*() {
    const { answer, turns } = script([1200, 1200, 1200])
    const report = yield* Kit.run(
      CollectorProbe,
      { endpoint: "local", baselines: { quality: 0.9, costUsd: 0.05, latencyMs: 400 }, maxIterations: 2 },
      {
        filename: join(directory, "drift-persists.sqlite"),
        executionId: "collector-probe-drift-persists",
        script: answer,
        actions: layer
      }
    )

    expect(turns.filter((turn) => turn.startsWith("detect"))).toEqual([
      "detect 1200 vs 400 after 0",
      "detect 1200 vs 400 after 1"
    ])
    expect(report.overallStatus).toBe("critical")
    expect(report.iterationsRun).toBe(2)
    expect(report.anomaliesDetected).toBe(2)
    expect(report.alerts).toEqual([
      { metric: "latency", message: "latency drifted up by 200% (400 -> 1200)", severity: "critical" },
      { metric: "latency", message: "latency drifted up by 200% (400 -> 1200)", severity: "critical" }
    ])
  }))

it.effect("settles healthy after one round with no drift", () =>
  Effect.gen(function*() {
    const { answer, turns } = script([450])
    const report = yield* Kit.run(CollectorProbe, { endpoint: "local" }, {
      filename: join(directory, "healthy.sqlite"),
      executionId: "collector-probe-healthy",
      script: answer,
      actions: layer
    })

    expect(turns).toHaveLength(3)
    expect(turns[0]).toContain("invoke 1 local null")
    expect(report).toEqual({
      overallStatus: "healthy",
      totalInvocations: 1,
      iterationsRun: 1,
      anomaliesDetected: 0,
      alerts: [],
      recommendations: ["All metrics within acceptable thresholds"],
      summary: "Collector probe ran 1 iterations over 1 invocations. 0 drift events detected."
    })
  }))
