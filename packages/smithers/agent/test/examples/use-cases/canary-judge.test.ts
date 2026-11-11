import { afterAll, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CanaryJudge, layer } from "../../../examples/use-cases/canary-judge.vibe"
import * as Kit from "../../../examples/use-cases/kit.vibe"

const directory = mkdtempSync(join(tmpdir(), "canary-judge-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

const endpoints = {
  stableMetricsEndpoint: "http://metrics/stable",
  stableLogSource: "loki://stable",
  stableTraceStore: "tempo://stable",
  canaryMetricsEndpoint: "http://metrics/canary",
  canaryLogSource: "loki://canary",
  canaryTraceStore: "tempo://canary"
}

/**
 * A collector that reports `canaryErrorRate` for the canary stream and 0.5 for
 * stable, a comparator that computes the error-rate delta from the two
 * snapshots it was handed and flags a critical signal above one point, and a
 * judge that rolls back on a critical signal and promotes otherwise. Every
 * request is recorded in order.
 */
const script = (canaryErrorRate: number) => {
  const turns: Array<string> = []
  const answer: Kit.Script = (asked) => {
    const collect = /Collect the (\w+) stream's telemetry over the last (\d+) minutes\.\n\nMetrics endpoint: (.+)/
      .exec(asked)
    if (collect !== null) {
      const stream = collect[1]!
      turns.push(`collect ${stream} ${collect[2]}m ${collect[3]}`)
      return {
        stream,
        latencyP50Ms: 40,
        latencyP99Ms: 180,
        errorRate: stream === "canary" ? canaryErrorRate : 0.5,
        throughputRps: 900,
        logAnomalies: stream === "canary" && canaryErrorRate > 1.5 ? ["NullPointerException in CartService"] : [],
        traceWarnings: []
      }
    }
    if (asked.includes("Compare the canary with stable.")) {
      const stable = JSON.parse(/\nStable: (.+)/.exec(asked)![1]!)
      const canary = JSON.parse(/\nCanary: (.+)/.exec(asked)![1]!)
      const thresholds = /\nThresholds: (.+)/.exec(asked)![1]!
      turns.push(`compare ${stable.stream}/${canary.stream} thresholds ${thresholds}`)
      const errorRateDelta = canary.errorRate - stable.errorRate
      return {
        latencyDelta: { p50Pct: 0, p99Pct: 0 },
        errorRateDelta,
        throughputDelta: 0,
        newAnomalies: canary.logAnomalies,
        riskSignals: errorRateDelta > 1 ? [{ signal: `error rate +${errorRateDelta}`, severity: "critical" }] : [],
        summary: `error rate delta ${errorRateDelta}`
      }
    }
    const judge = /Judge deployment (.+) of (.+)\.\n\nComparison: .+\nRisk signals: (.+)/.exec(asked)
    if (judge !== null) {
      const signals: ReadonlyArray<{ readonly signal: string; readonly severity: string }> = JSON.parse(judge[3]!)
      turns.push(`judge ${judge[1]} of ${judge[2]}`)
      const critical = signals.find((signal) => signal.severity === "critical")
      return {
        decision: critical === undefined ? "promote" : "rollback",
        confidence: 90,
        reasons: critical === undefined ? ["within thresholds"] : [critical.signal],
        conditions: ["error rate stays under 1%"],
        summary: critical === undefined ? "Canary is healthy." : `Roll back: ${critical.signal}.`
      }
    }
    return undefined
  }
  return { answer, turns }
}

it.effect("promotes a healthy canary and names the promote command", () =>
  Effect.gen(function*() {
    const { answer, turns } = script(0.6)
    const action = yield* Kit.run(CanaryJudge, {
      ...endpoints,
      windowMinutes: 30,
      thresholds: { maxErrorRateDelta: 1 },
      deploymentId: "dep-7",
      serviceName: "cart",
      notifyChannels: ["#cart-releases"]
    }, {
      filename: join(directory, "promote.sqlite"),
      executionId: "canary-judge-promote",
      script: answer,
      actions: layer
    })

    // Both streams were collected, in any order, before the comparison.
    expect(turns.slice(0, 2).sort()).toEqual([
      "collect canary 30m http://metrics/canary",
      "collect stable 30m http://metrics/stable"
    ])
    expect(turns.slice(2)).toEqual([
      "compare stable/canary thresholds {\"maxErrorRateDelta\":1}",
      "judge dep-7 of cart"
    ])
    expect(action).toEqual({
      action: "promote",
      commands: ["deployctl promote dep-7"],
      notifyChannels: ["#cart-releases"],
      summary: "Canary is healthy."
    })
  }))

it.effect("rolls back a canary whose errors regress, with the 0.x defaults", () =>
  Effect.gen(function*() {
    const { answer, turns } = script(2.5)
    const action = yield* Kit.run(CanaryJudge, endpoints, {
      filename: join(directory, "rollback.sqlite"),
      executionId: "canary-judge-rollback",
      script: answer,
      actions: layer
    })

    expect(turns.slice(0, 2).sort()).toEqual([
      "collect canary 15m http://metrics/canary",
      "collect stable 15m http://metrics/stable"
    ])
    expect(turns.slice(2)).toEqual(["compare stable/canary thresholds {}", "judge unknown of unknown"])
    // The judge's reason is the signal the comparator computed from the two snapshots.
    expect(action).toEqual({
      action: "rollback",
      commands: ["deployctl rollback unknown"],
      notifyChannels: ["#deploys"],
      summary: "Roll back: error rate +2."
    })
  }))
