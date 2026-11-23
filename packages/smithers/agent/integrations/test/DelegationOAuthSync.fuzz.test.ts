import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Layer, Logger, Option, Redacted, Result, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { describe, expect, it } from "vitest"
import * as OAuthToken from "../src/core/OAuthToken.ts"
import * as Auth from "../src/github/Auth.vibe"
import * as AuthBroker from "../src/github/AuthBroker.vibe"
import * as Collaborators from "../src/github/Collaborators.ts"
import * as Delegation from "../src/github/Delegation.vibe"
import * as GitDatabase from "../src/github/GitDatabase.ts"
import * as GitHubClient from "../src/github/GitHubClient.ts"
import * as IssueChanges from "../src/github/IssueChanges.vibe"
import * as Proposals from "../src/github/Proposals.vibe"
import * as Sync from "../src/github/Sync.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")

const jsonResp = (req: HttpClientRequest.HttpClientRequest, status: number, body: unknown, headers: Record<string, string> = {}) =>
  HttpClientResponse.fromWeb(
    req,
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers }
    })
  )

describe("@smthrs/integrations OAuthToken, Auth, AuthBroker, GitDatabase, Sync, Collaborators, IssueChanges, Proposals & Delegation fuzz invariants", () => {
  it("OAuthToken.make, exchangeCode, exchangeRefreshToken & reasonForOAuthError handle rotation, caching & error mapping", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        authMode: Schema.Literals(["body", "basic"]),
        oauthErr: Schema.Literals([
          "invalid_grant",
          "invalid_client",
          "unauthorized_client",
          "invalid_scope",
          "invalid_request",
          "slow_down",
          "temporarily_unavailable",
          "custom_unknown_error"
        ]),
        rotates: Schema.Boolean,
        expiresIn: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 120, maximum: 7200 }))),
        httpFail: Schema.Literals([200, 400, 401, 500]),
        badUrl: Schema.Boolean
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ authMode, oauthErr, rotates, expiresIn, httpFail, badUrl }) =>
          Effect.gen(function*() {
            const mapped = OAuthToken.reasonForOAuthError(oauthErr)
            if (typeof mapped !== "string" || mapped.length === 0) return false

            let tokenSeq = 0
            const fakeHttp = HttpClient.make((req) =>
              Effect.sync(() => {
                tokenSeq++
                if (httpFail !== 200) {
                  return jsonResp(req, httpFail, { error: oauthErr, error_description: "denied" })
                }
                return jsonResp(req, 200, {
                  access_token: `atk_${tokenSeq}`,
                  token_type: "bearer",
                  expires_in: expiresIn,
                  ...(rotates ? { refresh_token: `rtk_${tokenSeq}` } : {}),
                  scope: "repo read:user"
                })
              })
            )

            const tokenUrl = badUrl ? "http://remote.example.com/oauth/token" : "https://auth.example.test/oauth/token"
            const codeRes = yield* OAuthToken.exchangeCode({
              tokenUrl,
              clientId: "cid-1",
              clientSecret: Redacted.make("csec-1"),
              clientAuthentication: authMode,
              code: Redacted.make("auth-code-1"),
              redirectUri: "https://app.example.test/cb"
            }).pipe(Effect.provideService(HttpClient.HttpClient, fakeHttp), Effect.result)

            if (badUrl || httpFail !== 200) {
              if (Result.isSuccess(codeRes)) return false
            } else {
              if (!Result.isSuccess(codeRes) || Redacted.value(codeRes.success.accessToken) !== "atk_1") return false
            }

            const store = OAuthToken.memoryStore(Redacted.make("rtk_init"))
            const srcRes = yield* OAuthToken.make({
              tokenUrl,
              clientId: "cid-1",
              clientSecret: Redacted.make("csec-1"),
              clientAuthentication: authMode,
              refreshToken: store
            }).pipe(Effect.provideService(HttpClient.HttpClient, fakeHttp), Effect.result)

            if (badUrl) {
              return Result.isFailure(srcRes)
            }
            if (Result.isFailure(srcRes)) return false
            const tok1 = yield* srcRes.success.token.pipe(Effect.result)
            if (httpFail !== 200) {
              return Result.isFailure(tok1)
            }
            if (Result.isFailure(tok1)) return false
            // Second read must reuse cached token without hitting token endpoint again
            const callsBefore = tokenSeq
            const tok2 = yield* srcRes.success.token
            if (Redacted.value(tok2) !== Redacted.value(tok1.success) || tokenSeq !== callsBefore) return false
            if (rotates) {
              const latest = yield* store.load
              if (!Redacted.value(latest).startsWith("rtk_")) return false
            }
            return true
          }).pipe(Effect.provide(Logger.layer([]))),
        { seed, executions: Math.min(executions, 80) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("GitHubAuth.layer & AuthBroker origin validation uphold OAuth, device-flow, permission & canonical origin invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        origin: Schema.Literals([
          "https://app.smithers.sh",
          "https://app.smithers.sh/",
          "https://app.smithers.sh/path",
          "http://localhost:3000",
          "http://127.0.0.1:4000",
          "http://evil.example.com",
          "javascript:alert(1)",
          "not-a-url"
        ]),
        localDev: Schema.Boolean,
        perm: Schema.Literals(["admin", "maintain", "write", "triage", "read", "none"]),
        deviceOutcome: Schema.Literals(["ok", "authorization_pending", "slow_down", "expired_token"]),
        state: Schema.Literals(["st-1", "st-abc"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ origin, localDev, perm, deviceOutcome, state }) =>
          Effect.gen(function*() {
            const isCanon = AuthBroker.canonicalOrigin(origin, localDev)
            if (origin === "https://app.smithers.sh" && !isCanon) return false
            if (origin === "https://app.smithers.sh/path" && isCanon) return false
            if (origin === "http://evil.example.com" && isCanon) return false
            if (origin === "javascript:alert(1)" && isCanon) return false
            if (origin === "http://localhost:3000" && isCanon !== localDev) return false

            const sites: ReadonlyArray<AuthBroker.HostedSite> = [
              { origin: "https://app.smithers.sh", secret: Redacted.make("s".repeat(32)) }
            ]
            const allowed = AuthBroker.allowedOrigin(origin, sites, localDev)
            if (origin === "https://app.smithers.sh" && !allowed) return false
            if (origin === "http://evil.example.com" && allowed) return false

            const fakeHttp = HttpClient.make((req, url) =>
              Effect.sync(() => {
                const p = url.pathname
                if (p === "/login/oauth/access_token") {
                  if (req.body._tag === "Uint8Array" && new TextDecoder().decode(req.body.body).includes("device_code")) {
                    if (deviceOutcome === "ok") {
                      return jsonResp(req, 200, { access_token: "ghu_dev", token_type: "bearer" })
                    }
                    return jsonResp(req, 200, { error: deviceOutcome })
                  }
                  return jsonResp(req, 200, {
                    access_token: "ghu_exchanged",
                    refresh_token: "ghr_exchanged",
                    expires_in: 3600,
                    refresh_token_expires_in: 7200
                  })
                }
                if (p === "/login/device/code") {
                  return jsonResp(req, 200, {
                    device_code: "dc_123",
                    user_code: "ABCD-1234",
                    verification_uri: "https://github.com/login/device",
                    expires_in: 900,
                    interval: 5
                  })
                }
                if (p === "/user") {
                  return jsonResp(req, 200, { id: 42, login: "octocat" })
                }
                if (p.includes("/repos/")) {
                  return jsonResp(req, 200, {
                    permissions: {
                      admin: perm === "admin",
                      maintain: perm === "maintain",
                      push: perm === "write",
                      triage: perm === "triage",
                      pull: perm === "read"
                    }
                  })
                }
                if (p.includes("/applications/") && req.method === "DELETE") {
                  return HttpClientResponse.fromWeb(req, new Response(null, { status: 204 }))
                }
                return jsonResp(req, 404, { message: "not found" })
              })
            )
            const authLayer = Auth.layer({
              clientId: "Iv1.test",
              clientSecret: Redacted.make("secret-123"),
              webBaseUrl: "https://github.test",
              apiBaseUrl: "https://api.github.test"
            }).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, fakeHttp)))

            return yield* Effect.gen(function*() {
              const auth = yield* Auth.GitHubAuth
              const url = auth.authorizeUrl({
                state,
                codeChallenge: "chal123",
                redirectUri: "https://app.smithers.sh/cb"
              })
              if (!url.includes(state) || !url.includes("chal123")) return false
              const tok = yield* auth.exchange({
                code: Redacted.make("c1"),
                codeVerifier: Redacted.make("v1"),
                redirectUri: "https://app.smithers.sh/cb"
              })
              if (Redacted.value(tok.accessToken) !== "ghu_exchanged") return false
              const ref = yield* auth.refresh(Redacted.make("ghr_old"))
              if (Redacted.value(ref.accessToken) !== "ghu_exchanged") return false
              const u = yield* auth.user(tok.accessToken)
              if (u.id !== 42 || u.login !== "octocat") return false
              const gotPerm = yield* auth.permission(tok.accessToken, "smithersai/smithers")
              if (gotPerm !== perm) return false
              yield* auth.revoke(tok.accessToken)
              const dc = yield* auth.deviceCode()
              if (dc.userCode !== "ABCD-1234") return false
              const pollRes = yield* auth.deviceToken(dc.deviceCode).pipe(Effect.result)
              if (Result.isFailure(pollRes)) return false
              return true
            }).pipe(Effect.provide(authLayer), Effect.provide(Logger.layer([])))
          }),
        { seed: seed + 1, executions: Math.min(executions, 80) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("GitDatabase, Sync, Collaborators, IssueChanges, Proposals & Delegation stores uphold REST/GraphQL & persistence invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        login: Schema.Literals(["octocat", "alice-1", "bad login!", "-bad"]),
        issueNum: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 500 }))),
        repoId: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 10_000 }))),
        fullListing: Schema.Boolean,
        sha: Schema.Literals(["0123456789abcdef0123456789abcdef01234567", "fedcba9876543210fedcba9876543210fedcba98"]),
        personUrl: Schema.Literals([
          "https://api.github.com/users/42",
          "https://github.com/user/99",
          "person:123",
          "invalid"
        ])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ login, issueNum, repoId, fullListing, sha, personUrl }) =>
          Effect.gen(function*() {
            // Sync IDs & Delegation pure helpers
            if (!Sync.issueId(repoId, issueNum).includes(String(issueNum))) return false
            if (!Sync.commentId(repoId, issueNum).includes(String(issueNum))) return false
            Delegation.personOf(personUrl)
            if (!Delegation.handles("https://broker.test" + Delegation.ROUTE)) return false
            if (Delegation.handles("https://broker.test/other")) return false

            const memStore = yield* Delegation.memoryStore()
            let journaled = 0
            const journal = Delegation.memoryJournal(() => {
              journaled++
            })
            const jVal = yield* journal("op-1", Effect.succeed("result-1"))
            if (jVal !== "result-1" || journaled !== 1) return false
            if (memStore === undefined) return false

            const fakeHttp = HttpClient.make((req, url) =>
              Effect.sync(() => {
                const p = url.pathname
                if (p === "/graphql") {
                  const q = req.body._tag === "Uint8Array" ? new TextDecoder().decode(req.body.body) : ""
                  if (q.includes("updateRefs")) {
                    return jsonResp(req, 200, { data: { updateRefs: { clientMutationId: null } } })
                  }
                  if (q.includes("ref(")) {
                    return jsonResp(req, 200, { data: { repository: { r0: { target: { oid: sha } } } } })
                  }
                  return jsonResp(req, 200, { data: { repository: { id: "R_kgDO1" } } })
                }
                if (p.includes("/collaborators/") && p.endsWith("/permission")) {
                  return jsonResp(req, 200, {
                    permission: "write",
                    role_name: "write",
                    user: { id: 1, login }
                  })
                }
                if (p.endsWith("/assignees")) {
                  return jsonResp(req, 200, [{ id: 1, login: "octocat" }])
                }
                if (p.includes("/issues/") && p.endsWith("/timeline")) {
                  return jsonResp(req, 200, [{ event: "labeled", created_at: "2026-10-01T00:00:00Z" }])
                }
                if (p.includes("/issues/") && p.endsWith("/sub_issues")) {
                  return jsonResp(req, 201, {
                    id: 999,
                    node_id: "I_999",
                    number: 999,
                    title: "Sub",
                    body: null,
                    state: "open",
                    state_reason: null,
                    user: { id: 1, login: "octocat" },
                    labels: [],
                    comments: 0,
                    created_at: "2026-10-01T00:00:00Z",
                    updated_at: "2026-10-01T00:00:00Z",
                    closed_at: null
                  })
                }
                if (p.includes("/issues/comments")) {
                  return jsonResp(req, 200, [{
                    id: 500 + issueNum,
                    body: "sync comment",
                    user: { id: 1, login: "octocat" },
                    html_url: `https://github.com/smithersai/smithers/issues/${issueNum}#issuecomment-${500 + issueNum}`,
                    issue_url: `https://api.github.com/repos/smithersai/smithers/issues/${issueNum}`,
                    created_at: "2026-10-01T00:00:00Z",
                    updated_at: "2026-10-01T00:00:00Z"
                  }])
                }
                if (p.endsWith(`/issues/${issueNum}`)) {
                  return jsonResp(req, 200, {
                    id: 1000 + issueNum,
                    node_id: "I_1",
                    number: issueNum,
                    title: "Issue",
                    body: "body",
                    state: "open",
                    state_reason: null,
                    user: { id: 1, login: "octocat" },
                    labels: [],
                    assignees: [{ id: 1, login: "octocat" }],
                    comments: 0,
                    created_at: "2026-10-01T00:00:00Z",
                    updated_at: "2026-10-01T00:00:00Z",
                    closed_at: null
                  })
                }
                if (p.endsWith("/issues") && req.method === "GET") {
                  return jsonResp(req, 200, [{
                    id: 1000 + issueNum,
                    number: issueNum,
                    title: "Synced issue",
                    body: "hello",
                    user: { id: 1, login: "octocat" },
                    html_url: `https://github.com/smithersai/smithers/issues/${issueNum}`,
                    created_at: "2026-10-01T00:00:00Z",
                    updated_at: "2026-10-01T00:00:00Z"
                  }])
                }
                if (p.endsWith("/forks") && req.method === "POST") {
                  return jsonResp(req, 202, {
                    name: "smithers",
                    owner: { login: "octocat" },
                    default_branch: "main"
                  })
                }
                if (p.includes("/pulls/") && p.endsWith("/files")) {
                  return jsonResp(req, 200, [{ filename: "docs/readme.md", status: "modified" }])
                }
                if (p.includes("/pulls/")) {
                  return jsonResp(req, 200, {
                    id: 3000 + issueNum,
                    node_id: "PR_3000",
                    number: issueNum,
                    title: "Doc PR",
                    body: "update",
                    state: "open",
                    draft: false,
                    merged: false,
                    mergeable: true,
                    mergeable_state: "clean",
                    html_url: `https://github.com/smithersai/smithers/pull/${issueNum}`,
                    user: { id: 42, login: "octocat" },
                    head: { ref: "feat/x", sha },
                    base: { ref: "main", sha, repo: { full_name: "smithersai/smithers", default_branch: "main" } },
                    labels: [],
                    commits: 1,
                    additions: 1,
                    deletions: 0,
                    changed_files: 1,
                    created_at: "2026-10-01T00:00:00Z",
                    updated_at: "2026-10-01T00:00:00Z",
                    merged_at: null,
                    closed_at: null
                  })
                }
                if (p.endsWith("/git/blobs") && req.method === "POST") {
                  return jsonResp(req, 201, { sha: "b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0" })
                }
                if (p.includes("/git/blobs/") && req.method === "GET") {
                  return jsonResp(req, 200, { content: Buffer.from("blob-text").toString("base64"), encoding: "base64", sha })
                }
                if (p.includes("/git/trees/") && req.method === "GET") {
                  return jsonResp(req, 200, { sha, truncated: false, tree: [{ path: "a.txt", mode: "100644", type: "blob", sha }] })
                }
                if (p.endsWith("/git/trees") && req.method === "POST") {
                  return jsonResp(req, 201, { sha })
                }
                if (p.includes("/git/commits/") && req.method === "GET") {
                  return jsonResp(req, 200, { sha, tree: { sha }, parents: [], message: "init" })
                }
                if (p.endsWith("/git/commits") && req.method === "POST") {
                  return jsonResp(req, 201, { sha, tree: { sha }, parents: [], message: "new" })
                }
                if (p.includes("/git/ref/")) {
                  return jsonResp(req, 200, { ref: "refs/heads/main", object: { sha, type: "commit" } })
                }
                if (p.endsWith("/repos/smithersai/smithers")) {
                  return jsonResp(req, 200, { id: repoId, name: "smithers", full_name: "smithersai/smithers", default_branch: "main", owner: { login: "smithersai" }, private: false })
                }
                return jsonResp(req, 404, { message: "not found" })
              })
            )
            const ghClient = yield* GitHubClient.make({
              token: "ghp_fuzz123456789",
              apiBaseUrl: "https://api.github.test"
            }).pipe(Effect.provideService(HttpClient.HttpClient, fakeHttp))

            const ghLayer = Layer.merge(
              Layer.succeed(GitHubClient.GitHubClient, ghClient),
              Logger.layer([])
            )

            return yield* Effect.gen(function*() {
              // Collaborators.permission
              const permRes = yield* Collaborators.permission("smithersai", "smithers", login).pipe(Effect.result)
              if (Collaborators.LOGIN_PATTERN.test(login) !== Result.isSuccess(permRes)) return false

              // IssueChanges
              const ip = yield* IssueChanges.issuePath("smithersai", "smithers", issueNum)
              if (!ip.includes(String(issueNum))) return false
              const got = yield* IssueChanges.get("smithersai", "smithers", issueNum)
              if (got.number !== issueNum) return false
              const upd = yield* IssueChanges.update("smithersai", "smithers", issueNum, { labels: ["bug"], state: "open" })
              if (upd.number !== issueNum) return false
              yield* IssueChanges.link("smithersai", "smithers", issueNum, 999)
              const asg = yield* IssueChanges.assignees("smithersai", "smithers")
              if (asg.length !== 1) return false
              const tl = yield* IssueChanges.timeline("smithersai", "smithers", issueNum)
              if (tl.length !== 1) return false

              // Proposals
              const fork = yield* Proposals.ensureFork("smithersai", "smithers", "octocat")
              if (fork.owner.login !== "octocat") return false
              const docRev = yield* Proposals.documentReview("smithersai", "smithers", issueNum)
              if (Option.isNone(docRev) || docRev.value.head !== sha || docRev.value.files.length !== 1) return false

              // GitDatabase
              const repo = yield* GitDatabase.make("smithersai", "smithers")
              const refs = yield* repo.readRefs(["refs/heads/main"])
              if (refs.length !== 1 || refs[0]!.oid !== sha) return false
              const commit = yield* repo.readCommit(sha)
              if (commit.oid !== sha) return false
              const tree = yield* repo.readTree(sha)
              if (tree.length !== 1) return false
              const blobText = yield* repo.readBlob(sha)
              if (blobText !== "blob-text") return false
              const newBlob = yield* repo.writeBlob("hello")
              if (newBlob !== "b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0") return false
              yield* repo.updateRefs({ operation: "fuzz-op-1", updates: [{ ref: "refs/heads/main", before: sha, after: sha }] })

              // Sync adapter issues + comments phases
              const adapter = Sync.make({
                connectionId: "conn-1",
                owner: "smithersai",
                repo: "smithers",
                client: ghClient,
                fullListing
              })
              const page1 = yield* adapter.changes(null)
              if (page1.records.length === 0 || page1.cursor === null) return false
              const page2 = yield* adapter.changes(page1.cursor)
              if (page2.records.length === 0 || !page2.done) return false
              return true
            }).pipe(Effect.provide(ghLayer))
          }),
        { seed: seed + 2, executions: Math.min(executions, 60) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
