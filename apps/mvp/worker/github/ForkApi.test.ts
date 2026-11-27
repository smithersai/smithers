import { generateKeyPairSync } from "node:crypto"
import { digestSync } from "@smthrs/crypto"
import type { GitHub } from "@smthrs/integrations"
import { Effect, Exit, Layer, Option, Redacted } from "effect"
import { HttpEffect } from "effect/http"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientError from "effect/http/HttpClientError"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import { SqlClient } from "effect/sql"
import { describe, expect, test } from "vitest"
import * as TestDatabase from "../../db/TestDatabase.ts"
import { forkRoute, syncUpstreamRoute } from "../../src/features/fork/contract.ts"
import { type Actor, Sessions } from "../Actor.vibe"
import * as Flows from "../Flows.vibe"
import * as RepoFork from "../flows/RepoFork.vibe"
import * as SessionKeys from "../SessionKeys.vibe"
import * as SessionStore from "../SessionStore.vibe"
import { runFlow } from "../test/flowHost.ts"
import type { GitHubApp } from "./Config.vibe"
import * as ForkApi from "./ForkApi.vibe"

const sessionOf = (actor: Actor | undefined) =>
  Layer.succeed(
    Sessions,
    Sessions.of({
      resolve: Effect.succeed(actor === undefined ? Option.none() : Option.some(actor)),
    }),
  )

const brokenSqlLayer = Layer.effect(SqlClient.SqlClient, Effect.fail(new Error("db down")))

const TEST_RSA_PEM = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString()

const fakeApp: GitHubApp = {
  appId: "12345",
  privateKey: Redacted.make(TEST_RSA_PEM),
  webhookSecret: Option.some(Redacted.make("fake-webhook")),
  apiBaseUrl: "https://api.github.test",
  repository: { id: "github/smithersai/smithers", owner: "smithersai", name: "smithers" },
}

const fakeAppAuth: GitHub.AppAuth.AppAuth = {
  jwt: Effect.succeed(Redacted.make("jwt")),
  installation: () => Effect.succeed({ id: 7 }),
  installationToken: () => Effect.die("unused in RepoFork"),
}

const seedSignedInPerson = (
  sql: SqlClient.SqlClient,
  keys: SessionKeys.SessionKeys,
  githubId: number,
  login: string,
  expiresInMs = 8 * 3600_000,
) =>
  Effect.gen(function* () {
    const personId = crypto.randomUUID()
    const sessionId = crypto.randomUUID()
    const access = yield* keys.seal(Redacted.make("ghu_test_user_token"), {
      id: sessionId,
      name: "github_access",
      version: 1,
    })
    yield* sql`INSERT INTO people (id, github_id, github_login) VALUES (${personId}::uuid, ${githubId}, ${login})`
    yield* SessionStore.createSession({
      id: sessionId,
      tokenDigest: digestSync(sessionId),
      personId,
      role: null,
      roleGeneration: yield* SessionStore.roleObservation,
      access,
      accessExpiresAt: Date.now() + expiresInMs,
      refresh: null,
      refreshDigest: null,
      maxAgeSeconds: 3600,
    })
    return { personId, sessionId }
  })

