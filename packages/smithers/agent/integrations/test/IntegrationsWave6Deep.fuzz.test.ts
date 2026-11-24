import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Exit, Layer, Option, Redacted, Schema } from "effect"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as Channel from "../src/core/Channel.ts"
import * as Connection from "../src/core/Connection.ts"
import * as CoreMigrations from "../src/core/Migrations.ts"
import * as SourceRecord from "../src/core/SourceRecord.ts"
import { layerMemory as sourceStoreMemory, layerSql as sourceStoreSql, SourceStore } from "../src/core/SourceStore.ts"
import * as Broker from "../src/github/AuthBroker.vibe"
import * as AuthConsent from "../src/github/AuthConsent.vibe"
import * as Issues from "../src/github/Issues.ts"
import * as Once from "../src/github/Once.ts"
import { Core, GitHub } from "../src/index.ts"
import { durable } from "./DurableBroker.vibe"
import { json as jsonRes, startFixture } from "./Fixture.ts"
import { gitHubLayer } from "./Http.ts"
import { recorded, register, withChannels } from "./SourceDoorHarness.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261124")

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const makeRecord = (
  id: string,
  text: string,
  updatedAtMs: number,
  containerId: string,
  version: string | null = null,
  deleted = false
): SourceRecord.SourceRecord => ({
  provider: "github",
  connectionId: "team-chat",
  externalId: id,
  kind: "message",
  url: `https://chat.test/m/${id}`,
  author: { id: "u1", label: "Alice" },
  createdAtMs: updatedAtMs - 10,
  updatedAtMs,
  version,
  retrievedAtMs: updatedAtMs + 1,
  access: { scope: "container", containerId },
  thread: { containerId, threadId: "t1", parentId: null },
  text: deleted ? "" : text,
  deleted,
  payload: deleted ? null : { id, text }
})

