import { expect, test } from "vitest"
import { telemetryExport } from "./telemetryExport"
import { Otlp } from "@smthrs/observability"
import { Effect } from "effect"
import { captured, ORIGIN } from "./test/relay"

test("OTLP leaves neither typed repository paths nor exception text on the device boundary", () => {
  const marker = "private-repository-sentinel"
  const attributes = Object.entries({
    "url.full": `https://app.test/api/repos/typed-owner/${marker}/about?token=secret`,
    "url.path": `/api/repos/typed-owner/${marker}/about`,
    "exception.message": marker,
    "exception.stacktrace": marker,
    "exception.type": "ResponseError",
    "http.response.status_code": 503,
    repoId: marker,
    unknown: marker,
  }).map(([key, value]) => ({ key, value: typeof value === "number" ? { intValue: value } : { stringValue: value } }))
  const exported = telemetryExport({ resourceSpans: [{ scopeSpans: [{ spans: [{ attributes, events: [{ attributes }], status: { code: 2, message: marker } }] }] }] })
  expect(JSON.stringify(exported)).not.toContain(marker)
  expect(JSON.stringify(exported)).not.toContain("typed-owner")
  expect(JSON.stringify(exported)).toContain("/api/repos/:owner/:repo/about")
  expect(JSON.stringify(exported)).toContain("ResponseError")
  expect(JSON.stringify(exported)).toContain("503")
  expect(JSON.stringify(exported)).not.toContain("message")
})

test("only scalar path strings are accepted; nulls and unrelated OTLP values keep their types", () => {
  expect(telemetryExport({ attributes: [{ key: "url.path", value: { intValue: 42 } }], status: 200, other: null, name: "GET" }))
    .toEqual({ attributes: [], status: 200, other: null, name: "GET" })
  expect(telemetryExport({ status: null })).toEqual({ status: null })
})

test("the real OTLP exporter applies privacy before serializing a failure to the transport", async () => {
  const marker = "typed-private-repository"
  const export_ = captured(Otlp.layerFetch({ baseUrl: `${ORIGIN}/api/telemetry`, transform: telemetryExport }))
  await Effect.runPromise(Effect.scoped(Effect.fail(new Error(`/api/repos/owner/${marker}/about`)).pipe(
    Effect.withSpan("GET", { attributes: { "url.full": `https://app.test/api/repos/owner/${marker}/about`, "url.path": `/api/repos/owner/${marker}/about`, "http.response.status_code": 503 } }),
    Effect.ignore,
    Effect.provide(export_.layer),
  )))
  expect(export_.exports.length).toBeGreaterThan(0)
  expect(JSON.stringify(export_.exports)).not.toContain(marker)
  expect(JSON.stringify(export_.exports)).toContain("/api/repos/:owner/:repo/about")
})
