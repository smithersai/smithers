import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { Effect } from "effect"
import { FetchHttpClient } from "effect/http"
import { afterEach, describe, expect, test } from "vitest"
import { RemoteRunsClient } from "./api"
import type { Inspection } from "./schema"

// The real remote runs client from the browser's side, against a local HTTP server that plays a gateway: real sockets,
// so a stalled body, a body cut short and nothing listening are what a browser would meet. Every answer ChatApi itself
// gives is tested through its real handler in remote.test.ts and worker/RemoteRuns.test.ts.

const RUN = "todo:6f1c2a7e-3b4d-4c5e-8f90-1a2b3c4d5e6f"

const value = (text: string) => ({ text, bytes: text.length, clipped: false })

const READ: Inspection = {
  run: {
    runId: RUN,
    flowName: "todo",
    status: "running",
    createdAtMs: 1,
    startedAtMs: 2,
    finishedAtMs: null,
    parentRunId: null,
    cancelRequestedAtMs: null,
    waiting: null,
    lastSeq: 0,
    origin: null,
    input: value("{}"),
    result: null,
  },
  steps: [],
  children: [],
  journal: {
    events: [{ seq: 0, eventType: "flows.engine.plan-recorded", emittedAtMs: 3, payload: value("{}") }],
    afterSeq: -1,
    nextSeq: 0,
    hasMore: false,
  },
}

const servers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of servers.splice(0)) await close()
})

/** A server that answers every request with `respond`, keeping what each asked for. */
const serve = async (respond: (request: IncomingMessage, response: ServerResponse) => void) => {
  const asked: Array<string> = []
  const server = createServer((request, response) => {
    asked.push(`${request.method} ${request.url}`)
    respond(request, response)
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

const read = (origin: string, options?: { readonly afterSeq?: number; readonly limit?: number }) =>
  Effect.runPromise(
    Effect.result(Effect.flatMap(RemoteRunsClient, (client) => client.inspect(RUN, options))).pipe(
      Effect.provide(RemoteRunsClient.layer({ origin, within: "300 millis" })),
      Effect.provide(FetchHttpClient.layer),
    ),
  )

const json = (status: number, body: unknown) => (_: IncomingMessage, response: ServerResponse) => {
  response.writeHead(status, { "content-type": "application/json" })
  response.end(JSON.stringify(body))
}

test("reads the run from its route, a page at a time, and decodes it as the engine's own read", async () => {
  const server = await serve(json(200, READ))
  const answered = await read(server.origin)
  expect(answered._tag === "Success" && answered.success).toEqual(READ)
  await read(server.origin, { afterSeq: 4, limit: 2 })
  await read(server.origin, { limit: 500 })
  expect(server.asked).toEqual([
    `GET /api/remote-runs/${encodeURIComponent(RUN)}`,
    `GET /api/remote-runs/${encodeURIComponent(RUN)}?afterSeq=4&limit=2`,
    `GET /api/remote-runs/${encodeURIComponent(RUN)}?limit=500`,
  ])
})

test("a refusal fails with its status and the code its body names", async () => {
  const named = await serve(json(404, { code: "not_started" }))
  expect(await read(named.origin)).toMatchObject({ _tag: "Failure", failure: { status: 404, code: "not_started" } })
  const bare = await serve((_, response) => {
    response.writeHead(502, { "content-type": "text/html" })
    response.end("<html>bad gateway</html>")
  })
  const result = await read(bare.origin)
  expect(result).toMatchObject({ _tag: "Failure", failure: { status: 502 } })
  expect(result._tag === "Failure" && result.failure.code).toBe(undefined)
})

test("a 200 whose body isn't a run fails with its status", async () => {
  const { origin } = await serve(json(200, { run: { runId: RUN } }))
  const result = await read(origin)
  expect(result).toMatchObject({ _tag: "Failure", failure: { status: 200 } })
  expect(result._tag === "Failure" && result.failure.code).toBe(undefined)
})

test("a body that stalls fails at the deadline with no status, as the network does", async () => {
  const { origin } = await serve((_, response) => {
    response.writeHead(200, { "content-type": "application/json" })
    response.write('{"run":')
  })
  const result = await read(origin)
  expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "RemoteReadFailed" } })
  expect(result._tag === "Failure" && result.failure.status).toBe(undefined)
})

test("nothing listening fails at once with no status", async () => {
  const { origin } = await serve(() => {})
  await servers.splice(0)[0]!()
  const result = await read(origin)
  expect(result._tag === "Failure" && result.failure.status).toBe(undefined)
})

