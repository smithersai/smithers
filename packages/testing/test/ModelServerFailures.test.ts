/**
 * Late failures must finish the real HTTP response, even after a heartbeat.
 */
import { expect, it } from "@effect/vitest"
import * as Model from "@smthrs/model/Model"
import { Deferred, Effect, Logger, Stream } from "effect"
import * as ModelServer from "../src/ModelServer.ts"
import * as TurnGate from "../src/TurnGate.ts"

it.live("ends a replay miss after the heartbeat opens the stream", () =>
  Effect.gen(function*() {
    const gate = yield* TurnGate.make()
    const missing = Model.make({ stream: () => Stream.die(new Error("private fixture detail")) })
    const server = yield* ModelServer.make({
      model: TurnGate.model(missing, { gate, key: () => "missing" }),
      heartbeatMs: 5
    })
    const response = yield* Effect.tryPromise(() =>
      fetch(`${server.url}${ModelServer.paths.chat}`, {
        method: "POST",
        body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "private prompt" }], stream: true }),
        signal: AbortSignal.timeout(2_000)
      })
    )
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("text/event-stream")
    const reader = response.body!.getReader()
    const first = yield* Effect.tryPromise(() => reader.read())
    expect(new TextDecoder().decode(first.value)).toContain(": held")
    yield* gate.release("missing")
    const remaining = yield* Effect.tryPromise(async () => {
      let text = ""
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) return text
        text += new TextDecoder().decode(chunk.value)
      }
    })
    expect(remaining).toContain("\"type\":\"unrecorded\"")
    expect(remaining).toContain("model m, messages: 1")
    expect(remaining).not.toContain("private")
    expect(remaining).not.toContain("[DONE]")
  }).pipe(Effect.scoped))

it.live("ends a route defect with a generic 500 and keeps serving requests", () =>
  Effect.gen(function*() {
    const gate = yield* TurnGate.make()
    const server = yield* ModelServer.make({
      model: Model.make({ stream: () => Stream.empty }),
      gate: { ...gate, held: () => Effect.die(new Error("private route detail")) }
    })
    const response = yield* Effect.tryPromise(() =>
      fetch(`${server.url}${ModelServer.paths.held}`, { signal: AbortSignal.timeout(2_000) })
    )
    expect(response.status).toBe(500)
    const body = yield* Effect.promise(() => response.text())
    expect(JSON.parse(body)).toMatchObject({ error: { type: "internal_error" } })
    expect(body).not.toContain("private")
    const health = yield* Effect.promise(() => fetch(`${server.url}${ModelServer.paths.health}`))
    expect(health.status).toBe(200)
  }).pipe(Effect.scoped))

for (const disconnect of [false, true]) {
  it.live(`finishes a streaming request when failure reporting defects: disconnect=${disconnect}`, () =>
    Effect.gen(function*() {
      const gate = yield* TurnGate.make()
      const reported = yield* Deferred.make<void>()
      const logger = Logger.make(() => {
        Deferred.doneUnsafe(reported, Effect.void)
        throw new Error("private logger detail")
      })
      const server = yield* ModelServer.make({
        model: TurnGate.model(Model.make({ stream: () => Stream.die("missing") }), {
          gate,
          key: () => "missing"
        }),
        heartbeatMs: 5
      }).pipe(Effect.provide(Logger.layer([logger])))
      const controller = new AbortController()
      const response = yield* Effect.tryPromise(() =>
        fetch(`${server.url}${ModelServer.paths.chat}`, {
          method: "POST",
          body: JSON.stringify({ model: "m", messages: [], stream: true }),
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(2_000)])
        })
      )
      const reader = response.body!.getReader()
      yield* Effect.tryPromise(() => reader.read())
      if (disconnect) controller.abort()
      yield* gate.release("missing")
      yield* Deferred.await(reported)
      if (!disconnect) {
        const body = yield* Effect.tryPromise(async () => {
          let text = ""
          for (;;) {
            const chunk = await reader.read()
            if (chunk.done) return text
            text += new TextDecoder().decode(chunk.value)
          }
        })
        expect(body).toContain("\"type\":\"internal_error\"")
        expect(body).not.toContain("private")
      }
      const health = yield* Effect.promise(() => fetch(`${server.url}${ModelServer.paths.health}`))
      expect(health.status).toBe(200)
    }).pipe(Effect.scoped))
}

it.live("answers a model that throws before constructing its stream", () =>
  Effect.gen(function*() {
    const server = yield* ModelServer.make({
      model: Model.make({
        stream: () => {
          throw new Error("private construction detail")
        }
      }),
      heartbeatMs: 5
    })
    const response = yield* Effect.tryPromise(() =>
      fetch(`${server.url}${ModelServer.paths.chat}`, {
        method: "POST",
        body: JSON.stringify({ model: "m", messages: [], stream: true }),
        signal: AbortSignal.timeout(2_000)
      })
    )
    expect(response.status).toBe(501)
    const body = yield* Effect.promise(() => response.text())
    expect(JSON.parse(body)).toMatchObject({ error: { type: "unrecorded" } })
    expect(body).not.toContain("private")
    const health = yield* Effect.promise(() => fetch(`${server.url}${ModelServer.paths.health}`))
    expect(health.status).toBe(200)
  }).pipe(Effect.scoped))
