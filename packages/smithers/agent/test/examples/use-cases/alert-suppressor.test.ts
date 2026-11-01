import { afterAll, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Alert } from "../../../examples/use-cases/alert-suppressor.vibe"
import { AlertSuppressor, layer } from "../../../examples/use-cases/alert-suppressor.vibe"
import * as Kit from "../../../examples/use-cases/kit.ts"

const directory = mkdtempSync(join(tmpdir(), "alert-suppressor-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

const alert = (id: string, message: string, severity: (typeof Alert.Type)["severity"] = "high"): typeof Alert.Type => ({
  id,
  source: "prometheus",
  severity,
  message,
  timestamp: "2026-10-14T03:00:00Z",
  labels: JSON.stringify({ service: "api" })
})

/**
 * A context agent that reports one noise rule and one open incident, a
 * classifier that suppresses alerts matching the rule, observes alerts matching
 * the incident and escalates the rest, and a dispatcher that pages, tickets or
 * drops by the verdicts it was handed. Every request is recorded in order.
 */
const script = () => {
  const turns: Array<string> = []
  const answer: Kit.Script = (asked) => {
    if (asked.includes("Look up incident context for these alerts.")) {
      const alerts: ReadonlyArray<{ readonly id: string }> = JSON.parse(/\nAlerts: (.+)/.exec(asked)![1]!)
      turns.push(`context from ${/\nIncident source: (.+)/.exec(asked)![1]} for ${alerts.map((a) => a.id).join(",")}`)
      return {
        recentIncidents: [{ id: "INC-9", title: "API latency", status: "open", relatedAlertPatterns: ["latency"] }],
        noiseRules: [{ pattern: "disk 80%", reason: "nightly backup fills the disk" }]
      }
    }
    if (asked.includes("Classify each unique alert.")) {
      const alerts: ReadonlyArray<{ readonly id: string; readonly message: string }> = JSON.parse(
        /\nUnique alerts: (.+)/.exec(asked)![1]!
      )
      const rules: ReadonlyArray<{ readonly pattern: string }> = JSON.parse(/\nNoise rules: (.+)/.exec(asked)![1]!)
      const incidents: ReadonlyArray<{ readonly id: string; readonly relatedAlertPatterns: ReadonlyArray<string> }> =
        JSON.parse(/\nRecent incidents: (.+)/.exec(asked)![1]!)
      turns.push(`classify ${alerts.map((a) => a.id).join(",")}`)
      return {
        classifications: alerts.map((a) => {
          const rule = rules.find((r) => a.message.includes(r.pattern))
          const incident = incidents.find((i) => i.relatedAlertPatterns.some((p) => a.message.includes(p)))
          return {
            alertId: a.id,
            verdict: rule !== undefined ? "suppress" : incident !== undefined ? "observe" : "escalate",
            confidence: 0.9,
            ...(rule === undefined ? {} : { matchedNoiseRule: rule.pattern }),
            ...(incident === undefined ? {} : { matchedIncidentId: incident.id }),
            reasoning: "matched context",
            riskLevel: rule === undefined ? "high" : "low"
          }
        })
      }
    }
    if (asked.includes("Dispatch these verdicts.")) {
      const channel = /\nPage channel: (.+)/.exec(asked)![1]!
      const tickets = /\nTicket system: (.+)/.exec(asked)![1]!
      const verdicts: ReadonlyArray<{ readonly alertId: string; readonly verdict: string }> = JSON.parse(
        /\nClassifications: (.+)/.exec(asked)![1]!
      )
      turns.push(`dispatch to ${channel} and ${tickets}`)
      const of = (verdict: string) => verdicts.filter((v) => v.verdict === verdict).map((v) => v.alertId)
      return {
        paged: of("escalate").map((alertId) => ({ alertId, channel })),
        ticketed: of("observe").map((alertId) => ({ alertId, ticketUrl: `https://${tickets}/${alertId}` })),
        dropped: of("suppress")
      }
    }
    return undefined
  }
  return { answer, turns }
}

it.effect("drops duplicates and noise, tickets known incidents and pages the novel alert", () =>
  Effect.gen(function*() {
    const { answer, turns } = script()
    const output = yield* Kit.run(AlertSuppressor, {
      alerts: [
        alert("A1", "api latency p99 over 2s"),
        alert("A2", "api latency p99 over 2s"),
        alert("A3", "disk 80% on db-1", "medium"),
        alert("A4", "certificate expires in 2 days", "critical")
      ],
      pageChannel: "slack:#oncall",
      ticketSystem: "linear"
    }, {
      filename: join(directory, "mixed.sqlite"),
      executionId: "alert-suppressor-mixed",
      script: answer,
      actions: layer
    })

    // The context agent saw every alert; the classifier saw only the unique ones.
    expect(turns).toEqual([
      "context from opsgenie for A1,A2,A3,A4",
      "classify A1,A3,A4",
      "dispatch to slack:#oncall and linear"
    ])
    expect(output).toEqual({
      totalReceived: 4,
      suppressed: 2,
      escalated: 1,
      ticketed: 1,
      observed: 1,
      summary:
        "Received 4 alerts. Deduplicated 1 duplicates. Escalated 1 to slack:#oncall. Filed 1 tickets. Suppressed 1 as known noise."
    })
  }))

it.effect("runs every agent on an empty batch with the 0.x defaults", () =>
  Effect.gen(function*() {
    const { answer, turns } = script()
    const output = yield* Kit.run(AlertSuppressor, {}, {
      filename: join(directory, "empty.sqlite"),
      executionId: "alert-suppressor-empty",
      script: answer,
      actions: layer
    })

    expect(turns).toEqual(["context from opsgenie for ", "classify ", "dispatch to pagerduty and jira"])
    expect(output).toEqual({
      totalReceived: 0,
      suppressed: 0,
      escalated: 0,
      ticketed: 0,
      observed: 0,
      summary:
        "Received 0 alerts. Deduplicated 0 duplicates. Escalated 0 to pagerduty. Filed 0 tickets. Suppressed 0 as known noise."
    })
  }))
