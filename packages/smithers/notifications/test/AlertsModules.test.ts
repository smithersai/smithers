/**
 * The alert module boundary: which module owns which export, and that
 * `Alerts.ts` owns none of them.
 *
 * The policy, the webhook transport, and the journal-backed runtime are three
 * concerns with three reasons to change, and `Alerts.ts` is the barrel that
 * keeps them one import for a consumer. The pin is the ownership map: a symbol
 * that grows back into the barrel, or drifts between concerns, fails here
 * instead of in a reviewer's memory. The surface list is the other half, since
 * a barrel that quietly stops re-exporting a name is a break no typecheck of
 * this package would see.
 */
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as AlertPolicy from "../src/AlertPolicy.ts"
import * as AlertRuntime from "../src/AlertRuntime.ts"
import * as Alerts from "../src/Alerts.ts"
import * as AlertSink from "../src/AlertSink.ts"
import * as layerWebhook from "../src/layerWebhook.ts"

/** The module each published name is declared in, and the only one it may come from. */
const owners: ReadonlyArray<readonly [string, Readonly<Record<string, unknown>>, ReadonlyArray<string>]> = [
  ["AlertPolicy", AlertPolicy, [
    "alertId",
    "coalescingKey",
    "conditions",
    "decide",
    "defaultDetectors",
    "deliveredEventType",
    "Detector",
    "failedEventType",
    "Policy",
    "Rule",
    "Severity"
  ]],
  ["AlertSink", AlertSink, ["AlertError", "FailureCode", "layerNoop", "Sink"]],
  ["AlertRuntime", AlertRuntime, ["AlertRuntime", "layer"]],
  ["layerWebhook", layerWebhook, ["defaultWebhookTimeout", "layerWebhook"]]
]

const published = Alerts as Readonly<Record<string, unknown>>

describe("the Alerts barrel", () => {
  it("publishes exactly the names the alert modules declare", () => {
    expect(Object.keys(Alerts).sort()).toEqual(owners.flatMap(([, , names]) => names).sort())
  })

  it("takes every name from the module that owns the concern", () => {
    for (const [, module, names] of owners) {
      for (const name of names) {
        expect(published[name]).toBe(module[name])
      }
    }
  })

  it("declares nothing of its own, so a concern cannot grow back into it", () => {
    for (const name of Object.keys(Alerts)) {
      const declaring = owners.filter(([, module, names]) => Object.hasOwn(module, name) && names.includes(name))
      expect(declaring.map(([owner]) => owner)).toHaveLength(1)
    }
  })

  it("keeps the shared fold private to the policy module", () => {
    for (const helper of ["detectorsOf", "observe", "payloadRecord"]) {
      expect(Object.hasOwn(AlertPolicy, helper)).toBe(true)
      expect(Object.hasOwn(Alerts, helper)).toBe(false)
    }
  })
})

describe("the Alerts types", () => {
  it("re-exports every type a consumer names through the namespace", () => {
    const severity: Alerts.Severity = "critical"
    const detector: Alerts.Detector = { field: "status", value: "failed" }
    const rule: Alerts.Rule = { afterMs: 30_000, severity }
    const policy: Alerts.Policy = { rules: { stalled: rule }, detectors: { stalled: detector } }
    const open: Alerts.Open = { runId: "run-1", condition: "stalled", since: 0 }
    const alert: Alerts.Alert = {
      runId: open.runId,
      condition: open.condition,
      since: open.since,
      firedAt: 30_000,
      severity,
      coalescingKey: Alerts.coalescingKey(open.runId, open.condition)
    }
    const tick: Alerts.Tick = { delivered: [alert], failed: [], refused: [], suppressed: [] }
    const code: Alerts.FailureCode = "sink_timeout"
    const sink: Alerts.SinkService = { deliver: () => Effect.fail(new Alerts.AlertError({ code, message: code })) }
    const runtime: Alerts.RuntimeService = { tick: () => Effect.succeed(tick) }

    expect(Alerts.decide(policy, [open], 30_000)).toEqual([alert])
    expect(Alerts.alertId(alert)).toBe("alert:run-1:stalled:0")
    expect(Effect.runSync(Effect.result(sink.deliver(alert))).toString()).toContain(code)
    expect(Effect.runSync(runtime.tick(alert.runId))).toBe(tick)
  })
})
