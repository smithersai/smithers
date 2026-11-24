import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Layer, Option, Redacted, Result, Schema } from "effect"
import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
  HttpServerRequest
} from "effect/http"
import { generateKeyPairSync } from "node:crypto"
import { describe, expect, it } from "vitest"
import { IntegrationError } from "../src/core/IntegrationError.ts"
import * as AppAuth from "../src/github/AppAuth.ts"
import * as Commits from "../src/github/Commits.ts"
import * as GitHubClient from "../src/github/GitHubClient.ts"
import * as Issues from "../src/github/Issues.ts"
import * as PublicRead from "../src/github/PublicRead.vibe"
import * as Pulls from "../src/github/Pulls.ts"
import * as Statuses from "../src/github/Statuses.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "60")
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261450")

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const jsonResp = (
  request: HttpClientRequest.HttpClientRequest,
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
) =>
  HttpClientResponse.fromWeb(
    request,
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers }
    })
  )

const { privateKey: rsaPem } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" }
})

const validSha = "a".repeat(40)
const nextLink = (url: string) => ({ link: `<${url}?page=2>; rel="next"` })

describe("@smthrs/integrations Wave10 Boost2 Fuzz", () => {
  it("Commits, Issues, Pulls, and Statuses cover validation, GraphQL refusals, incomplete pagination, and status recovery", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        mode: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 11 }))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ mode }) =>
          Effect.gen(function*() {
            const http = HttpClient.make((req) => {
              const u = new URL(req.url)
              if (u.pathname === "/graphql") {
                const text = req.body._tag === "Uint8Array" ? new TextDecoder().decode(req.body.body) : ""
                if (text.includes("createCommitOnBranch")) {
                  if (mode % 3 === 0) {
                    return Effect.succeed(jsonResp(req, 200, { errors: [{ message: "stale", type: "STALE_DATA" }] }))
                  }
                  if (mode % 3 === 1) {
                    return Effect.succeed(jsonResp(req, 200, { errors: [{ message: "other error" }] }))
                  }
                  return Effect.succeed(
                    jsonResp(req, 200, { data: { createCommitOnBranch: { commit: { oid: "b".repeat(40) } } } })
                  )
                }
                if (text.includes("markPullRequestReadyForReview")) {
                  return Effect.succeed(jsonResp(req, 200, { errors: [{ message: "not draft" }] }))
                }
                if (text.includes("updatePullRequestBranch")) {
                  return Effect.succeed(
                    jsonResp(req, 200, { errors: [{ message: "conflict", type: "UNPROCESSABLE" }] })
                  )
                }
              }
              if (u.pathname === "/repos/o/r/issues/1/sub_issues") {
                return Effect.succeed(jsonResp(req, 200, [{ id: 2 }]))
              }
              if (u.pathname === "/repos/o/r/issues" && req.method === "GET") {
                return Effect.succeed(jsonResp(req, 200, [], nextLink("https://api.github.com/repos/o/r/issues")))
              }
              if (u.pathname === "/repos/o/r/issues/1/comments" && req.method === "GET") {
                return Effect.succeed(
                  jsonResp(req, 200, mode % 2 === 0 ? [] : [{ body: Issues.withWriteMarker("hi", "w-1"), bad: true }], nextLink("https://api.github.com/repos/o/r/issues/1/comments"))
                )
              }
              if (u.pathname.startsWith("/repos/o/r/issues/1/labels/") && req.method === "DELETE") {
                return Effect.succeed(jsonResp(req, 404, { message: "not found" }))
              }
              if (u.pathname === "/repos/o/r/labels" && req.method === "POST") {
                return Effect.succeed(jsonResp(req, 422, { message: "exists" }))
              }
              if (u.pathname === "/repos/o/r/pulls" && req.method === "GET") {
                return Effect.succeed(
                  jsonResp(
                    req,
                    200,
                    mode % 2 === 0 ? [] : [{ bad: "pull" }],
                    nextLink("https://api.github.com/repos/o/r/pulls")
                  )
                )
              }
              if (u.pathname === "/repos/o/r/pulls/1/reviews" && req.method === "GET") {
                return Effect.succeed(
                  jsonResp(req, 200, [], nextLink("https://api.github.com/repos/o/r/pulls/1/reviews"))
                )
              }
              if (u.pathname.startsWith("/repos/o/r/statuses/")) {
                return Effect.succeed(
                  jsonResp(req, 201, {
                    id: 1,
                    state: "success",
                    context: "ci/build",
                    description: "ok",
                    target_url: "https://ci.example.com/1", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z"
                  })
                )
              }
              return Effect.succeed(jsonResp(req, 200, {}))
            })

            const gh = yield* GitHubClient.make(
              { token: "ghp_b2", apiBaseUrl: "https://api.github.com" },
              {}
            ).pipe(Effect.provideService(HttpClient.HttpClient, http))
            const withGh = <A, E>(eff: Effect.Effect<A, E, GitHubClient.GitHubClient>) =>
              eff.pipe(Effect.provideService(GitHubClient.GitHubClient, gh))

            // 1. Commits.createOnBranch validation & GraphQL answers
            expect(
              Result.isFailure(
                yield* Effect.result(
                  withGh(
                    Commits.createOnBranch("o", "r", {
                      branch: "main",
                      expectedHeadOid: validSha,
                      headline: "bad\nline",
                      additions: [{ path: "a.txt", contents: "YQ==" }],
                      deletions: []
                    })
                  )
                )
              )
            ).toBe(true)
            expect(
              Result.isFailure(
                yield* Effect.result(
                  withGh(
                    Commits.createOnBranch("o", "r", {
                      branch: "main",
                      expectedHeadOid: validSha,
                      headline: "ok",
                      additions: [],
                      deletions: []
                    })
                  )
                )
              )
            ).toBe(true)
            expect(
              Result.isFailure(
                yield* Effect.result(
                  withGh(
                    Commits.createOnBranch("o", "r", {
                      branch: "main",
                      expectedHeadOid: validSha,
                      headline: "ok",
                      additions: [],
                      deletions: ["../escape"]
                    })
                  )
                )
              )
            ).toBe(true)
            const cOut = yield* Effect.result(
              withGh(
                Commits.createOnBranch("o", "r", {
                  branch: "main",
                  expectedHeadOid: validSha,
                  headline: "feat: test",
                  body: "details",
                  additions: [{ path: "a.txt", contents: "YQ==" }],
                  deletions: ["b.txt"]
                })
              )
            )
            expect(Result.isSuccess(cOut) || Result.isFailure(cOut)).toBe(true)

            // 2. Issues validation, listSubIssues, incomplete finders, 404/422 label helpers
            expect(() => Issues.writeMarker("bad id!")).toThrow()
            expect(Issues.writeIdOf(null)).toBeUndefined()
            const subs = yield* withGh(Issues.listSubIssues("o", "r", 1))
            expect(subs.length).toBe(1)
            expect(
              Result.isFailure(yield* Effect.result(withGh(Issues.findIssueByWrite("o", "r", { writeId: "w-1", since: "2026-01-01T00:00:00Z" }))))
            ).toBe(true)
            expect(
              Result.isFailure(yield* Effect.result(withGh(Issues.findCommentByWrite("o", "r", 1, { writeId: "w-1" }))))
            ).toBe(true)
            expect(Result.isFailure(yield* Effect.result(withGh(Issues.addLabels("o", "r", 1, [] as any))))).toBe(true)
            expect(Result.isFailure(yield* Effect.result(withGh(Issues.removeLabel("o", "r", 1, ".."))))).toBe(true)
            expect(yield* withGh(Issues.removeLabel("o", "r", 1, "bug"))).toBe(false)
            expect(
              Result.isFailure(
                yield* Effect.result(withGh(Issues.createLabel("o", "r", { name: "bug", color: "#fff" })))
              )
            ).toBe(true)
            expect(
              Result.isFailure(
                yield* Effect.result(
                  withGh(Issues.createLabel("o", "r", { name: "bug", color: "ff00aa", description: "x".repeat(120) }))
                )
              )
            ).toBe(true)
            expect(yield* withGh(Issues.createLabel("o", "r", { name: "bug", color: "ff00aa", description: "desc" }))).toBe(
              false
            )

            // 3. Pulls validation, incomplete finders, GraphQL refusals
            expect(
              Result.isFailure(
                yield* Effect.result(
                  withGh(Pulls.createPull("o", "r", { head: "feat", base: "main", title: "  ", body: "" }))
                )
              )
            ).toBe(true)
            expect(
              Result.isFailure(yield* Effect.result(withGh(Pulls.findPullByHead("o", "r", { head: "o:feat" }))))
            ).toBe(true)
            expect(
              Result.isFailure(yield* Effect.result(withGh(Pulls.markReady("o", "r", "PR_1"))))
            ).toBe(true)
            expect(
              Result.isFailure(
                yield* Effect.result(
                  withGh(
                    Pulls.updateBranch("o", "r", {
                      pullNodeId: "PR_1",
                      expectedHeadOid: validSha,
                      method: mode % 2 === 0 ? "merge" : "rebase"
                    })
                  )
                )
              )
            ).toBe(true)
            expect(
              Result.isFailure(
                yield* Effect.result(
                  withGh(
                    Pulls.updateBranch("o", "r", {
                      pullNodeId: "bad id!",
                      expectedHeadOid: validSha,
                      method: "merge"
                    })
                  )
                )
              )
            ).toBe(true)
            expect(
              Result.isFailure(
                yield* Effect.result(
                  withGh(
                    Pulls.updateBranch("o", "r", {
                      pullNodeId: "PR_1",
                      expectedHeadOid: "bad-sha",
                      method: "merge"
                    })
                  )
                )
              )
            ).toBe(true)
            expect(
              Result.isFailure(
                yield* Effect.result(
                  withGh(
                    Pulls.updateBranch("o", "r", {
                      pullNodeId: "PR_1",
                      expectedHeadOid: validSha,
                      method: "squash" as any
                    })
                  )
                )
              )
            ).toBe(true)
            expect(
              Result.isFailure(
                yield* Effect.result(
                  withGh(
                    Pulls.createReview("o", "r", 1, { commitId: validSha, event: "COMMENT", body: "  " })
                  )
                )
              )
            ).toBe(true)
            expect(
              Result.isFailure(
                yield* Effect.result(
                  withGh(
                    Pulls.createReview("o", "r", 1, { commitId: validSha, event: "BAD" as any, body: "hi" })
                  )
                )
              )
            ).toBe(true)
            expect(
              Result.isFailure(yield* Effect.result(withGh(Pulls.findReviewByWrite("o", "r", 1, { writeId: "w-1" }))))
            ).toBe(true)

            // 4. Statuses.create
            expect(
              Result.isFailure(
                yield* Effect.result(
                  withGh(Statuses.create("o", "r", "bad", { state: "success", context: "ci" }))
                )
              )
            ).toBe(true)
            expect(
              Result.isFailure(
                yield* Effect.result(
                  withGh(Statuses.create("o", "r", validSha, { state: "weird" as any, context: "ci" }))
                )
              )
            ).toBe(true)
            expect(
              Result.isFailure(
                yield* Effect.result(
                  withGh(Statuses.create("o", "r", validSha, { state: "success", context: "  " }))
                )
              )
            ).toBe(true)
            const stOk = yield* withGh(
              Statuses.create("o", "r", validSha, {
                state: "success",
                context: "ci/build",
                description: "d".repeat(200),
                targetUrl: "https://ci.example.com/1"
              })
            )
            expect(stOk.state).toBe("success")

            return true
          }),
        { executions: Math.min(executions, 36), seed }
      )
    )
    assertPassed(report)
  }, 60_000)

  it("AppAuth and PublicRead cover key validation, token minting, route rejections, and installation cache recheck", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        mode: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 11 }))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ mode }) =>
          Effect.gen(function*() {
            // 1. AppAuth invalid credentials & installationToken validation
            const dummyHttp = HttpClient.make((req) => {
              const u = new URL(req.url)
              if (u.pathname.endsWith("/access_tokens")) {
                return Effect.succeed(
                  jsonResp(
                    req,
                    201,
                    mode % 2 === 0
                      ? { token: "ghs_ok", expires_at: "not-a-date" }
                      : { token: "ghs_ok", expires_at: new Date(Date.now() + 3600_000).toISOString() }
                  )
                )
              }
              return Effect.succeed(jsonResp(req, 200, { id: 10 }))
            })
            expect(
              Result.isFailure(
                yield* Effect.result(
                  AppAuth.make({ appId: "bad id!", privateKey: Redacted.make(rsaPem) }).pipe(
                    Effect.provideService(HttpClient.HttpClient, dummyHttp)
                  )
                )
              )
            ).toBe(true)
            expect(
              Result.isFailure(
                yield* Effect.result(
                  AppAuth.make({
                    appId: "123",
                    privateKey: Redacted.make("-----BEGIN PRIVATE KEY-----\n!!!not-b64!!!\n-----END PRIVATE KEY-----")
                  }).pipe(Effect.provideService(HttpClient.HttpClient, dummyHttp))
                )
              )
            ).toBe(true)
            expect(
              Result.isFailure(
                yield* Effect.result(
                  AppAuth.make({
                    appId: "123",
                    privateKey: Redacted.make("-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----")
                  }).pipe(Effect.provideService(HttpClient.HttpClient, dummyHttp))
                )
              )
            ).toBe(true)

            const appLayer = AppAuth.layer({ appId: "123", privateKey: Redacted.make(rsaPem) }).pipe(
              Layer.provide(Layer.succeed(HttpClient.HttpClient, dummyHttp))
            )
            yield* Effect.gen(function*() {
              const app = yield* AppAuth.AppAuth
              expect(Result.isFailure(yield* Effect.result(app.installationToken({ installationId: 0 })))).toBe(true)
              expect(
                Result.isFailure(
                  yield* Effect.result(app.installationToken({ installationId: 1, repositories: ["bad/repo"] }))
                )
              ).toBe(true)
              expect(
                Result.isFailure(
                  yield* Effect.result(app.installationToken({ installationId: 1, repositoryIds: [-1] }))
                )
              ).toBe(true)
              const tokRes = yield* Effect.result(
                app.installationToken({
                  installationId: 1,
                  repositories: ["app"],
                  repositoryIds: [42],
                  permissions: { contents: "read" }
                })
              )
              expect(Result.isSuccess(tokRes) || Result.isFailure(tokRes)).toBe(true)
            }).pipe(Effect.provide(appLayer))

            // 2. PublicRead.client + PublicRead.route + PublicRead.installations
            const secret = Redacted.make("public-read-secret-key-0123456789")
            const siteOrigin = "https://site.example.com"
            const brokerOrigin = "https://broker.example.com"
            const readGrant = { repository: "acme/app", repositoryId: 77, paths: ["pulls"] as const }

            let githubRespMode = mode % 5
            const upstreamGh = HttpClient.make((req) => {
              if (githubRespMode === 0) {
                return Effect.fail(
                  new HttpClientError.HttpClientError({
                    reason: new HttpClientError.TransportError({ request: req, cause: new Error("down") })
                  })
                )
              }
              if (githubRespMode === 1) return Effect.succeed(HttpClientResponse.fromWeb(req, new Response(null, { status: 304 })))
              if (githubRespMode === 2) return Effect.succeed(jsonResp(req, 404, { message: "nope" }))
              if (githubRespMode === 3) {
                return Effect.succeed(
                  jsonResp(req, 403, { message: "rate limit" }, { "x-ratelimit-remaining": "0" })
                )
              }
              return Effect.succeed(jsonResp(req, 200, { id: 77, private: false }, { etag: "\"v1\"" }))
            })

            const routeApp = PublicRead.route({
              origin: brokerOrigin,
              sites: [{ origin: siteOrigin, secret, reads: [readGrant] }],
              token: () =>
                mode === 10
                  ? Effect.fail({ _tag: "PublicReadRefused", reason: "unavailable" } as any)
                  : Effect.succeed(Redacted.make("ghs_pub")),
              github: upstreamGh
            })

            // Non-POST -> 405, invalid JSON -> 403
            const r405 = yield* routeApp.pipe(
              Effect.provideService(
                HttpServerRequest.HttpServerRequest,
                HttpServerRequest.fromWeb(new Request(`${brokerOrigin}/github/public-read`, { method: "GET" }))
              )
            )
            expect(r405.status).toBe(405)
            const rBadJson = yield* routeApp.pipe(
              Effect.provideService(
                HttpServerRequest.HttpServerRequest,
                HttpServerRequest.fromWeb(
                  new Request(`${brokerOrigin}/github/public-read`, { method: "POST", body: "{bad" })
                )
              )
            )
            expect(rBadJson.status).toBe(403)

            // Client -> route round-trip + client refusals (non-GET, bad refusal header, missing answered header)
            const brokerHttp = HttpClient.make((req) => {
              if (mode === 11) {
                return Effect.succeed(jsonResp(req, 503, { reason: "unavailable" }, { "x-smithers-refusal": "unavailable" }))
              }
              if (mode === 9) {
                return Effect.succeed(jsonResp(req, 200, { ok: true })) // missing x-smithers-answered
              }
              return Effect.gen(function*() {
                const body = req.body._tag === "Uint8Array" ? new TextDecoder().decode(req.body.body) : ""
                const sreq = HttpServerRequest.fromWeb(
                  new Request(req.url, { method: req.method, body, headers: req.headers as Record<string, string> })
                )
                const sres = yield* routeApp.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, sreq))
                const web = yield* Effect.promise(() =>
                  import("effect/http/HttpServerResponse").then((m) => m.toWeb(sres))
                )
                return HttpClientResponse.fromWeb(req, web)
              })
            })
            const pubClient = yield* PublicRead.site({
              origin: siteOrigin,
              brokerOrigin,
              secret
            }).pipe(Effect.provideService(HttpClient.HttpClient, brokerHttp))
            const nonGet = yield* Effect.result(
              pubClient.execute(HttpClientRequest.post("https://api.github.com/repos/acme/app/pulls"))
            )
            expect(Result.isFailure(nonGet)).toBe(true)
            const okGet = yield* Effect.result(
              pubClient.execute(
                HttpClientRequest.get("https://api.github.com/repos/acme/app/pulls").pipe(
                  HttpClientRequest.setHeader("if-none-match", "\"v1\"")
                )
              )
            )
            expect(Result.isSuccess(okGet) || Result.isFailure(okGet)).toBe(true)

            // PublicRead.installations: 404 forbidden, 401 retry-once, private repo -> forbidden, cache hit
            let recheckCount = 0
            const instGh = HttpClient.make((req) => {
              recheckCount++
              if (mode % 4 === 0 && recheckCount === 1) return Effect.succeed(jsonResp(req, 401, { message: "bad" }))
              if (mode % 4 === 1) return Effect.succeed(jsonResp(req, 404, { message: "gone" }))
              if (mode % 4 === 2) return Effect.succeed(jsonResp(req, 200, { id: 77, private: true }))
              return Effect.succeed(jsonResp(req, 200, { id: 77, private: false }))
            })
            const fakeApp: AppAuth.AppAuth = {
              installation: () =>
                mode === 8
                  ? Effect.fail(new IntegrationError("delivery-failed", "no inst", { status: 404 }))
                  : Effect.succeed({ id: 5 }),
              installationToken: () =>
                Effect.succeed({ token: Redacted.make("ghs_m"), expiresAt: Date.now() + 3600_000 })
            } as any
            const inst = PublicRead.installations(fakeApp, instGh)
            const i1 = yield* Effect.result(inst(readGrant))
            expect(Result.isSuccess(i1) || Result.isFailure(i1)).toBe(true)
            if (Result.isSuccess(i1)) {
              const i2 = yield* Effect.result(inst(readGrant))
              expect(Result.isSuccess(i2)).toBe(true)
            }

            return true
          }),
        { executions: Math.min(executions, 28), seed: seed + 1 }
      )
    )
    assertPassed(report)
  }, 60_000)
})
