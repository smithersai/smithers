import { Effect, Layer, Option, Redacted } from "effect"
import { HttpEffect } from "effect/http"
import { SqlClient } from "effect/sql"
import { describe, expect, test } from "vitest"
import * as TestDatabase from "../../db/TestDatabase.ts"
import { forkRoute, syncUpstreamRoute } from "../../src/features/fork/contract.ts"
import { type Actor, Sessions } from "../Actor.vibe"
import * as Flows from "../Flows.vibe"
import * as RepoFork from "../flows/RepoFork.vibe"
import * as ForkApi from "./ForkApi.vibe"
import type { GitHubApp } from "./Config.vibe"

const sessionOf = (actor: Actor | undefined) =>
  Layer.succeed(
    Sessions,
    Sessions.of({
      resolve: Effect.succeed(actor === undefined ? Option.none() : Option.some(actor)),
    }),
  )

const fakeApp: GitHubApp = {
  appId: "12345",
  privateKey: Redacted.make("fake-pem"),
  webhookSecret: Option.some(Redacted.make("fake-webhook")),
  apiBaseUrl: "https://api.github.test",
  repository: { id: "github/smithersai/smithers", owner: "smithersai", name: "smithers" },
}

describe("ForkApi", () => {
  test("handles GET/POST fork, rejects person-only and own-repo forks, and tracks fork/upstream provenance", async () => {
    const dbLayer = TestDatabase.layer("fork-api")
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const personId = crypto.randomUUID()
          const [person] = yield* sql<{ readonly id: string }>`
            INSERT INTO people (id, github_id, github_login)
            VALUES (${personId}::uuid, 88001, ${"forker-bob"})
            RETURNING id::text AS id`
          const actor: Actor = {
            subject: { kind: "person", id: person!.id },
            role: null,
            login: "forker-bob",
            session: "sess-1",
          }

          const started: Array<{ flow: unknown; payload: unknown }> = []
          const fakeStarter = Layer.succeed(
            Flows.FlowStarter,
            Flows.FlowStarter.of({
              start: (flow, options) => {
                started.push({ flow, payload: options.payload })
                return Effect.void
              },
            }),
          )

          const sharedDb = Layer.succeed(SqlClient.SqlClient, sql)
          const api = yield* ForkApi.make(sharedDb, { app: Option.some(fakeApp) })
          const call = (who: Actor | undefined, req: Request) =>
            Effect.promise(() =>
              HttpEffect.toWebHandler(
                api.fetch.pipe(Effect.provide(sessionOf(who)), Effect.provide(fakeStarter)),
              )(req),
            )

          expect(ForkApi.handles(forkRoute("smithersai", "smithers"))).toBe(true)
          expect(ForkApi.handles(syncUpstreamRoute("forker-bob", "smithers"))).toBe(true)
          expect(ForkApi.handles("/api/repos/smithersai/smithers/tree/main")).toBe(false)

          // Signed out -> 401
          const r401 = yield* call(undefined, new Request(`https://smithers.sh${forkRoute("smithersai", "smithers")}`))
          expect(r401.status).toBe(401)

          // GET before forking -> status: "none"
          const rNone = yield* call(actor, new Request(`https://smithers.sh${forkRoute("smithersai", "smithers")}`))
          expect(rNone.status).toBe(200)
          expect(yield* Effect.promise(() => rNone.json())).toMatchObject({ status: "none" })

          // POST delegated agent -> 403 person_only
          const agentActor: Actor = { ...actor, act: { kind: "agent", id: "run-9" } }
          const rAgent = yield* call(
            agentActor,
            new Request(`https://smithers.sh${forkRoute("smithersai", "smithers")}`, { method: "POST" }),
          )
          expect(rAgent.status).toBe(403)

          // POST own repo -> 409 own_repo
          const rOwn = yield* call(
            actor,
            new Request(`https://smithers.sh${forkRoute("forker-bob", "smithers")}`, { method: "POST" }),
          )
          expect(rOwn.status).toBe(409)

          // POST upstream repo -> 202 forking & starts repo/Fork flow
          const rFork = yield* call(
            actor,
            new Request(`https://smithers.sh${forkRoute("smithersai", "smithers")}`, { method: "POST" }),
          )
          expect(rFork.status).toBe(202)
          const forkJson = (yield* Effect.promise(() => rFork.json())) as { status: string; forkOwner: string; forkName: string }
          expect(forkJson).toMatchObject({ status: "forking", forkOwner: "forker-bob", forkName: "smithers" })
          expect(started.some((s) => s.flow === RepoFork.RepoFork)).toBe(true)

          // Mark ready in Postgres and verify both upstream GET and fork-repo GET report provenance
          yield* sql`UPDATE repo_forks SET status = ${"ready"}, app_installed = true WHERE person_id = ${person!.id}::uuid`
          const rUpstream = yield* call(actor, new Request(`https://smithers.sh${forkRoute("smithersai", "smithers")}`))
          expect(yield* Effect.promise(() => rUpstream.json())).toMatchObject({
            status: "ready",
            forkOwner: "forker-bob",
            forkName: "smithers",
            appInstalled: true,
          })

          const rOnFork = yield* call(actor, new Request(`https://smithers.sh${forkRoute("forker-bob", "smithers")}`))
          expect(yield* Effect.promise(() => rOnFork.json())).toMatchObject({
            status: "none",
            isFork: true,
            upstreamOwner: "smithersai",
            upstreamName: "smithers",
          })
        }),
      ).pipe(Effect.provide(dbLayer)),
    )
  })
})