/** A run credential as the engine mints one: its claims, base64url, then a signature this client never reads. */
const credentialFor = (run: string, flow: string) =>
  `${Buffer.from(JSON.stringify({ run, chain: [flow] })).toString("base64url")}.signature`

const steer = (origin: string, credential?: string) =>
  Effect.runPromise(
    Effect.result(Effect.flatMap(RemoteRunsClient, (client) =>
      client.steer(RUN, { id: "8a7f0c2e-5d1b-4c4a-9a43-0f2a1f7e9b10", body: "Use tabs" }, credential))).pipe(
        Effect.provide(RemoteRunsClient.layer({ origin, within: "300 millis" })),
        Effect.provide(FetchHttpClient.layer),
      ),
  )

test("a steer goes to its run's route: taken, or had already", async () => {
  const taken = await serve(json(202, { id: "x", seq: 4 }))
  expect(await steer(taken.origin)).toMatchObject({ _tag: "Success", success: { existing: false } })
  expect(taken.asked).toEqual([`POST /api/remote-runs/${encodeURIComponent(RUN)}/steers`])
  const had = await serve(json(200, { id: "x", seq: 4 }))
  expect(await steer(had.origin)).toMatchObject({ _tag: "Success", success: { existing: true } })
})

test("a refused steer fails with its status and the code its body names", async () => {
  const named = await serve(json(409, { code: "not_working" }))
  expect(await steer(named.origin)).toMatchObject({ _tag: "Failure", failure: { status: 409, code: "not_working" } })
  const bare = await serve((_, response) => {
    response.writeHead(503)
    response.end()
  })
  const result = await steer(bare.origin)
  expect(result).toMatchObject({ _tag: "Failure", failure: { status: 503 } })
  expect(result._tag === "Failure" && result.failure.code).toBe(undefined)
})

test("an agent's steer goes as its run: a fresh credential of that run, then the steer with it", async () => {
  const headers: Array<string | undefined> = []
  const server = await serve((request, response) => {
    headers.push(request.headers.authorization)
    if (request.url?.endsWith("/credential")) return json(200, { token: "fresh-token" })(request, response)
    return json(202, { id: "x", seq: 1 })(request, response)
  })
  const credential = credentialFor("answer-1/chat/Respond", "run/steer")
  expect(await steer(server.origin, credential)).toMatchObject({ _tag: "Success" })
  expect(server.asked).toEqual([
    `POST /api/runs/${encodeURIComponent("answer-1/chat/Respond")}/credential`,
    `POST /api/remote-runs/${encodeURIComponent(RUN)}/steers`,
  ])
  expect(headers).toEqual([undefined, "Bearer fresh-token"])
})

test("an agent's steer whose credential can't be renewed is not sent: the renewal's status, or none", async () => {
  const refused = await serve(json(401, { code: "revoked" }))
  expect(await steer(refused.origin, credentialFor("answer-1", "run/steer"))).toMatchObject({ _tag: "Failure", failure: { status: 401 } })
  expect(refused.asked).toHaveLength(1)
  // Not a credential at all, its claims unreadable or not base64url: nothing is asked.
  const none = await serve(json(202, {}))
  expect(await steer(none.origin, "not-a-credential")).toMatchObject({ _tag: "Failure", failure: { status: 403 } })
  expect(await steer(none.origin, "!!!.signature")).toMatchObject({ _tag: "Failure", failure: { status: 403 } })
  expect(none.asked).toEqual([])
  // A renewal whose answer isn't a token, and one with nothing listening, fail with no status.
  const garbled = await serve(json(200, { nope: true }))
  const result = await steer(garbled.origin, credentialFor("answer-1", "run/steer"))
  expect(result._tag === "Failure" && result.failure.status).toBe(undefined)
  const gone = await serve(() => {})
  await servers.pop()!()
  const nothing = await steer(gone.origin, credentialFor("answer-1", "run/steer"))
  expect(nothing._tag === "Failure" && nothing.failure.status).toBe(undefined)
})

test("a steer with nothing listening, or no answer in time, fails with no status", async () => {
  const stalled = await serve(() => {})
  const late = await steer(stalled.origin)
  expect(late._tag === "Failure" && late.failure.status).toBe(undefined)
  const gone = await serve(() => {})
  await servers.pop()!()
  const nothing = await steer(gone.origin)
  expect(nothing._tag === "Failure" && nothing.failure.status).toBe(undefined)
})

