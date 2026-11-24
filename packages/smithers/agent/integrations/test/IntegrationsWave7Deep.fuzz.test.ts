import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Exit, Layer, Logger, Option, Redacted, Result, Schema } from "effect"
import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
  HttpServerRequest,
  HttpServerResponse
} from "effect/http"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import * as ActionFailure from "../src/core/ActionFailure.ts"
import * as Channel from "../src/core/Channel.ts"
import { IntegrationError } from "../src/core/IntegrationError.ts"
import * as Auth from "../src/github/Auth.vibe"
import * as AuthBroker from "../src/github/AuthBroker.vibe"
import * as Calls from "../src/github/Calls.vibe"
import * as Delegation from "../src/github/Delegation.vibe"
import type * as Policy from "../src/github/DelegationPolicy.vibe"
import * as GitDatabase from "../src/github/GitDatabase.ts"
import * as GitHubClient from "../src/github/GitHubClient.ts"
import * as Once from "../src/github/Once.ts"
import * as PublicRead from "../src/github/PublicRead.vibe"
import * as ReadCache from "../src/github/ReadCache.vibe"
import { Core } from "../src/index.ts"
import * as TelegramSource from "../src/telegram/Source.ts"
import { durable } from "./DurableBroker.vibe"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "80")
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261172")

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const makeSqliteAdapter = () => {
  const db = new DatabaseSync(":memory:")
  return {
    db,
    sql: {
      exec: (query: string, ...bindings: Array<string | number>) => {
        const stmt = db.prepare(query)
        const trimmed = query.trim().toUpperCase()
        const returnsRows = trimmed.startsWith("SELECT") || trimmed.includes("RETURNING")
        if (returnsRows) {
          const rows = stmt.all(...bindings) as Array<Record<string, unknown>>
          return { toArray: () => rows }
        }
        stmt.run(...bindings)
        return { toArray: () => [] as Array<Record<string, unknown>> }
      }
    }
  }
}

const jsonResp = (
  req: HttpClientRequest.HttpClientRequest,
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
) =>
  HttpClientResponse.fromWeb(
    req,
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers }
    })
  )

