// `FeedsClient` against every answer ChatApi's answer route gives (worker/feeds/Api.ts), through the host's `fetch`: the
// browser's own capability, given here as a function answering the request it is handed. The step that calls it
// (`feed/answer/request`) is driven over a client that answers as told, and the contract's helpers are checked here too.
import { Cause, Effect, Exit, Layer, Metric } from "effect"
import { FetchHttpClient } from "effect/http"
import { describe, expect, test } from "vitest"
import { AnswerNotTaken, FeedsClient } from "./api"
import {
  feedAnswersRoute,
  feedDocumentId,
  feedRepo,
  feedsRoute,
  isFeedName,
  isIndexName,
  parseFeedRepo,
  parseFeedRoute,
} from "./contract"
import { FeedAnswerRefused, FeedAnswerUnsent } from "./flows"
import type { Answered } from "./schema"
import { answers, failureOf, requestAnswer } from "./steps"

/** The client over a `fetch` that answers with `respond`, recording each request it was handed. */
const client = (respond: (request: Request) => Promise<Response>, within?: `${number} millis`) => {
  const seen: Array<{ readonly method: string; readonly url: string; readonly body: string }> = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    seen.push({ method: request.method, url: request.url, body: await request.clone().text() })
    return respond(request)
  }
  const layer = FeedsClient.layer({ origin: "http://chat.test", ...(within === undefined ? {} : { within }) }).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
  )
  const run = <A, E>(effect: (client: FeedsClient["Service"]) => Effect.Effect<A, E>) =>
    Effect.runPromise(Effect.exit(Effect.flatMap(FeedsClient, effect).pipe(Effect.provide(layer))))
  return { run, seen }
}

const refusalOf = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? { ...(Cause.squash(exit.cause) as AnswerNotTaken) } : "succeeded"

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }))

const ID = "7d1c2f4e-8a0b-4c3d-9e5f-0a1b2c3d4e5f"
const decision = { owner: "smithersai", name: "vibelang", id: ID, item: "decision-7", choice: "approve" } as const

describe("FeedsClient", () => {
  test("answers at POST <repo>/feeds/answers with the choice and the text, taking a 200", async () => {
    const { run, seen } = client(() => json({ id: ID, seq: 4 }))
    expect(await run((c) => c.answer(decision))).toEqual(Exit.succeed({ id: ID, seq: 4 }))
    expect(await run((c) => c.answer({ ...decision, choice: null, text: "later" }))).toEqual(Exit.succeed({ id: ID, seq: 4 }))
    expect(seen).toEqual([
      {
        method: "POST",
        url: "http://chat.test/api/repos/smithersai/vibelang/feeds/answers",
        body: JSON.stringify({ id: ID, item: "decision-7", choice: "approve", text: null }),
      },
      {
        method: "POST",
        url: "http://chat.test/api/repos/smithersai/vibelang/feeds/answers",
        body: JSON.stringify({ id: ID, item: "decision-7", choice: null, text: "later" }),
      },
    ])
  })

  test("a refusal carries its status and the route's code, or its status alone without one", async () => {
    expect(refusalOf(await client(() => json({ code: "forbidden" }, 403)).run((c) => c.answer(decision)))).toEqual({
      _tag: "AnswerNotTaken",
      status: 403,
      code: "forbidden",
    })
    expect(refusalOf(await client(() => Promise.resolve(new Response("", { status: 503 }))).run((c) => c.answer(decision))))
      .toEqual({ _tag: "AnswerNotTaken", status: 503 })
  })

  test("no network, a body that isn't the route's, and no answer within the deadline are refusals", async () => {
    expect(refusalOf(await client(() => Promise.reject(new TypeError("offline"))).run((c) => c.answer(decision))))
      .toEqual({ _tag: "AnswerNotTaken" })
    expect(refusalOf(await client(() => json({ seq: "x" })).run((c) => c.answer(decision)))).toEqual({
      _tag: "AnswerNotTaken",
      status: 200,
    })
    const never = client(() => new Promise<Response>(() => {}), "50 millis")
    expect(refusalOf(await never.run((c) => c.answer(decision)))).toEqual({ _tag: "AnswerNotTaken" })
  })
})

