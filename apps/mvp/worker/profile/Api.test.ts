import { Duration, Effect, Layer, Option, Redacted } from "effect"
import { FetchHttpClient, HttpEffect, HttpServerRequest } from "effect/http"
import { describe, expect, test } from "vitest"
import * as ReadToken from "../github/ReadToken.ts"
import * as ProfileApi from "./Api.vibe"
import * as ProfileSource from "./Source.ts"
import type { Kept, KeptAnswer, KeptRefusal, ProfileStore, Via } from "./Store.vibe"

const API = "https://api.github.test"

/** In-memory ProfileStore implementing the exact fencing contract for unit tests without external DB dependencies. */
const memoryStore = (): ProfileStore => {
  const rows = new Map<string, { kept: Kept; gen: number }>()
  return {
    get: (owner) => Effect.succeed(Option.fromNullishOr(rows.get(owner)?.kept)),
    claim: (owner, nowMs, untilMs, recoverAnonymous = false) =>
      Effect.sync(() => {
        const existing = rows.get(owner)
        if (existing === undefined) {
          rows.set(owner, { kept: { answer: Option.none(), nextReadAtMs: untilMs, refusal: null }, gen: 1 })
          return "1"
        }
        const canClaim =
          existing.kept.nextReadAtMs === null ||
          existing.kept.nextReadAtMs <= nowMs ||
          (recoverAnonymous && existing.kept.refusal === "rate_limited" &&
            (existing.kept.refusalVia === undefined || existing.kept.refusalVia === "anonymous"))
        if (!canClaim) return false
        const gen = existing.gen + 1
        rows.set(owner, {
          kept: { answer: existing.kept.answer, nextReadAtMs: untilMs, refusal: null },
          gen,
        })
        return String(gen)
      }),
    keep: (owner, answer: KeptAnswer, generation: string) =>
      Effect.sync(() => {
        const existing = rows.get(owner)
        if (existing === undefined || String(existing.gen) !== generation) return false
        rows.set(owner, {
          kept: { answer: Option.some(answer), nextReadAtMs: answer.freshUntilMs, refusal: null },
          gen: existing.gen + 1,
        })
        return true
      }),
    refuse: (owner, refusal: KeptRefusal, nextReadAtMs: number, via: Via | undefined, generation: string) =>
      Effect.sync(() => {
        const existing = rows.get(owner)
        if (existing === undefined || String(existing.gen) !== generation) return false
        rows.set(owner, {
          kept: {
            answer: refusal === "not_found" ? Option.none() : existing.kept.answer,
            nextReadAtMs,
            refusal,
            ...(via === undefined ? {} : { refusalVia: via }),
          },
          gen: existing.gen + 1,
        })
        return true
      }),
  }
}

const makeApi = (
  githubFetch: (url: URL) => Response,
  token: Option.Option<Redacted.Redacted<string>> = Option.some(Redacted.make("ghs_test")),
) => {
  const store = memoryStore()
  const source = ProfileSource.make(
    {
      token: ReadToken.fixed(token),
      apiBaseUrl: API,
      freshFor: Duration.minutes(10),
      anonymousFreshFor: Duration.minutes(60),
    },
    store,
  )
  const api = ProfileApi.make(source)
  const layer = Layer.merge(
    FetchHttpClient.layer,
    Layer.succeed(
      FetchHttpClient.Fetch,
      ((input: RequestInfo | URL) => Promise.resolve(githubFetch(new URL(new Request(input).url)))) as typeof globalThis.fetch,
    ),
  )
  const handler = HttpEffect.toWebHandler(
    Effect.flatMap(HttpServerRequest.HttpServerRequest, () => api.fetch).pipe(Effect.provide(layer)),
  )
  const send = (path: string, method = "GET") => handler(new Request(`https://smithers.test${path}`, { method }))
  return { send, store }
}