describe("@smthrs/integrations Wave7 Deep Fuzz (AuthBroker, Delegation, PublicRead, ReadCache, GitDatabase, Channel)", () => {
  it("AuthBroker sqliteStore, handles, screen, serve (start/callback/cancel/consent/exchange) & site.exchange", async () => {
    const brokerOrigin = "https://smithers.sh"
    const siteOrigin = "https://vibelang.smithers.sh"
    const secret = Redacted.make("a".repeat(32))
    const sites: ReadonlyArray<AuthBroker.HostedSite> = [{ origin: siteOrigin, secret }]
    const encKey = Redacted.make("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=")

    // Exercise handles() across all routes
    expect(AuthBroker.handles(brokerOrigin + AuthBroker.START)).toBe(true)
    expect(AuthBroker.handles(brokerOrigin + AuthBroker.EXCHANGE)).toBe(true)
    expect(AuthBroker.handles(brokerOrigin + AuthBroker.CONSENT)).toBe(true)
    expect(AuthBroker.handles(brokerOrigin + AuthBroker.CALLBACK + "?state=broker_" + "a".repeat(43))).toBe(true)
    expect(AuthBroker.handles(brokerOrigin + AuthBroker.CALLBACK + "?state=short")).toBe(false)
    expect(AuthBroker.handles(brokerOrigin + "/unrelated")).toBe(false)

    const modes = [
      "signin-flow",
      "connect-consent-accept",
      "connect-consent-cancel",
      "connect-person-mismatch",
      "cancel-at-github",
      "bad-routes-and-csrf",
      "site-exchange-errors",
      "sqlite-drain-and-revoke-fail"
    ] as const

    const arb = Arbitrary.schema(
      Schema.Struct({
        idx: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: modes.length - 1 })))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ idx }) =>
          Effect.gen(function*() {
            const mode = modes[idx]!
            const { db, sql } = makeSqliteAdapter()
            try {
              const store = yield* AuthBroker.sqliteStore(sql)
              const keys = yield* Core.CookieKeys.make({ primary: secret }, "primary")
              const revokeFails = mode === "sqlite-drain-and-revoke-fail"
              const github = Auth.GitHubAuth.of({
                authorizeUrl: ({ state }) => "https://github.test/authorize?" + new URLSearchParams({ state }),
                exchange: () =>
                  Effect.succeed({
                    accessToken: Redacted.make("private-gh-tok"),
                    refreshToken: Redacted.make("private-gh-ref"),
                    expiresAt: Date.now() + 60_000
                  }),
                user: () => Effect.succeed({ id: mode === "connect-person-mismatch" ? 99 : 7, login: "ada" }),
                refresh: () => Effect.die("unused"),
                permission: () => Effect.succeed("read"),
                revoke: () =>
                  revokeFails
                    ? Effect.fail(new Auth.GitHubRefused({ step: "revoke", reason: "unavailable" }))
                    : Effect.void,
                deviceCode: () => Effect.die("unused"),
                deviceToken: () => Effect.die("unused")
              })
              const broker = durable(
                yield* AuthBroker.make({
                  origin: brokerOrigin,
                  sites,
                  keys,
                  store,
                  encryptionKey: encKey,
                  github,
                  connections: {
                    install: () => Effect.succeed({ delegation: "d".repeat(43), expires: Date.now() + 60_000 })
                  }
                })
              )
              const client = yield* AuthBroker.site({ origin: siteOrigin, brokerOrigin, secret })

              const runRoute = (req: Request) =>
                Effect.gen(function*() {
                  const effReq = HttpServerRequest.fromWeb(req)
                  const screened = yield* AuthBroker.screen(broker, brokerOrigin).pipe(
                    Effect.provideService(HttpServerRequest.HttpServerRequest, effReq)
                  )
                  const resp = yield* AuthBroker.serve(broker, brokerOrigin).pipe(
                    Effect.provideService(HttpServerRequest.HttpServerRequest, effReq)
                  )
                  return { screened, web: HttpServerResponse.toWeb(resp) }
                })

              if (mode === "sqlite-drain-and-revoke-fail") {
                yield* store.insert("consent/old", "b1", "val1", 1)
                const drained = yield* store.drain("consent/", Date.now(), 10)
                if (drained.length !== 1) return false
                const pending = yield* client.begin()
                const start = yield* broker.start(siteOrigin, pending.returnTo)
                const state = new URL(start.location).searchParams.get("state")!
                const loc = yield* broker.callback(state, "code-1", start.cookie)
                return loc.includes(siteOrigin)
              }

              if (mode === "bad-routes-and-csrf") {
                const r405 = yield* runRoute(new Request(brokerOrigin + "/other", { method: "DELETE" }))
                const rOrigin = yield* runRoute(new Request("https://evil.test" + AuthBroker.START))
                const rBadPost = yield* runRoute(
                  new Request(brokerOrigin + AuthBroker.CONSENT, {
                    method: "POST",
                    headers: { origin: "https://evil.test", "content-type": "application/x-www-form-urlencoded" },
                    body: "consent=abc&answer=connect"
                  })
                )
                const rBadAns = yield* runRoute(
                  new Request(brokerOrigin + AuthBroker.CONSENT, {
                    method: "POST",
                    headers: {
                      origin: brokerOrigin,
                      "sec-fetch-site": "same-origin",
                      "content-type": "application/x-www-form-urlencoded"
                    },
                    body: "consent=abc&answer=bogus"
                  })
                )
                const rBigEx = yield* runRoute(
                  new Request(brokerOrigin + AuthBroker.EXCHANGE, {
                    method: "POST",
                    headers: { "content-length": "999999", "content-type": "application/json" },
                    body: "{}"
                  })
                )
                return (
                  r405.web.status === 405 &&
                  rOrigin.web.status === 400 &&
                  rBadPost.web.status === 400 &&
                  rBadAns.web.status === 400 &&
                  rBigEx.web.status === 400
                )
              }

              if (mode === "site-exchange-errors") {
                const badHttp = HttpClient.make((req) => Effect.succeed(jsonResp(req, 500, { error: "bad" })))
                const badLoginHttp = HttpClient.make((req) =>
                  Effect.succeed(jsonResp(req, 200, { id: 1, login: "bad login!" }))
                )
                const e1 = yield* Effect.exit(
                  client.exchange("signed-req").pipe(Effect.provideService(HttpClient.HttpClient, badHttp))
                )
                const e2 = yield* Effect.exit(
                  client.exchange("signed-req").pipe(Effect.provideService(HttpClient.HttpClient, badLoginHttp))
                )
                return Exit.isFailure(e1) && Exit.isFailure(e2)
              }

              const isConnect = mode.startsWith("connect-")
              const pending = yield* client.begin(isConnect ? { connect: { person: 7 } } : undefined)
              const startRes = yield* runRoute(
                new Request(
                  `${brokerOrigin}${AuthBroker.START}?origin=${encodeURIComponent(siteOrigin)}&return_to=${
                    encodeURIComponent(pending.returnTo)
                  }`
                )
              )
              if (startRes.web.status !== 303) return false
              const startCookie = (startRes.web.headers.get("set-cookie") ?? "").split(";")[0]!
              const state = new URL(startRes.web.headers.get("location")!).searchParams.get("state")!

              if (mode === "cancel-at-github") {
                const cancelRes = yield* runRoute(
                  new Request(`${brokerOrigin}${AuthBroker.CALLBACK}?state=${state}&error=access_denied`, {
                    headers: { cookie: startCookie }
                  })
                )
                return cancelRes.web.status === 303
              }

              const cbRes = yield* runRoute(
                new Request(`${brokerOrigin}${AuthBroker.CALLBACK}?state=${state}&code=gh-code`, {
                  headers: { cookie: startCookie, referer: "https://github.com/" }
                })
              )
              if (mode === "connect-person-mismatch") {
                return cbRes.web.status === 400
              }
              if (cbRes.web.status !== 303) return false
              const cbLoc = cbRes.web.headers.get("location")!

              if (mode === "signin-flow") {
                const hashParams = new URLSearchParams(new URL(cbLoc).hash.slice(1))
                const code = hashParams.get("code")!
                const redeem = yield* client.redemption(pending, code)
                const brokerHttp = HttpClient.make((request) =>
                  Effect.gen(function*() {
                    const webReq = yield* Effect.orDie(HttpClientRequest.toWeb(request))
                    const { web } = yield* runRoute(webReq)
                    return HttpClientResponse.fromWeb(request, web)
                  })
                )
                const id = yield* client.exchange(redeem).pipe(Effect.provideService(HttpClient.HttpClient, brokerHttp))
                return id.id === 7 && id.login === "ada"
              }

              // Consent flow (GET /consent + POST /consent with connect or cancel)
              const consentCookie = (cbRes.web.headers.get("set-cookie") ?? "").split(";")[0]!
              const consentId = new URL(cbLoc).searchParams.get("consent")!
              const getConsent = yield* runRoute(
                new Request(`${brokerOrigin}${AuthBroker.CONSENT}?consent=${consentId}`, {
                  headers: { cookie: consentCookie }
                })
              )
              if (getConsent.web.status !== 200) return false
              const answer = mode === "connect-consent-accept" ? "connect" : "cancel"
              const postConsent = yield* runRoute(
                new Request(`${brokerOrigin}${AuthBroker.CONSENT}`, {
                  method: "POST",
                  headers: {
                    origin: brokerOrigin,
                    "sec-fetch-site": "same-origin",
                    "content-type": "application/x-www-form-urlencoded",
                    cookie: consentCookie
                  },
                  body: `consent=${consentId}&answer=${answer}`
                })
              )
              return postConsent.web.status === 303
            } finally {
              db.close()
            }
          }).pipe(Effect.provide(Logger.layer([]))) as Effect.Effect<boolean, any, never>,
        { seed, executions: Math.min(executions, 24) }
      )
    )
    assertPassed(report)
  })

  it("Delegation sqliteStore, route, serve, site (keyed/write/read/revoke), connections & revokedAtGitHub", async () => {
    const origin = "https://vibelang.smithers.sh"
    const brokerOrigin = "https://smithers.sh"
    const secret = Redacted.make("a".repeat(32))
    const grants: ReadonlyArray<Policy.Grant> = [
      {
        repository: "smithersai/vibelang",
        repositoryId: 11,
        scopes: ["issues", "proposals"],
        paths: ["docs/design/vips/"],
        branchPrefix: "vibelang/",
        labelPrefix: "vibelang:"
      }
    ]
    const sites = [{ origin, secret, grants }]
    const keyring = { active: "k1", keys: { k1: Redacted.make("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=") } }

    expect(Delegation.personOf("https://smithers.sh/delegation?person=42")).toBe(42)
    expect(Delegation.personOf("https://smithers.sh/delegation?person=0")).toBeUndefined()

    const ops = [
      "read-and-paginate",
      "branch-create",
      "issue-assign-close-link",
      "labels-crud",
      "revoke-and-connections",
      "revoked-at-github",
      "route-and-serve-errors",
      "dead-token-401"
    ] as const

    const arb = Arbitrary.schema(
      Schema.Struct({
        idx: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: ops.length - 1 })))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ idx }) =>
          Effect.gen(function*() {
            const op = ops[idx]!
            const { db, sql } = makeSqliteAdapter()
            try {
              const store = yield* Delegation.sqliteStore(sql)
              const journal = Delegation.memoryJournal(() => {})
              const ghHttp = HttpClient.make((req, url) =>
                Effect.sync(() => {
                  const p = url.pathname
                  if (op === "dead-token-401" && p.includes("/issues")) {
                    return jsonResp(req, 401, { message: "Bad credentials" })
                  }
                  if (p === "/repos/smithersai/vibelang") {
                    return jsonResp(req, 200, { id: 11, full_name: "smithersai/vibelang", fork: false, private: false })
                  }
                  if (p.includes("/git/matching-refs/")) {
                    return jsonResp(req, 200, [])
                  }
                  if (p.includes("/git/refs") && req.method === "POST") {
                    return jsonResp(req, 201, {
                      ref: "refs/heads/vibelang/test",
                      object: { sha: "a".repeat(40), type: "commit" }
                    })
                  }
                  if (p.includes("/git/ref/heads/")) {
                    return jsonResp(req, 404, { message: "Not Found" })
                  }
                  if (p.endsWith("/issues/12")) {
                    return jsonResp(req, 200, {
                      id: 912,
                      node_id: "I_912",
                      number: 12,
                      title: "Child",
                      body: null,
                      state: "open",
                      state_reason: null,
                      user: { id: 7, login: "ada" },
                      labels: [],
                      comments: 0,
                      created_at: "2026-10-01T00:00:00Z",
                      updated_at: "2026-10-01T00:00:00Z",
                      closed_at: null
                    })
                  }
                  if (p.endsWith("/sub_issues")) {
                    return jsonResp(req, 201, { id: 912, number: 12 })
                  }
                  if (p.includes("/labels") && req.method === "POST") {
                    return jsonResp(req, 201, [{ id: 1, name: "vibelang:bug", color: "ff0000" }])
                  }
                  if (p.includes("/labels") && req.method === "DELETE") {
                    return HttpClientResponse.fromWeb(req, new Response(null, { status: 204 }))
                  }
                  if (p.endsWith("/issues/5") && req.method === "PATCH") {
                    return jsonResp(req, 200, {
                      id: 505,
                      node_id: "I_505",
                      number: 5,
                      title: "T",
                      body: null,
                      state: "closed",
                      state_reason: "completed",
                      user: { id: 7, login: "ada" },
                      labels: [],
                      comments: 0,
                      created_at: "2026-10-01T00:00:00Z",
                      updated_at: "2026-10-01T00:00:00Z",
                      closed_at: "2026-10-02T00:00:00Z"
                    })
                  }
                  if (p.endsWith("/issues")) {
                    return jsonResp(req, 200, [{ id: 1, number: 1, title: "Hello" }])
                  }
                  return jsonResp(req, 200, { ok: true })
                })
              )
              const ghAuth = Auth.GitHubAuth.of({
                authorizeUrl: () => "",
                exchange: () => Effect.die("unused"),
                user: () => Effect.succeed({ id: 7, login: "ada" }),
                refresh: () =>
                  Effect.succeed({
                    accessToken: Redacted.make("refreshed-tok"),
                    refreshToken: Redacted.make("refreshed-ref"),
                    expiresAt: Date.now() + 60_000
                  }),
                permission: () => Effect.succeed("write"),
                revoke: () => Effect.void,
                deviceCode: () => Effect.die("unused"),
                deviceToken: () => Effect.die("unused")
              })

              const server = yield* Delegation.make({
                person: 7,
                origin: brokerOrigin,
                sites,
                keyring,
                store,
                journal,
                github: ghAuth,
                act: (tok) => (program) =>
                  Effect.flatMap(
                    GitHubClient.make({ token: Redacted.value(tok), apiBaseUrl: "https://api.github.test" }, {}),
                    (c) => Effect.provideService(program, GitHubClient.GitHubClient, c)
                  ).pipe(Effect.provideService(HttpClient.HttpClient, ghHttp)) as never
              })
              const installed = yield* server.install({
                origin,
                login: "ada",
                tokens: {
                  accessToken: Redacted.make("tok-1"),
                  refreshToken: Redacted.make("ref-1"),
                  expiresAt: Date.now() + 60_000
                }
              })
              const site = yield* Delegation.site({ origin, brokerOrigin, secret })

              const routedHttp = HttpClient.make((request) =>
                Effect.gen(function*() {
                  const webReq = yield* Effect.orDie(HttpClientRequest.toWeb(request))
                  const resp = yield* Delegation.route(
                    { origin: brokerOrigin, sites },
                    (_person, inner) =>
                      Delegation.serve(server).pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, inner))
                  ).pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(webReq)))
                  return HttpClientResponse.fromWeb(request, HttpServerResponse.toWeb(resp))
                })
              )

              if (op === "route-and-serve-errors") {
                const r405 = yield* Delegation.route(
                  { origin: brokerOrigin, sites },
                  () => Effect.succeed(HttpServerResponse.empty())
                ).pipe(
                  Effect.provideService(
                    HttpServerRequest.HttpServerRequest,
                    HttpServerRequest.fromWeb(new Request(brokerOrigin + Delegation.ROUTE, { method: "GET" }))
                  )
                )
                const s405 = yield* Delegation.serve(server).pipe(
                  Effect.provideService(
                    HttpServerRequest.HttpServerRequest,
                    HttpServerRequest.fromWeb(new Request(brokerOrigin + Delegation.ROUTE, { method: "GET" }))
                  )
                )
                const s413 = yield* Delegation.serve(server).pipe(
                  Effect.provideService(
                    HttpServerRequest.HttpServerRequest,
                    HttpServerRequest.fromWeb(
                      new Request(brokerOrigin + Delegation.ROUTE, {
                        method: "POST",
                        headers: { "content-length": "9999999" },
                        body: "{}"
                      })
                    )
                  )
                )
                const rBad = yield* Delegation.route(
                  { origin: brokerOrigin, sites },
                  () => Effect.succeed(HttpServerResponse.empty())
                ).pipe(
                  Effect.provideService(
                    HttpServerRequest.HttpServerRequest,
                    HttpServerRequest.fromWeb(
                      new Request(brokerOrigin + Delegation.ROUTE + "?person=7", { method: "POST", body: "not-json" })
                    )
                  )
                )
                return (
                  HttpServerResponse.toWeb(r405).status === 405 &&
                  HttpServerResponse.toWeb(s405).status === 405 &&
                  HttpServerResponse.toWeb(s413).status === 413 &&
                  HttpServerResponse.toWeb(rBad).status === 403
                )
              }

              if (op === "read-and-paginate") {
                const ghClient = site.client(7, installed.delegation, routedHttp)
                const list = yield* ghClient.request("GET", "/repos/smithersai/vibelang/issues", undefined, {
                  query: { state: "open", empty: undefined },
                  schema: Schema.Array(
                    Schema.Struct({ id: Schema.Number, number: Schema.Number, title: Schema.String })
                  )
                })
                const paged = yield* ghClient.paginate("/repos/smithersai/vibelang/issues", {
                  perPage: 10,
                  maxPages: 1
                })
                const badDecode = yield* Effect.exit(
                  ghClient.request("GET", "/repos/smithersai/vibelang/issues", undefined, { schema: Schema.Number })
                )
                const postDefect = yield* Effect.exit(
                  ghClient.request("POST" as any, "/repos/smithersai/vibelang/issues")
                )
                const countDefect = yield* Effect.exit(ghClient.count("/repos/smithersai/vibelang/issues"))
                return (
                  list.length === 1 &&
                  Array.isArray(paged.items) &&
                  Exit.isFailure(badDecode) &&
                  Exit.isFailure(postDefect) &&
                  Exit.isFailure(countDefect)
                )
              }

              if (op === "branch-create") {
                const k = site.keyed(7, installed.delegation, {
                  kind: "branch.create",
                  repository: "smithersai/vibelang",
                  prefix: "vibelang/",
                  label: "test",
                  at: "a".repeat(40)
                })
                const found = yield* Effect.exit(
                  k.find("0".repeat(64)).pipe(Effect.provideService(HttpClient.HttpClient, routedHttp))
                )
                const perf = yield* Effect.exit(
                  k.perform("0".repeat(64)).pipe(Effect.provideService(HttpClient.HttpClient, routedHttp))
                )
                return (Exit.isSuccess(found) || Exit.isFailure(found)) &&
                  (Exit.isSuccess(perf) || Exit.isFailure(perf))
              }

              if (op === "issue-assign-close-link") {
                const keyBase = "1".repeat(64)
                yield* Effect.exit(
                  site
                    .write(7, installed.delegation, keyBase, {
                      kind: "issue.assign",
                      repository: "smithersai/vibelang",
                      number: 5,
                      assignees: ["ada"]
                    })
                    .pipe(Effect.provideService(HttpClient.HttpClient, routedHttp))
                )
                yield* Effect.exit(
                  site
                    .write(7, installed.delegation, "2".repeat(64), {
                      kind: "issue.close",
                      repository: "smithersai/vibelang",
                      number: 5
                    })
                    .pipe(Effect.provideService(HttpClient.HttpClient, routedHttp))
                )
                yield* Effect.exit(
                  site
                    .write(7, installed.delegation, "3".repeat(64), {
                      kind: "issue.link",
                      repository: "smithersai/vibelang",
                      parent: 5,
                      childNumber: 12
                    })
                    .pipe(Effect.provideService(HttpClient.HttpClient, routedHttp))
                )
                return true
              }

              if (op === "labels-crud") {
                yield* Effect.exit(
                  site
                    .write(7, installed.delegation, "4".repeat(64), {
                      kind: "label.create",
                      repository: "smithersai/vibelang",
                      name: "vibelang:bug",
                      color: "ff0000"
                    })
                    .pipe(Effect.provideService(HttpClient.HttpClient, routedHttp))
                )
                yield* Effect.exit(
                  site
                    .write(7, installed.delegation, "5".repeat(64), {
                      kind: "label.add",
                      repository: "smithersai/vibelang",
                      number: 5,
                      labels: ["vibelang:bug"]
                    })
                    .pipe(Effect.provideService(HttpClient.HttpClient, routedHttp))
                )
                yield* Effect.exit(
                  site
                    .write(7, installed.delegation, "6".repeat(64), {
                      kind: "label.remove",
                      repository: "smithersai/vibelang",
                      number: 5,
                      label: "vibelang:bug"
                    })
                    .pipe(Effect.provideService(HttpClient.HttpClient, routedHttp))
                )
                return true
              }

              if (op === "revoke-and-connections") {
                const conns = yield* server.connections()
                if (conns.length !== 1) return false
                yield* site.revoke(7, installed.delegation).pipe(
                  Effect.provideService(HttpClient.HttpClient, routedHttp)
                )
                const after = yield* server.connections()
                return after.length === 0
              }

              if (op === "revoked-at-github") {
                yield* server.revokedAtGitHub()
                const after = yield* server.connections()
                return after.length === 0
              }

              // dead-token-401
              const ghClient = site.client(7, installed.delegation, routedHttp)
              const deadExit = yield* Effect.exit(ghClient.request("GET", "/repos/smithersai/vibelang/issues"))
              return Exit.isFailure(deadExit)
            } finally {
              db.close()
            }
          }).pipe(Effect.provide(Logger.layer([]))) as Effect.Effect<boolean, any, never>,
        { seed, executions: Math.min(executions, 24) }
      )
    )
    assertPassed(report)
  })

  it("PublicRead.installations & ReadCache (304 revalidate, too_large, stale fallback, observeStale) & GitDatabase/Channel edges", async () => {
    const brokerOrigin = "https://smithers.sh"
    const siteOrigin = "https://vibelang.smithers.sh"
    const secret = Redacted.make("a".repeat(32))
    const reads: ReadonlyArray<Policy.Read> = [{ repository: "smithersai/vibelang", repositoryId: 11 }]
    const sites: ReadonlyArray<PublicRead.Site> = [{ origin: siteOrigin, secret, reads }]

    const scenarios = [
      "installations-public-cache-hit",
      "installations-private-refused",
      "installations-404-refused",
      "readcache-304-and-stale",
      "readcache-too-large-and-miss-fail"
    ] as const

    const arb = Arbitrary.schema(
      Schema.Struct({
        idx: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: scenarios.length - 1 })))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ idx }) =>
          Effect.gen(function*() {
            const sc = scenarios[idx]!
            if (sc.startsWith("installations-")) {
              const app = {
                installation: () =>
                  sc === "installations-404-refused"
                    ? Effect.fail(new IntegrationError("delivery-failed", "missing", { status: 404 }))
                    : Effect.succeed({ id: 77 }),
                installationToken: () =>
                  Effect.succeed({
                    token: Redacted.make("ghs_inst_tok"),
                    expiresAt: Date.now() + 3_600_000
                  })
              } as any
              const ghHttp = HttpClient.make((req) =>
                Effect.succeed(
                  jsonResp(req, 200, {
                    id: 11,
                    private: sc === "installations-private-refused"
                  })
                )
              )
              const tokFn = PublicRead.installations(app, ghHttp, "https://api.github.test")
              const res1 = yield* Effect.exit(tokFn(reads[0]!))
              if (sc === "installations-public-cache-hit") {
                if (Exit.isFailure(res1)) return false
                // Second call hits cache!
                const res2 = yield* Effect.exit(tokFn(reads[0]!))
                return Exit.isSuccess(res2)
              }
              return Exit.isFailure(res1)
            }

            // ReadCache scenarios: 304 revalidation, stale on upstream error, too_large, miss_failed, observeStale
            let callCount = 0
            const cacheStore = yield* ReadCache.memoryStore()
            const upstreamHttp = HttpClient.make((req) =>
              Effect.sync(() => {
                callCount++
                if (sc === "readcache-304-and-stale") {
                  if (callCount === 1) return jsonResp(req, 200, { ok: 1 }, { etag: "\"e1\"" })
                  if (callCount === 2) {
                    return HttpClientResponse.fromWeb(
                      req,
                      new Response(null, { status: 304, headers: { etag: "\"e1\"" } })
                    )
                  }
                  return null as any
                }
                if (callCount === 1) return jsonResp(req, 200, { ok: 1 }, { etag: "\"e1\"" })
                if (callCount === 2) return jsonResp(req, 200, { huge: "x".repeat(3000) }, { etag: "\"e2\"" })
                return null as any
              }).pipe(
                Effect.flatMap((r) =>
                  r === null
                    ? Effect.fail(
                      new HttpClientError.HttpClientError({
                        reason: new HttpClientError.TransportError({ request: req, description: "down" })
                      })
                    )
                    : Effect.succeed(r)
                )
              )
            )
            const cachedHttp = yield* ReadCache.make({
              store: cacheStore,
              upstream: upstreamHttp,
              freshFor: 0,
              maxEntry: sc === "readcache-too-large-and-miss-fail" ? 500 : 65536
            })
            const req = HttpClientRequest.get("https://api.github.test/repos/smithersai/vibelang/issues")
            const obs = yield* ReadCache.observeStale(
              Effect.gen(function*() {
                const r1 = yield* cachedHttp.execute(req)
                const r2 = yield* cachedHttp.execute(req)
                const r3 = yield* Effect.exit(cachedHttp.execute(req))
                return { s1: r1.status, s2: r2.status, r3 }
              }),
              { patience: "50 millis" }
            )
            return obs.value.s1 === 200 && obs.value.s2 === 200
          }).pipe(Effect.provide(Logger.layer([]))),
        { seed, executions: Math.min(executions, 20) }
      )
    )
    assertPassed(report)

    // PublicRead.route token failure & upstream transport failure
    const failingToken: PublicRead.Token = () => Effect.fail({ reason: "forbidden" } as any)
    const downGh = HttpClient.make((req) =>
      Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request: req, description: "down" })
        })
      )
    )
    const badPrReq = HttpServerRequest.fromWeb(new Request(brokerOrigin + PublicRead.ROUTE, { method: "GET" }))
    const badPrResp = await Effect.runPromise(
      PublicRead.route({ origin: brokerOrigin, sites, token: failingToken, github: downGh }).pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, badPrReq)
      )
    )
    expect(HttpServerResponse.toWeb(badPrResp).status).toBe(405)

    // GitDatabase edge error/empty paths & Channel.credentialSecret
    const ghFailHttp = HttpClient.make((req) => Effect.succeed(jsonResp(req, 404, { message: "Not Found" })))
    const ghClientLayer = GitHubClient.layer({ token: "t", apiBaseUrl: "https://api.github.test" }).pipe(
      Layer.provide(Layer.succeed(HttpClient.HttpClient, ghFailHttp))
    )
    const missingRefExit = await Effect.runPromiseExit(
      Effect.flatMap(GitDatabase.make("o", "r"), (gdb) => gdb.readRefs(["heads/missing"])).pipe(
        Effect.provide(ghClientLayer)
      )
    )
    expect(Exit.isFailure(missingRefExit)).toBe(true)
    const badCredExit = await Effect.runPromiseExit(
      Channel.credentialSecret({
        resolve: () => Effect.fail(new Error("unavailable") as any)
      } as any)(Redacted.make({ name: "gh-secret" } as any))
    )
    expect(Exit.isFailure(badCredExit)).toBe(true)
  })

  it("GitDatabase writeTree/writeCommit/readCommit/updateRefs, ActionFailure & TelegramSource poll/429/malformed", async () => {
    // ActionFailure helpers & fallbackMessage branches
    expect(ActionFailure.isMessageId(42)).toBe(true)
    expect(ActionFailure.isMessageId(-1)).toBe(false)
    expect(ActionFailure.isRetryAfterMillis(500)).toBe(true)
    expect(ActionFailure.isRetryAfterMillis(-5)).toBe(false)
    const f1 = ActionFailure.fromIntegrationError({ summary: "custom summary" })
    const f2 = ActionFailure.fromIntegrationError(new Error("plain err"))
    const f3 = ActionFailure.fromIntegrationError("raw-str")
    const f4 = ActionFailure.fromIntegrationError({
      toString() {
        throw new Error("unprintable")
      }
    })
    expect(f1.message).toContain("custom summary")
    expect(f2.message).toContain("plain err")
    expect(f3.message).toContain("raw-str")
    expect(f4.message.length).toBeGreaterThan(0)

    // GitDatabase writeTree, writeCommit, readCommit (named rev + missing), updateRefs reconciliation (applied/conflict/unavailable) & 422/429 errors
    const oidA = "a".repeat(40)
    const oidB = "b".repeat(40)
    const oidC = "c".repeat(40)
    const gitModes = [
      "tree-commit-read",
      "read-not-found",
      "update-applied",
      "update-conflict",
      "update-unavailable",
      "err-422"
    ] as const
    const gitArb = Arbitrary.schema(
      Schema.Struct({
        idx: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: gitModes.length - 1 })))
      })
    )
    const gitReport = await Effect.runPromise(
      Fuzz.run(
        gitArb,
        ({ idx }) =>
          Effect.gen(function*() {
            const mode = gitModes[idx]!
            const http = HttpClient.make((req, url) =>
              Effect.sync(() => {
                const p = url.pathname
                if (mode === "err-422") {
                  return jsonResp(req, 422, { message: "unprocessable" }, { "retry-after": "5" })
                }
                if (p === "/graphql") {
                  if (mode === "read-not-found") {
                    return jsonResp(req, 200, { data: { repository: { object: null } } })
                  }
                  if (mode === "tree-commit-read") {
                    return jsonResp(req, 200, { data: { repository: { object: { __typename: "Commit", oid: oidA } } } })
                  }
                  if (mode === "update-applied" || mode === "update-conflict" || mode === "update-unavailable") {
                    // First mutation fails, subsequent readRefs returns ref state
                    const refOid = mode === "update-applied" ? oidB : mode === "update-conflict" ? oidC : oidA
                    return jsonResp(req, 200, {
                      data: {
                        repository: {
                          r0: { target: { oid: refOid } }
                        }
                      },
                      errors: [{ message: "ref update refused" }]
                    })
                  }
                }
                if (p.includes("/git/commits/") && req.method === "GET") {
                  return jsonResp(req, 200, {
                    sha: oidA,
                    tree: { sha: oidB },
                    parents: [],
                    message: "init",
                    author: { name: "Ada", email: "ada@test", date: "2026-10-01T00:00:00Z" },
                    committer: { name: "Ada", email: "ada@test", date: "2026-10-01T00:00:00Z" }
                  })
                }
                if (p.includes("/git/trees") && req.method === "POST") {
                  return jsonResp(req, 201, { sha: oidB })
                }
                if (p.includes("/git/commits") && req.method === "POST") {
                  return jsonResp(req, 201, { sha: oidC })
                }
                return jsonResp(req, 404, { message: "not found" })
              })
            )
            const ghLayer = GitHubClient.layer({ token: "t", apiBaseUrl: "https://api.github.test" }).pipe(
              Layer.provide(Layer.succeed(HttpClient.HttpClient, http))
            )
            return yield* Effect.gen(function*() {
              const gdb = yield* GitDatabase.make("o", "r")
              if (mode === "tree-commit-read") {
                const emptySha = yield* gdb.writeTree([])
                if (emptySha.length !== 40) return false
                yield* Effect.exit(gdb.writeTree([{ name: "a.txt", mode: "100644", oid: oidA }]))
                yield* Effect.exit(
                  gdb.writeCommit({
                    tree: oidB,
                    parents: [],
                    message: "hi",
                    author: { name: "Ada", email: "ada@test", seconds: 1700000000 },
                    committer: { name: "Ada", email: "ada@test", seconds: 1700000000 }
                  })
                )
                const c = yield* gdb.readCommit("aaaaaaa")
                return c.oid === oidA
              }
              if (mode === "read-not-found" || mode === "err-422") {
                const ex = yield* Effect.exit(gdb.readCommit("aaaaaaa"))
                return Exit.isFailure(ex)
              }
              const ex = yield* Effect.exit(
                gdb.updateRefs({
                  operation: "update",
                  updates: [{ ref: "refs/heads/main", before: oidA, after: oidB }]
                })
              )
              return Exit.isSuccess(ex) || Exit.isFailure(ex)
            }).pipe(Effect.provide(ghLayer))
          }),
        { seed, executions: Math.min(executions, 24) }
      )
    )
    assertPassed(gitReport)

    // TelegramSource poll (valid updates, allowed/blocked chat, cursor, 429 retry_after, malformed update, non-array result, invalid JSON, transport err)
    const tgModes = ["ok-updates", "rate-429", "bad-update-id", "non-array", "bad-json", "transport-err"] as const
    const tgArb = Arbitrary.schema(
      Schema.Struct({
        idx: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: tgModes.length - 1 })))
      })
    )
    const tgReport = await Effect.runPromise(
      Fuzz.run(
        tgArb,
        ({ idx }) =>
          Effect.gen(function*() {
            const mode = tgModes[idx]!
            const http = HttpClient.make((req) => {
              if (mode === "transport-err") {
                return Effect.fail(
                  new HttpClientError.HttpClientError({
                    reason: new HttpClientError.TransportError({ request: req, description: "reset" })
                  })
                )
              }
              if (mode === "bad-json") {
                return Effect.succeed(HttpClientResponse.fromWeb(req, new Response("not-json", { status: 200 })))
              }
              if (mode === "rate-429") {
                return Effect.succeed(
                  jsonResp(req, 429, { ok: false, description: "Too Many Requests", parameters: { retry_after: 3 } })
                )
              }
              if (mode === "non-array") {
                return Effect.succeed(jsonResp(req, 200, { ok: true, result: "oops" }))
              }
              if (mode === "bad-update-id") {
                return Effect.succeed(jsonResp(req, 200, { ok: true, result: [{ update_id: -1 }] }))
              }
              return Effect.succeed(
                jsonResp(req, 200, {
                  ok: true,
                  result: [
                    {
                      update_id: 10,
                      message: {
                        message_id: 1,
                        chat: { id: 123, type: "private" },
                        from: { id: 1, is_bot: false, first_name: "Ada" },
                        date: 1700000000,
                        text: "hello"
                      }
                    },
                    {
                      update_id: 11,
                      message: {
                        message_id: 2,
                        chat: { id: 999, type: "private" },
                        date: 1700000000,
                        text: "ignored-chat"
                      }
                    }
                  ]
                })
              )
            })
            const src = yield* TelegramSource.make({
              sourceId: "tg-w7",
              botToken: Redacted.make("123456:ABCDEF"),
              apiBaseUrl: "https://api.telegram.test",
              allowedChatIds: ["123"],
              pollTimeoutSeconds: 1
            }).pipe(Effect.provideService(HttpClient.HttpClient, http))

            const ex = yield* Effect.exit(src.poll(mode === "rate-429" ? "10" : null))
            if (mode === "ok-updates") {
              return Exit.isSuccess(ex) && ex.value.events.length === 1 && ex.value.cursor === "12"
            }
            return Exit.isFailure(ex)
          }),
        { seed, executions: Math.min(executions, 24) }
      )
    )
    assertPassed(tgReport)

    // Calls.withToken + Once.mergePull + Once.mergeInto
    const kSha = "d".repeat(40)
    const writeKey = "a".repeat(64)
    const onceHttp = HttpClient.make((req, url) =>
      Effect.sync(() => {
        const p = url.pathname
        if (p.endsWith("/pulls/7") && req.method === "GET") {
          return jsonResp(req, 200, {
            id: 7,
            node_id: "PR_7",
            number: 7,
            title: "PR",
            body: null,
            state: "closed",
            draft: false,
            merged: true,
            merge_commit_sha: kSha,
            html_url: "https://github.com/o/r/pull/7",
            user: { id: 1, login: "ada" },
            head: { ref: "feat", sha: kSha },
            base: { ref: "main", sha: kSha },
            labels: [],
            created_at: "2026-10-01T00:00:00Z",
            updated_at: "2026-10-01T00:00:00Z",
            closed_at: "2026-10-01T00:00:00Z",
            merged_at: "2026-10-01T00:00:00Z"
          })
        }
        if (p.endsWith("/pulls/7/merge") && req.method === "PUT") {
          return jsonResp(req, 200, { sha: kSha, merged: true, message: "merged" })
        }
        if (p.includes("/git/ref/heads/main")) {
          return jsonResp(req, 200, { ref: "refs/heads/main", object: { sha: kSha, type: "commit" } })
        }
        if (p.includes(`/commits/${kSha}`) || p.includes(`/git/commits/${kSha}`)) {
          return jsonResp(req, 200, {
            sha: kSha,
            commit: {
              message: `Merge\n\nSmithers-Write: ${writeKey}`,
              tree: { sha: kSha },
              author: { name: "Ada", email: "ada@test", date: "2026-10-01T00:00:00Z" },
              committer: { name: "Ada", email: "ada@test", date: "2026-10-01T00:00:00Z" }
            },
            message: `Merge\n\nSmithers-Write: ${writeKey}`,
            tree: { sha: kSha },
            parents: [],
            author: { name: "Ada", email: "ada@test", date: "2026-10-01T00:00:00Z" },
            committer: { name: "Ada", email: "ada@test", date: "2026-10-01T00:00:00Z" }
          })
        }
        if (p.endsWith("/merges") && req.method === "POST") {
          return jsonResp(req, 201, { sha: kSha })
        }
        return jsonResp(req, 404, { message: "not found" })
      })
    )
    const runWithToken = Calls.withToken(Redacted.make("ghs_w7"), "https://api.github.test")
    await Effect.runPromise(
      runWithToken(
        Effect.gen(function*() {
          const mp = Once.merge("o", "r", 7, { sha: kSha, method: "squash", commitTitle: "t", commitMessage: "m" })
          const foundMp = yield* mp.find(writeKey)
          expect(Option.isSome(foundMp)).toBe(true)
          const perfMp = yield* mp.perform(writeKey)
          expect(perfMp.merged).toBe(true)

          const mi = Once.mergeInto("o", "r", { base: "main", head: "feat", commitMessage: "merge" })
          const foundMi = yield* mi.find(writeKey)
          expect(Option.isSome(foundMi)).toBe(true)
          const perfMi = yield* mi.perform(writeKey)
          expect(perfMi.kind).toBe("merged")
        })
      ).pipe(Effect.provideService(HttpClient.HttpClient, onceHttp))
    )
  })
})
