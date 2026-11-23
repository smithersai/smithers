import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Layer, Logger, Option, Redacted, Result, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { describe, expect, it } from "vitest"
import { redact } from "../src/core/Redact.ts"
import * as AuthBrokerPolicy from "../src/github/AuthBrokerPolicy.vibe"
import * as AuthConsent from "../src/github/AuthConsent.vibe"
import * as DelegationPolicy from "../src/github/DelegationPolicy.vibe"
import * as RateBudget from "../src/github/internal/rateBudget.ts"
import { Core, GitHub, Telegram } from "../src/index.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")

describe("@smthrs/integrations comprehensive crypto, cookie, OAuth, source-store & sync fuzz invariants", () => {
  it("Signature.verifySignature & CookieKeys enforce constant-time HMAC, cross-purpose isolation & key rotation", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        payload: Schema.String.pipe(Schema.check(Schema.isMaxLength(80))),
        secret: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(32))),
        purpose: Schema.Literals(["session", "oauth_state", "csrf_token"]),
        otherPurpose: Schema.Literals(["session", "oauth_state", "csrf_token"]),
        cookieVal: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(40))),
        keyId: Schema.Literals(["k1", "k2"]),
        tamperBit: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 63 })))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ payload, secret, purpose, otherPurpose, cookieVal, keyId, tamperBit }) =>
          Effect.gen(function*() {
            const bytes = new TextEncoder().encode(payload)
            if (!Core.Signature.constantTimeEqual(bytes, new Uint8Array(bytes))) return false
            if (bytes.length > 0) {
              const flipped = new Uint8Array(bytes)
              flipped[tamperBit % flipped.length]! ^= 1
              if (Core.Signature.constantTimeEqual(bytes, flipped)) return false
            }

            const macHex = yield* Core.Signature.computeHmacSha256Hex(payload, secret)
            const okBare = yield* Core.Signature.verifySignature({ payload, secret, signature: macHex })
            const okPrefixed = yield* Core.Signature.verifySignature({
              payload,
              secret,
              signature: `${Core.Signature.GITHUB_SIGNATURE_PREFIX}${macHex}`,
              prefix: Core.Signature.GITHUB_SIGNATURE_PREFIX
            })
            if (!okBare || !okPrefixed) return false

            const idx = tamperBit % macHex.length
            const flippedChar = macHex[idx] === "0" ? "1" : "0"
            const tampered = macHex.slice(0, idx) + flippedChar + macHex.slice(idx + 1)
            const okTampered = yield* Core.Signature.verifySignature({ payload, secret, signature: tampered })
            if (okTampered) return false

            if (yield* Core.Signature.verifySignature({ payload, secret: "", signature: macHex })) return false
            if (yield* Core.Signature.verifySignature({ payload, secret, signature: undefined })) return false

            const keys = yield* Core.CookieKeys.make({
              k1: Redacted.make(secret),
              k2: Redacted.make(`${secret}-rot`)
            }, "k1")
            const signed = yield* keys.sign(purpose, cookieVal, keyId)
            const verified = yield* keys.verify(purpose, signed)
            if (Option.isNone(verified)) return false
            if (verified.value.value !== cookieVal || verified.value.keyId !== keyId) return false

            const dot = signed.lastIndexOf(".")
            const upperSigned = signed.slice(0, dot + 1) + signed.slice(dot + 1).toUpperCase()
            if (upperSigned !== signed && Option.isSome(yield* keys.verify(purpose, upperSigned))) return false

            if (purpose !== otherPurpose) {
              const cross = yield* keys.verify(otherPurpose, signed)
              if (Option.isSome(cross)) return false
            }
            return true
          }),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("AuthorizationUrl, Pkce, SignalName, JsonPath, Redact & ActionFailure obey security & round-trip invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        scheme: Schema.Literals(["https", "http", "javascript"]),
        host: Schema.Literals(["github.com", "localhost", "127.0.0.1", "evil.example"]),
        extraKey: Schema.Literals(["prompt", "state", "code_challenge", "client_id", "redirect_uri", "login"]),
        service: Schema.Literals(["github", "telegram", "slack", "bad service", ""]),
        event: Schema.Literals(["push", "issue_comment", "pr.opened", "bad:event", ""]),
        secret: Schema.String.pipe(Schema.check(Schema.isMinLength(6), Schema.isMaxLength(20))),
        reason: Schema.Literals(Core.IntegrationError.reasons)
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ scheme, host, extraKey, service, event, secret, reason }) =>
          Effect.gen(function*() {
            const pair = yield* Core.Pkce.createPkcePair()
            const recomputed = yield* Core.Pkce.deriveCodeChallenge(pair.codeVerifier)
            if (recomputed !== pair.codeChallenge) return false

            const isInsecure = scheme !== "https" &&
              !(scheme === "http" && (host === "localhost" || host === "127.0.0.1"))
            const isReserved = Core.AuthorizationUrl.RESERVED_PARAMS.includes(extraKey)
            const authRes = yield* Effect.result(
              Effect.try(() =>
                Core.AuthorizationUrl.buildAuthorizationUrl({
                  authorizationEndpoint: `${scheme}://${host}/login/oauth/authorize`,
                  clientId: "cid-1",
                  redirectUri: "https://app.example.test/callback",
                  state: "state-xyz",
                  codeChallenge: pair.codeChallenge,
                  scope: ["read:user", "repo"],
                  extraParams: { [extraKey]: "injected" }
                })
              )
            )
            if ((isInsecure || isReserved) && Result.isSuccess(authRes)) return false
            if (!isInsecure && !isReserved) {
              if (Result.isFailure(authRes)) return false
              const parsed = new URL(authRes.success)
              if (parsed.searchParams.get("state") !== "state-xyz") return false
              if (parsed.searchParams.get("code_challenge") !== pair.codeChallenge) return false
            }

            const validSeg = Core.SignalName.isSegment(service) && Core.SignalName.isSegment(event)
            if (validSeg) {
              const name = Core.SignalName.eventName(service, event)
              if (!Core.SignalName.isEventName(name) || !Core.SignalName.isIntegrationSignalName(name)) return false
              const parsed = Core.SignalName.parse(name)
              if (parsed === null || parsed.service !== service || parsed.event !== event) return false
              if (!Core.SignalName.receivedBy(service).includes(service)) return false
            }

            const leaked = `Bearer ${secret} failed with ${secret}!`
            const cleaned = redact(leaked, [secret])
            if (cleaned.includes(secret)) return false

            const doc = { a: { b: { c: 42, s: "hi" } } }
            if (Core.JsonPath.readInteger(doc, "a.b.c") !== 42) return false
            if (Core.JsonPath.readString(doc, "a.b.s") !== "hi") return false
            if (
              Core.JsonPath.readHeader({ headers: { "X-Hub-Signature-256": "abc" } }, "x-hub-signature-256") !== "abc"
            ) {
              return false
            }

            const err = new Core.IntegrationError.IntegrationError(
              reason as Core.IntegrationError.Reason,
              `msg with ${secret}`
            )
            const actFail = Core.ActionFailure.fromIntegrationError(err)
            const back = Core.ActionFailure.toIntegrationError(actFail)
            if (back.reason !== err.reason) return false

            const r = Core.OAuthToken.reasonForOAuthError("invalid_grant")
            if (typeof r !== "string") return false
            return true
          }),
        { seed: seed + 1, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("SourceRecord ordering, SourceStore (Memory & SQLite) grant isolation & Sync.runSync match reference model", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        v1: Schema.Literals(["", "1", "2", "10", "v1", "v2"]),
        v2: Schema.Literals(["", "1", "2", "10", "v1", "v2"]),
        t1: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1000, maximum: 5000 }))),
        t2: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1000, maximum: 5000 }))),
        scope: Schema.Literals(["private", "container", "workspace", "public"]),
        grantContainer: Schema.Literals(["*", "org/repo-a", "org/repo-b"]),
        recordContainer: Schema.Literals(["org/repo-a", "org/repo-b"]),
        pages: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 3 })))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ v1, v2, t1, t2, scope, grantContainer, recordContainer, pages }) =>
          Effect.gen(function*() {
            const ver1 = v1 === "" ? null : v1
            const ver2 = v2 === "" ? null : v2
            const o1 = { version: ver1, updatedAtMs: t1, deleted: false }
            const o2 = { version: ver2, updatedAtMs: t2, deleted: false }
            const c12 = Core.SourceRecord.compare(o1, o2)
            const c21 = Core.SourceRecord.compare(o2, o1)
            if (Math.sign(c12) !== -Math.sign(c21)) return false
            if (Core.SourceRecord.supersedes(o1, o2) !== (c12 > 0)) return false

            const rec: Core.SourceRecord.SourceRecord = {
              provider: "github",
              connectionId: "conn-1",
              kind: "issue",
              externalId: "issue-1",
              version: ver1,
              createdAtMs: 1000,
              updatedAtMs: t1,
              retrievedAtMs: t1,
              text: "Test issue body text",
              deleted: false,
              url: "https://github.com/org/repo-a/issues/1",
              author: { id: "u1", label: "Alice" },
              access: { scope, containerId: recordContainer },
              thread: { containerId: recordContainer, threadId: null, parentId: null },
              payload: { title: "Test issue" }
            }
            const ref = Core.SourceRecord.reference(rec)
            if (ref.externalId !== "issue-1") return false
            const tomb = Core.SourceRecord.tombstone(rec, t1 + 100)
            if (!tomb.deleted) return false

            const grant: Core.SourceStore.Grant = {
              connectionId: "conn-1",
              containers: [grantContainer]
            }
            const covered = Core.SourceStore.covers([grant], rec)
            if (covered !== (grantContainer === "*" || grantContainer === recordContainer)) {
              return false
            }

            const sqlLayer = Core.SourceStore.layerSql.pipe(
              Layer.provideMerge(Core.Migrations.layer),
              Layer.provideMerge(TestDatabase.layer),
              Layer.provideMerge(Logger.layer([]))
            )
            for (const storeLayer of [Core.SourceStore.layerMemory, sqlLayer]) {
              const ok = yield* Effect.gen(function*() {
                const store = yield* Core.SourceStore.SourceStore
                const syncReport = yield* Core.Sync.runSync({
                  maxPages: pages,
                  adapter: {
                    provider: "github",
                    connectionId: "conn-1",
                    stream: "issues",
                    changes: (cursor) => {
                      const pageNum = cursor === null ? 1 : Number(cursor)
                      const done = pageNum >= pages
                      return Effect.succeed({
                        records: [{ ...rec, externalId: `issue-${pageNum}`, updatedAtMs: t1 + pageNum }],
                        cursor: done ? String(pageNum) : String(pageNum + 1),
                        reset: false,
                        done
                      })
                    }
                  }
                })
                if (syncReport.pages !== pages || syncReport.inserted !== pages) return false
                const retrieved = yield* store.retrieve({
                  allowed: [grant],
                  limit: 20
                })
                if (covered) {
                  if (retrieved.length !== pages) return false
                } else {
                  if (retrieved.length !== 0) return false
                }
                return true
              }).pipe(Effect.provide(storeLayer))
              if (!ok) return false
            }

            const memCur = yield* Core.CursorStore.makeMemory
            yield* memCur.set("k", "v1")
            if ((yield* memCur.get("k")) !== "v1") return false
            if (
              !Core.Connection.containersAllowed({ containers: [grantContainer] }, recordContainer) &&
              (grantContainer === "*" || grantContainer === recordContainer)
            ) {
              return false
            }

            Schema.decodeUnknownResult(GitHub.Payload.Issue)({ bad: true })
            Schema.decodeUnknownResult(Telegram.Payload.Message)({ message_id: 1 })
            return true
          }),
        { seed: seed + 2, executions: Math.min(executions, 40) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("GitHub DelegationPolicy, AuthBrokerPolicy, AuthConsent, pushSource & rateBudget enforce strict authorization & rate limits", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        now: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1000, maximum: 10_000 }))),
        delta: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: -500, maximum: 5000 }))),
        ttl: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 100, maximum: 2000 }))),
        path: Schema.Literals([
          "docs/guide.md",
          "docs/../.github/workflows/ci.yml",
          ".github/workflows/ci.yml",
          "docs/.\t./secret.md",
          "docs/%2e%2e/secret.md",
          "docs\\escape.md",
          "other/file.md"
        ]),
        readPath: Schema.Literals([
          "/repos/smithersai/smithers/issues",
          "/repos/smithersai/smithers/pulls/1?state=open",
          "/repos/smithersai/smithers/secrets/actions",
          "/repos/alice/smithers/branches",
          "/repositories/42/issues",
          "/repositories/042/issues",
          "/repos/smithersai/smithers/../../evil"
        ]),
        method: Schema.Literals(["GET", "POST", "PATCH", "DELETE", "HEAD"]),
        status: Schema.Literals([200, 403, 429, 500]),
        remaining: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 100 })))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ now, delta, ttl, path, readPath, method, status, remaining }) =>
          Effect.sync(() => {
            // AuthBrokerPolicy exact specs
            const expires = now + delta
            if (AuthBrokerPolicy.validDeadline(expires, now, ttl) !== (expires > now && expires <= now + ttl)) {
              return false
            }
            if (AuthBrokerPolicy.liveRecord("a", "a", expires, now) !== (expires > now)) return false
            if (AuthBrokerPolicy.liveRecord("a", "b", expires, now)) return false

            // DelegationPolicy grant validation & operation authorization
            const grant: DelegationPolicy.Grant = {
              repository: "smithersai/smithers",
              repositoryId: 42,
              scopes: ["issues", "proposals"],
              paths: ["docs/"],
              branchPrefix: "proposals/",
              labelPrefix: "site:"
            }
            if (!DelegationPolicy.validGrant(grant)) return false
            if (DelegationPolicy.validGrant({ ...grant, paths: [".github/"] })) return false
            if (DelegationPolicy.validGrant({ ...grant, repositoryId: 0 })) return false

            const commitAllowed = DelegationPolicy.permits([grant], "alice", {
              kind: "commit.create",
              repository: "smithersai/smithers",
              branch: "proposals/fix-1",
              expectedHeadOid: "abc",
              headline: "update doc",
              additions: [{ path, contents: "hi" }],
              deletions: []
            })
            const pathSafe = path === "docs/guide.md"
            if (commitAllowed !== pathSafe) return false

            // Pull request head MUST belong to login & branchPrefix
            if (
              !DelegationPolicy.permits([grant], "alice", {
                kind: "pull.create",
                repository: "smithersai/smithers",
                head: "alice:proposals/fix-1",
                base: "main",
                title: "t",
                body: "b"
              })
            ) return false
            if (
              DelegationPolicy.permits([grant], "alice", {
                kind: "pull.create",
                repository: "smithersai/smithers",
                head: "bob:proposals/fix-1",
                base: "main",
                title: "t",
                body: "b"
              })
            ) return false

            // Label ops MUST require labelPrefix
            if (
              !DelegationPolicy.permits([grant], "alice", {
                kind: "label.create",
                repository: "smithersai/smithers",
                name: "site:bug",
                color: "ffffff"
              })
            ) return false
            if (
              DelegationPolicy.permits([grant], "alice", {
                kind: "label.create",
                repository: "smithersai/smithers",
                name: "admin",
                color: "ffffff"
              })
            ) return false

            // Read target & publicRead MUST block secrets/traversal/leading-zero IDs
            const rt = DelegationPolicy.readTarget([grant], "alice", readPath)
            if ((readPath.includes("secrets") || readPath.includes("..")) && rt !== undefined) return false
            const reads: ReadonlyArray<DelegationPolicy.Read> = [{
              repository: "smithersai/smithers",
              repositoryId: 42
            }]
            const pr = DelegationPolicy.publicRead(reads, readPath)
            if (
              (readPath.includes("secrets") || readPath.includes("..") || readPath.includes("/042/")) &&
              pr !== undefined
            ) {
              return false
            }
            if (DelegationPolicy.liveDelegation("active", expires, now) !== (expires > now)) return false

            // AuthConsent pure helpers
            AuthConsent.pageOf("https://github.com/login/oauth/authorize", "https://github.com")
            AuthConsent.pageOf(undefined, "https://github.com")
            AuthConsent.hourlyBucket(remaining)

            // GitHub PushEvent source extraction
            GitHub.Payload.pushSource({
              ref: "refs/heads/main",
              after: "0123456789abcdef0123456789abcdef01234567",
              repository: { full_name: "smithersai/smithers", id: 42 }
            })

            // RateBudget state machine invariants
            const isW = RateBudget.isWrite(method)
            if ((method === "GET" || method === "HEAD") && isW) return false
            const res = RateBudget.resourceOf(readPath)
            const limits = RateBudget.resolveLimits({})
            let st = RateBudget.emptyState
            const adm = RateBudget.begin(st, now, res)
            if (adm.admitted) st = adm.state
            const headers = new Headers({
              "x-ratelimit-remaining": String(remaining),
              "x-ratelimit-limit": "5000",
              "x-ratelimit-reset": String(Math.floor((now + 60_000) / 1000)),
              "x-ratelimit-resource": res
            })
            const finished = RateBudget.finish(
              st,
              now,
              {
                resource: res,
                limited: status === 429 || status === 403,
                headers: (name) => headers.get(name) ?? undefined
              },
              limits
            )
            st = finished.state
            if (isW) {
              const wr = RateBudget.reserveWrites(st, now, 1, limits)
              st = RateBudget.releaseWrite(wr.state, wr.slots[0] ?? now)
            }
            RateBudget.currentBudget(st, now, res)
            RateBudget.earliestStart(st, now, isW ? 1 : 0, res, limits)
            return true
          }),
        { seed: seed + 3, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("GitHubClient enforces retry classification, token redaction, redirect refusal, origin pinning on pagination, and Repository path safety", async () => {
    const secretToken = "ghp_SUPERSECRETTOKENVALUE1234567890"
    const arb = Arbitrary.schema(
      Schema.Struct({
        method: Schema.Literals(["GET", "POST", "PATCH", "DELETE"]),
        status: Schema.Literals([200, 204, 302, 400, 401, 403, 404, 422, 429, 500, 503]),
        rateLimited403: Schema.Boolean,
        retryAfter: Schema.Literals(["", "5", "999999"]),
        nextOrigin: Schema.Literals(["same", "evil", "none"]),
        owner: Schema.Literals(["octocat", "org_emu", "..", "-bad", "a/b"]),
        repo: Schema.Literals(["smithers", "app.js", ".", "..", "a/b"]),
        login: Schema.Literals(["octocat", "smithers[bot]", "../admin", ""])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ method, status, rateLimited403, retryAfter, nextOrigin, owner, repo, login }) =>
          Effect.gen(function*() {
            const ownerOk = GitHub.Repository.isOwner(owner)
            const repoOk = GitHub.Repository.isRepo(repo)
            const pathRes = yield* GitHub.Repository.requireRepositoryPath(owner, repo).pipe(Effect.result)
            if (ownerOk && repoOk) {
              if (pathRes._tag !== "Success" || pathRes.success !== `${owner}/${repo}`) throw new Error("FAIL_AT_" + 1)
            } else {
              if (pathRes._tag !== "Failure") throw new Error("FAIL_AT_" + 2)
            }

            const fakeHttp = HttpClient.make((req) => {
              const fullUrl = Option.getOrElse(Option.map(HttpClientRequest.toUrl(req), (u) => u.href), () => req.url)
              const headers = new Headers({ "content-type": "application/json" })
              if (retryAfter !== "") headers.set("retry-after", retryAfter)
              if (status === 403 && rateLimited403) headers.set("x-ratelimit-remaining", "0")
              if (status === 302) headers.set("location", "https://evil.example.com/steal")
              if (fullUrl.includes("per_page=1") && status === 200) {
                headers.set(
                  "link",
                  "<https://api.github.com/repos/octocat/smithers/issues?page=7&per_page=1>; rel=\"last\""
                )
                return Effect.succeed(
                  HttpClientResponse.fromWeb(req, new Response(JSON.stringify([{ id: 1 }]), { status: 200, headers }))
                )
              }
              if (fullUrl.includes("per_page=2") && status === 200) {
                if (nextOrigin === "same" && !fullUrl.includes("&page=2")) {
                  headers.set(
                    "link",
                    "<https://api.github.com/repos/octocat/smithers/issues?per_page=2&page=2>; rel=\"next\""
                  )
                } else if (nextOrigin === "evil") {
                  headers.set("link", "<https://evil.example.com/steal?page=2>; rel=\"next\"")
                }
                return Effect.succeed(
                  HttpClientResponse.fromWeb(req, new Response(JSON.stringify([{ id: 1 }]), { status: 200, headers }))
                )
              }
              if (status === 204) {
                return Effect.succeed(HttpClientResponse.fromWeb(req, new Response(null, { status: 204, headers })))
              }
              if (status >= 400) {
                return Effect.succeed(
                  HttpClientResponse.fromWeb(
                    req,
                    new Response(JSON.stringify({ message: `err echoed ${secretToken}` }), { status, headers })
                  )
                )
              }
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  req,
                  new Response(JSON.stringify({ permission: "admin", role_name: "admin", user: { id: 7 } }), {
                    status,
                    headers
                  })
                )
              )
            })

            const client = yield* GitHub.GitHubClient.make(
              { token: secretToken, apiBaseUrl: "https://api.github.com" },
              {}
            ).pipe(Effect.provideService(HttpClient.HttpClient, fakeHttp))

            const reqRes = yield* client.request(
              method,
              "/repos/octocat/smithers/issues",
              method === "GET" ? undefined : { title: "hi" }
            ).pipe(Effect.result)
            if (status === 200 || status === 204) {
              if (reqRes._tag !== "Success") throw new Error("FAIL_AT_" + 3)
            } else {
              if (reqRes._tag !== "Failure") throw new Error("FAIL_AT_" + 4)
              const err = reqRes.failure
              if (err.message.includes(secretToken)) throw new Error("FAIL_AT_" + 5)
              if (JSON.stringify(err.details ?? {}).includes(secretToken)) throw new Error("FAIL_AT_" + 6)
              const details = err.details as
                | { readonly retryable?: boolean; readonly outcomeUnknown?: boolean }
                | undefined
              if (status === 429 || (status === 403 && rateLimited403)) {
                if (err.reason !== "rate-limited" && details?.retryable !== true) throw new Error("FAIL_AT_" + 7)
              }
              if (status >= 500 && method !== "GET") {
                if (details?.retryable === true) throw new Error("FAIL_AT_" + 8)
              }
            }

            if (status === 200) {
              const paged = yield* client.paginate("/repos/octocat/smithers/issues", {
                perPage: 2,
                maxPages: 3,
                withNext: true
              }).pipe(Effect.result)
              if (nextOrigin === "evil") {
                if (paged._tag !== "Failure") throw new Error("FAIL_AT_" + 9)
              } else {
                if (paged._tag !== "Success") throw new Error("FAIL_AT_" + 10)
                if (nextOrigin === "same" && paged.success.items.length !== 2) throw new Error("FAIL_AT_" + 11)
                if (nextOrigin === "none" && paged.success.items.length !== 1) throw new Error("FAIL_AT_" + 12)
              }

              const cnt = yield* client.count("/repos/octocat/smithers/issues").pipe(Effect.result)
              if (cnt._tag !== "Success" || cnt.success.total !== 7) throw new Error("FAIL_AT_" + 13)

              const permRes = yield* GitHub.Collaborators.permission("octocat", "smithers", login).pipe(
                Effect.provideService(GitHub.GitHubClient.GitHubClient, client),
                Effect.result
              )
              if (GitHub.Collaborators.LOGIN_PATTERN.test(login)) {
                if (
                  permRes._tag !== "Success" || Option.isNone(permRes.success) ||
                  permRes.success.value.permission !== "admin"
                ) throw new Error("FAIL_AT_" + 14)
              } else {
                if (permRes._tag !== "Failure") throw new Error("FAIL_AT_" + 15)
              }
            }

            // Pure helpers
            const rlHeaders = new Headers({
              ...(retryAfter !== "" ? { "retry-after": retryAfter } : {}),
              ...(rateLimited403 ? { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1700000100" } : {})
            })
            GitHub.GitHubClient.isRateLimitResponse(status, rlHeaders, {
              message: rateLimited403 ? "secondary rate limit" : "nope"
            })
            GitHub.GitHubClient.retryAfterMs(rlHeaders, 1_700_000_000_000)
            GitHub.GitHubClient.nextPageUrl("<https://api.github.com/a?page=2>; rel=\"next\"")
            GitHub.GitHubClient.lastPageNumber("<https://api.github.com/a?page=9>; rel=\"last\"")
            return true
          }).pipe(Effect.provide(Logger.layer([]))),
        { seed: seed + 4, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
