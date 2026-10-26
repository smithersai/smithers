import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http"
import { TestClock } from "effect/testing"
import { expect, test } from "vitest"
import { TIMELINE_SUMMARIES_ROUTE } from "./contract"
import { SummaryFailed } from "./flow"
import { SummaryLedger } from "./steps"

// The ledger's real HTTP client over an injected HTTP service: the server's answers as worker/TimelineSummaries.ts sends
// them, and the faults no server can be made to send on demand. The happy path against the real route is in
// src/features/timeline/integration.test.ts.
type Answer = { readonly status: number; readonly body?: unknown } | "transport" | "hang"
const ledgerOver = (answer: Answer) => {
  const seen: Array<{ readonly url: string; readonly body: unknown }> = []
  const client = HttpClient.make((request) => Effect.gen(function* () {
    seen.push({ url: request.url, body: request.body._tag === "Uint8Array" ? JSON.parse(new TextDecoder().decode(request.body.body)) : undefined })
    if (answer === "hang") return yield* Effect.never
    if (answer === "transport") return yield* Effect.fail(new HttpClientError.HttpClientError({ reason: new HttpClientError.TransportError({ request }) }))
    return HttpClientResponse.fromWeb(request, new Response(answer.body === undefined ? "not json" : JSON.stringify(answer.body), { status: answer.status }))
  }))
  return { seen, layer: SummaryLedger.layer("https://chat.test").pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client))) }
}
const claim = { messageId: "m", revision: "abcdef0123456789", reason: "long_answer" as const }
const run = <A>(answer: Answer, use: (ledger: SummaryLedger["Service"]) => Effect.Effect<A, SummaryFailed>) => {
  const { seen, layer } = ledgerOver(answer)
  return Effect.runPromise(Effect.exit(Effect.flatMap(Effect.service(SummaryLedger), use)).pipe(Effect.provide(layer))).then(exit => ({ exit, seen }))
}
const failed = (exit: Exit.Exit<unknown, SummaryFailed>) => Exit.isFailure(exit) ? (Cause.squash(exit.cause) as SummaryFailed).code : "succeeded"

test("claims and records through the route, and says whether this claim took the answer", async () => {
  const took = await run({ status: 200, body: { claimed: true } }, ledger => ledger.claim(claim))
  expect(took.exit).toEqual(Exit.succeed(true))
  expect(took.seen).toEqual([{ url: `https://chat.test${TIMELINE_SUMMARIES_ROUTE}`, body: { op: "claim", ...claim } }])
  expect((await run({ status: 200, body: { claimed: false } }, ledger => ledger.claim(claim))).exit).toEqual(Exit.succeed(false))
  const recorded = await run({ status: 200, body: { recorded: true } }, ledger => ledger.record({ messageId: "m", revision: claim.revision, summary: "Retry check completed" }))
  expect(recorded.exit).toEqual(Exit.succeed(undefined))
  expect(recorded.seen[0]!.body).toEqual({ op: "record", messageId: "m", revision: claim.revision, summary: "Retry check completed" })
})

test.each([
  [{ status: 429, body: { code: "capped" } }, "capped"],
  [{ status: 503, body: { code: "unavailable" } }, "unavailable"],
  [{ status: 408 }, "unavailable"],
  [{ status: 404, body: { code: "not_found" } }, "refused"],
  [{ status: 409, body: { code: "unfinished" } }, "refused"],
  [{ status: 200 }, "unavailable"],
  [{ status: 200, body: { claimed: "yes" } }, "unavailable"],
  ["transport", "unavailable"],
] as const)("a claim answered %j fails %s", async (answer, code) => {
  expect(failed((await run(answer, ledger => ledger.claim(claim))).exit)).toBe(code)
})

test("a claim the server never answers is unavailable after its deadline", async () => {
  const { layer } = ledgerOver("hang")
  const exit = await Effect.runPromise(Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(Effect.exit(Effect.flatMap(Effect.service(SummaryLedger), ledger => ledger.claim(claim))))
    yield* TestClock.adjust("15 seconds")
    return yield* Fiber.join(fiber)
  }).pipe(Effect.provide(Layer.merge(layer, TestClock.layer()))))
  expect(failed(exit)).toBe("unavailable")
})

test("a record the server refuses as unclaimed fails refused", async () => {
  const exit = (await run({ status: 409, body: { code: "unclaimed" } }, ledger => ledger.record({ messageId: "m", revision: claim.revision, summary: "x" }))).exit
  expect(failed(exit)).toBe("refused")
})