const okGraphProfile = (login = "roninjin10") =>
  new Response(
    JSON.stringify({
      data: {
        repositoryOwner: {
          __typename: "User",
          login,
          avatarUrl: "https://avatars.githubusercontent.com/u/1",
          name: "Will Cory",
          bio: "Building Smithers",
          company: "@smithersai",
          location: "SF",
          websiteUrl: "https://smithers.sh",
          twitterUsername: "FUCORY",
          pronouns: null,
          createdAt: "2018-01-01T00:00:00Z",
          status: null,
          followers: { totalCount: 10 },
          following: { totalCount: 2 },
          organizations: { nodes: [] },
          pinnedItems: { nodes: [] },
          repositories: { totalCount: 0, nodes: [] },
          profileRepo: null,
          contributionsCollection: null,
        },
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  )

describe("worker/profile/Api", () => {
  test("handles /api/profiles/<owner>, caches fresh responses, and serves hits without re-calling GitHub", async () => {
    let calls = 0
    const { send } = makeApi(() => {
      calls += 1
      return okGraphProfile("roninjin10")
    })

    expect(ProfileApi.handles("/api/profiles/roninjin10")).toBe(true)
    expect(ProfileApi.handles("/api/repos/roninjin10/smithers")).toBe(false)

    const first = await send("/api/profiles/roninjin10")
    expect(first.status).toBe(200)
    expect(first.headers.get("cache-control")).toMatch(/^public, max-age=\d+, must-revalidate$/)
    expect(await first.json()).toMatchObject({ login: "roninjin10", name: "Will Cory" })
    expect(calls).toBe(1)

    // Case-insensitive cache hit avoids a second GitHub call.
    const second = await send("/api/profiles/RONINJIN10")
    expect(second.status).toBe(200)
    expect(await second.json()).toMatchObject({ login: "roninjin10" })
    expect(calls).toBe(1)
  })

  test("refuses reserved/invalid owners with 404, non-GET with 405, and upstream rate limit with 503 + Retry-After", async () => {
    let calls = 0
    const { send } = makeApi(() => {
      calls += 1
      return new Response(JSON.stringify({ errors: [{ type: "RATE_LIMITED" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    })

    expect((await send("/api/profiles/app")).status).toBe(404)
    expect((await send("/api/profiles/bad_user")).status).toBe(404)
    expect((await send("/api/profiles/%E0%A4%A")).status).toBe(404)
    expect((await send("/api/profiles/roninjin10/extra")).status).toBe(404)
    expect((await send("/api/profiles/roninjin10", "POST")).status).toBe(405)
    expect(calls).toBe(0)

    const limited = await send("/api/profiles/roninjin10")
    expect(limited.status).toBe(503)
    expect(await limited.json()).toEqual({ code: "rate_limited" })
    expect(calls).toBe(1)

    // Cached refusal holds bursts off without calling GitHub again.
    const held = await send("/api/profiles/roninjin10")
    expect(held.status).toBe(503)
    expect(held.headers.get("retry-after")).toBeTruthy()
    expect(calls).toBe(1)
  })

  test("a missing GitHub owner returns an uncached 404 response", async () => {
    const { send } = makeApi(() => Response.json({ data: { repositoryOwner: null } }))
    const response = await send("/api/profiles/missing-owner")

    expect([response.status, response.headers.get("cache-control"), response.headers.get("retry-after")])
      .toEqual([404, "no-store", null])
    expect(await response.json()).toEqual({ code: "not_found" })
  })

  test("a source defect returns an uncached 503 correlated to the request", async () => {
    const { fetch } = ProfileApi.make({ answer: () => Effect.die(new Error("Profile source defect")) })
    const handler = HttpEffect.toWebHandler(Effect.provide(fetch, FetchHttpClient.layer))
    const response = await handler(new Request("https://smithers.test/api/profiles/owner", {
      headers: { "cf-ray": "0123456789abcdef-SJC" },
    }))

    expect([response.status, response.headers.get("cache-control"), response.headers.get("x-smithers-ray")])
      .toEqual([503, "no-store", "0123456789abcdef-SJC"])
    expect(await response.json()).toEqual({ code: "unavailable" })
  })
})
