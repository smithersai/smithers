import { Otlp } from "@smthrs/observability"
import { Effect, Metric } from "effect"
import { expect, test } from "vitest"
import { dropped } from "./features/attention/actions"
import { BROWSER_TELEMETRY, EXPORTED_SPANS, WITHHELD } from "./telemetry"
import { captured, ORIGIN, relay, relayed } from "./test/relay"

test("the real relay removes sensitive values from HTTP URL fields", async () => {
  const secret = "private-session-credential"
  const attributes = Object.entries({
    "url.full": `https://person:${secret}@example.com/api/${secret}?token=${secret}#${secret}`,
    "url.query": `token=${secret}`,
  }).map(([key, stringValue]) => ({ key, value: { stringValue } }))
  const lines = await Effect.runPromise(relay([{
    path: "/v1/traces",
    body: JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: [{
      name: "GET", traceId: "a".repeat(32), spanId: "b".repeat(16),
      startTimeUnixNano: "1000000", endTimeUnixNano: "2000000", attributes,
    }] }] }] }),
  }], BROWSER_TELEMETRY))
  expect(lines).toHaveLength(1)
  expect(JSON.stringify(lines)).not.toContain(secret)
  expect(lines[0]!.name).toBe("GET")
})

test("exported spans are exactly the permitted records minus the withheld intersection", () => {
  const withheld = new Set<string>(WITHHELD.spans)
  expect(EXPORTED_SPANS).toEqual(BROWSER_TELEMETRY.records.filter((name) => !withheld.has(name)))
  expect(EXPORTED_SPANS.length).toBe(BROWSER_TELEMETRY.records.length - BROWSER_TELEMETRY.records.filter((name) => withheld.has(name)).length)
})

test("the relay preserves pending-act failures, silent doors and report refusal reasons", async () => {
  const exported = captured(Otlp.layerFetch({ baseUrl: `${ORIGIN}/api/telemetry`, serviceName: "smithers-web" }))
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* Effect.logWarning("notifications.pending").pipe(Effect.annotateLogs({
      subject: "run:attention-relay", version: 1, act: "hide", outcome: "dropped", reason: "@smthrs/mvp/attention/ActRefused",
    }))
    yield* Metric.update(Metric.withAttributes(dropped, { act: "hide", reason: "@smthrs/mvp/attention/ActRefused" }), 1)
    yield* Effect.logInfo("branch.write.identity").pipe(Effect.annotateLogs({
      runId: "operation-round", parentRunId: "operation-start", flow: "branch/operation/program",
      principal: "Session", identity: "person",
    }))
    yield* Effect.logWarning("auth.run_credential").pipe(Effect.annotateLogs({ flow: "notification/ack", outcome: "door_timeout" }))
    for (const reason of ["settled", "other_launcher", "no_row"]) {
      yield* Effect.logInfo("agent.status.report").pipe(Effect.annotateLogs({
        runId: "attention-relay", status: 409, errorCode: "not_writable", reason,
      }))
    }
  }).pipe(Effect.provide(exported.layer), Effect.provideService(Metric.MetricRegistry, new Map()))))
  const { kept, dropped: removed } = await Effect.runPromise(relayed(exported.exports, BROWSER_TELEMETRY))
  expect([...removed.records]).toEqual([])
  expect([...removed.fields.values()].flatMap((fields) =>
    [...fields].filter((field) => !(WITHHELD.fields as ReadonlyArray<string>).includes(field))
  )).toEqual([])
  const fields = (name: string) => kept.filter((line) => line.name === name).map((line) => line.fields)
  expect(fields("notifications.pending")).toContainEqual(expect.objectContaining({
    subject: "run:attention-relay", version: 1, act: "hide", outcome: "dropped", reason: "@smthrs/mvp/attention/ActRefused",
  }))
  expect(fields("smithers_notification_acts_dropped")).toContainEqual(expect.objectContaining({
    act: "hide", reason: "@smthrs/mvp/attention/ActRefused", "otlp.value": 1,
  }))
  expect(fields("branch.write.identity")).toContainEqual(expect.objectContaining({
    runId: "operation-round", parentRunId: "operation-start", flow: "branch/operation/program",
    principal: "Session", identity: "person",
  }))
  expect(fields("auth.run_credential")).toContainEqual(expect.objectContaining({ flow: "notification/ack", outcome: "door_timeout" }))
  expect(fields("agent.status.report").map((line) => line.reason)).toEqual(["settled", "other_launcher", "no_row"])
})
