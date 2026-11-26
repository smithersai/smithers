import { ElectricCollection } from "@smthrs/effect-electric"
import { Effect, Logger, Metric, Stream } from "effect"
import { expect, test } from "vitest"
import { BROWSER_TELEMETRY, EXPORTED_SPANS } from "../../telemetry"
import { observeIssueShape, shapeTransitions } from "./shapeSync.vibe"

test("the issue shape records its first request, refusal and recovery without leaking the failure cause", async () => {
  const secret = "private issue body sentinel"
  const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = []
  const registry: Metric.MetricRegistry = new Map()
  const events: ReadonlyArray<ElectricCollection.SyncEvent> = [
    { _tag: "Sent" },
    { _tag: "Failed", status: 503 },
    { _tag: "Sent" },
    { _tag: "Failed", status: 429 },
    { _tag: "Sent" },
    { _tag: "Failed", status: 429 },
    { _tag: "Sent" },
    { _tag: "Succeeded" },
    { _tag: "Sent" },
    { _tag: "Succeeded" },
    { _tag: "Stopped", error: new ElectricCollection.SyncFailed({ status: 403, cause: new Error(secret) }) },
    { _tag: "Sent" },
    { _tag: "Succeeded" },
  ]
  await Effect.runPromise(observeIssueShape(Stream.fromIterable(events)).pipe(
    Effect.provideService(Logger.CurrentLoggers, new Set([Logger.make((line) => void logs.push(Logger.formatStructured.log(line)))])),
    Effect.provideService(Metric.MetricRegistry, registry),
  ))
  const lines = logs.filter((line) => line.message === "issues.shape.sync")
  expect(lines.map((line) => line.annotations)).toEqual([
    { phase: "sent", durationMs: expect.any(Number) },
    { phase: "failed", status: 503, durationMs: expect.any(Number) },
    { phase: "failed", status: 429, durationMs: expect.any(Number) },
    { phase: "ready", durationMs: expect.any(Number) },
    { phase: "stopped", status: 403, durationMs: expect.any(Number) },
    { phase: "ready", durationMs: expect.any(Number) },
  ])
  expect(JSON.stringify(lines)).not.toContain(secret)
  const count = (phase: string) => Effect.runSync(Metric.value(Metric.withAttributes(shapeTransitions, { phase }))
    .pipe(Effect.provideService(Metric.MetricRegistry, registry))).count
  expect([count("sent"), count("failed"), count("ready"), count("stopped")]).toEqual([1, 2, 2, 1])
  expect(BROWSER_TELEMETRY.records).toContain("issues.shape.sync")
  expect(BROWSER_TELEMETRY.records).toContain("smithers_issue_shape_transitions")
  expect(EXPORTED_SPANS).toContain("issues.shape.sync")
})