describe("ForkApi", () => {
  test("covers GET/POST fork, sync-upstream, auth/validation/method checks, and error paths", async () => {
    const dbLayer = TestDatabase.layer("fork-api-full")
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const sharedDb = Layer.succeed(SqlClient.SqlClient, sql)
          const sessionKeys = yield* SessionKeys.make(Redacted.make("k".repeat(64)))
          const { personId, sessionId } = yield* seedSignedInPerson(sql, sessionKeys, 88001, "forker-bob")

          const actor: Actor = {
            subject: { kind: "person", id: personId },
            role: null,
            login: "forker-bob",
            session: sessionId,
          }
          const agentActor: Actor = { ...actor, act: { kind: "agent", id: "run-9" } }

          let starterFail = false
          const started: Array<{ flow: unknown; payload: unknown }> = []
          const fakeStarter = Layer.succeed(
            Flows.FlowStarter,
            Flows.FlowStarter.of({
              start: (flow, options) => {
                if (starterFail) return Effect.fail(new Flows.StartUnavailable({ errorCode: "down" }))
                started.push({ flow, payload: options.payload })
                return Effect.void
              },
            }),
          )

          let syncMode: "ok" | "ok-minimal" | "409" | "403" | "404" | "500" = "ok"
          const fakeHttp = HttpClient.make((req) => {
            if (req.url.endsWith("/merge-upstream")) {
              if (syncMode === "409") {
                return Effect.succeed(HttpClientResponse.fromWeb(req, new Response("{\"message\":\"conflict\"}", { status: 409 })))
              }
              if (syncMode === "403") {
                return Effect.succeed(HttpClientResponse.fromWeb(req, new Response("{\"message\":\"forbidden\"}", { status: 403 })))
              }
              if (syncMode === "404") {
                return Effect.succeed(HttpClientResponse.fromWeb(req, new Response("{\"message\":\"missing\"}", { status: 404 })))
              }
              if (syncMode === "500") {
                return Effect.succeed(HttpClientResponse.fromWeb(req, new Response("{\"message\":\"err\"}", { status: 500 })))
              }
              const body =
                syncMode === "ok"
                  ? { message: "Successfully fetched and fast-forwarded.", merge_type: "fast-forward", base_branch: "upstream:main" }
                  : { message: "Already up to date." }
              return Effect.succeed(
                HttpClientResponse.fromWeb(req, new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })),
              )
            }
            return Effect.succeed(HttpClientResponse.fromWeb(req, new Response("{}", { status: 404 })))
          })

          const api = yield* ForkApi.make(sharedDb, {
            app: Option.some(fakeApp),
            keys: Option.some(sessionKeys),
            http: fakeHttp,
          })
          const uncfgApi = yield* ForkApi.make(sharedDb, { app: Option.none() })
          const brokenApi = yield* ForkApi.make(brokenSqlLayer, {
            app: Option.some(fakeApp),
            keys: Option.some(sessionKeys),
          })

          const call = (who: Actor | undefined, req: Request, which = api) =>
            Effect.promise(() =>
              HttpEffect.toWebHandler(
                which.fetch.pipe(Effect.provide(sessionOf(who)), Effect.provide(fakeStarter)),
              )(req),
            )

          expect(ForkApi.handles(forkRoute("smithersai", "smithers"))).toBe(true)
          expect(ForkApi.handles(syncUpstreamRoute("forker-bob", "smithers"))).toBe(true)
          expect(ForkApi.handles("/api/repos/smithersai/smithers/tree/main")).toBe(false)

          // Unmatched path -> 404
          expect((yield* call(actor, new Request("https://smithers.sh/api/repos/invalid"))).status).toBe(404)

          // Signed out -> 401
          expect((yield* call(undefined, new Request(`https://smithers.sh${forkRoute("smithersai", "smithers")}`))).status).toBe(401)

          // Method not allowed -> 405
          expect(
            (yield* call(actor, new Request(`https://smithers.sh${forkRoute("smithersai", "smithers")}`, { method: "DELETE" }))).status,
          ).toBe(405)
          expect(
            (yield* call(actor, new Request(`https://smithers.sh${syncUpstreamRoute("forker-bob", "smithers")}`, { method: "GET" }))).status,
          ).toBe(405)

          // GET before forking -> 200 none; DB error -> 503
          const rNone = yield* call(actor, new Request(`https://smithers.sh${forkRoute("smithersai", "smithers")}`))
          expect(rNone.status).toBe(200)
          expect(yield* Effect.promise(() => rNone.json())).toMatchObject({ status: "none" })
          expect(
            (yield* call(actor, new Request(`https://smithers.sh${forkRoute("smithersai", "smithers")}`), brokenApi)).status,
          ).toBe(503)

          // POST delegated agent -> 403; own repo -> 409; unconfigured -> 503; DB err -> 503; starter err -> 503
          expect(
            (yield* call(agentActor, new Request(`https://smithers.sh${forkRoute("smithersai", "smithers")}`, { method: "POST" }))).status,
          ).toBe(403)
          expect(
            (yield* call(actor, new Request(`https://smithers.sh${forkRoute("forker-bob", "smithers")}`, { method: "POST" }))).status,
          ).toBe(409)
          expect(
            (yield* call(actor, new Request(`https://smithers.sh${forkRoute("smithersai", "smithers")}`, { method: "POST" }), uncfgApi)).status,
          ).toBe(503)
          expect(
            (yield* call(actor, new Request(`https://smithers.sh${forkRoute("smithersai", "smithers")}`, { method: "POST" }), brokenApi)).status,
          ).toBe(503)

          starterFail = true
          expect(
            (yield* call(actor, new Request(`https://smithers.sh${forkRoute("smithersai", "smithers")}`, { method: "POST" }))).status,
          ).toBe(503)
          starterFail = false

          // POST upstream repo -> 202 forking & starts repo/Fork flow
          const rFork = yield* call(actor, new Request(`https://smithers.sh${forkRoute("smithersai", "smithers")}`, { method: "POST" }))
          expect(rFork.status).toBe(202)
          expect(started.some((s) => s.flow === RepoFork.RepoFork)).toBe(true)

          // Mark ready -> POST returns 200 already_ready, GET reports ready and fork provenance
          yield* sql`UPDATE repo_forks SET status = ${"ready"}, app_installed = true WHERE person_id = ${personId}::uuid`
          const rAlready = yield* call(actor, new Request(`https://smithers.sh${forkRoute("smithersai", "smithers")}`, { method: "POST" }))
          expect(rAlready.status).toBe(200)
          expect(yield* Effect.promise(() => rAlready.json())).toMatchObject({ status: "ready" })

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

          // sync-upstream: 403 agent, 503 unconfigured, 200 synced (with & without body), 409, 403, 404, 500
          expect(
            (yield* call(agentActor, new Request(`https://smithers.sh${syncUpstreamRoute("forker-bob", "smithers")}`, { method: "POST" }))).status,
          ).toBe(403)
          expect(
            (yield* call(actor, new Request(`https://smithers.sh${syncUpstreamRoute("forker-bob", "smithers")}`, { method: "POST" }), uncfgApi)).status,
          ).toBe(503)

          syncMode = "ok"
          const syncOk = yield* call(
            actor,
            new Request(`https://smithers.sh${syncUpstreamRoute("forker-bob", "smithers")}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ branch: "main" }),
            }),
          )
          expect(syncOk.status).toBe(200)
          expect(yield* Effect.promise(() => syncOk.json())).toMatchObject({
            synced: true,
            mergeType: "fast-forward",
            baseBranch: "upstream:main",
          })

          syncMode = "ok-minimal"
          const syncMin = yield* call(
            actor,
            new Request(`https://smithers.sh${syncUpstreamRoute("forker-bob", "smithers")}`, { method: "POST" }),
          )
          expect(syncMin.status).toBe(200)

          syncMode = "409"
          expect(
            (yield* call(actor, new Request(`https://smithers.sh${syncUpstreamRoute("forker-bob", "smithers")}`, { method: "POST" }))).status,
          ).toBe(409)
          syncMode = "403"
          expect(
            (yield* call(actor, new Request(`https://smithers.sh${syncUpstreamRoute("forker-bob", "smithers")}`, { method: "POST" }))).status,
          ).toBe(403)
          syncMode = "404"
          expect(
            (yield* call(actor, new Request(`https://smithers.sh${syncUpstreamRoute("forker-bob", "smithers")}`, { method: "POST" }))).status,
          ).toBe(404)
          syncMode = "500"
          expect(
            (yield* call(actor, new Request(`https://smithers.sh${syncUpstreamRoute("forker-bob", "smithers")}`, { method: "POST" }))).status,
          ).toBe(503)
        }),
      ).pipe(Effect.provide(dbLayer)),
    )
  })
})