describe("failureOf", () => {
  test("a 4xx is final, with its code when it is one of the route's; anything else is tried again", () => {
    expect(failureOf(new AnswerNotTaken({ status: 409, code: "conflict" }))).toEqual(
      new FeedAnswerRefused({ status: 409, code: "conflict" }),
    )
    expect(failureOf(new AnswerNotTaken({ status: 400, code: "made_up" }))).toEqual(new FeedAnswerRefused({ status: 400 }))
    expect(failureOf(new AnswerNotTaken({ status: 503, code: "unavailable" }))).toEqual(new FeedAnswerUnsent())
    expect(failureOf(new AnswerNotTaken({ status: 399 }))).toEqual(new FeedAnswerUnsent())
    expect(failureOf(new AnswerNotTaken({}))).toEqual(new FeedAnswerUnsent())
  })
})

describe("feed/answer/request", () => {
  /** The step over a client answering `answer`, with its counts by outcome. */
  const step = (answer: Effect.Effect<Answered, AnswerNotTaken>) => {
    const registry: Metric.MetricRegistry = new Map()
    return Effect.runPromise(
      Effect.exit(requestAnswer(decision)).pipe(
        Effect.provide(Layer.succeed(FeedsClient, FeedsClient.of({ answer: () => answer }))),
        Effect.provideService(Metric.MetricRegistry, registry),
        Effect.flatMap((exit) =>
          Effect.map(
            Effect.all(
              ["sent", "refused", "unsent"].map((outcome) =>
                Effect.map(
                  Metric.value(Metric.withAttributes(answers, { outcome })),
                  (state) => [outcome, state.count] as const,
                )
              ),
            ),
            (counts) => ({ exit, counts: Object.fromEntries(counts) }),
          ).pipe(Effect.provideService(Metric.MetricRegistry, registry))
        ),
      ),
    )
  }

  test("an answer ChatApi recorded succeeds with its place and counts as sent", async () => {
    const { exit, counts } = await step(Effect.succeed({ id: ID, seq: 1 }))
    expect(exit).toEqual(Exit.succeed({ id: ID, seq: 1 }))
    expect(counts).toEqual({ sent: 1, refused: 0, unsent: 0 })
  })

  test("a refusal fails for good, and an unreachable ChatApi fails to be tried again", async () => {
    const refused = await step(Effect.fail(new AnswerNotTaken({ status: 403, code: "person_only" })))
    expect(refused.exit).toEqual(Exit.fail(new FeedAnswerRefused({ status: 403, code: "person_only" })))
    expect(refused.counts).toEqual({ sent: 0, refused: 1, unsent: 0 })
    const unsent = await step(Effect.fail(new AnswerNotTaken({})))
    expect(unsent.exit).toEqual(Exit.fail(new FeedAnswerUnsent()))
    expect(unsent.counts).toEqual({ sent: 0, refused: 0, unsent: 1 })
  })
})

describe("the contract", () => {
  test("names, repositories and routes", () => {
    expect(["lanes", "transcript/lane-3", "report/r2/Codex:astra", "a.b_c-d"].map(isFeedName)).toEqual([true, true, true, true])
    expect(["Lanes", "lanes/", "/lanes", "a b", "x:y", `a${"b".repeat(200)}`].map(isFeedName)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
    ])
    expect([isIndexName("lanes"), isIndexName("diff/abc")]).toEqual([true, false])
    expect(feedRepo("SmithersAI", "VibeLang")).toBe("smithersai/vibelang")
    expect(feedDocumentId("smithersai/vibelang", "diff/a")).toBe("smithersai/vibelang:diff/a")
    expect([parseFeedRepo("A/B"), parseFeedRepo("a"), parseFeedRepo("a/b/c"), parseFeedRepo("-a/b")]).toEqual([
      "a/b",
      undefined,
      undefined,
      undefined,
    ])
    expect(feedsRoute("a b", "c")).toBe("/api/repos/a%20b/c/feeds")
    expect(feedAnswersRoute("a", "c")).toBe("/api/repos/a/c/feeds/answers")
    expect(parseFeedRoute("/api/repos/A/b/feeds")).toEqual({ owner: "A", name: "b", route: "documents" })
    expect(parseFeedRoute("/api/repos/a/b/feeds/answers")).toEqual({ owner: "a", name: "b", route: "answers" })
    expect(parseFeedRoute("/api/repos/a/b/stack")).toBeUndefined()
    expect(parseFeedRoute("/api/repos/%E0%A4%A/b/feeds")).toBeUndefined()
    expect(parseFeedRoute("/api/repos/-a/b/feeds")).toBeUndefined()
  })
})
