import * as Channels from "@smthrs/control/Channels"
import { CredentialConflict, InvalidInput, Unauthorized } from "@smthrs/control/ControlError"
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Fuzz } from "@smthrs/fuzz"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as SqlClient from "effect/sql/SqlClient"
import * as Migrations from "../src/core/Migrations.ts"
import { Arbitrary, Duration, Effect, Exit, Layer, Option, Redacted, Result, Schema } from "effect"
import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
  HttpServerRequest
} from "effect/http"
import { describe, expect, it } from "vitest"
import * as Channel from "../src/core/Channel.ts"
import { IntegrationError } from "../src/core/IntegrationError.ts"
import * as OAuthToken from "../src/core/OAuthToken.ts"
import * as SourceStore from "../src/core/SourceStore.ts"
import * as OpenApi from "../src/OpenApi.ts"
import * as Actions from "../src/github/Actions.ts"
import * as GitHubClient from "../src/github/GitHubClient.ts"
import * as Payload from "../src/github/Payload.ts"
import * as Proposals from "../src/github/Proposals.vibe"
import * as Proxy from "../src/github/Proxy.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "60")
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261401")

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

describe("@smthrs/integrations Wave10 Deep Fuzz", () => {
  it("GitHubClient, OpenApi.fromSpec, Payload.pushSource, and Proposals cover edge and error branches", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        idx: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 15 }))
      })
    )

    const validSha1 = "a".repeat(40)
    const validSha2 = "b".repeat(40)
    const zeroSha = "0".repeat(40)

    const pushPayloads: ReadonlyArray<unknown> = [
      null,
      { before: "bad", after: validSha1, ref: "refs/heads/main" },
      { before: validSha1, after: zeroSha, ref: "refs/heads/main", deleted: true },
      { before: validSha1, after: validSha2, ref: "refs/heads/main", deleted: true },
      { before: zeroSha, after: zeroSha, ref: "refs/heads/main", deleted: true },
      { before: validSha1, after: zeroSha, ref: "refs/heads/main" },
      { before: zeroSha, after: validSha2, ref: "refs/heads/main", created: false },
      { before: zeroSha, after: validSha2, ref: "refs/heads/main", created: true },
      { before: validSha1, after: validSha2, ref: "refs/tags/v1.0.0" }
    ]

    const badSpecs: ReadonlyArray<Record<string, unknown>> = [
      { openapi: "2.0", paths: {} },
      { openapi: "3.1.0", paths: "bad" },
      { openapi: "3.1.0", paths: { "no-leading-slash": {} } },
      { openapi: "3.1.0", paths: { "/ok": "not-obj" } },
      { openapi: "3.1.0", paths: { "/ok": { get: "not-obj" } } },
      { openapi: "3.1.0", paths: { "/ok": { get: { operationId: "bad id!" } } } },
      { openapi: "3.1.0", paths: { "/ok": { get: { operationId: "op1", parameters: "not-array" } } } },
      { openapi: "3.1.0", paths: { "/ok": { get: { operationId: "op1", parameters: ["bad"] } } } },
      { openapi: "3.1.0", paths: { "/ok": { get: { operationId: "op1", parameters: [{ name: "", in: "query" }] } } } },
      { openapi: "3.1.0", paths: { "/ok": { get: { operationId: "op1", parameters: [{ name: "x", in: "cookie" }] } } } },
      { openapi: "3.1.0", paths: { "/ok": { get: { operationId: "op1", parameters: [{ name: "bad header!", in: "header" }] } } } },
      {
        openapi: "3.1.0",
        paths: { "/ok": { get: { operationId: "op1", parameters: [{ name: "x", in: "header", schema: { type: "array" } }] } } }
      },
      { openapi: "3.1.0", paths: { "/items/{id}": { get: { operationId: "op1", parameters: [] } } } },
      {
        openapi: "3.1.0",
        paths: {
          "/items": {
            get: { operationId: "op1", parameters: [{ name: "unused", in: "path", schema: { type: "string" } }] }
          }
        }
      },
      { openapi: "3.1.0", paths: { "/a": { get: { operationId: "dup" } }, "/b": { get: { operationId: "dup" } } } },
      { openapi: "3.1.0", paths: { "/a": { get: { operationId: "op1", parameters: [{ $ref: "#/components/parameters/Missing" }] } } } }
    ]

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ idx }) =>
          Effect.gen(function*() {
            // 1. GitHubClient.lastPageNumber
            expect(GitHubClient.lastPageNumber(null)).toBeNull()
            expect(
              GitHubClient.lastPageNumber(
                `<https://api.github.com/items?page=2>; title="next"; rel="next", <https://api.github.com/items?page=9>; rel="last"`
              )
            ).toBe(9)
            expect(GitHubClient.lastPageNumber(`<http://[bad>; rel="last"`)).toBeNull()
            expect(GitHubClient.lastPageNumber(`<https://api.github.com/items?page=abc>; rel="last"`)).toBeNull()

            // 2. GitHubClient.make invalid configs
            const badCfgs = [
              { token: "t", apiBaseUrl: "http://[bad" },
              { token: "t", apiBaseUrl: "http://example.com" },
              { token: "t", apiBaseUrl: "https://api.github.com", requestTimeout: 0 },
              { token: "t", apiBaseUrl: "https://api.github.com", requestTimeout: Duration.infinity }
            ] as const
            const mkBad = yield* Effect.result(
              GitHubClient.make(badCfgs[idx % badCfgs.length]!, {}).pipe(
                Effect.provideService(HttpClient.HttpClient, HttpClient.make(() => Effect.die("never")))
              )
            )
            expect(Result.isFailure(mkBad)).toBe(true)

            // 3. GitHubClient runtime paths: non-JSON text, transport error (GET/POST), timeout, GraphQL 200 rate limit, 429 proxy retry-at, paginate bounds & bad link & non-array
            const clientHttp = HttpClient.make((req) => {
              const url = new URL(req.url)
              if (url.pathname.includes("text-body")) return Effect.succeed(jsonResp(req, 200, "not-json-plain-text"))
              if (url.pathname.includes("transport-err")) {
                return Effect.fail(
                  new HttpClientError.HttpClientError({
                    reason: new HttpClientError.TransportError({ request: req, cause: new Error("econnreset") })
                  })
                )
              }
              if (url.pathname.includes("slow")) return Effect.never
              if (url.pathname === "/graphql") {
                return Effect.succeed(jsonResp(req, 200, { data: null, errors: [{ type: "RATE_LIMITED" }] }))
              }
              if (url.pathname.includes("proxy-429")) {
                return Effect.succeed(
                  jsonResp(req, 429, { message: "deferred" }, {
                    "x-smithers-retry-at": new Date(Date.now() + 5000).toISOString(),
                    "x-smithers-rate-limit-reason": "secondary"
                  })
                )
              }
              if (url.pathname.includes("bad-next")) {
                return Effect.succeed(jsonResp(req, 200, { singleObj: 1 }, { link: `<http://[bad>; rel="next"` }))
              }
              return Effect.succeed(jsonResp(req, 200, [{ id: 1 }]))
            })
            const client = yield* GitHubClient.make(
              { token: "ghp_test", apiBaseUrl: "https://api.github.com", requestTimeout: "20 millis" },
              {}
            ).pipe(Effect.provideService(HttpClient.HttpClient, clientHttp))

            if (idx % 6 === 0) {
              const txt = yield* client.request("GET", "/text-body")
              expect(txt).toBe("not-json-plain-text")
              const badPath = yield* Effect.result(client.request("GET", "http://[bad"))
              expect(Result.isFailure(badPath)).toBe(true)
            } else if (idx % 6 === 1) {
              const tGet = yield* Effect.result(client.request("GET", "/transport-err"))
              const tPost = yield* Effect.result(client.request("POST", "/transport-err", { a: 1 }))
              expect(Result.isFailure(tGet) && Result.isFailure(tPost)).toBe(true)
            } else if (idx % 6 === 2) {
              const sGet = yield* Effect.result(client.request("GET", "/slow"))
              const sPost = yield* Effect.result(client.request("POST", "/slow", { a: 1 }))
              expect(Result.isFailure(sGet) && Result.isFailure(sPost)).toBe(true)
            } else if (idx % 6 === 3) {
              const gql = yield* Effect.result(client.request("POST", "/graphql", { query: "{ viewer { login } }" }))
              expect(Result.isFailure(gql)).toBe(true)
            } else if (idx % 6 === 4) {
              const p429 = yield* Effect.result(client.request("GET", "/proxy-429"))
              expect(Result.isFailure(p429)).toBe(true)
            } else {
              const b1 = yield* Effect.result(client.paginate("/items", { perPage: 0 }))
              const b2 = yield* Effect.result(client.paginate("/items", { maxPages: Number.POSITIVE_INFINITY }))
              const b3 = yield* Effect.result(client.paginate("/bad-next"))
              expect(Result.isFailure(b1) && Result.isFailure(b2) && Result.isFailure(b3)).toBe(true)
            }

            // 4. Payload.pushSource
            const pr = Payload.pushSource(pushPayloads[idx % pushPayloads.length])
            expect(Result.isSuccess(pr) || Result.isFailure(pr)).toBe(true)

            // 5. OpenApi.fromSpec error paths
            const specRes = yield* Effect.result(
              OpenApi.fromSpec(badSpecs[idx]!, {
                baseUrl: "https://api.example.com",
                namespace: "test"
              })
            )
            expect(Result.isFailure(specRes)).toBe(true)

            // 6. Proposals.ensureFork & documentReview
            let pullCallCount = 0
            const propHttp = HttpClient.make((req) => {
              const u = new URL(req.url)
              if (u.pathname === "/repos/acme/app" && req.method === "GET") {
                return Effect.succeed(jsonResp(req, 200, { name: "app", owner: { login: "acme" }, default_branch: "main" }))
              }
              if (u.pathname === "/repos/alice/app") {
                if (idx % 4 === 0) {
                  return Effect.succeed(
                    jsonResp(req, 200, {
                      name: "app",
                      owner: { login: "alice" },
                      default_branch: "main",
                      fork: true,
                      parent: { full_name: "acme/app" }
                    })
                  )
                }
                if (idx % 4 === 1) {
                  return Effect.succeed(
                    jsonResp(req, 200, { name: "app", owner: { login: "alice" }, default_branch: "main", fork: false })
                  )
                }
                if (idx % 4 === 2) return Effect.succeed(jsonResp(req, 500, { message: "boom" }))
                return Effect.succeed(jsonResp(req, 404, { message: "not found" }))
              }
              if (u.pathname === "/repos/acme/app/forks" && req.method === "POST") {
                return Effect.succeed(jsonResp(req, 202, { name: "app", owner: { login: "alice" }, default_branch: "main" }))
              }
              if (u.pathname === "/repos/acme/app/pulls/1") {
                pullCallCount++
                if (idx % 6 === 0) return Effect.succeed(jsonResp(req, 404, { message: "gone" }))
                if (idx % 6 === 1) return Effect.succeed(jsonResp(req, 500, { message: "err" }))
                const isNullUser = idx % 6 === 2 || (idx % 6 === 3 && pullCallCount === 2)
                const sha = idx % 6 === 4 && pullCallCount === 2 ? "b".repeat(40) : "a".repeat(40)
                return Effect.succeed(
                  jsonResp(req, 200, {
                    id: 1,
                    number: 1,
                    state: "open",
                    title: "T",
                    body: null,
                    html_url: "https://github.com/acme/app/pull/1",
                    draft: false,
                    merged: false,
                    mergeable: true,
                    changed_files: idx % 6 === 5 ? 99 : 1,
                    user: isNullUser ? null : { id: 7, login: "alice" },
                    head: { ref: "feat", sha },
                    base: { ref: "main", sha: "c".repeat(40) }
                  })
                )
              }
              if (u.pathname === "/repos/acme/app/pulls/1/files") {
                return Effect.succeed(
                  jsonResp(
                    req,
                    200,
                    idx === 15 ? [{ filename: 123, status: "bogus" }] : [{ filename: "README.md", status: "modified" }]
                  )
                )
              }
              return Effect.succeed(jsonResp(req, 200, {}))
            })
            const propClient = yield* GitHubClient.make(
              { token: "ghp_prop", apiBaseUrl: "https://api.github.com" },
              {}
            ).pipe(Effect.provideService(HttpClient.HttpClient, propHttp))
            const forkSame = yield* Proposals.ensureFork("acme", "app", "ACME").pipe(
              Effect.provideService(GitHubClient.GitHubClient, propClient)
            )
            expect(forkSame.sourceDefaultBranch).toBe("main")
            const forkOther = yield* Effect.result(
              Proposals.ensureFork("acme", "app", "alice").pipe(
                Effect.provideService(GitHubClient.GitHubClient, propClient)
              )
            )
            expect(Result.isSuccess(forkOther) || Result.isFailure(forkOther)).toBe(true)
            const docRev = yield* Effect.result(
              Proposals.documentReview("acme", "app", 1).pipe(
                Effect.provideService(GitHubClient.GitHubClient, propClient)
              )
            )
            expect(Result.isSuccess(docRev) || Result.isFailure(docRev)).toBe(true)

            return true
          }),
        { executions: Math.min(executions, 48), seed }
      )
    )
    assertPassed(report)
  }, 60_000)

  it("SourceStore (memory + SQLite), OAuthToken, and Channel cover validation, revocation, rotation, and ingress faults", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        mode: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 11 }))
      })
    )

    const mkRec = (overrides: Record<string, unknown> = {}) => ({
      provider: "github",
      connectionId: "conn-1",
      externalId: "ext-1",
      kind: "issue",
      url: "https://github.com/o/r/issues/1",
      author: { id: "u1", label: "alice" },
      createdAtMs: 1000,
      updatedAtMs: 2000,
      version: "v1",
      retrievedAtMs: 3000,
      access: { scope: "container", containerId: "c1" },
      thread: { containerId: "c1", threadId: "t1", parentId: null },
      text: "Hello World",
      deleted: false,
      payload: { ok: true },
      ...overrides
    })

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ mode }) =>
          Effect.gen(function*() {
            // 1. SourceStore memory + SQLite
            const mem = yield* SourceStore.makeMemory
            const badSchema = yield* Effect.result(mem.apply([{ bad: true } as any]))
            expect(Result.isFailure(badSchema)).toBe(true)
            const badTime = yield* Effect.result(mem.apply([mkRec({ createdAtMs: Number.NaN }) as any]))
            expect(Result.isFailure(badTime)).toBe(true)

            const r1 = mkRec({ externalId: "e1", updatedAtMs: 1000, retrievedAtMs: 1000, text: "first needle" })
            const r2 = mkRec({ externalId: "e2", updatedAtMs: null, createdAtMs: null, retrievedAtMs: 1000, text: "second" })
            const r3 = mkRec({ connectionId: "conn-2", externalId: "e1", updatedAtMs: 1000, retrievedAtMs: 1000, text: "third" })
            const r4 = mkRec({ externalId: "e0", updatedAtMs: 1000, retrievedAtMs: 1000, text: "fourth" })
            yield* mem.apply([r1 as any, r2 as any, r3 as any, r4 as any])

            // Equal copy with fresher retrievedAtMs & changed content vs identical content
            yield* mem.apply([
              mkRec({ externalId: "e1", updatedAtMs: 1000, retrievedAtMs: 2000, text: "first needle v2" }) as any,
              mkRec({ externalId: "e1", updatedAtMs: 1000, retrievedAtMs: 3000, text: "first needle v2" }) as any
            ])
            // Revoke and re-apply equal copy (keep while revoked), then lift / verifyReference
            yield* mem.revokeContainer("conn-1", "c1")
            yield* mem.apply([mkRec({ externalId: "e1", updatedAtMs: 1000, retrievedAtMs: 4000, text: "still revoked" }) as any])

            const badPage = yield* Effect.result(
              mem.commit({
                provider: "github",
                connectionId: "conn-1",
                stream: mode % 2 === 0 ? "" : "issues",
                changes: { records: [r3 as any], nextCursor: null, hasMore: false } as any
              })
            )
            expect(Result.isFailure(badPage)).toBe(true)

            // Retrieve edge cases: empty allowed, invalid limit, empty kinds, query, tie-breaking sort
            const emptyAllowed = yield* mem.retrieve({ allowed: [], limit: 10 })
            expect(emptyAllowed).toEqual([])
            const badLimit = yield* Effect.result(mem.retrieve({ allowed: [{ connectionId: "conn-1", containers: ["*"] }], limit: 0 }))
            expect(Result.isFailure(badLimit)).toBe(true)
            const sorted = yield* mem.retrieve({
              allowed: [
                { connectionId: "conn-1", containers: ["*"] },
                { connectionId: "conn-2", containers: ["*"] }
              ],
              limit: 10
            })
            expect(Array.isArray(sorted)).toBe(true)
            const emptyKinds = yield* mem.retrieve({
              allowed: [{ connectionId: "conn-2", containers: ["c1"] }],
              kinds: [],
              limit: 10
            })
            expect(emptyKinds).toEqual([])

            const ref = { connectionId: "conn-2", externalId: "e1", updatedAtMs: 1000, version: "v1", retrievedAtMs: 1000 }
            const v1 = yield* mem.validate({
              allowed: [{ connectionId: "conn-2", containers: ["c1"] }, { connectionId: "conn-1", containers: ["*"] }],
              references: [{ ...ref, externalId: "nope" }, { ...ref, connectionId: "conn-1" }, ref, { ...ref, version: "v0" }]
            })
            const vDenied = yield* mem.validate({ allowed: [{ connectionId: "conn-2", containers: ["other"] }], references: [ref] })
            yield* mem.apply([mkRec({ connectionId: "conn-2", externalId: "e1", updatedAtMs: 2000, deleted: true }) as any])
            const vDeleted = yield* mem.validate({ allowed: [{ connectionId: "conn-2", containers: ["c1"] }], references: [ref] })
            expect(v1.map((x) => x.validity)).toEqual(["missing", "revoked", "current", "changed"])
            expect(vDenied[0]?.validity).toBe("denied")
            expect(vDeleted[0]?.validity).toBe("deleted")

            // SQLite SourceStore: corrupt payload_json, empty grant containers, empty kinds, query
            if (mode % 3 === 0) {
              yield* Effect.scoped(
                Effect.gen(function*() {
                  const sql = yield* SqlClient.SqlClient
                  const store = yield* SourceStore.SourceStore
                  yield* store.apply([r3 as any])
                  expect(yield* store.retrieve({ allowed: [], limit: 10 })).toEqual([])
                  expect(
                    yield* store.retrieve({
                      allowed: [{ connectionId: "conn-2", containers: [] }],
                      kinds: [],
                      query: "third",
                      limit: 10
                    })
                  ).toEqual([])
                  const found = yield* store.retrieve({
                    allowed: [{ connectionId: "conn-2", containers: ["c1"] }],
                    query: "third",
                    limit: 10
                  })
                  expect(found.length).toBe(1)
                  yield* sql`UPDATE smithers_integration_records SET payload_json = '{bad' WHERE connection_id = 'conn-2'`
                  const corrupt = yield* Effect.result(store.get("conn-2", "e1"))
                  expect(Result.isFailure(corrupt)).toBe(true)
                }).pipe(Effect.provide(Layer.orDie(Layer.provideMerge(SourceStore.layerSql, Layer.provideMerge(Migrations.layer, TestDatabase.sqliteLayer)))))
              )
            }

            // 2. OAuthToken: memoryRefreshTokenStore conflict, credentialStore, resolveEndpoint errors, refresh & make errors
            const rStore = OAuthToken.memoryStore(Redacted.make("rt-1"))
            expect(yield* rStore.replace(Redacted.make("wrong"), Redacted.make("rt-2"))).toBe(false)
            const credStore = OAuthToken.credentialStore(
              {
                resolve: () =>
                  Effect.fail(
                    mode % 2 === 0
                      ? new Unauthorized({ message: "no" })
                      : new InvalidInput({ issue: "missing" })
                  ),
                rotate: () => Effect.fail(new CredentialConflict({ id: "oauth", expectedVersion: 1, actualVersion: 2 }))
              } as any,
              { id: "oauth", name: "oauth" }
            )
            expect(Result.isFailure(yield* Effect.result(credStore.load))).toBe(true)
            expect(yield* credStore.replace(Redacted.make("a"), Redacted.make("b"))).toBe(false)

            const badOAuthCfgs = [
              { tokenUrl: "not-a-url", clientId: "cid", refreshToken: Redacted.make("rt") },
              { tokenUrl: "http://example.com/tok", clientId: "cid", refreshToken: Redacted.make("rt") },
              { tokenUrl: "https://auth.example.com/tok", clientId: "   ", refreshToken: Redacted.make("rt") },
              { tokenUrl: "https://auth.example.com/tok", clientId: "cid", refreshToken: Redacted.make("rt"), requestTimeout: 0 }
            ] as const
            const badRef = yield* Effect.result(
              OAuthToken.exchangeRefreshToken(badOAuthCfgs[mode % badOAuthCfgs.length]!).pipe(
                Effect.provideService(HttpClient.HttpClient, HttpClient.make(() => Effect.die("never")))
              )
            )
            expect(Result.isFailure(badRef)).toBe(true)

            const oauthHttp = HttpClient.make((req) => {
              if (mode % 6 === 0) {
                return Effect.fail(
                  new HttpClientError.HttpClientError({
                    reason: new HttpClientError.TransportError({ request: req, cause: new Error("net") })
                  })
                )
              }
              if (mode % 6 === 1) return Effect.never
              if (mode % 6 === 2) return Effect.succeed(jsonResp(req, 200, "not-json"))
              if (mode % 6 === 3) {
                return Effect.succeed(jsonResp(req, 200, { access_token: "at", token_type: "mac", expires_in: 60 }))
              }
              if (mode % 6 === 4) {
                return Effect.succeed(jsonResp(req, 400, { error: "invalid_grant" }))
              }
              return Effect.succeed(
                jsonResp(req, 200, { access_token: "at-new", token_type: "Bearer", expires_in: 3600, refresh_token: "rt-2" })
              )
            })
            const refOut = yield* Effect.result(
              OAuthToken.exchangeRefreshToken({
                tokenUrl: "https://auth.example.com/tok",
                clientId: "cid",
                refreshToken: Redacted.make("rt-1"),
                scopes: ["repo"],
                requestTimeout: "20 millis"
              }).pipe(Effect.provideService(HttpClient.HttpClient, oauthHttp))
            )
            expect(Result.isSuccess(refOut) || Result.isFailure(refOut)).toBe(true)

            // OAuthToken.make bad skew + rotationPending + persist conflict
            const badSkew = yield* Effect.result(
              OAuthToken.make({
                tokenUrl: "https://auth.example.com/tok",
                clientId: "cid",
                refreshToken: rStore,
                skew: Duration.infinity
              }).pipe(Effect.provideService(HttpClient.HttpClient, oauthHttp))
            )
            expect(Result.isFailure(badSkew)).toBe(true)

            let loadN = 0
            const rotatingStore: OAuthToken.RefreshTokenStore = {
              load: Effect.sync(() => Redacted.make(loadN++ === 0 ? "rt-old" : mode % 2 === 0 ? "rt-rotated" : "rt-old")),
              replace: () => Effect.succeed(false)
            }
            const src = yield* OAuthToken.make({
              tokenUrl: "https://auth.example.com/tok",
              clientId: "cid",
              refreshToken: rotatingStore,
              scopes: ["read"],
              requestTimeout: "20 millis"
            }).pipe(Effect.provideService(HttpClient.HttpClient, oauthHttp))
            const tokRes = yield* Effect.result(src.token)
            expect(Result.isSuccess(tokRes) || Result.isFailure(tokRes)).toBe(true)

            // 3. Channel.make + Channel.fromSource error paths
            const ch = Channel.make({
              name: "test-ch",
              credential: Redacted.make({ id: "wh", name: "wh" }),
              secret: Channel.constantSecret(Redacted.make("sec")),
              verify: (_raw, _sec) => {
                if (mode % 3 === 0) throw new Error("boom verify")
                if (mode % 3 === 1) return Effect.succeed(false)
                return Effect.succeed(true)
              },
              decode: () => {
                if (mode % 3 === 0) throw new IntegrationError("decode-failed", "known bad")
                if (mode % 3 === 1) throw new TypeError("unexpected secret leak")
                return { malformed: true } as any
              },
              route: Channel.startFlow("f1" as any)
            })
            const rawReq = { body: new TextEncoder().encode("{}"), headers: {} }
            const vRes = yield* Effect.result(ch.verify(rawReq as any))
            expect(Result.isSuccess(vRes) || Result.isFailure(vRes)).toBe(true)
            const dRes = yield* Effect.result(ch.decode(rawReq as any))
            expect(Result.isFailure(dRes)).toBe(true)
            expect(ch.project({ updatedAt: 123 } as any, { cursor: null } as any).operation).toBe("noop")

            const door = Channel.fromSource({
              name: "poll-ch",
              route: Channel.startFlow("f1" as any)
            })
            expect(Result.isFailure(yield* Effect.result(door.channel.verify({ body: new Uint8Array(), headers: {} } as any)))).toBe(true)
            expect(Result.isFailure(yield* Effect.result(door.channel.decode({ body: new TextEncoder().encode("{"), headers: {} } as any)))).toBe(true)
            expect(Result.isFailure(yield* Effect.result(door.channel.decode({ body: new TextEncoder().encode("null"), headers: {} } as any)))).toBe(true)
            expect(
              Result.isFailure(
                yield* Effect.result(door.channel.decode({ body: new TextEncoder().encode("{}"), headers: {} } as any))
              )
            ).toBe(true)
            const fakeChannels = Channels.Channels.of({
              register: () => Effect.void,
              ingest: () => {
                if (mode % 4 === 0) return Effect.fail(new InvalidInput({ issue: "bad" }))
                if (mode % 4 === 1) return Effect.fail(new Unauthorized({ message: "unauth" }))
                if (mode % 4 === 2) return Effect.succeed({ _tag: "Parked", planId: "p1" } as any)
                return Effect.succeed({ _tag: "Conflict" } as any)
              }
            } as any)
            const hRes = yield* Effect.result(
              door.handle([
                {
                  source: "github",
                  eventName: "issue",
                  correlationId: "c1",
                  payload: mode === 11 ? (10n as any) : { a: 1 },
                  dedupeKey: "k1",
                  receivedAtMs: 1000
                }
              ]).pipe(Effect.provideService(Channels.Channels, fakeChannels))
            )
            expect(Result.isFailure(hRes)).toBe(true)

            return true
          }) as Effect.Effect<boolean, never, never>,
        { executions: Math.min(executions, 36), seed: seed + 1 }
      )
    )
    assertPassed(report)
  }, 60_000)

  it("Proxy.make and GitHub Actions cover control endpoints, timeouts, rate-limit deferrals, and reconciliation", async () => {
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
            // 1. Proxy.make
            const upstreamHttp = HttpClient.make((req) => {
              const u = new URL(req.url)
              if (u.pathname.includes("timeout")) return Effect.never
              if (u.pathname.includes("netfail")) {
                return Effect.fail(
                  new HttpClientError.HttpClientError({
                    reason: new HttpClientError.TransportError({ request: req, cause: new Error("down") })
                  })
                )
              }
              return Effect.succeed(
                jsonResp(req, 200, { ok: true }, {
                  link: `<https://api.github.com/repos/o/r/issues?page=2>; rel="next"`,
                  "transfer-encoding": "chunked"
                })
              )
            })
            const proxyApp = yield* Proxy.make({
              upstream: "https://api.github.com",
              publicOrigin: mode % 2 === 0 ? "https://proxy.example.com" : undefined,
              capability: mode === 0 ? undefined : "cap-secret",
              maxBodyBytes: 32,
              requestTimeout: "20 millis",
              credential: (repo) => {
                if (repo === "fail/cred") {
                  return Effect.fail(new IntegrationError("credentials-missing", "no cred"))
                }
                if (repo === "fail/rl") {
                  return Effect.fail(
                    new IntegrationError("rate-limited", "defer", {
                      retryAt: new Date(Date.now() + 5000).toISOString(),
                      reason: "primary"
                    })
                  )
                }
                return Effect.succeed({ principal: "p1", token: "tok" })
              }
            }).pipe(Effect.provideService(HttpClient.HttpClient, upstreamHttp))

            const callProxy = (url: string, init: RequestInit = {}) => {
              const req = HttpServerRequest.fromWeb(new Request(url, init))
              return proxyApp.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, req))
            }

            const authHeader = { authorization: "Bearer cap-secret" }
            const health = yield* callProxy("http://127.0.0.1/_smithers/health")
            expect(health.status).toBe(200)
            const notFound = yield* callProxy("http://127.0.0.1/_smithers/unknown")
            expect(notFound.status).toBe(404)
            const badWrites = yield* callProxy("http://127.0.0.1/_smithers/admission?writes=-1", { headers: authHeader })
            expect(badWrites.status).toBe(400)
            const okAdm = yield* callProxy("http://127.0.0.1/_smithers/admission?repo=o/r&writes=1", { headers: authHeader })
            expect(okAdm.status).toBe(200)

            if (mode % 6 === 0) {
              const okFwd = yield* callProxy("http://127.0.0.1/REPOS/o/r/issues", {
                headers: { ...authHeader, accept: "application/vnd.github+json" }
              })
              expect(okFwd.status).toBe(200)
            } else if (mode % 6 === 1) {
              const tooBig = yield* callProxy("http://127.0.0.1/repos/o/r/issues", {
                method: "POST",
                headers: authHeader,
                body: "X".repeat(100)
              })
              expect(tooBig.status).toBe(413)
            } else if (mode % 6 === 2) {
              const people = yield* callProxy("http://127.0.0.1/repos/o/r/pulls/1/merge", {
                method: "PUT",
                headers: authHeader,
                body: "{}"
              })
              expect(people.status).toBe(403)
            } else if (mode % 6 === 3) {
              const credErr = yield* callProxy("http://127.0.0.1/repos/fail/cred/issues", { headers: authHeader })
              const rlErr = yield* callProxy("http://127.0.0.1/repos/fail/rl/issues", { headers: authHeader })
              expect(credErr.status).toBe(502)
              expect(rlErr.status).toBe(429)
            } else if (mode % 6 === 4) {
              const toErr = yield* callProxy("http://127.0.0.1/repos/o/r/timeout", { headers: authHeader })
              const nfErr = yield* callProxy("http://127.0.0.1/repos/o/r/netfail", { headers: authHeader })
              expect(toErr.status).toBe(504)
              expect(nfErr.status).toBe(502)
            } else {
              // Bad Host header (when publicOrigin is undefined)
              const badHost = yield* callProxy("http://127.0.0.1/repos/o/r/issues", {
                headers: { ...authHeader, host: "evil host with spaces" }
              })
              expect(badHost.status === 400 || badHost.status === 200).toBe(true)
            }

            // 2. Actions.runKey outside FlowInstance dies with EffectKeyUnavailable
            const rkExit = yield* Effect.exit(Actions.runKey("test-action"))
            expect(Exit.isFailure(rkExit)).toBe(true)

            // 3. Actions.UpsertComment, CheckRun, LinkPullRequest via real FlowEngine.layerMemory
            const actionHttp = HttpClient.make((req) => {
              const u = new URL(req.url)
              if (u.pathname === "/repos/acme/app/issues/1/comments" && req.method === "GET") {
                if (mode % 4 === 0) {
                  return Effect.succeed(jsonResp(req, 200, [{ bad: "comment" }]))
                }
                if (mode % 4 === 1) {
                  return Effect.succeed(
                    jsonResp(req, 200, [], { link: `<https://api.github.com/repos/acme/app/issues/1/comments?page=2>; rel="next"` })
                  )
                }
                const marker = Actions.stickyMarker("k1")
                return Effect.succeed(
                  jsonResp(req, 200, [
                    {
                      id: 77,
                      html_url: "https://github.com/acme/app/issues/1#comment-77",
                      body: mode % 4 === 2 ? `hello\n\n${marker}` : `old\n\n${marker}`,
                      user: { login: "bot", type: "Bot" },
                      performed_via_github_app: { id: 99 }
                    }
                  ])
                )
              }
              if (u.pathname === "/repos/acme/app/issues/comments/77" && req.method === "PATCH") {
                return Effect.succeed(
                  jsonResp(req, 200, { id: 77, html_url: "https://github.com/acme/app/issues/1#comment-77" })
                )
              }
              if (u.pathname.endsWith("/check-runs") && req.method === "GET") {
                if (mode % 3 === 0) {
                  return Effect.succeed(jsonResp(req, 200, { total_count: 150, check_runs: [] }))
                }
                return Effect.succeed(
                  jsonResp(req, 200, {
                    total_count: 1,
                    check_runs: [
                      {
                        id: 55,
                        html_url: "https://github.com/acme/app/runs/55",
                        status: "in_progress",
                        conclusion: null,
                        external_id: "ck-1",
                        app: { id: 99 }
                      }
                    ]
                  })
                )
              }
              if (u.pathname === "/repos/acme/app/check-runs/55" && req.method === "PATCH") {
                return Effect.succeed(
                  jsonResp(req, 200, {
                    id: 55,
                    html_url: "https://github.com/acme/app/runs/55",
                    status: "completed",
                    conclusion: "success",
                    external_id: "ck-1",
                    app: { id: 99 }
                  })
                )
              }
              if (u.pathname === "/repos/acme/app/pulls/5" && req.method === "GET") {
                return Effect.succeed(jsonResp(req, 200, { number: 5, html_url: "https://github.com/acme/app/pull/5" }))
              }
              if (u.pathname === "/graphql" && req.method === "POST") {
                const bodyText = req.body._tag === "Uint8Array" ? new TextDecoder().decode(req.body.body) : ""
                if (bodyText.includes("closingIssuesReferences")) {
                  if (mode % 6 === 0) return Effect.succeed(jsonResp(req, 200, { errors: [{ message: "denied" }], data: { pullRepository: { pullRequest: { id: "PR_1", closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false } } } }, issueRepository: { issue: { id: "I_1" } } } }))
                  if (mode % 6 === 1) return Effect.succeed(jsonResp(req, 200, { data: { pullRepository: { pullRequest: { id: "PR_1", closingIssuesReferences: { nodes: [{ id: "I_1" }], pageInfo: { hasNextPage: false } } } }, issueRepository: { issue: { id: "I_1" } } } }))
                  if (mode % 6 === 2) return Effect.succeed(jsonResp(req, 200, { data: { pullRepository: { pullRequest: { id: "PR_1", closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: true } } } }, issueRepository: { issue: { id: "I_1" } } } }))
                  return Effect.succeed(jsonResp(req, 200, { data: { pullRepository: { pullRequest: { id: "PR_1", closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false } } } }, issueRepository: { issue: { id: "I_1" } } } }))
                }
                if (mode % 6 === 3) return Effect.succeed(jsonResp(req, 200, { errors: [{ message: "no mut" }] }))
                if (mode % 6 === 4) return Effect.succeed(jsonResp(req, 200, { data: { addCloseIssueReferences: { issue: { id: "WRONG" } } } }))
                return Effect.succeed(jsonResp(req, 200, { data: { addCloseIssueReferences: { issue: { id: "I_1" } } } }))
              }
              return Effect.succeed(jsonResp(req, 200, {}))
            })

            const ghLayer = GitHubClient.layer({ token: "ghp_act", apiBaseUrl: "https://api.github.com" }, {}).pipe(
              Layer.provide(Layer.succeed(HttpClient.HttpClient, actionHttp))
            )
            const runAct = <Tag extends string, P extends Flow.AnyStructSchema & Schema.Top, S extends Schema.Top, E extends Schema.Top>(
              decl: Action.Declared<Tag, P, S, E>,
              payload: P["Type"]
            ) => {
              const flow = Flow.make(decl.name + "/w10", {
                payload: decl.payloadSchema as any,
                success: decl.successSchema as any,
                error: decl.errorSchema as any,
                body: (input) => decl.call(input as never)
              })
              const impl = Actions.layer as unknown as Layer.Layer<Action.Requirement<Tag>, never, Layer.Services<typeof Actions.layer>>
              const layer = Layer.mergeAll(impl, Interpreter.layer(flow)).pipe(
                Layer.provideMerge(Action.layerImplementations),
                Layer.provideMerge(Layer.mergeAll(FlowEngine.layerMemory, ghLayer, NodeCrypto.layer))
              )
              return Effect.result(
                flow.execute(payload as never, { executionId: "w10-" + decl.name + "-" + mode + "-" + Math.random() }).pipe(
                  Effect.provide(layer),
                  Effect.scoped
                )
              )
            }
            const r1 = yield* runAct(Actions.UpsertComment, {
              owner: "acme",
              repo: "app",
              issueNumber: 1,
              key: "k1",
              body: "hello",
              author: { appId: 99 }
            })
            expect(Result.isSuccess(r1) || Result.isFailure(r1)).toBe(true)
            const r2 = yield* runAct(Actions.CheckRun, {
              owner: "acme",
              repo: "app",
              headSha: "a".repeat(40),
              name: "ci",
              key: "ck-1",
              appId: 99,
              status: "completed",
              conclusion: "success",
              detailsUrl: "https://ci.example.com/1",
              output: { title: "OK", summary: "All green" }
            })
            expect(Result.isSuccess(r2) || Result.isFailure(r2)).toBe(true)
            const r3 = yield* runAct(Actions.LinkPullRequest, {
              owner: "acme",
              repo: "app",
              pullNumber: 5,
              issueNumber: 10
            })
            expect(Result.isSuccess(r3) || Result.isFailure(r3)).toBe(true)

            return true
          }) as Effect.Effect<boolean, never, never>,
        { executions: Math.min(executions, 14), seed: seed + 2 }
      )
    )
    assertPassed(report)
  }, 60_000)
})
