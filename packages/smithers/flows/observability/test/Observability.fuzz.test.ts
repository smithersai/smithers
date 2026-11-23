import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Layer, Logger, References, Result, Schema } from "effect"
import { HttpServerRequest } from "effect/http"
import { describe, expect, it } from "vitest"
import { Endpoint, OtlpRelay } from "../src/index.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "1000" : "200"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261122")

describe("@smthrs/observability OtlpRelay & Endpoint fuzz invariants", () => {
  it("OtlpRelay.serve enforces method/path/size/nesting limits and strict allowlist filtering", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        method: Schema.Literals(["POST", "GET", "PUT", "DELETE"]),
        signal: Schema.Literals(["logs", "traces", "metrics", "unknown"]),
        recordName: Schema.Literals(["allowed.event", "forbidden.event", "secret.dump"]),
        allowedFieldVal: Schema.String.pipe(Schema.check(Schema.isMaxLength(20))),
        secretFieldVal: Schema.String.pipe(Schema.check(Schema.isMinLength(6), Schema.isMaxLength(24))),
        oversize: Schema.Boolean,
        tooDeep: Schema.Boolean
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ method, signal, recordName, allowedFieldVal, secretFieldVal, oversize, tooDeep }) =>
          Effect.gen(function*() {
            const emitted: Array<{ readonly message: unknown; readonly annotations: Record<string, unknown> }> = []
            const captureLogger = Logger.layer([
              Logger.make((log) => {
                emitted.push({ message: log.message, annotations: log.fiber.getRef(References.CurrentLogAnnotations) })
              })
            ])
            let body: string
            if (oversize) {
              body = "a".repeat(2048)
            } else if (tooDeep) {
              body = "[".repeat(80) + "]".repeat(80)
            } else if (signal === "logs") {
              body = JSON.stringify({
                resourceLogs: [{
                  resource: { attributes: [{ key: "service.name", value: { stringValue: "svc" } }] },
                  scopeLogs: [{
                    logRecords: [{
                      body: { stringValue: recordName },
                      attributes: [
                        { key: "safe.tag", value: { stringValue: allowedFieldVal } },
                        { key: "secret.token", value: { stringValue: secretFieldVal } }
                      ]
                    }]
                  }]
                }]
              })
            } else {
              body = "{}"
            }
            const webReq = new Request(`https://obs.example/v1/${signal}`, {
              method,
              ...(method === "POST" || method === "PUT"
                ? { body, headers: { "content-type": "application/json" } }
                : {})
            })
            const serverReq = HttpServerRequest.fromWeb(webReq)
            const response = yield* OtlpRelay.serve({
              maxBodyBytes: 1024,
              maxRecords: 10,
              allow: {
                records: ["allowed.event"],
                fields: ["otlp.signal", "service.name", "safe.tag"]
              }
            }).pipe(
              Effect.provide(
                Layer.mergeAll(
                  Layer.succeed(HttpServerRequest.HttpServerRequest, serverReq),
                  captureLogger
                )
              )
            )

            if (signal === "unknown") return response.status === 404 && emitted.length === 0
            if (method !== "POST") return response.status === 405 && emitted.length === 0
            if (oversize) return response.status === 413 && emitted.length === 0
            if (tooDeep) return response.status === 400 && emitted.length === 0
            if (response.status !== 200) return false

            for (const entry of emitted) {
              if ("secret.token" in entry.annotations) return false
              for (const k of Object.keys(entry.annotations)) {
                if (k !== "otlp.signal" && k !== "service.name" && k !== "safe.tag") return false
              }
            }
            if (signal === "logs") {
              if (recordName === "allowed.event" && emitted.length !== 1) return false
              if (recordName !== "allowed.event" && emitted.length !== 0) return false
            }
            return true
          }),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Endpoint.decode rejects non-http(s)/malformed/oversized URLs and normalize strips trailing slashes", async () => {
    const arb = Arbitrary.schema(
      Schema.Union([
        Schema.String.pipe(Schema.check(Schema.isMaxLength(128))),
        Schema.Literals([
          "https://otel.example.com///",
          "http://127.0.0.1:4318/",
          "javascript:alert(1)",
          "file:///etc/passwd",
          "ftp://example.com",
          "https://user:pass@example.com/v1",
          "https://example.com/" + "a".repeat(2100)
        ])
      ])
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (raw) =>
          Effect.gen(function*() {
            const res = yield* Effect.result(Endpoint.decode(raw, "otlp.endpoint"))
            if (Result.isFailure(res)) {
              return res.failure._tag === "@smthrs/observability/InvalidExporterEndpoint"
            }
            const ok = res.success
            if (ok.length > Endpoint.maximumEndpointLength) return false
            if (!/^https?:\/\//i.test(ok)) return false
            const norm = Endpoint.normalize(ok)
            if (norm.endsWith("/")) return false
            const traceUrl = Endpoint.signalUrl(norm, "traces")
            return traceUrl.endsWith("/v1/traces")
          }),
        { seed: seed + 1, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
