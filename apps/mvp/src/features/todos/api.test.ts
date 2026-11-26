import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { Effect, Logger, Metric, Tracer } from "effect"
import { FetchHttpClient } from "effect/http"
import { afterEach, expect, test } from "vitest"
import { BROWSER_TELEMETRY, EXPORTED_SPANS } from "../../telemetry"
import { type ChangeRequest, readTodoStatus, StackClient } from "./api.vibe"
import { statusReads } from "./metrics"
import { inspectStatus } from "./steps.vibe"

// The real stack client from the browser's side, against a local HTTP server that plays a gateway: real sockets, so a
// stalled body, a body cut short and nothing listening are what a browser would meet. Every answer ChatApi itself gives
// is tested through its real handler in todos.test.ts and worker/stack/Api.test.ts.

const change: ChangeRequest = { opId: crypto.randomUUID(), op: "drop", number: 3 }

const servers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of servers.splice(0)) await close()
})

/** A server that answers every request with `respond`, keeping what each asked for. */
const serve = async (respond: (request: IncomingMessage, response: ServerResponse) => void) => {
  const asked: Array<{ readonly method: string; readonly url: string; readonly body: string }> = []
  const server = createServer((request, response) => {
    let body = ""
    request.on("data", (chunk) => (body += chunk))
    request.on("end", () => {
      asked.push({ method: request.method!, url: request.url!, body })
      respond(request, response)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  servers.push(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  )
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, asked }
}

const send = (origin: string) =>
  Effect.runPromise(
    Effect.result(Effect.flatMap(StackClient, (client) => client.change("octo", "hello", change))).pipe(
      Effect.provide(StackClient.layer({ origin, within: "300 millis" })),
      Effect.provide(FetchHttpClient.layer),
    ),
  )

const read = (origin: string) =>
  Effect.runPromise(Effect.result(readTodoStatus(origin, "octo", "hello", 3, "300 millis")).pipe(
    Effect.provide(FetchHttpClient.layer),
  ))

const json = (status: number, body: unknown) => (_: IncomingMessage, response: ServerResponse) => {
  response.writeHead(status, { "content-type": "application/json" })
  response.end(JSON.stringify(body))
}

test("posts the change to its repository's stack route and reads what ChatApi took", async () => {
  const taken = await serve(json(202, { txid: 41, opId: change.opId, outcome: "dropped", number: 3 }))
  const took = await send(taken.origin)
  expect(took._tag === "Success" && took.success).toEqual({ txid: 41, opId: change.opId, outcome: "dropped", number: 3 })
  expect(taken.asked).toEqual([{ method: "POST", url: "/api/repos/octo/hello/stack", body: JSON.stringify(change) }])
})

test("a refusal is not taken, with its status and the code its body names", async () => {
  const named = await serve(json(409, { code: "stack_full" }))
  expect(await send(named.origin)).toMatchObject({ _tag: "Failure", failure: { status: 409, code: "stack_full" } })
  const bare = await serve((_, response) => {
    response.writeHead(502, { "content-type": "text/html" })
    response.end("<html>bad gateway</html>")
  })
  const result = await send(bare.origin)
  expect(result).toMatchObject({ _tag: "Failure", failure: { status: 502 } })
  expect(result._tag === "Failure" && result.failure.code).toBe(undefined)
  const other = await serve(json(400, { reason: "x" }))
  const unnamed = await send(other.origin)
  expect(unnamed._tag === "Failure" && unnamed.failure.code).toBe(undefined)
})

test("a 202 whose body isn't the contract's is not taken, with its status", async () => {
  const { origin } = await serve(json(202, { txid: "41" }))
  expect(await send(origin)).toMatchObject({ _tag: "Failure", failure: { status: 202 } })
})

test("a body that stalls fails at the deadline with no status, as the network does", async () => {
  const { origin } = await serve((_, response) => {
    response.writeHead(202, { "content-type": "application/json" })
    response.write('{"txid":')
  })
  const result = await send(origin)
  expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "ChangeNotTaken" } })
  expect(result._tag === "Failure" && result.failure.status).toBe(undefined)
})

test("nothing listening fails at once with no status", async () => {
  const { origin } = await serve(() => {})
  await servers.splice(0)[0]!()
  const result = await send(origin)
  expect(result._tag === "Failure" && result.failure.status).toBe(undefined)
})

test("reads current TODO status through the authorized route", async () => {
  const served = await serve(json(200, {
    kind: "found", number: 3, state: "working", step: "implement", attempt: 1,
    branch: "smithers/t3", prNumber: null, failure: null, note: null,
    runId: "todo:attempt-3", updatedAt: "2026-10-23 20:00:00+00",
  }))
  expect(await read(served.origin)).toMatchObject({
    _tag: "Success", success: { kind: "found", state: "working", runId: "todo:attempt-3" },
  })
  expect(served.asked).toEqual([{ method: "GET", url: "/api/repos/octo/hello/stack/3", body: "" }])
})

