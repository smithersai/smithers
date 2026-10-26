// `PersonalModelClient` against every answer ChatApi's routes for a person's own model give (worker/personal/Api.ts),
// through the host's `fetch`: the browser's own capability, given here as a function answering the request it is
// handed. The steps that call it (`model/test/request`, `model/remove/request`) are driven over a client that answers
// as told. ChatApi's own answers are tested through its real handler in personal-model.test.ts.
import { Cause, Effect, Exit, Layer, Metric, Redacted } from "effect"
import { FetchHttpClient } from "effect/http"
import { describe, expect, test } from "vitest"
import { MODEL_WITHIN, ModelNotTaken, PersonalModelClient, TEST_WITHIN } from "./api"
import { ModelRefused, ModelUnsent } from "./flows"
import { type Op, type Outcome, writes } from "./metrics"
import type { TestResult } from "./schema"
import { failureOf, requestRemove, requestTest } from "./steps"

const KEY = "sk-test-SENTINEL/+=\"key\""

/** The client over a `fetch` that answers with `respond`, recording each request it was handed. */
const client = (
  respond: (request: Request) => Promise<Response>,
  within?: { readonly within?: `${number} millis`; readonly testWithin?: `${number} millis` },
) => {
  const seen: Array<{ readonly method: string; readonly url: string; readonly body: string }> = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    seen.push({ method: request.method, url: request.url, body: await request.clone().text() })
    return respond(request)
  }
  const layer = PersonalModelClient.layer({ origin: "http://chat.test", ...within }).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
  )
  const run = <A, E>(effect: (client: PersonalModelClient["Service"]) => Effect.Effect<A, E>) =>
    Effect.runPromise(Effect.exit(Effect.flatMap(PersonalModelClient, effect).pipe(Effect.provide(layer))))
  return { run, seen }
}

const refusalOf = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? { ...(Cause.squash(exit.cause) as ModelNotTaken) } : "succeeded"

const json = (body: unknown, status: number) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }))

const put = {
  keys: [
    { protocol: "openai-chat", baseUrl: "https://api.openai.com", key: Redacted.make(KEY) },
    // The key saved at this base URL stays: the body carries no key for it.
    { protocol: "anthropic-messages", baseUrl: "https://api.anthropic.com", key: undefined },
  ],
  models: {
    fast: { protocol: "anthropic-messages", modelId: "claude-haiku-4-5" },
    implement: { protocol: "openai-chat", modelId: "gpt-6.1-sol" },
  },
} as const

const ok: TestResult = { ok: true, latencyMs: 412, sample: "ok" }
const refusedByProvider: TestResult = { ok: false, latencyMs: 98, code: "authentication", status: 401, host: "api.openai.com" }

describe("PersonalModelClient", () => {
  test("Save puts each key's protocol and base URL, a typed key once, and the tiers; Remove deletes; Test posts", async () => {
    const answers = [json({}, 202), json({}, 202), json(ok, 200), json(refusedByProvider, 200)]
    const { run, seen } = client(() => answers.shift()!)
    expect(await run((c) => c.put(put))).toEqual(Exit.succeed(undefined))
    expect(await run((c) => c.remove)).toEqual(Exit.succeed(undefined))
    expect(await run((c) => c.test)).toEqual(Exit.succeed(ok))
    expect(await run((c) => c.test)).toEqual(Exit.succeed(refusedByProvider))
    expect(seen).toEqual([
      {
        method: "PUT",
        url: "http://chat.test/api/me/model",
        body: JSON.stringify({
          keys: [
            { protocol: "openai-chat", baseUrl: "https://api.openai.com", key: KEY },
            { protocol: "anthropic-messages", baseUrl: "https://api.anthropic.com" },
          ],
          models: {
            fast: { protocol: "anthropic-messages", modelId: "claude-haiku-4-5" },
            implement: { protocol: "openai-chat", modelId: "gpt-6.1-sol" },
          },
        }),
      },
      { method: "DELETE", url: "http://chat.test/api/me/model", body: "" },
      { method: "POST", url: "http://chat.test/api/me/model/test", body: "" },
      { method: "POST", url: "http://chat.test/api/me/model/test", body: "" },
    ])
  })

  test("a refusal carries its status and ChatApi's code, or its status alone when the body names none of its codes", async () => {
    expect(refusalOf(await client(() => json({ code: "invalid_base_url" }, 400)).run((c) => c.put(put)))).toEqual({
      _tag: "ModelNotTaken",
      status: 400,
      code: "invalid_base_url",
    })
    expect(refusalOf(await client(() => json({ code: "none" }, 404)).run((c) => c.test))).toEqual({
      _tag: "ModelNotTaken",
      status: 404,
      code: "none",
    })
    expect(refusalOf(await client(() => json({ code: "made_up" }, 403)).run((c) => c.remove))).toEqual({
      _tag: "ModelNotTaken",
      status: 403,
    })
    expect(refusalOf(await client(() => Promise.resolve(new Response("", { status: 503 }))).run((c) => c.remove)))
      .toEqual({ _tag: "ModelNotTaken", status: 503 })
    // A save is answered 202 once its flow started, and a test 200 once its call came back: no other success.
    expect(refusalOf(await client(() => json({}, 200)).run((c) => c.put(put))))
      .toEqual({ _tag: "ModelNotTaken", status: 200 })
    expect(refusalOf(await client(() => json(ok, 202)).run((c) => c.test))).toEqual({ _tag: "ModelNotTaken", status: 202 })
  })

  test("no network, a body that isn't the route's, and no answer within the deadline are not taken", async () => {
    expect(refusalOf(await client(() => Promise.reject(new TypeError("offline"))).run((c) => c.put(put)))).toEqual({
      _tag: "ModelNotTaken",
    })
    expect(refusalOf(await client(() => json({ ok: "yes" }, 200)).run((c) => c.test))).toEqual({
      _tag: "ModelNotTaken",
      status: 200,
    })
    const never = client(() => new Promise<Response>(() => {}), { within: "50 millis", testWithin: "60 millis" })
    expect(refusalOf(await never.run((c) => c.put(put)))).toEqual({ _tag: "ModelNotTaken" })
    expect(refusalOf(await never.run((c) => c.remove))).toEqual({ _tag: "ModelNotTaken" })
    expect(refusalOf(await never.run((c) => c.test))).toEqual({ _tag: "ModelNotTaken" })
    // A test waits on the provider's call, so it gets longer than a write.
    expect([MODEL_WITHIN, TEST_WITHIN]).toEqual(["15 seconds", "45 seconds"])
  })
})