const stop = (origin: string) =>
  Effect.runPromise(
    Effect.result(Effect.flatMap(RemoteRunsClient, (client) => client.stop(RUN))).pipe(
      Effect.provide(RemoteRunsClient.layer({ origin, within: "300 millis" })),
      Effect.provide(FetchHttpClient.layer),
    ),
  )

test("a stop goes to its run's route: requested, or the run had ended", async () => {
  const requested = await serve(json(202, { outcome: "requested" }))
  expect(await stop(requested.origin)).toMatchObject({ _tag: "Success", success: { outcome: "requested" } })
  expect(requested.asked).toEqual([`POST /api/remote-runs/${encodeURIComponent(RUN)}/stop`])
  const ended = await serve(json(200, { outcome: "settled" }))
  expect(await stop(ended.origin)).toMatchObject({ _tag: "Success", success: { outcome: "settled" } })
})

test("a refused stop fails with its status and the code its body names; an answer that isn't one, with its status", async () => {
  const named = await serve(json(404, { code: "not_found" }))
  expect(await stop(named.origin)).toMatchObject({ _tag: "Failure", failure: { status: 404, code: "not_found" } })
  const bare = await serve((_, response) => {
    response.writeHead(503)
    response.end()
  })
  const refused = await stop(bare.origin)
  expect(refused).toMatchObject({ _tag: "Failure", failure: { status: 503 } })
  expect(refused._tag === "Failure" && refused.failure.code).toBe(undefined)
  const odd = await serve(json(202, { outcome: "maybe" }))
  expect(await stop(odd.origin)).toMatchObject({ _tag: "Failure", failure: { status: 202 } })
})

test("a stop with nothing listening, or no answer in time, fails with no status", async () => {
  const silent = await serve(() => undefined)
  const late = await stop(silent.origin)
  expect(late._tag === "Failure" && late.failure.status).toBe(undefined)
  const closed = await serve(() => undefined)
  await servers.splice(0).reduce((done, close) => done.then(close), Promise.resolve())
  const nothing = await stop(closed.origin)
  expect(nothing._tag === "Failure" && nothing.failure.status).toBe(undefined)
})

const cloudRuns = (origin: string) =>
  Effect.runPromise(
    Effect.result(Effect.flatMap(RemoteRunsClient, (client) => client.list)).pipe(
      Effect.provide(RemoteRunsClient.layer({ origin, within: "300 millis" })),
      Effect.provide(FetchHttpClient.layer),
    ),
  )

describe("the runs on Cloudflare", () => {
  const listed = {
    runId: RUN, flow: "todo", kind: "todo", status: "running", cancelRequested: false, createdAtMs: 1, startedAtMs: 2,
    finishedAtMs: null, trigger: "commit", branch: "todo/fix", actor: "maya", repo: "octo/hello",
  }

  test("lists them from their route, at most the list's bound, decoded", async () => {
    const server = await serve(json(200, { runs: [listed] }))
    const answered = await cloudRuns(server.origin)
    expect(answered._tag === "Success" && answered.success).toEqual([listed])
    expect(server.asked).toEqual(["GET /api/cloud-runs?limit=50"])
  })

  test("a refusal fails with its status and code; a body that isn't a list, with its status; a stall, with none", async () => {
    const refused = await serve(json(401, { code: "authentication" }))
    expect(await cloudRuns(refused.origin)).toMatchObject({ _tag: "Failure", failure: { status: 401, code: "authentication" } })
    const bare = await serve((_, response) => {
      response.writeHead(503, { "content-type": "text/plain" })
      response.end("down")
    })
    const down = await cloudRuns(bare.origin)
    expect(down).toMatchObject({ _tag: "Failure", failure: { status: 503 } })
    expect(down._tag === "Failure" && down.failure.code).toBe(undefined)
    const wrong = await serve(json(200, { runs: [{ runId: RUN }] }))
    expect(await cloudRuns(wrong.origin)).toMatchObject({ _tag: "Failure", failure: { status: 200 } })
    const stalled = await serve((_, response) => {
      response.writeHead(200, { "content-type": "application/json" })
      response.write('{"runs":')
    })
    const late = await cloudRuns(stalled.origin)
    expect(late._tag === "Failure" && late.failure.status).toBe(undefined)
    const gone = await serve(() => {})
    await servers.splice(-1)[0]!()
    const nobody = await cloudRuns(gone.origin)
    expect(nobody._tag === "Failure" && nobody.failure.status).toBe(undefined)
  })
})
