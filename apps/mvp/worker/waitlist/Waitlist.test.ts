import { Effect, Layer, Option } from "effect"
import { HttpEffect } from "effect/http"
import { SqlClient } from "effect/sql"
import { describe, expect, test } from "vitest"
import * as Database from "../../db/Database.ts"
import * as TestDatabase from "../../db/TestDatabase.ts"
import { WAITLIST_JOIN_ROUTE, WAITLIST_MAX_BODY_BYTES } from "../../src/features/waitlist/contract.ts"
import { Sessions, SessionsUnavailable, type Actor } from "../Actor.ts"
import * as BodyLimits from "../BodyLimits.ts"
import { routeOf } from "../Throttle.ts"
import { join, normalizeWaitlistUrl } from "./Waitlist.ts"

const sessionOf = (actor: Actor | undefined) =>
  Layer.succeed(
    Sessions,
    Sessions.of({
      resolve: Effect.succeed(actor === undefined ? Option.none() : Option.some(actor)),
    }),
  )

describe("waitlist/join", () => {
  test("validates and normalizes HTTPS repo URLs strictly and deduplicates GitHub aliases", () => {
    expect(normalizeWaitlistUrl("https://GitHub.com/Evmts/Voltaire.git/")).toBe("https://github.com/evmts/voltaire")
    expect(normalizeWaitlistUrl("https://github.com/Org/Repo?token=secret#top")).toBe("https://github.com/org/repo")
    expect(normalizeWaitlistUrl("https://github.com/org/repo/issues/1")).toBeUndefined()
    expect(normalizeWaitlistUrl("https://github.com/org")).toBeUndefined()
    expect(normalizeWaitlistUrl("http://github.com/org/repo")).toBeUndefined()
    expect(normalizeWaitlistUrl("https://github.com:8443/org/repo")).toBeUndefined()
    expect(normalizeWaitlistUrl("javascript:alert(1)")).toBeUndefined()
    expect(normalizeWaitlistUrl("https://user:pass@github.com/org/repo")).toBeUndefined()
    expect(normalizeWaitlistUrl("https://github.com/")).toBeUndefined()
    expect(normalizeWaitlistUrl("https://localhost/org/repo")).toBeUndefined()
  })

  test("has dedicated rate limit and 4 KiB admission body limit", async () => {
    expect(routeOf(WAITLIST_JOIN_ROUTE)).toBe("waitlist")
    const cap = await Effect.runPromise(BodyLimits.forRequest(WAITLIST_JOIN_ROUTE))
    expect(cap).toBe(WAITLIST_MAX_BODY_BYTES)
  })

  test("persists idempotently in Postgres, rejects delegated or refused credentials, bounds body size, and degrades cleanly", async () => {
    const dbLayer = TestDatabase.layer("waitlist")
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Database.migrate
          const sql = yield* SqlClient.SqlClient
          const sqlLayer = Layer.succeed(SqlClient.SqlClient, sql)

          const callJoin = async (opts: {
            readonly method?: string
            readonly body?: string
            readonly actor?: Actor
            readonly headers?: Record<string, string>
            readonly sessionsLayer?: Layer.Layer<Sessions>
          }) => {
            const req = new Request(`https://smithers.sh${WAITLIST_JOIN_ROUTE}`, {
              method: opts.method ?? "POST",
              headers: { "content-type": "application/json", ...opts.headers },
              ...(opts.body !== undefined ? { body: opts.body } : {}),
            })
            const handler = HttpEffect.toWebHandler(
              join.pipe(Effect.provide(Layer.merge(sqlLayer, opts.sessionsLayer ?? sessionOf(opts.actor)))),
            )
            const res = await handler(req)
            const text = await res.text()
            return { status: res.status, json: text === "" ? undefined : JSON.parse(text) }
          }

          const person: Actor = { subject: { kind: "person", id: "usr_1" }, role: "member", login: "alice" }
          const first = yield* Effect.promise(() =>
            callJoin({
              actor: person,
              body: JSON.stringify({ repoUrl: "https://github.com/Acme/Widget.git", workflowNote: ".smithers/workflows/ci.vibe" }),
            }),
          )
          const second = yield* Effect.promise(() =>
            callJoin({
              actor: person,
              body: JSON.stringify({ repoUrl: "https://GITHUB.COM/acme/widget/" }),
            }),
          )
          const delegated: Actor = {
            subject: { kind: "person", id: "usr_1" },
            role: "member",
            login: "alice",
            act: { kind: "agent", id: "agt_1" },
          }
          const denied = yield* Effect.promise(() =>
            callJoin({
              actor: delegated,
              body: JSON.stringify({ repoUrl: "https://github.com/acme/widget" }),
            }),
          )
          const refusedCred = yield* Effect.promise(() =>
            callJoin({
              headers: { authorization: "Bearer bad-token" },
              body: JSON.stringify({ repoUrl: "https://github.com/acme/widget" }),
            }),
          )
          const anon = yield* Effect.promise(() =>
            callJoin({
              body: JSON.stringify({ repoUrl: "https://github.com/acme/widget", workflowNote: "should-not-persist" }),
            }),
          )
          const unavailable = yield* Effect.promise(() =>
            callJoin({
              sessionsLayer: Layer.succeed(
                Sessions,
                Sessions.of({ resolve: Effect.fail(new SessionsUnavailable({ errorCode: "down" })) }),
              ),
              body: JSON.stringify({ repoUrl: "https://github.com/acme/widget" }),
            }),
          )
          const wrongMethod = yield* Effect.promise(() => callJoin({ method: "GET" }))
          const big = yield* Effect.promise(() => callJoin({ body: "x".repeat(5000) }))
          const bad = yield* Effect.promise(() => callJoin({ body: JSON.stringify({ repoUrl: "javascript:alert(1)" }) }))
          const rows = yield* sql<{ readonly requester: string; readonly workflow_note: string }>`
            SELECT requester, workflow_note FROM waitlist_entries ORDER BY position ASC`
          return { first, second, denied, refusedCred, anon, unavailable, wrongMethod, big, bad, rows }
        }).pipe(Effect.provide(dbLayer)),
      ),
    )

    expect(result.first.status).toBe(200)
    expect(result.first.json).toEqual({
      status: "submitted",
      repoUrl: "https://github.com/acme/widget",
      position: result.first.json.position,
    })
    expect(result.second.status).toBe(200)
    expect(result.second.json.position).toBe(result.first.json.position)
    expect(result.denied.status).toBe(403)
    expect(result.denied.json).toEqual({ error: "person_only" })
    expect(result.refusedCred.status).toBe(401)
    expect(result.refusedCred.json).toEqual({ error: "authentication" })
    expect(result.anon.status).toBe(200)
    expect(result.unavailable.status).toBe(503)
    expect(result.unavailable.json).toEqual({ error: "unavailable" })
    expect(result.wrongMethod.status).toBe(405)
    expect(result.big.status).toBe(413)
    expect(result.bad.status).toBe(400)
    expect(result.rows).toEqual([
      { requester: "person:usr_1", workflow_note: ".smithers/workflows/ci.vibe" },
      { requester: "anonymous", workflow_note: "" },
    ])
  })
})