describe("@smthrs/integrations Wave 6 deep fuzz (SourceRecord, Connection, SourceStore SQLite, Channel, AuthBroker, Once)", () => {
  it("SourceRecord ordering/tombstones/containers & Connection policies obey total-order, containment, and secret-resolution invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        v1: Schema.NullOr(Schema.Literals(["1", "2", "10", "v1", "v2", "a"])),
        v2: Schema.NullOr(Schema.Literals(["1", "2", "10", "v1", "v2", "b"])),
        v3: Schema.NullOr(Schema.Literals(["1", "2", "10", "v1", "v2", "c"])),
        t1: Schema.Int.check(Schema.isBetween({ minimum: 1000, maximum: 2000 })),
        t2: Schema.Int.check(Schema.isBetween({ minimum: 1000, maximum: 2000 })),
        d1: Schema.Boolean,
        d2: Schema.Boolean,
        container: Schema.Literals(["c-a", "c-b", "c-c"]),
        wildcard: Schema.Boolean,
        personal: Schema.Boolean,
        principal: Schema.Literals(["alice", "bob"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ v1, v2, v3, t1, t2, d1, d2, container, wildcard, personal, principal }) =>
          Effect.gen(function*() {
            expect(SourceRecord.compareVersion(v1, v1)).toBe(0)
            const c12 = SourceRecord.compareVersion(v1, v2)
            const c21 = SourceRecord.compareVersion(v2, v1)
            expect(Math.sign(c12) + Math.sign(c21)).toBe(0)
            const c23 = SourceRecord.compareVersion(v2, v3)
            const c13 = SourceRecord.compareVersion(v1, v3)
            if (c12 <= 0 && c23 <= 0) expect(c13).toBeLessThanOrEqual(0)
            if (c12 >= 0 && c23 >= 0) expect(c13).toBeGreaterThanOrEqual(0)

            const o1: SourceRecord.Ordering = { updatedAtMs: t1, deleted: d1, version: v1 }
            const o2: SourceRecord.Ordering = { updatedAtMs: t2, deleted: d2, version: v2 }
            expect(SourceRecord.compare(o1, o1)).toBe(0)
            expect(Math.sign(SourceRecord.compare(o1, o2)) + Math.sign(SourceRecord.compare(o2, o1))).toBe(0)
            expect(SourceRecord.supersedes(o1, o2)).toBe(SourceRecord.compare(o1, o2) > 0)

            const rec = makeRecord("m1", "hello", t1, container, v1, d1)
            const decoded = yield* SourceRecord.decode(rec)
            expect(decoded.externalId).toBe("m1")
            const tomb = SourceRecord.tombstone(
              {
                provider: rec.provider,
                connectionId: rec.connectionId,
                kind: rec.kind,
                externalId: rec.externalId,
                access: rec.access,
                thread: rec.thread
              },
              t1 + 50
            )
            expect(tomb.deleted).toBe(true)
            expect(SourceRecord.containers(rec)).toContain(container)
            const ref = SourceRecord.reference(rec)
            expect(ref.externalId).toBe("m1")

            const conn: Connection.Connection = {
              id: "team-chat",
              provider: "github",
              label: "Team Chat",
              credential: { id: "cred-1", name: "chat-token" },
              scopes: ["read"],
              personal,
              containers: wildcard ? [Connection.ANY_CONTAINER] : ["c-a", "c-b"]
            }
            const decConn = yield* Connection.decode(conn)
            expect(decConn.id).toBe("team-chat")
            const allowed = Connection.containersAllowed(conn, container)
            expect(allowed).toBe(wildcard || container !== "c-c")

            const authz = Connection.personalPolicy({ personalPrincipals: ["alice"] })
            const canUse = yield* authz(principal, conn)
            expect(canUse).toBe(personal ? principal === "alice" : true)

            const fakeCred = {
              resolve: (r: { readonly id: string; readonly name: string }) =>
                Effect.succeed(Redacted.make(`sec-${r.name}`))
            } as unknown as Parameters<typeof Connection.resolveSecret>[0]["credentials"]
            const resolved = yield* Connection.resolveSecret({
              credentials: fakeCred,
              connection: conn,
              principal,
              authorize: authz
            }).pipe(Effect.exit)
            if (canUse) {
              expect(Exit.isSuccess(resolved)).toBe(true)
            } else {
              expect(Exit.isFailure(resolved)).toBe(true)
            }
            return true
          }),
        { executions: Math.min(executions, 120), seed }
      )
    )
    assertPassed(report)
  })

  it(
    "Differential fuzz: SQLite SourceStore matches Memory SourceStore across apply, tombstones, container filtering, text search, and purge",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          ops: Schema.Array(
            Schema.Struct({
              kind: Schema.Literals([
                "put",
                "tombstone",
                "search",
                "get",
                "validate",
                "revokeContainer",
                "revokeConn",
                "reinstate",
                "commit"
              ]),
              id: Schema.Literals(["m1", "m2", "m3", "m4"]),
              container: Schema.Literals(["c-a", "c-b"]),
              ts: Schema.Int.check(Schema.isBetween({ minimum: 1000, maximum: 1020 })),
              text: Schema.Literals(["Deploy 100%_alpha", "release beta", "notes gamma"])
            })
          ).check(Schema.isMinLength(6), Schema.isMaxLength(16))
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ ops }) =>
            Effect.promise(async () => {
              const dir = mkdtempSync(join(tmpdir(), "smthrs-srcstore-"))
              try {
                const dbLayer = Layer.provideMerge(
                  DurableWriter.layer(),
                  NodeDatabase.layer({ filename: join(dir, "sources.sqlite") })
                )
                const migrated = Layer.provideMerge(CoreMigrations.layer, dbLayer)
                const sqlLayer = Layer.provideMerge(sourceStoreSql, migrated)

                const runWith = (layer: Layer.Layer<SourceStore, unknown, never>) =>
                  Effect.runPromise(
                    Effect.gen(function*() {
                      const store = yield* SourceStore
                      const trace: Array<unknown> = []
                      for (const op of ops) {
                        if (op.kind === "put") {
                          const r = yield* store.apply([makeRecord(op.id, op.text, op.ts, op.container, String(op.ts))])
                          trace.push(["put", r.inserted, r.updated, r.unchanged, r.tombstoned])
                        } else if (op.kind === "tombstone") {
                          const t = SourceRecord.tombstone(
                            {
                              provider: "github",
                              connectionId: "team-chat",
                              kind: "message",
                              externalId: op.id,
                              access: { scope: "container", containerId: op.container },
                              thread: { containerId: op.container, threadId: "t1", parentId: null }
                            },
                            op.ts
                          )
                          const r = yield* store.apply([t])
                          trace.push(["tomb", r.inserted, r.updated, r.unchanged, r.tombstoned])
                        } else if (op.kind === "get") {
                          const got = yield* store.get("team-chat", op.id)
                          trace.push([
                            "get",
                            Option.isSome(got)
                              ? [got.value.record.externalId, got.value.record.deleted, got.value.revoked]
                              : null
                          ])
                        } else if (op.kind === "search") {
                          const found = yield* store.retrieve({
                            allowed: [{ connectionId: "team-chat", containers: [op.container] }],
                            query: op.text.split(" ")[0]!,
                            limit: 10
                          })
                          trace.push(["search", found.map((f) => [f.externalId, f.updatedAtMs])])
                        } else if (op.kind === "validate") {
                          const v = yield* store.validate({
                            allowed: [{ connectionId: "team-chat", containers: [op.container] }],
                            references: [
                              SourceRecord.reference(makeRecord(op.id, op.text, op.ts, op.container, String(op.ts)))
                            ]
                          })
                          trace.push(["validate", v.map((x) => x.validity)])
                        } else if (op.kind === "revokeContainer") {
                          const n = yield* store.revokeContainer("team-chat", op.container)
                          const rev = yield* store.isRevoked("team-chat", op.container)
                          trace.push(["revC", n, rev])
                        } else if (op.kind === "revokeConn") {
                          const n = yield* store.revokeConnection("team-chat")
                          const rev = yield* store.isRevoked("team-chat")
                          trace.push(["revAll", n, rev])
                        } else if (op.kind === "reinstate") {
                          yield* store.reinstate("team-chat")
                          yield* store.reinstate("team-chat", op.container)
                          trace.push([
                            "rein",
                            yield* store.isRevoked("team-chat"),
                            yield* store.isRevoked("team-chat", op.container)
                          ])
                        } else {
                          const c = yield* store.commit({
                            provider: "github",
                            connectionId: "team-chat",
                            stream: "s1",
                            changes: {
                              records: [makeRecord(op.id, op.text, op.ts, op.container, String(op.ts))],
                              cursor: `cur-${op.ts}`,
                              reset: op.ts % 2 === 0,
                              done: true
                            }
                          })
                          const cur = yield* store.cursor("team-chat", "s1")
                          trace.push(["commit", c.inserted, c.updated, c.swept, cur])
                        }
                      }
                      return trace
                    }).pipe(Effect.provide(layer))
                  )

                const memTrace = await runWith(sourceStoreMemory)
                const sqlTrace = await runWith(sqlLayer)
                expect(sqlTrace).toEqual(memTrace)
                return true
              } finally {
                rmSync(dir, { recursive: true, force: true })
              }
            }),
          { executions: Math.min(executions, 20), seed: seed + 1 }
        )
      )
      assertPassed(report)
    },
    60_000
  )

  it(
    "Channel.fromSource, signedBodyKey, constantSecret, and AuthBroker + AuthConsent enforce auth, PKCE, CSRF, and dedupe invariants",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          routeKind: Schema.Literals(["flow", "signal"]),
          fault: Schema.Literals([
            "none",
            "exchange",
            "user",
            "identity",
            "tamperReturn",
            "wrongOrigin",
            "badCookie",
            "wrongPkce",
            "replay"
          ]),
          eventId: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })),
          consentDecision: Schema.Literals(["approve", "deny"])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ routeKind, fault, eventId, consentDecision }) =>
            Effect.gen(function*() {
              const digest = yield* Channel.signedBodyKey(new TextEncoder().encode(`body-${eventId}`))
              expect(digest.length).toBeGreaterThan(10)
              const sec = yield* Channel.constantSecret(Redacted.make("s-1"))(
                Redacted.make({ id: "c1", name: "k" }) as never
              )
              expect(Redacted.value(sec)).toBe("s-1")

              const seen = recorded()
              const door = Channel.fromSource({
                name: "chat",
                route: routeKind === "flow" ? Channel.startFlow("triage") : Channel.signalRun(`run-${eventId}`)
              })
              const ev = {
                source: "chat",
                eventName: "integration:chat:msg",
                correlationId: `room:${eventId}`,
                payload: { eventId },
                dedupeKey: `chat:${eventId}`,
                receivedAtMs: 2_000 + eventId
              }
              const [r1, r2] = yield* Effect.promise(() =>
                withChannels(
                  Effect.gen(function*() {
                    yield* register(door)
                    const first = yield* door.ingest(ev)
                    const second = yield* door.ingest({ ...ev, receivedAtMs: 9_000 + eventId })
                    return [first, second] as const
                  }),
                  seen
                )
              )
              expect(r1._tag).toBe("Accepted")
              expect(r2._tag).toBe("AlreadyApplied")

              const page = AuthConsent.pageOf(
                consentDecision === "approve" ? "https://github.test/login/oauth/authorize" : undefined,
                "https://github.test"
              )
              expect(["shown", "skipped"]).toContain(page)
              expect(AuthConsent.hourlyBucket(eventId)).toBe(
                eventId >= AuthConsent.HOURLY_TOKENS ? "at_limit" : "under_limit"
              )
              yield* AuthConsent.observe({
                page,
                afterRevocation: consentDecision === "deny",
                hourlyTokens: eventId,
                path: routeKind === "flow" ? "sign_in" : "connect"
              })

              const origin = "https://vibelang.smithers.sh"
              const otherOrigin = "https://other.smithers.sh"
              const secret = Redacted.make("a".repeat(32))
              const sites = [
                { origin, secret },
                { origin: otherOrigin, secret: Redacted.make("b".repeat(32)) }
              ]
              const keys = yield* Core.CookieKeys.make({ primary: secret }, "primary")
              const github = GitHub.Auth.GitHubAuth.of({
                authorizeUrl: ({ state, codeChallenge, redirectUri }) =>
                  "https://github.test/authorize?" +
                  new URLSearchParams({ state, code_challenge: codeChallenge, redirect_uri: redirectUri }),
                exchange: () =>
                  fault === "exchange"
                    ? Effect.fail(new GitHub.Auth.GitHubRefused({ step: "exchange", reason: "unavailable" }))
                    : Effect.succeed({
                      accessToken: Redacted.make("gh-secret-tok"),
                      refreshToken: Redacted.make("gh-refresh-tok"),
                      expiresAt: null
                    }),
                user: () =>
                  fault === "user"
                    ? Effect.fail(new GitHub.Auth.GitHubRefused({ step: "user", reason: "unavailable" }))
                    : Effect.succeed({ id: fault === "identity" ? 0 : 7, login: "ada" }),
                refresh: () => Effect.fail(new GitHub.Auth.GitHubRefused({ step: "refresh", reason: "rejected" })),
                permission: () => Effect.succeed("read"),
                revoke: () => Effect.void,
                deviceCode: () => Effect.fail(new GitHub.Auth.GitHubRefused({ step: "device", reason: "unavailable" })),
                deviceToken: () => Effect.fail(new GitHub.Auth.GitHubRefused({ step: "device", reason: "unavailable" }))
              })
              expect(AuthConsent.githubOrigin(github)).toBe("https://github.test")
              const store = yield* Broker.memoryStore()
              const broker = durable(
                yield* Broker.make({
                  origin: "https://smithers.sh",
                  sites,
                  keys,
                  store,
                  encryptionKey: Redacted.make("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="),
                  github
                })
              )
              const siteClient = yield* Broker.site({ origin, brokerOrigin: "https://smithers.sh", secret })
              const pending = yield* siteClient.begin()

              if (fault === "tamperReturn") {
                const ex = yield* broker.start(origin, pending.returnTo + "0").pipe(Effect.exit)
                expect(Exit.isFailure(ex)).toBe(true)
                return true
              }
              if (fault === "wrongOrigin") {
                const ex = yield* broker.start(otherOrigin, pending.returnTo).pipe(Effect.exit)
                expect(Exit.isFailure(ex)).toBe(true)
                return true
              }

              const started = yield* broker.start(origin, pending.returnTo)
              const state = new URL(started.location).searchParams.get("state")!

              if (fault === "badCookie") {
                const ex = yield* broker.callback(state, "code-1", started.cookie + "0").pipe(Effect.exit)
                expect(Exit.isFailure(ex)).toBe(true)
                return true
              }

              const cb = yield* broker.callback(state, "code-1", started.cookie).pipe(Effect.exit)
              if (fault === "exchange" || fault === "user" || fault === "identity") {
                expect(Exit.isFailure(cb)).toBe(true)
                return true
              }
              expect(Exit.isSuccess(cb)).toBe(true)
              if (Exit.isSuccess(cb)) {
                const fragment = new URLSearchParams(new URL(cb.value).hash.slice(1))
                const handoffCode = fragment.get("code")!
                if (fault === "wrongPkce") {
                  const badReq = yield* siteClient.redemption({ ...pending, verifier: "x".repeat(43) }, handoffCode)
                  const ex = yield* broker.exchange(origin, badReq).pipe(Effect.exit)
                  expect(Exit.isFailure(ex)).toBe(true)
                  return true
                }
                const reqPayload = yield* siteClient.redemption(pending, handoffCode)
                const exchanged = yield* broker.exchange(origin, reqPayload)
                expect(exchanged.login).toBe("ada")
                if (fault === "replay") {
                  const replayCb = yield* broker.callback(state, "code-1", started.cookie).pipe(Effect.exit)
                  expect(Exit.isFailure(replayCb)).toBe(true)
                  const replayEx = yield* broker.exchange(origin, reqPayload).pipe(Effect.exit)
                  expect(Exit.isFailure(replayEx)).toBe(true)
                }
              }
              const req = HttpServerRequest.fromWeb(new Request("https://smithers.sh/health"))
              expect(req.url).toContain("/health")
              return true
            }),
          { executions: Math.min(executions, 50), seed: seed + 2 }
        )
      )
      assertPassed(report)
    },
    60_000
  )

  it("GitHub.Once trailer/branch/issue/comment/review/pull reconciliation resists foreign collisions", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        label: Schema.Literals(["fix", "feat", "docs"]),
        keyHex: Schema.Literals([
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210"
        ]),
        msg: Schema.Literals(["Hello world", "Multi\nline\nbody", "Edge: trailer"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ label, keyHex, msg }) =>
          Effect.promise(async () => {
            const stamped = Once.withTrailer(msg, keyHex)
            expect(Once.trailerKeyOf(stamped)).toBe(keyHex)
            expect(Once.trailerKeyOf(msg)).toBeUndefined()
            const br = Once.branchName("smithers/", label, keyHex)
            expect(br).toContain(keyHex.slice(0, Once.BRANCH_KEY_LENGTH))

            const USER = { id: 1, login: "octocat", type: "User", site_admin: false }
            const BASE = "a".repeat(40)
            const OTHER = "9".repeat(64)
            let seq = 1
            const nextSha = () => (seq++).toString(16).padStart(40, "b")
            const refs = new Map<string, string>([["main", BASE]])
            const issues: Array<Record<string, unknown>> = [
              {
                id: 1,
                node_id: "I_1",
                number: 1,
                title: "T",
                body: Issues.withWriteMarker(msg, OTHER),
                state: "open",
                state_reason: null,
                user: USER,
                labels: [],
                comments: 0,
                closed_at: null,
                html_url: "https://github.test/o/r/issues/1",
                created_at: "2026-10-20T10:00:00Z",
                updated_at: "2026-10-20T10:00:00Z"
              }
            ]
            const comments: Array<Record<string, unknown>> = [
              {
                id: 10,
                node_id: "IC_10",
                body: Issues.withWriteMarker(msg, OTHER),
                user: USER,
                html_url: "https://github.test/o/r/issues/7#c",
                issue_url: "https://api.github.test/repos/o/r/issues/7",
                author_association: "OWNER",
                created_at: "2026-10-20T10:00:00Z",
                updated_at: "2026-10-20T10:00:00Z"
              }
            ]
            const reviews: Array<Record<string, unknown>> = [
              {
                id: 20,
                node_id: "PRR_20",
                body: Issues.withWriteMarker(msg, OTHER),
                state: "COMMENTED",
                user: USER,
                commit_id: BASE,
                html_url: "https://github.test/o/r/pull/7#r",
                submitted_at: "2026-10-20T10:00:00Z"
              }
            ]
            const pulls: Array<Record<string, unknown>> = []

            const fixture = await startFixture((request, response) => {
              const url = new URL(request.url ?? "/", "http://127.0.0.1")
              const path = url.pathname
              const body = request.body ? JSON.parse(request.body) : {}
              if (path === "/repos/o/r/git/refs" && request.method === "POST") {
                const name = String(body.ref).replace(/^refs\/heads\//, "")
                refs.set(name, body.sha)
                return jsonRes(response, 201, { ref: body.ref, object: { sha: body.sha, type: "commit" } })
              }
              if (path.startsWith("/repos/o/r/git/matching-refs/heads/")) {
                const pref = decodeURIComponent(path.slice("/repos/o/r/git/matching-refs/heads/".length))
                const matched = [...refs.entries()]
                  .filter(([k]) => k.startsWith(pref))
                  .map(([k, sha]) => ({ ref: `refs/heads/${k}`, object: { sha, type: "commit" } }))
                return jsonRes(response, 200, matched)
              }
              if (path === "/repos/o/r/issues" && request.method === "POST") {
                const num = 10 + issues.length
                const iss = {
                  id: 100 + num,
                  node_id: `I_${num}`,
                  number: num,
                  title: body.title,
                  body: body.body,
                  state: "open",
                  state_reason: null,
                  user: USER,
                  labels: [],
                  comments: 0,
                  closed_at: null,
                  html_url: `https://github.test/o/r/issues/${num}`,
                  created_at: "2026-10-20T10:01:00Z",
                  updated_at: "2026-10-20T10:01:00Z"
                }
                issues.push(iss)
                return jsonRes(response, 201, iss)
              }
              if (path === "/repos/o/r/issues" && request.method === "GET") {
                return jsonRes(response, 200, [...issues].reverse())
              }
              if (path === "/repos/o/r/issues/7/comments") {
                if (request.method === "GET") return jsonRes(response, 200, comments)
                const c = {
                  id: 500 + comments.length,
                  node_id: `IC_${comments.length}`,
                  body: body.body,
                  user: USER,
                  html_url: "https://github.test/o/r/issues/7#c",
                  issue_url: "https://api.github.test/repos/o/r/issues/7",
                  author_association: "OWNER",
                  created_at: "2026-10-20T10:01:00Z",
                  updated_at: "2026-10-20T10:01:00Z"
                }
                comments.push(c)
                return jsonRes(response, 201, c)
              }
              if (path === "/repos/o/r/pulls/7/reviews") {
                if (request.method === "GET") return jsonRes(response, 200, reviews)
                const rv = {
                  id: 900 + reviews.length,
                  node_id: `PRR_${reviews.length}`,
                  body: body.body,
                  state: "COMMENTED",
                  user: USER,
                  commit_id: BASE,
                  html_url: "https://github.test/o/r/pull/7#r",
                  submitted_at: "2026-10-20T10:01:00Z"
                }
                reviews.push(rv)
                return jsonRes(response, 201, rv)
              }
              if (path === "/repos/o/r/pulls" && request.method === "POST") {
                const num = 1 + pulls.length
                const pr = {
                  id: 2000 + num,
                  node_id: `PR_${num}`,
                  number: num,
                  title: body.title,
                  body: body.body,
                  state: "open",
                  draft: false,
                  merged: false,
                  mergeable: true,
                  closed_at: null,
                  merged_at: null,
                  merge_commit_sha: null,
                  user: USER,
                  labels: [],
                  html_url: `https://github.test/o/r/pull/${num}`,
                  head: { ref: body.head, sha: refs.get(body.head) ?? nextSha() },
                  base: { ref: body.base, sha: BASE },
                  created_at: "2026-10-20T10:01:00Z",
                  updated_at: "2026-10-20T10:01:00Z"
                }
                pulls.push(pr)
                return jsonRes(response, 201, pr)
              }
              if (path === "/repos/o/r/pulls" && request.method === "GET") {
                const head = url.searchParams.get("head")
                return jsonRes(
                  response,
                  200,
                  pulls.filter((p) => `o:${(p["head"] as Record<string, unknown>)["ref"]}` === head)
                )
              }
              return jsonRes(response, 404, { message: "Not Found" })
            })

            try {
              const layer = gitHubLayer({ apiBaseUrl: fixture.origin, token: "ghp_test" })
              await Effect.runPromise(
                Effect.gen(function*() {
                  // Branch keyed action: find none -> perform -> find matches
                  const branchOp = Once.branch("o", "r", { prefix: "smithers/", label, at: Effect.succeed(BASE) })
                  expect(Option.isNone(yield* branchOp.find(keyHex))).toBe(true)
                  const b1 = yield* branchOp.perform(keyHex)
                  const bFound = yield* branchOp.find(keyHex)
                  expect(Option.isSome(bFound) && bFound.value.name === b1.name).toBe(true)

                  // Issue keyed action ignores foreign OTHER key
                  const issueOp = Once.issue("o", "r", {
                    title: "T",
                    body: msg,
                    since: "2026-10-20T00:00:00Z",
                    author: "octocat"
                  })
                  expect(Option.isNone(yield* issueOp.find(keyHex))).toBe(true)
                  const i1 = yield* issueOp.perform(keyHex)
                  const iFound = yield* issueOp.find(keyHex)
                  expect(Option.isSome(iFound) && iFound.value.number === i1.number).toBe(true)

                  // Comment keyed action
                  const commentOp = Once.comment("o", "r", 7, msg, { author: "octocat" })
                  expect(Option.isNone(yield* commentOp.find(keyHex))).toBe(true)
                  const c1 = yield* commentOp.perform(keyHex)
                  const cFound = yield* commentOp.find(keyHex)
                  expect(Option.isSome(cFound) && cFound.value.id === c1.id).toBe(true)

                  // Review keyed action
                  const reviewOp = Once.review("o", "r", 7, { commitId: BASE, event: "COMMENT", body: msg })
                  expect(Option.isNone(yield* reviewOp.find(keyHex))).toBe(true)
                  const r1 = yield* reviewOp.perform(keyHex)
                  const rFound = yield* reviewOp.find(keyHex)
                  expect(Option.isSome(rFound) && rFound.value.id === r1.id).toBe(true)

                  // Pull request keyed action
                  const pullOp = Once.pull("o", "r", { head: b1.name, base: "main", title: "PR", body: msg })
                  expect(Option.isNone(yield* pullOp.find(keyHex))).toBe(true)
                  const p1 = yield* pullOp.perform(keyHex)
                  const pFound = yield* pullOp.find(keyHex)
                  expect(Option.isSome(pFound) && pFound.value.number === p1.number).toBe(true)
                }).pipe(Effect.provide(layer))
              )
              return true
            } finally {
              await fixture.close()
            }
          }),
        { executions: Math.min(executions, 10), seed: seed + 3 }
      )
    )
    assertPassed(report)
  }, 60_000)
})
