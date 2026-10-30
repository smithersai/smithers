import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { Effect, Metric } from "effect"
import { FetchHttpClient } from "effect/http"
import { afterEach, expect, test } from "vitest"
import { PullsClient, PullsRequestFailed } from "./api"
import { failureOf, requestReview, reviews } from "./steps"

// Review on request from the device's side (docs/features/pulls.md#review-on-request): `pull/review/request` through the
// real `PullsClient`, against a local HTTP server that plays ChatApi, so what the step makes of each answer is what a
// browser would meet. ChatApi's own answers are tested through its real handler (worker/github/Review.test.ts).

const HEAD = "a".repeat(40)

const servers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of servers.splice(0)) await close()
})

/** A server that answers every request `status` with `body`, keeping what each asked for. */
const serve = async (status: number, body: unknown) => {
  const asked: Array<{ readonly method: string; readonly url: string; readonly body: string }> = []
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let text = ""
    request.on("data", (chunk) => (text += chunk))
    request.on("end", () => {
      asked.push({ method: request.method!, url: request.url!, body: text })
      response.writeHead(status, { "content-type": "application/json" })
      response.end(typeof body === "string" ? body : JSON.stringify(body))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
  servers.push(close)
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, asked, close }
}

/** The step once against `origin`, with the count it made by outcome. */
const ask = (origin: string, headSha?: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const count = (outcome: string) =>
        Metric.value(Metric.withAttributes(reviews, { outcome })).pipe(Effect.map((state) => state.count))
      const counts = Effect.all({ sent: count("sent"), refused: count("refused"), unsent: count("unsent") })
      const before = yield* counts
      const result = yield* Effect.result(
        requestReview({ repo: "octo/hello", number: 7, ...(headSha === undefined ? {} : { headSha }) }),
      )
      const after = yield* counts
      return {
        result,
        sent: after.sent - before.sent,
        refused: after.refused - before.refused,
        unsent: after.unsent - before.unsent,
      }
    }).pipe(
      Effect.provide(PullsClient.layer({ origin, within: "2 seconds" })),
      Effect.provide(FetchHttpClient.layer),
    ),
  )

test("asks ChatApi to review the head the page showed, or the current head from /review", async () => {
  const taken = await serve(202, { sha: HEAD, started: true })
  const pressed = await ask(taken.origin, HEAD)
  expect(pressed.result._tag === "Success" ? pressed.result.success : pressed.result).toEqual({ sha: HEAD, started: true })
  expect(pressed.sent).toBe(1)
  await ask(taken.origin)
  expect(taken.asked).toEqual([
    { method: "POST", url: "/api/repos/octo/hello/pulls/7/review", body: JSON.stringify({ headSha: HEAD }) },
    { method: "POST", url: "/api/repos/octo/hello/pulls/7/review", body: "{}" },
  ])
})

test("a refusal is final, with ChatApi's code when it is one; 503 not_configured too", async () => {
  for (
    const [status, body, code] of [
      [403, { code: "forbidden" }, "forbidden"],
      [409, { code: "head_moved" }, "head_moved"],
      [404, { code: "something_new" }, undefined],
      [400, "not json", undefined],
      [503, { code: "not_configured" }, "not_configured"],
    ] as const
  ) {
    const { origin } = await serve(status, body)
    const answer = await ask(origin)
    expect(answer.result._tag).toBe("Failure")
    const failure = answer.result._tag === "Failure" ? answer.result.failure : undefined
    expect(failure).toMatchObject({ _tag: "@smthrs/mvp/pulls/ReviewRefused", status })
    expect(failure && "code" in failure ? failure.code : undefined).toBe(code)
    expect([answer.refused, answer.unsent]).toEqual([1, 0])
  }
})

test("ChatApi down, unreachable, or answering what isn't the contract: tried again", async () => {
  const down = await serve(503, { code: "unavailable" })
  expect((await ask(down.origin)).result).toMatchObject({ failure: { _tag: "@smthrs/mvp/pulls/ReviewUnsent" } })
  const wrong = await serve(202, { sha: 1 })
  expect((await ask(wrong.origin)).result).toMatchObject({ failure: { _tag: "@smthrs/mvp/pulls/ReviewUnsent" } })
  const gone = await serve(202, {})
  await gone.close()
  const unreachable = await ask(gone.origin)
  expect(unreachable.result).toMatchObject({ failure: { _tag: "@smthrs/mvp/pulls/ReviewUnsent" } })
  expect([unreachable.sent, unreachable.unsent]).toEqual([0, 1])
})

test("what a failed request means: a 4xx but a rate limit, or no App, is final; anything else is tried again", () => {
  expect(failureOf(new PullsRequestFailed({ status: 401, code: "authentication" }))).toMatchObject({ code: "authentication" })
  expect(failureOf(new PullsRequestFailed({ status: 502 }))._tag).toBe("@smthrs/mvp/pulls/ReviewUnsent")
  expect(failureOf(new PullsRequestFailed({ status: 429, code: "rate_limited" }))._tag).toBe("@smthrs/mvp/pulls/ReviewUnsent")
  expect(failureOf(new PullsRequestFailed({}))._tag).toBe("@smthrs/mvp/pulls/ReviewUnsent")
})
