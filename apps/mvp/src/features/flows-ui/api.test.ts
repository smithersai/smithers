// `FlowsClient` against every kind of answer ChatApi's flows and drafts routes give (worker/PersonalFlows.ts), through
// the host's `fetch`: the browser's own capability, given here as a function answering the request it is handed. The
// routes themselves are proved in worker/PersonalFlows.test.ts; here, what a step makes of each answer.
import { Cause, Effect, Exit, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { describe, expect, test } from "vitest"
import { FlowsClient } from "./api.vibe"

/** The client over a `fetch` that answers with `respond`, recording each request it was handed. */
const client = (respond: (request: Request) => Promise<Response>, within?: `${number} millis`) => {
  const seen: Array<{ readonly method: string; readonly url: string; readonly body: string }> = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    seen.push({ method: request.method, url: request.url, body: await request.clone().text() })
    return respond(request)
  }
  const layer = FlowsClient.layer({ origin: "http://chat.test", ...(within === undefined ? {} : { within }) }).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
  )
  const run = <A, E>(effect: (client: FlowsClient["Service"]) => Effect.Effect<A, E>) =>
    Effect.runPromise(Effect.exit(Effect.flatMap(FlowsClient, effect).pipe(Effect.provide(layer))))
  return { run, seen }
}

/** What a failed call failed with, as plain fields. */
const failureOf = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? { ...(Cause.squash(exit.cause) as object) } : "succeeded"

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }))

const draft = {
  id: "d",
  scope: "person",
  repoId: null,
  target: "flow",
  name: "hello",
  request: "Say hello",
  status: "ready",
  round: 0,
  summary: null,
  files: [],
  checks: [],
  questions: [],
  failure: null,
  flowId: null,
  createdAt: "2026-10-20T00:00:00.000Z",
  updatedAt: "2026-10-20T00:00:00.000Z",
}

describe("FlowsClient", () => {
  test("reads and writes each route, and decodes its answer", async () => {
    const source = { flowId: "f", name: "hello", revision: 2, digest: "a".repeat(64), source: "---" }
    const answers = new Map<string, unknown>([
      ["GET http://chat.test/api/flows", { flows: [] }],
      ["GET http://chat.test/api/flows/source?name=hello&revision=2", source],
      ["GET http://chat.test/api/flows/source?name=hello", source],
      ["GET http://chat.test/api/flows/source?name=hello&revision=1&flowId=f", source],
      ["GET http://chat.test/api/flow-drafts/d", draft],
      ["POST http://chat.test/api/flow-drafts/d", { txid: 3 }],
      ["POST http://chat.test/api/flow-drafts/d/answers", { txid: null }],
      ["POST http://chat.test/api/flows/save", { flowId: "f", name: "hello", revision: 1, txid: 4 }],
      ["POST http://chat.test/api/flows/write", { flowId: "f", name: "hello", revision: 2, txid: 6 }],
      ["POST http://chat.test/api/flows/f/delete", { txid: 5 }],
      ["POST http://chat.test/api/flow-drafts/d/delete", { txid: 7 }],
    ])
    const { run, seen } = client((request) => json(answers.get(`${request.method} ${request.url}`)))
    expect(await run((c) => c.list)).toEqual(Exit.succeed({ flows: [] }))
    expect(await run((c) => c.source("hello", 2))).toEqual(Exit.succeed(source))
    expect(await run((c) => c.source("hello"))).toEqual(Exit.succeed(source))
    expect(await run((c) => c.source("hello", 1, "f"))).toEqual(Exit.succeed(source))
    expect(await run((c) => c.draft("d"))).toEqual(Exit.succeed(draft))
    expect(await run((c) => c.writeDraft("d", { ...draft, scope: "person", status: "ready", flowId: null } as never)))
      .toEqual(Exit.void)
    expect(await run((c) => c.answer("d", { round: 0, answers: [{ id: "q", value: "a" }] }))).toEqual(Exit.void)
    expect(await run((c) => c.save({ draftId: "d", name: "hello", description: "x", source: "---", digest: "a".repeat(64) })))
      .toEqual(Exit.succeed({ flowId: "f", name: "hello", revision: 1, txid: 4 }))
    const write = { name: "hello", revision: 1, description: "x", source: "export default 1", digest: "a".repeat(64) }
    expect(await run((c) => c.write(write))).toEqual(Exit.succeed({ flowId: "f", name: "hello", revision: 2, txid: 6 }))
    expect(JSON.parse(seen.at(-1)!.body)).toEqual(write)
    expect(await run((c) => c.remove("f"))).toEqual(Exit.succeed(true))
    expect(await run((c) => c.deleteDraft("d"))).toEqual(Exit.succeed(true))
    expect(seen.map((request) => request.method))
      .toEqual(["GET", "GET", "GET", "GET", "GET", "POST", "POST", "POST", "POST", "POST", "POST"])
  })

  test("a 404 is a missing flow for a source or a write and nothing to delete; elsewhere a refusal", async () => {
    const { run } = client(() => json({ code: "not_found" }, 404))
    expect(failureOf(await run((c) => c.source("hello")))).toEqual({ _tag: "@smthrs/mvp/flows/FlowNotFound" })
    expect(failureOf(await run((c) =>
      c.write({ name: "hello", revision: 1, description: "x", source: "s", digest: "a".repeat(64) })
    ))).toEqual({ _tag: "@smthrs/mvp/flows/FlowNotFound" })
    expect(await run((c) => c.remove("f"))).toEqual(Exit.succeed(false))
    expect(await run((c) => c.deleteDraft("d"))).toEqual(Exit.succeed(false))
    expect(failureOf(await run((c) => c.draft("d")))).toEqual({
      _tag: "@smthrs/mvp/flows/FlowsRefused",
      status: 404,
      code: "not_found",
    })
  })

  test("a refusal carries the route's code, or `refused` without one", async () => {
    expect(failureOf(await client(() => json({ code: "stale_round" }, 409)).run((c) => c.answer("d", { round: 0, answers: [] }))))
      .toEqual({ _tag: "@smthrs/mvp/flows/FlowsRefused", status: 409, code: "stale_round" })
    expect(failureOf(await client(() => Promise.resolve(new Response("nope", { status: 400 }))).run((c) => c.list)))
      .toEqual({ _tag: "@smthrs/mvp/flows/FlowsRefused", status: 400, code: "refused" })
  })

  test("no network, a 5xx, a body that isn't the route's, and no answer in time are unavailable: tried again", async () => {
    expect(failureOf(await client(() => Promise.reject(new TypeError("offline"))).run((c) => c.list)))
      .toEqual({ _tag: "@smthrs/mvp/flows/FlowsUnavailable" })
    expect(failureOf(await client(() => json({ code: "unavailable" }, 503)).run((c) => c.list)))
      .toEqual({ _tag: "@smthrs/mvp/flows/FlowsUnavailable", status: 503 })
    expect(failureOf(await client(() => json({ nope: true })).run((c) => c.list)))
      .toEqual({ _tag: "@smthrs/mvp/flows/FlowsUnavailable", status: 200 })
    expect(failureOf(await client(() => new Promise(() => {}), "50 millis").run((c) => c.list)))
      .toEqual({ _tag: "@smthrs/mvp/flows/FlowsUnavailable" })
  })
})