describe("failureOf", () => {
  test("a 4xx is final with its code, but a timeout's or a rate limit's; so is 503 off; anything else is tried again", () => {
    expect(failureOf(new ModelNotTaken({ status: 400, code: "invalid_model" }))).toEqual(
      new ModelRefused({ status: 400, code: "invalid_model" }),
    )
    expect(failureOf(new ModelNotTaken({ status: 404, code: "none" }))).toEqual(new ModelRefused({ status: 404, code: "none" }))
    expect(failureOf(new ModelNotTaken({ status: 401 }))).toEqual(new ModelRefused({ status: 401 }))
    expect(failureOf(new ModelNotTaken({ status: 499 }))).toEqual(new ModelRefused({ status: 499 }))
    expect(failureOf(new ModelNotTaken({ status: 503, code: "off" }))).toEqual(new ModelRefused({ status: 503, code: "off" }))
    for (const refused of [
      new ModelNotTaken({ status: 408 }),
      new ModelNotTaken({ status: 429 }),
      new ModelNotTaken({ status: 503, code: "unavailable" }),
      new ModelNotTaken({ status: 500 }),
      new ModelNotTaken({ status: 399 }),
      new ModelNotTaken({}),
    ]) {
      expect(failureOf(refused)).toEqual(new ModelUnsent())
    }
  })
})

describe("model/test/request and model/remove/request", () => {
  /** A step over a client answering `answer`, with its counts by outcome. */
  const step = <A>(
    run: Effect.Effect<A, unknown, PersonalModelClient>,
    op: Op,
    answer: { readonly test?: Effect.Effect<TestResult, ModelNotTaken>; readonly remove?: Effect.Effect<void, ModelNotTaken> },
  ) => {
    const registry: Metric.MetricRegistry = new Map()
    const outcomes: ReadonlyArray<Outcome> = ["sent", "refused", "unsent", "ok", "failed"]
    return Effect.runPromise(
      Effect.exit(run).pipe(
        Effect.provide(Layer.succeed(PersonalModelClient, PersonalModelClient.of({
          put: () => Effect.die("no step saves"),
          remove: answer.remove ?? Effect.die("not this step"),
          test: answer.test ?? Effect.die("not this step"),
        }))),
        Effect.flatMap((exit) =>
          Effect.map(
            Effect.all(outcomes.map((outcome) =>
              Effect.map(Metric.value(Metric.withAttributes(writes, { op, outcome })), (state) => [outcome, state.count] as const)
            )),
            (counts) => ({ exit, counts: Object.fromEntries(counts.filter(([, count]) => count > 0)) }),
          )
        ),
        Effect.provideService(Metric.MetricRegistry, registry),
      ),
    )
  }

  test("a test that went through answers its result, counted ok or failed", async () => {
    expect(await step(requestTest, "test", { test: Effect.succeed(ok) })).toEqual({ exit: Exit.succeed(ok), counts: { ok: 1 } })
    expect(await step(requestTest, "test", { test: Effect.succeed(refusedByProvider) })).toEqual({
      exit: Exit.succeed(refusedByProvider),
      counts: { failed: 1 },
    })
    const unreachable: TestResult = { ok: false, latencyMs: 30_000, code: "transport", status: null, host: "api.openai.com" }
    expect(await step(requestTest, "test", { test: Effect.succeed(unreachable) })).toEqual({
      exit: Exit.succeed(unreachable),
      counts: { failed: 1 },
    })
  })

  test("a remove ChatApi took answers removed, counted sent", async () => {
    expect(await step(requestRemove, "delete", { remove: Effect.void })).toEqual({
      exit: Exit.succeed({ removed: true }),
      counts: { sent: 1 },
    })
  })

  test("a refusal fails for good, and an unreachable ChatApi fails to be tried again", async () => {
    expect(await step(requestTest, "test", { test: Effect.fail(new ModelNotTaken({ status: 404, code: "none" })) })).toEqual({
      exit: Exit.fail(new ModelRefused({ status: 404, code: "none" })),
      counts: { refused: 1 },
    })
    expect(await step(requestRemove, "delete", { remove: Effect.fail(new ModelNotTaken({ status: 401 })) })).toEqual({
      exit: Exit.fail(new ModelRefused({ status: 401 })),
      counts: { refused: 1 },
    })
    expect(await step(requestRemove, "delete", { remove: Effect.fail(new ModelNotTaken({})) })).toEqual({
      exit: Exit.fail(new ModelUnsent()),
      counts: { unsent: 1 },
    })
    expect(await step(requestTest, "test", { test: Effect.fail(new ModelNotTaken({ status: 502 })) })).toEqual({
      exit: Exit.fail(new ModelUnsent()),
      counts: { unsent: 1 },
    })
  })
})