describe("RepoFork durable flow", () => {
  test("creates fork on GitHub and settles ready, permanent failures, and retry exhaustion", async () => {
    const dbLayer = TestDatabase.layer("repo-fork-flow")
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const sharedDb = Layer.succeed(SqlClient.SqlClient, sql)
          const sessionKeys = yield* SessionKeys.make(Redacted.make("f".repeat(64)))
          const { personId, sessionId } = yield* seedSignedInPerson(sql, sessionKeys, 89001, "flow-alice")

          const insertForkRow = (upstreamOwner: string, upstreamName: string) =>
            sql<{ readonly id: string }>`
              INSERT INTO repo_forks (id, person_id, upstream_repo_id, upstream_owner, upstream_name, fork_owner, fork_name, fork_repo_id, status)
              VALUES (${crypto.randomUUID()}::uuid, ${personId}::uuid, ${`github/${upstreamOwner}/${upstreamName}`}, ${upstreamOwner}, ${upstreamName}, ${"flow-alice"}, ${upstreamName}, ${`github/flow-alice/${upstreamName}`}, ${"forking"})
              RETURNING id::text AS id`.pipe(Effect.map((r) => r[0]!.id))

          const readFork = (forkId: string) =>
            sql<{ readonly status: string; readonly failure: string | null; readonly appInstalled: boolean }>`
              SELECT status, failure, app_installed AS "appInstalled" FROM repo_forks WHERE id = ${forkId}::uuid`.pipe(
              Effect.map((r) => r[0]!),
            )

          // 1. Happy path with GitHub App already installed
          const forkId1 = yield* insertForkRow("smithersai", "smithers")
          yield* sql`
            INSERT INTO github_repositories (repo_id, installation_id)
            VALUES (${"github/flow-alice/smithers"}, 99)`
          const okHttp = HttpClient.make((req) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                req,
                new Response(
                  JSON.stringify({
                    id: 1001,
                    name: "smithers",
                    full_name: "flow-alice/smithers",
                    html_url: "https://github.com/flow-alice/smithers",
                    default_branch: "main",
                    fork: true,
                    owner: { login: "flow-alice" },
                  }),
                  { status: 202, headers: { "content-type": "application/json" } },
                ),
              ),
            ),
          )
          const res1 = yield* Effect.promise(() =>
            runFlow(
              RepoFork.RepoFork,
              { forkId: forkId1, personId, sessionId, upstreamOwner: "smithersai", upstreamName: "smithers" },
              RepoFork.registration({
                database: sharedDb,
                app: Option.some(fakeAppAuth),
                apiBaseUrl: "https://api.github.test",
                keys: Option.some(sessionKeys),
                refresh: () => Effect.void,
                http: okHttp,
              }),
            ),
          )
          expect(res1.exit).toEqual(Exit.succeed({ settled: true }))
          expect(yield* readFork(forkId1)).toEqual({ status: "ready", failure: null, appInstalled: true })

          // 2. Missing app/keys -> settles failed: unavailable
          const forkId2 = yield* insertForkRow("org", "no-app")
          const res2 = yield* Effect.promise(() =>
            runFlow(
              RepoFork.RepoFork,
              { forkId: forkId2, personId, sessionId, upstreamOwner: "org", upstreamName: "no-app" },
              RepoFork.registration({
                database: sharedDb,
                app: Option.none(),
                apiBaseUrl: "https://api.github.test",
                keys: Option.none(),
                refresh: () => Effect.void,
                http: okHttp,
              }),
            ),
          )
          expect(res2.exit).toEqual(Exit.succeed({ settled: true }))
          expect(yield* readFork(forkId2)).toEqual({ status: "failed", failure: "unavailable", appInstalled: false })

          // 3. Missing session token -> sign_in_required
          const forkId3 = yield* insertForkRow("org", "no-session")
          const res3 = yield* Effect.promise(() =>
            runFlow(
              RepoFork.RepoFork,
              {
                forkId: forkId3,
                personId,
                sessionId: crypto.randomUUID(),
                upstreamOwner: "org",
                upstreamName: "no-session",
              },
              RepoFork.registration({
                database: sharedDb,
                app: Option.some(fakeAppAuth),
                apiBaseUrl: "https://api.github.test",
                keys: Option.some(sessionKeys),
                refresh: () => Effect.void,
                http: okHttp,
              }),
            ),
          )
          expect(res3.exit).toEqual(Exit.succeed({ settled: true }))
          expect(yield* readFork(forkId3)).toEqual({ status: "failed", failure: "sign_in_required", appInstalled: false })

          // 4. GitHub 404 and 403 -> settles failed immediately without retrying
          for (const [status, expectedFailure, repoName] of [
            [404, "not_found", "missing-repo"],
            [403, "forbidden", "private-repo"],
          ] as const) {
            const fid = yield* insertForkRow("org", repoName)
            const errHttp = HttpClient.make((req) =>
              Effect.succeed(HttpClientResponse.fromWeb(req, new Response("{\"message\":\"nope\"}", { status }))),
            )
            const res = yield* Effect.promise(() =>
              runFlow(
                RepoFork.RepoFork,
                { forkId: fid, personId, sessionId, upstreamOwner: "org", upstreamName: repoName },
                RepoFork.registration({
                  database: sharedDb,
                  app: Option.some(fakeAppAuth),
                  apiBaseUrl: "https://api.github.test",
                  keys: Option.some(sessionKeys),
                  refresh: () => Effect.void,
                  http: errHttp,
                }),
              ),
            )
            expect(res.exit).toEqual(Exit.succeed({ settled: true }))
            expect(yield* readFork(fid)).toEqual({ status: "failed", failure: expectedFailure, appInstalled: false })
          }

          // 5. Transient network failure throws ForkRetry; retryExhausted maps it to failed: unavailable; settle records it
          const forkId5 = yield* insertForkRow("org", "flaky-repo")
          const flakyHttp = HttpClient.make((req) =>
            Effect.fail(
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({ request: req, cause: new Error("net") }),
              }),
            ),
          )
          const flakySteps = RepoFork.steps({
            database: sharedDb,
            app: Option.some(fakeAppAuth),
            apiBaseUrl: "https://api.github.test",
            keys: Option.some(sessionKeys),
            refresh: () => Effect.void,
            http: flakyHttp,
          })
          const retryErr = yield* Effect.result(
            flakySteps.createOnGitHub({
              forkId: forkId5,
              personId,
              sessionId,
              upstreamOwner: "org",
              upstreamName: "flaky-repo",
            }),
          )
          expect(retryErr._tag).toBe("Failure")
          if (retryErr._tag === "Failure") {
            const exhausted = yield* flakySteps.retryExhausted({ error: retryErr.failure })
            expect(exhausted).toEqual({ outcome: "failed", failure: "unavailable" })
            expect(yield* flakySteps.settle({ forkId: forkId5, result: exhausted })).toEqual({ settled: true })
          }
          expect(yield* readFork(forkId5)).toEqual({ status: "failed", failure: "unavailable", appInstalled: false })

          // 6. Settle DB failure surfaces ForkSettleFailed
          const brokenSteps = RepoFork.steps({
            database: brokenSqlLayer,
            app: Option.none(),
            apiBaseUrl: "https://api.github.test",
            keys: Option.none(),
            refresh: () => Effect.void,
            http: okHttp,
          })
          const settleErr = yield* Effect.result(
            brokenSteps.settle({ forkId: forkId1, result: { outcome: "failed", failure: "unavailable" } }),
          )
          expect(settleErr._tag).toBe("Failure")
          expect(RepoFork.forkExecutionId("f-1")).toBe("repo-fork:f-1")
        }),
      ).pipe(Effect.provide(dbLayer)),
    )
  }, 60_000)
})
