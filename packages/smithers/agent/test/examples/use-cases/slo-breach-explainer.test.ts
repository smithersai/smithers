import { afterAll, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Kit from "../../../examples/use-cases/kit.ts"
import { layer, SloBreachExplainer } from "../../../examples/use-cases/slo-breach-explainer.vibe"

const directory = mkdtempSync(join(tmpdir(), "slo-breach-explainer-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

const alarm = {
  service: "checkout",
  sloName: "p99-latency",
  threshold: "200ms",
  observed: "1450ms",
  window: "2026-03-28T14:00Z/PT1H"
}

/**
 * Three fetchers that name the service they were asked about, and an analyst
 * that builds its causal chain from the three contexts it was handed. With
 * `broken`, the change investigator answers off-schema. Every request is
 * recorded in order.
 */
const script = (broken = false) => {
  const turns: Array<string> = []
  const answer: Kit.Script = (asked) => {
    const service = /\nService: (.+)/.exec(asked)?.[1]
    if (asked.includes("Fetch traces for the breach.")) {
      turns.push(`traces ${service}`)
      return {
        topSpans: [{
          traceId: "t-1",
          spanName: `${service}.db.query`,
          durationMs: 1300,
          status: "timeout",
          attributes: { "db.system": "postgres" }
        }],
        bottleneck: `${service}.db.query`,
        sampleTraceId: "t-1"
      }
    }
    if (asked.includes("Fetch logs for the breach.")) {
      turns.push(`logs ${service} observed ${/\nObserved: (.+)/.exec(asked)?.[1]}`)
      return {
        errorCount: 812,
        topErrors: [{ message: "pool exhausted", count: 800, firstSeen: "14:02", lastSeen: "14:58" }],
        anomalies: ["connection wait time 40x baseline"]
      }
    }
    if (asked.includes("Fetch change history for the breach.")) {
      turns.push(`changes ${service}`)
      if (broken) return { changed: "something" }
      return {
        recentDeploys: [{ version: "v42", deployedAt: "13:55", author: "ada", description: "halve pool size" }],
        configChanges: [],
        suspectChange: "v42 halved the connection pool"
      }
    }
    if (asked.includes("Explain this SLO breach.")) {
      const read = (label: string) => JSON.parse(new RegExp(`\\n${label}: (.+)`).exec(asked)![1]!)
      const traces = read("Traces")
      const logs = read("Logs")
      const changes = read("Changes")
      turns.push(`synthesis ${read("Alarm").sloName}`)
      return {
        title: `${read("Alarm").service} p99 breach`,
        severity: "high",
        causalChain: [changes.suspectChange, logs.topErrors[0].message, `${traces.bottleneck} timed out`],
        rootCause: changes.suspectChange,
        impactSummary: `${logs.errorCount} failed requests`,
        mitigation: "Roll back v42",
        followUps: ["Alert on pool saturation"],
        summary: "Checkout latency breached after v42."
      }
    }
    return undefined
  }
  return { answer, turns }
}

it.effect("fetches the three contexts, then explains the chain they make", () =>
  Effect.gen(function*() {
    const { answer, turns } = script()
    const note = yield* Kit.run(SloBreachExplainer, alarm, {
      filename: join(directory, "explained.sqlite"),
      executionId: "slo-breach-explained",
      script: answer,
      actions: layer
    })

    // All three fetchers ran, in any order, before the analyst.
    expect(turns.slice(0, 3).sort()).toEqual(["changes checkout", "logs checkout observed 1450ms", "traces checkout"])
    expect(turns[3]).toBe("synthesis p99-latency")
    // The chain is built from what each fetcher reported.
    expect(note.causalChain).toEqual([
      "v42 halved the connection pool",
      "pool exhausted",
      "checkout.db.query timed out"
    ])
    expect(note.impactSummary).toBe("812 failed requests")
  }))

it.effect("fails without asking the analyst when one fetcher fails", () =>
  Effect.gen(function*() {
    const { answer, turns } = script(true)
    const exit = yield* Effect.exit(Kit.run(SloBreachExplainer, alarm, {
      filename: join(directory, "broken.sqlite"),
      executionId: "slo-breach-broken",
      script: answer,
      actions: layer
    }))

    expect(Exit.isFailure(exit)).toBe(true)
    expect(turns).toContain("changes checkout")
    expect(turns.some((turn) => turn.startsWith("synthesis"))).toBe(false)
  }))

it.effect("refuses an alarm missing a field before asking any agent", () =>
  Effect.gen(function*() {
    const { answer, turns } = script()
    const { window: _window, ...partial } = alarm
    const failure = yield* Effect.flip(Kit.run(SloBreachExplainer, partial as typeof alarm, {
      filename: join(directory, "invalid.sqlite"),
      executionId: "slo-breach-invalid",
      script: answer,
      actions: layer
    }))

    expect(failure._tag).toBe("SchemaError")
    expect(String(failure)).toContain("window")
    expect(turns).toEqual([])
  }))
