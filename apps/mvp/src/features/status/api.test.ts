// `RunsClient` against every answer ChatApi's runs routes give (worker/Runs.ts), through the host's `fetch`: the
// browser's own capability, given here as a function answering the request it is handed.
import { Cause, Effect, Exit, Layer, Logger } from "effect"
import { FetchHttpClient } from "effect/http"
import { describe, expect, test } from "vitest"
import { RunsClient, type RunsRefused } from "./api"

/** The client over a `fetch` that answers with `respond`, recording each request it was handed. */
const client = (respond: (request: Request) => Promise<Response>, within?: `${number} millis`) => {
  const seen: Array<{ readonly url: string; readonly body: string }> = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    seen.push({ url: request.url, body: await request.clone().text() })
    return respond(request)
  }
  const layer = RunsClient.layer({ origin: "http://chat.test", ...(within === undefined ? {} : { within }) }).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
  )
  const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = []
  const logger = Logger.make((options) => void logs.push(Logger.formatStructured.log(options)))
  const run = <A, E>(effect: (client: RunsClient["Service"]) => Effect.Effect<A, E>) =>
    Effect.runPromise(Effect.exit(Effect.flatMap(RunsClient, effect).pipe(Effect.provide(layer), Effect.provideService(Logger.CurrentLoggers, new Set([logger])))))
  return { run, seen, logs }
}

/** What a failed call failed with, as plain fields. */
const refusalOf = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? { ...(Cause.squash(exit.cause) as RunsRefused) } : "succeeded"

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }))

describe("RunsClient", () => {
  test("reports to /api/runs/<id> and answers to /api/runs/<id>/answer, taking a 200 with or without a transaction", async () => {
    const { run, seen } = client(() => json({ txid: 7 }))
    expect(await run((c) => c.report("run-1", { status: "working" }))).toEqual(Exit.void)
    const again = client(() => json({ txid: null }))
    expect(await again.run((c) => c.answer("run-1", { version: 2, value: "main" }))).toEqual(Exit.void)
    expect(seen).toEqual([{ url: "http://chat.test/api/runs/run-1", body: `{"status":"working"}` }])
    expect(again.seen).toEqual([{ url: "http://chat.test/api/runs/run-1/answer", body: `{"version":2,"value":"main"}` }])
  })

  test("a refusal carries its status and the route's code, or its status alone without one", async () => {
    expect(refusalOf(await client(() => json({ code: "not_open" }, 409)).run((c) => c.answer("r", { version: 1, value: true }))))
      .toEqual({ _tag: "RunsRefused", status: 409, code: "not_open" })
    expect(refusalOf(await client(() => Promise.resolve(new Response("", { status: 503 }))).run((c) => c.report("r", { status: "done" }))))
      .toEqual({ _tag: "RunsRefused", status: 503 })
  })

  test("an unreachable transport preserves its reason without a status or payload", async () => {
    expect(refusalOf(await client(() => Promise.reject(new TypeError("private transport message"))).run((c) => c.report("r", { status: "done" }))))
      .toEqual({ _tag: "RunsRefused", reason: "unreachable" })
  })

  test("a deadline preserves timeout without a status or payload", async () => {
    expect(refusalOf(await client(() => new Promise<Response>(() => {}), "50 millis").run((c) => c.report("r", { status: "done" }))))
      .toEqual({ _tag: "RunsRefused", reason: "timeout" })
  })

  test("a 200 whose receipt stalls still took the write, within the same deadline", async () => {
    const c = client(() => Promise.resolve(new Response(new ReadableStream())), "50 millis")
    expect(await c.run((c) => c.report("r", { status: "done" }))).toEqual(Exit.void)
    expect(c.logs).toContainEqual(expect.objectContaining({
      level: "WARN",
      message: "agent.status.malformed",
      annotations: expect.objectContaining({ feature: "status", status: 200, outcome: "malformed", errorCode: "timeout_after_200" }),
    }))
  })

  test.each(["invalid JSON", { nope: "private body" }])("a malformed 200 is written and warns without its body: %s", async (body) => {
    const c = client(() => typeof body === "string" ? Promise.resolve(new Response(body)) : json(body))
    expect(await c.run((c) => c.report("r", { status: "done" }))).toEqual(Exit.void)
    expect(c.logs).toContainEqual(expect.objectContaining({
      level: "WARN",
      message: "agent.status.malformed",
      annotations: expect.objectContaining({ feature: "status", status: 200, outcome: "malformed", errorCode: "decode" }),
    }))
    expect(JSON.stringify(c.logs)).not.toContain("private body")
  })

})
