// ChatApi's access route as the data gate asks it (access.ts), over an injected `fetch`, for the answers the route
// never gives a valid request: no network, a stalled answer, a body that is not its own, and each status
// (test.faults-by-injection). The route itself is worker/branch/ConversationApi.test.ts; the gate on a device,
// owners.test.ts.
import { Effect, Layer, Logger } from "effect"
import { FetchHttpClient } from "effect/http"
import { expect, test } from "vitest"
import { ConversationAccess } from "./access"

const ID = "6a3c2d0e-8a8b-5c1f-9e0a-1d2b3c4d5e6f"

/** What the client says of conversation `ID` over `fetch`, giving up after 50 ms, and what it logged. */
const check = async (fetch: typeof globalThis.fetch) => {
  const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = []
  const logger = Logger.make((options) => void logs.push(Logger.formatStructured.log(options)))
  const answer = await Effect.runPromise(
    Effect.flatMap(ConversationAccess, (access) => access.check(ID)).pipe(
      Effect.provide(ConversationAccess.layer({ origin: "http://chat.test", within: "50 millis" }).pipe(
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
      )),
      Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
    ),
  )
  return { answer, logged: logs.filter((line) => line.message === "conversation.access.unanswered").map((line) => line.annotations.reason) }
}

test("only ChatApi's own word opens or refuses: its 200 decisions and its 401, 403 and 404 with the code it gives each", async () => {
  const asked: Array<{ readonly url: string; readonly method: string }> = []
  const allowed = await check(async (input, init) => {
    const request = new Request(input, init)
    asked.push({ url: request.url, method: request.method })
    return Response.json({ allowed: true })
  })
  expect(allowed).toEqual({ answer: "allowed", logged: [] })
  expect(asked).toEqual([{ url: `http://chat.test/api/conversations/${ID}/access`, method: "GET" }])
  for (const code of ["forbidden", "not_found"]) {
    expect(await check(async () => Response.json({ allowed: false, code })), code).toEqual({ answer: "refused", logged: [] })
  }
  expect(await check(async () => Response.json({ allowed: false })), "bare").toEqual({ answer: "refused", logged: [] })
  for (const [status, code] of [[401, "sign_in"], [403, "forbidden"], [404, "not_found"]] as const) {
    expect(await check(async () => Response.json({ code }, { status })), code).toEqual({ answer: "refused", logged: [] })
  }
})

test("anything else is no answer, and is said: a deployment with no such route, a 200 that is not ChatApi's, a failing server, no network, a stalled answer", async () => {
  // A status with another status's code, or a refusal's status with no code of ChatApi's: not its word.
  for (const response of [
    () => Response.json({ code: "not_found" }, { status: 403 }),
    () => Response.json({ code: "unknown_route" }, { status: 404 }),
    () => Response.json({ code: "unavailable" }, { status: 503 }),
    () => Response.json({ code: "rate_limited" }, { status: 429 }),
  ]) expect(await check(async () => response())).toEqual({ answer: "unanswered", logged: [] })
  // A body that is none of ChatApi's: a page served in the route's place, a 200 that does not say allowed.
  for (const response of [
    () => new Response("<html></html>", { status: 404 }),
    () => new Response("ok"),
    () => Response.json({ allowed: false, code: "sign_in" }),
    () => Response.json({ allowed: "true" }),
    () => Response.json({ allowed: true, code: "forbidden" }),
    () => Response.json({}, { status: 403 }),
  ]) expect((await check(async () => response())).answer).toBe("unanswered")
  expect((await check(async () => new Response("ok"))).logged).toHaveLength(1)
  // No network, and an answer that never comes within the deadline: its request is aborted.
  expect(await check(async () => { throw new TypeError("offline") })).toEqual({ answer: "unanswered", logged: [expect.any(String)] })
  let aborted = false
  const stalled = await check((_input, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener("abort", () => {
      aborted = true
      reject(new DOMException("aborted", "AbortError"))
    })
  }))
  expect(stalled).toEqual({ answer: "unanswered", logged: ["TimeoutError"] })
  expect(aborted).toBe(true)
})