test("only a named 404 proves absence; access refusals and bad responses are unavailable", async () => {
  const missing = await serve(json(404, { code: "todo_not_found" }))
  expect(await read(missing.origin)).toMatchObject({ _tag: "Success", success: { kind: "not_found", number: 3 } })
  const repositoryMissing = await serve(json(404, { code: "not_found" }))
  expect(await read(repositoryMissing.origin)).toMatchObject({ _tag: "Failure", failure: { reason: "unavailable" } })
  const routeMissing = await serve(json(404, { code: "route_not_found" }))
  expect(await read(routeMissing.origin)).toMatchObject({ _tag: "Failure", failure: { reason: "unavailable" } })
  const signedOut = await serve(json(401, { code: "authentication" }))
  expect(await read(signedOut.origin)).toMatchObject({ _tag: "Failure", failure: { reason: "authentication" } })
  const guest = await serve(json(403, { code: "forbidden" }))
  expect(await read(guest.origin)).toMatchObject({ _tag: "Failure", failure: { reason: "forbidden" } })
  const upstreamDown = await serve(json(503, { code: "unavailable" }))
  expect(await read(upstreamDown.origin)).toMatchObject({ _tag: "Failure", failure: { reason: "unavailable" } })
  const malformed = await serve(json(200, { state: "working" }))
  expect(await read(malformed.origin)).toMatchObject({ _tag: "Failure", failure: { reason: "unavailable" } })
})

test("a status response that never completes cannot be treated as missing or queued", async () => {
  const stalled = await serve((_, response) => {
    response.writeHead(200, { "content-type": "application/json" })
    response.write('{"kind":"found",')
  })
  expect(await read(stalled.origin)).toMatchObject({ _tag: "Failure", failure: { reason: "unavailable" } })
})

test("an unreadable refusal body and an unavailable network never prove a TODO is missing", async () => {
  const gateway = await serve((_, response) => {
    response.writeHead(502, { "content-type": "text/html" })
    response.end("<html>bad gateway</html>")
  })
  expect(await read(gateway.origin)).toMatchObject({ _tag: "Failure", failure: { reason: "unavailable" } })
  await servers.splice(0)[0]!()
  expect(await read(gateway.origin)).toMatchObject({ _tag: "Failure", failure: { reason: "unavailable" } })
})

test("the status read's log, counter and agent span pass the browser telemetry relay", () => {
  for (const name of ["todos.inspect", "smithers_todo_status_reads_client", "execute_tool todo/inspect"]) {
    expect(BROWSER_TELEMETRY.records).toContain(name)
  }
  expect(EXPORTED_SPANS).toContain("todos.inspect")
  expect(EXPORTED_SPANS).toContain("execute_tool todo/inspect")
  expect(BROWSER_TELEMETRY.fields).toEqual(expect.arrayContaining(["outcome", "durationMs", "feature"]))
})

test("status steps record the actual read outcome in their log, span and counter", async () => {
  const registry: Metric.MetricRegistry = new Map()
  const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = []
  const spans: Array<Tracer.NativeSpan> = []
  const tracer = Tracer.make({ span(options) {
    const span = new Tracer.NativeSpan(options)
    spans.push(span)
    return span
  } })
  for (const [status, code, outcome] of [[404, "todo_not_found", "not_found"], [403, "forbidden", "forbidden"]] as const) {
    const served = await serve(json(status, { code }))
    const result = await Effect.runPromise(Effect.result(inspectStatus(served.origin, { repo: "octo/hello", number: 3 })).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(Metric.MetricRegistry, registry),
      Effect.provideService(Tracer.Tracer, tracer),
      Effect.provideService(Logger.CurrentLoggers, new Set([Logger.make((o) => void logs.push(Logger.formatStructured.log(o)))])),
    ))
    expect(result).toMatchObject(status === 404
      ? { _tag: "Success", success: { kind: "not_found", number: 3 } }
      : { _tag: "Failure", failure: { reason: "forbidden" } })
    expect(Effect.runSync(Metric.value(Metric.withAttributes(statusReads, { outcome })).pipe(
      Effect.provideService(Metric.MetricRegistry, registry),
    ))).toMatchObject({ count: 1 })
    expect(served.asked).toEqual([{ method: "GET", url: "/api/repos/octo/hello/stack/3", body: "" }])
    expect(logs.at(-1)).toMatchObject({ message: "todos.inspect", annotations: {
      outcome, feature: "todos", durationMs: expect.any(Number),
    } })
    expect(spans.filter((span) => span.name === "todos.inspect").at(-1)?.attributes.get("outcome")).toBe(outcome)
  }
})
