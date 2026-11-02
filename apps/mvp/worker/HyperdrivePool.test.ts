// Hyperdrive's pools read from Cloudflare's GraphQL Analytics API (worker/HyperdrivePool.ts, decision 0150): what a
// saturated pool is, and one read against a fake API that records what it was sent.
import { Effect, Fiber, Redacted } from "effect"
import { TestClock } from "effect/testing"
import { FetchHttpClient } from "effect/http"
import { describe, expect, test } from "vitest"
import * as HyperdrivePool from "./HyperdrivePool.ts"

const at = (minute: number) => new Date(Date.UTC(2026, 10, 2, 19, minute)).toISOString()

describe("judge", () => {
  test("two minutes in a row with more than 10 clients waiting at one config is saturated; one, or apart, is not", () => {
    const minute = (configId: string, n: number, waiting: number) => ({ configId, minute: at(n), waiting })
    // smithers.sh, 2026-11-02 19:01Z to 19:08Z.
    expect(HyperdrivePool.judge([14, 26, 30, 25, 24, 30, 32].map((waiting, n) => minute("chat", n + 1, waiting))))
      .toEqual({ peak: 32, sustainedMinutes: 7, saturated: true })
    expect(HyperdrivePool.judge([minute("chat", 1, 30), minute("chat", 2, 4), minute("chat", 3, 30)]))
      .toEqual({ peak: 30, sustainedMinutes: 1, saturated: false })
    // Two configs one minute each don't add up.
    expect(HyperdrivePool.judge([minute("chat", 1, 30), minute("engine", 2, 30)]).saturated).toBe(false)
    // A minute with no row is calm: 19:01 and 19:03 aren't in a row.
    expect(HyperdrivePool.judge([minute("engine", 1, 11), minute("engine", 3, 11)]).saturated).toBe(false)
    expect(HyperdrivePool.judge([minute("engine", 1, 10), minute("engine", 2, 10)]).saturated).toBe(false)
    expect(HyperdrivePool.judge([minute("engine", 2, 11), minute("engine", 1, 11)]).saturated).toBe(true)
    expect(HyperdrivePool.judge([])).toEqual({ peak: 0, sustainedMinutes: 0, saturated: false })
  })
})

/** Runs one read against `answer`, returning its outcome and what the API was sent. */
const readWith = async (answer: (body: unknown) => Response | Promise<Response>, configIds: ReadonlyArray<string> = ["c1", "c2"]) => {
  const sent: Array<{ url: string; authorization: string | null; body: unknown }> = []
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const body = await request.json()
    sent.push({ url: request.url, authorization: request.headers.get("authorization"), body })
    return answer(body)
  }) as typeof globalThis.fetch
  const result = await Effect.runPromise(
    HyperdrivePool.make({ accountId: "account", configIds, token: Redacted.make("secret-token"), apiUrl: "https://api.test" })
      .pipe(
        Effect.flatMap((read) => Effect.result(read(new Date(at(0)), new Date(at(7))))),
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
      ),
  )
  return { result, sent }
}

const pools = (rows: ReadonlyArray<{ configId: string; minute: number; waiting: number }>) =>
  Response.json({
    data: {
      viewer: {
        accounts: [{
          pools: rows.map((row) => ({
            max: { waitingClients: row.waiting },
            dimensions: { configId: row.configId, datetimeMinute: at(row.minute) },
          })),
        }],
      },
    },
  })

describe("make", () => {
  test("an API that doesn't answer within REQUEST_TIMEOUT fails the read as a timeout", async () => {
    const never = (() => new Promise<Response>(() => {})) as typeof globalThis.fetch
    const result = await Effect.runPromise(Effect.gen(function* () {
      const read = yield* HyperdrivePool.make({ accountId: "a", configIds: [], token: Redacted.make("t"), apiUrl: "https://api.test" })
      const fiber = yield* Effect.forkChild(Effect.result(read(new Date(at(0)), new Date(at(7)))))
      yield* TestClock.adjust(HyperdrivePool.REQUEST_TIMEOUT)
      return yield* Fiber.join(fiber)
    }).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, never),
      Effect.provide(TestClock.layer()),
    ))
    expect(result).toMatchObject({ _tag: "Failure", failure: { code: "timeout" } })
  })

  test("asks for the account's configs' busiest slice each minute of the span, and judges the answer", async () => {
    const { result, sent } = await readWith(() => pools([{ configId: "c2", minute: 3, waiting: 12 }, { configId: "c2", minute: 4, waiting: 18 }]))
    expect(result).toMatchObject({ _tag: "Success", success: { peak: 18, sustainedMinutes: 2, saturated: true } })
    expect(sent).toHaveLength(1)
    expect(sent[0]!.url).toBe("https://api.test/graphql")
    expect(sent[0]!.authorization).toBe("Bearer secret-token")
    expect(sent[0]!.body).toMatchObject({
      variables: { account: "account", from: at(0), to: at(7), configs: ["c1", "c2"] },
    })
    expect(JSON.stringify(sent[0]!.body)).toContain("hyperdrivePoolSizesAdaptiveGroups")
  })

  test("without configs it asks for every config of the account", async () => {
    const { sent } = await readWith(() => pools([]), [])
    const body = sent[0]!.body as { query: string; variables: Record<string, unknown> }
    expect(body.variables).not.toHaveProperty("configs")
    expect(body.query).not.toContain("configId_in")
  })

  test("an error status, a malformed or partial answer, or no answer fails the read with a code, never the token", async () => {
    const row = { max: { waitingClients: 30 }, dimensions: { configId: "c1", datetimeMinute: at(1) } }
    const answerOf = (body: unknown) => () => Response.json(body)
    const withPools = (pools: unknown, extra: object = {}) =>
      answerOf({ data: { viewer: { accounts: [{ pools }] } }, ...extra })
    for (const [answer, code] of [
      [() => new Response("no", { status: 403 }), "http_403"],
      [answerOf({ errors: [{ message: "x" }] }), "malformed"],
      // A partial failure: data, and errors beside it.
      [withPools([row], { errors: [{ message: "rate limited", path: ["viewer"] }] }), "malformed"],
      [answerOf(null), "malformed"],
      [answerOf({ data: null }), "malformed"],
      [answerOf({ data: { viewer: { accounts: [] } } }), "malformed"],
      [answerOf({ data: { viewer: { accounts: [{ pools: [] }, { pools: [] }] } } }), "malformed"],
      [withPools(null), "malformed"],
      [withPools([null]), "malformed"],
      [withPools([row, null]), "malformed"],
      [withPools([{ max: null, dimensions: row.dimensions }]), "malformed"],
      [withPools([{ max: { waitingClients: -1 }, dimensions: row.dimensions }]), "malformed"],
      [withPools([{ max: { waitingClients: 1.5 }, dimensions: row.dimensions }]), "malformed"],
      [withPools([{ max: { waitingClients: "30" }, dimensions: row.dimensions }]), "malformed"],
      [withPools([{ max: row.max, dimensions: { configId: "c1", datetimeMinute: "not a time" } }]), "malformed"],
      [withPools([{ max: row.max, dimensions: { configId: null, datetimeMinute: at(1) } }]), "malformed"],
      [() => new Response("not json"), "malformed"],
      [() => Promise.reject(new Error("down")), "unreachable"],
    ] as const) {
      const { result } = await readWith(answer)
      expect(result).toMatchObject({ _tag: "Failure", failure: { code } })
      expect(JSON.stringify(result)).not.toContain("secret-token")
    }
  })
})
