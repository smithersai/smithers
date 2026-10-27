import { expect, it } from "@effect/vitest"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Logger from "effect/Logger"
import * as Metric from "effect/Metric"
import { createServer } from "node:http"
import { Otlp } from "../src/index.ts"

it.effect("redacts log bodies, annotations and trace events at the real collector boundary", () =>
  Effect.promise(async () => {
    const requests: Array<{ url: string; body: string }> = []
    const server = createServer(async (request, response) => {
      const chunks: Array<Buffer> = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      requests.push({ url: request.url!, body: Buffer.concat(chunks).toString() })
      response.end("{}")
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    try {
      const address = server.address() as { port: number }
      const markers = [
        "sk-ant-api03-synthetic-01234567890123456789",
        "sk-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH",
        "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
        "github_pat_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ",
        "Bearer synthetic-credential-0123456789",
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzeW50aGV0aWMifQ.c3ludGhldGljc2lnbmF0dXJl"
      ]
      const keys = [
        "apiKey",
        "TOKEN",
        "authorization",
        "Password",
        "secret",
        "Cookie",
        "x-api-key",
        "credentials",
        "privateKey"
      ]
      const keyMarkers = keys.map((_, index) => `credential-marker-${index}`)
      await Effect.runPromise(
        Effect.gen(function*() {
          yield* Effect.annotateCurrentSpan(Object.fromEntries(keys.map((key, index) => [key, keyMarkers[index]])))
          const span = yield* Effect.currentSpan.pipe(Effect.orDie)
          span.event("explicit-event", 0n, {
            apiKey: "event-key-marker",
            nested: { items: [{ token: "event-nested-marker", note: markers[2] }] },
            safe: "event-kept"
          })
          yield* Effect.annotateCurrentSpan("nested", { items: [{ token: "span-nested-marker", note: markers[3] }] })
          yield* Effect.annotateCurrentSpan("safe", "span-kept")
          yield* Effect.annotateCurrentSpan("inputTokens", 100)
          yield* Effect.log("accounting-kept").pipe(Effect.annotateLogs({ maxTokens: 4096 }))
          span.event("accounting-event", 0n, { outputTokens: 20 })
          yield* Metric.update(
            Metric.withAttributes(Metric.counter("privacy_count"), {
              apiKey: "metric-key-marker",
              note: markers[0]!,
              safe: "metric-kept"
            }),
            1
          )
          for (const marker of markers) yield* Effect.log(marker)
          yield* Effect.log({ nested: [{ AuThOrIzAtIoN: "log-authorization-marker", note: markers[0] }] }).pipe(
            Effect.annotateLogs({ PASSWORD: "log-password-marker", cookie: "log-cookie-marker", safe: "kept" })
          )
          yield* Effect.logError(new Error(`failed ${markers[0]}`))
          yield* Effect.logError(Cause.fail(new Error(`cause ${markers[1]}`)))
        }).pipe(
          Effect.withSpan("privacy-test", { attributes: { "creation.apiKey": "creation-key-marker" } }),
          Effect.provide(Otlp.layerFetch({ baseUrl: `http://127.0.0.1:${address.port}`, exportInterval: "1 hour" })),
          Effect.provideService(Metric.MetricRegistry, new Map()),
          Effect.provideService(Logger.CurrentLoggers, new Set())
        )
      )
      for (const url of ["/v1/logs", "/v1/traces"]) {
        const records = requests.filter((request) => request.url === url)
        expect(records.length).toBeGreaterThan(0)
        const body = records.map((record) => record.body).join("")
        for (const marker of [...markers, "log-authorization-marker", "log-password-marker", "log-cookie-marker"]) {
          expect(body).not.toContain(marker)
        }
        expect(body).toContain("[REDACTED]")
        expect(body).toContain("kept")
      }
      const metrics = requests.filter((request) => request.url === "/v1/metrics").map((request) => request.body).join(
        ""
      )
      expect(metrics).toContain("privacy_count")
      expect(metrics).toContain("metric-kept")
      expect(metrics).not.toContain("metric-key-marker")
      expect(metrics).not.toContain(markers[0])
      const traces = requests.filter((request) => request.url === "/v1/traces").map((request) => request.body).join("")
      for (
        const marker of [
          ...keyMarkers,
          "event-key-marker",
          "event-nested-marker",
          "span-nested-marker",
          "creation-key-marker"
        ]
      ) {
        expect(traces).not.toContain(marker)
      }
      expect(traces).toMatch(/"key":"inputTokens","value":\{"intValue":100\}/)
      expect(traces).toMatch(/"key":"outputTokens","value":\{"intValue":20\}/)
      expect(requests.find((request) => request.url === "/v1/logs")!.body)
        .toMatch(/"key":"maxTokens","value":\{"intValue":4096\}/)
      expect(traces).toContain("creation.apiKey")
      expect(traces).toContain("span-kept")
      expect(traces).toContain("event-kept")
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  }))
