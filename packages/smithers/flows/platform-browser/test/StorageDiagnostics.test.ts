import { expect, it } from "@effect/vitest"
import { Otlp } from "@smthrs/observability"
import * as Cause from "effect/Cause"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import { createServer } from "node:http"
import { observe, openings } from "../src/internal/StorageDiagnostics.ts"
import * as Telemetry from "./fixtures/Telemetry.ts"

it.effect("external cancellation records interruption after initialization starts", () =>
  Effect.gen(function*() {
    const telemetry = Telemetry.make()
    const started = yield* Deferred.make<void>()
    const opening = yield* observe("build", Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)))
      .pipe(
        telemetry.observed,
        Effect.forkChild
      )
    yield* Deferred.await(started)
    yield* Fiber.interrupt(opening)
    const exit = yield* Fiber.await(opening)
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
    expect(telemetry.count(openings, { stage: "build", outcome: "interrupted" })).toBe(1)
    expect(telemetry.count(openings, { stage: "build", outcome: "failed" })).toBe(0)
    expect(telemetry.lines("browser.sqlite.open").map((log) => log.annotations.outcome)).toEqual([
      "opening",
      "interrupted"
    ])
  }))

it.effect("an interrupted open remains cancelled and is counted separately from a storage refusal", () =>
  Effect.gen(function*() {
    const telemetry = Telemetry.make()
    const exit = yield* observe("opfs", Effect.interrupt).pipe(Effect.exit, telemetry.observed)
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
    expect(telemetry.count(openings, { stage: "opfs", outcome: "interrupted" })).toBe(1)
    expect(telemetry.count(openings, { stage: "opfs", outcome: "failed" })).toBe(0)
    const lines = telemetry.lines("browser.sqlite.open")
    expect(lines.map((log) => log.annotations.outcome)).toEqual(["opening", "interrupted"])
    expect(lines[1]!.annotations).not.toHaveProperty("error.type")
  }))

it.effect("records a storage boundary and its native refusal without user content", () =>
  Effect.gen(function*() {
    const telemetry = Telemetry.make()
    expect(yield* observe("build", Effect.succeed(7)).pipe(telemetry.observed)).toBe(7)
    for (
      const failure of [
        new DOMException("private payload", "SecurityError"),
        { reason: { cause: new DOMException("private payload", "QuotaExceededError") } },
        { name: "private payload" },
        { name: 42 },
        undefined
      ]
    ) {
      expect(yield* observe("opfs", Effect.fail(failure)).pipe(Effect.flip, telemetry.observed)).toBe(failure)
    }
    const failed = telemetry.lines("browser.sqlite.open").filter((log) => log.annotations.outcome === "failed")
    expect(failed.map((log) => log.annotations["error.type"])).toEqual([
      "SecurityError",
      "QuotaExceededError",
      "unknown",
      "unknown",
      "unknown"
    ])
    expect(telemetry.count(openings, { stage: "opfs", outcome: "failed" })).toBe(5)
    expect(telemetry.count(openings, { stage: "build", outcome: "ready" })).toBe(1)
    expect(telemetry.named("browser.sqlite.open")).toHaveLength(6)
    expect(Telemetry.dump(telemetry)).not.toContain("private payload")
  }))

it.effect("exports only the diagnostic classification, preserving the original failure for its caller", () =>
  Effect.gen(function*() {
    const exported: Array<string> = []
    const server = createServer((request, response) => {
      const chunks: Array<Buffer> = []
      request.on("data", (chunk) => chunks.push(chunk))
      request.on("end", () => {
        exported.push(Buffer.concat(chunks).toString())
        response.writeHead(200, { "content-type": "application/json" })
        response.end("{}")
      })
    })
    yield* Effect.acquireRelease(
      Effect.promise(() => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))),
      () => Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve())))
    )
    const address = server.address() as { readonly port: number }
    const secret = new Error("private payload message")
    secret.name = "private payload name"
    secret.stack = "private payload stack"
    const actual = yield* observe("opfs", Effect.fail(secret)).pipe(
      Effect.flip,
      Effect.provide(Otlp.layerFetch({
        baseUrl: `http://127.0.0.1:${address.port}`,
        serviceName: "storage-diagnostic-test",
        spans: ["browser.sqlite.open"]
      }))
    )
    expect(actual).toBe(secret)
    expect(exported.join("\n")).toContain("browser.sqlite.open")
    expect(exported.join("\n")).toContain("unknown")
    expect(exported.join("\n")).not.toContain("private payload")
  }).pipe(Effect.scoped))
