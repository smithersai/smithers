import { PinClient } from "./api.vibe"
import { createServer } from "node:http"
import { FlowRuntime } from "@smthrs/flow"
import { Effect, Layer, Logger } from "effect"
import { FetchHttpClient } from "effect/http"
import { expect, test } from "vitest"
import { PinRefused, PinUnavailable } from "./flows"
import { stamp, writePin } from "./steps.vibe"

test("the durable request preserves targets, classifies final refusals and retries only transient failures", async () => {
  let status = 503
  let mode = "json"
  const posted: Array<unknown> = []
  // A faulty HTTP service for unhappy paths; happy-path requests run against real ChatApi in integration.test.ts.
  const server = createServer(async (req, res) => {
    let text = ""
    for await (const part of req) text += part
    posted.push(JSON.parse(text))
    if (mode === "network") { req.socket.destroy(); return }
    if (mode === "stall") return
    res.writeHead(status, { "content-type": "application/json" })
    res.end(mode === "malformed" ? "bad" : JSON.stringify(req.url?.endsWith("/stamp") ? { at: 42 } : { messageId: null, conversationId: "home" }))
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as { port: number }).port
  const run = (unpin = false, executionId = "press") => Effect.runPromise(writePin(unpin, "1 second")({ at: 1 }).pipe(
    Effect.result, Effect.provide(PinClient.layer(`http://127.0.0.1:${port}`).pipe(Layer.provide(FetchHttpClient.layer))), Effect.provideService(FlowRuntime.FlowInstance, { executionId } as FlowRuntime.FlowInstance["Service"]),
    Effect.provideService(Logger.CurrentLoggers, new Set()),
  ))
  const stamped = () => Effect.runPromise(stamp("1 second")({}).pipe(
    Effect.result, Effect.provide(PinClient.layer(`http://127.0.0.1:${port}`).pipe(Layer.provide(FetchHttpClient.layer))), Effect.provideService(FlowRuntime.FlowInstance, { executionId: "press/call/1" } as FlowRuntime.FlowInstance["Service"]),
    Effect.provideService(Logger.CurrentLoggers, new Set()),
  ))
  try {
    for (const code of [400, 401, 403, 404, 499]) {
      status = code
      expect(await stamped()).toMatchObject({ _tag: "Failure", failure: new PinRefused({ status: code }) })
      const r = await run()
      expect(r).toMatchObject({ _tag: "Failure", failure: new PinRefused({ status: code }) })
    }
    for (const code of [302, 408, 425, 429, 503]) {
      status = code
      expect(await stamped()).toMatchObject({ _tag: "Failure", failure: new PinUnavailable() })
      expect(await run()).toMatchObject({ _tag: "Failure", failure: new PinUnavailable() })
    }
    status = 200
    expect(await stamped()).toMatchObject({ _tag: "Success", success: { at: 42 } })
    expect(await run(true, "6a3c2d0e-8a8b-5c1f-9e0a-1d2b3c4d5e6f/call/1")).toMatchObject({ _tag: "Success", success: { messageId: null } })
    expect(posted.at(-1)).toEqual({ at: 1, answerId: "6a3c2d0e-8a8b-5c1f-9e0a-1d2b3c4d5e6f", messageId: null })
    for (const faulty of ["malformed", "network", "stall"]) {
      mode = faulty
      expect(await stamped()).toMatchObject({ _tag: "Failure", failure: new PinUnavailable() })
      expect(await run()).toMatchObject({ _tag: "Failure", failure: new PinUnavailable() })
    }
    expect(await Effect.runPromise(stamp()({ at: 12 }).pipe(Effect.provide(PinClient.layer(`http://127.0.0.1:${port}`).pipe(Layer.provide(FetchHttpClient.layer))), Effect.provideService(FlowRuntime.FlowInstance, { executionId: "press" } as FlowRuntime.FlowInstance["Service"])))).toEqual({ at: 12 })
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()))
  }
})

test("transport failures record safe codes without credentials or request content", async () => {
  const { HttpClientError, HttpClientRequest } = await import("effect/http")
  for (const description of [undefined, "run credential lineage", "private request detail"]) {
    const log: Array<ReturnType<typeof Logger.formatStructured.log>> = []
    const faulty = PinClient.of({ post: () => Effect.fail(new HttpClientError.HttpClientError({
      reason: new HttpClientError.TransportError({ request: HttpClientRequest.post("http://localhost/"), ...(description === undefined ? {} : { description }) }),
    })) })
    const result = await Effect.runPromise(writePin(false)({ at: 1 }).pipe(
      Effect.result,
      Effect.provideService(PinClient, faulty),
      Effect.provideService(FlowRuntime.FlowInstance, { executionId: "press" } as FlowRuntime.FlowInstance["Service"]),
      Effect.provideService(Logger.CurrentLoggers, new Set([Logger.make(options => { log.push(Logger.formatStructured.log(options)) })])),
    ))
    expect(result).toMatchObject({ failure: new PinUnavailable() })
    expect(log[0]!.annotations).toMatchObject({ outcome: "unavailable", errorCode: description === "run credential lineage" ? description : "TransportError" })
    expect(JSON.stringify(log)).not.toContain("private request detail")
  }
})
