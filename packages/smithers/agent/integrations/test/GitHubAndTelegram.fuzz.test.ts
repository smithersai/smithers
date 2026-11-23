import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Duration, Effect, Layer, Logger, Option, Redacted, Result, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse, HttpServerRequest, HttpServerResponse } from "effect/http"
import { describe, expect, it } from "vitest"
import * as Contents from "../src/github/Contents.ts"
import * as GitHubClient from "../src/github/GitHubClient.ts"
import * as Issues from "../src/github/Issues.ts"
import * as Once from "../src/github/Once.ts"
import * as Proxy from "../src/github/Proxy.ts"
import * as PublicRead from "../src/github/PublicRead.vibe"
import * as Pulls from "../src/github/Pulls.ts"
import * as RateLimit from "../src/github/RateLimit.ts"
import * as ReadCache from "../src/github/ReadCache.vibe"
import * as Refs from "../src/github/Refs.ts"
import * as Statuses from "../src/github/Statuses.ts"
import * as TelegramSource from "../src/telegram/Source.ts"

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

describe("@smthrs/integrations GitHub REST, ReadCache, PublicRead, Proxy, RateLimit & Telegram fuzz invariants", () => {
  it("Issues, Pulls, Refs, Contents, Statuses & Once validate inputs, preserve write markers/trailers & execute REST round-trips", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        owner: Schema.Literals(["smithersai", "octo-org"]),
        repo: Schema.Literals(["smithers", "demo_repo"]),
        writeId: Schema.Literals(["w-123", "abc-XYZ-9", "bad id!", ""]),
        body: Schema.String.pipe(Schema.check(Schema.isMaxLength(60))),
        branch: Schema.Literals(["main", "feat/fuzz-1", "a..b", "-bad", "refs/heads/x", "bad space", "ok_branch.1"]),
        head: Schema.Literals(["feat/x", "owner:feat/x", "", "bad head", "a:b:c"]),
        filePath: Schema.Literals(["README.md", "src/index.ts", "../escape", ""]),
        statusState: Schema.Literals(["pending", "success", "failure", "error"]),
        statusCtx: Schema.Literals(["smithers/ci", "check-1", " bad ", ""]),
        labelColor: Schema.Literals(["ff00aa", "00FF11", "zzzzzz", "12345"]),
        issueNum: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 500 }))),
        sha: Schema.Literals(["0123456789abcdef0123456789abcdef01234567", "abcdef1234567890abcdef1234567890abcdef12"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ owner, repo, writeId, body, branch, head, filePath, statusState, statusCtx, labelColor, issueNum, sha }) =>
          Effect.gen(function*() {
            const cleanBody = body.replace(/<!--\s*smithers:write:[^>]*-->/gi, "")
            // 1. Issues write marker round-trip
            if (Issues.WRITE_ID_PATTERN.test(writeId)) {
              const marked = Issues.withWriteMarker(cleanBody, writeId)
              if (Issues.writeIdOf(marked) !== writeId) return false
              if (Issues.withoutWriteMarker(marked) !== cleanBody) return false
              if (!Issues.writeMarker(writeId).includes(writeId)) return false
            }

            // 2. Once commit trailer & branchName invariants (64-char hex key)
            const hexKey = (sha + "0123456789abcdef01234567").slice(0, 64)
            const msg = Once.withTrailer("feat: update", hexKey)
            if (Once.trailerKeyOf(msg) !== hexKey) return false
            const bn = Once.branchName("smthrs/", "fix-bug", hexKey)
            if (!Refs.isBranch(bn)) return false

            // 3. Refs.isBranch & requireBranch consistency
            const branchOk = Refs.isBranch(branch)
            const reqBranch = yield* Refs.requireBranch(branch).pipe(Effect.result)
            if (branchOk !== Result.isSuccess(reqBranch)) return false

            // 4. Pulls.requireHead validation
            const reqHead = yield* Pulls.requireHead(head).pipe(Effect.result)
            if (head.length === 0 && Result.isSuccess(reqHead)) return false

            // 5. Full in-memory REST client exercising Issues, Pulls, Refs, Contents, Statuses
            const b64Content = Buffer.from("hello from fuzz\n", "utf8").toString("base64")
            const markedBody = Issues.WRITE_ID_PATTERN.test(writeId) ? Issues.withWriteMarker(cleanBody, writeId) : cleanBody
            const sampleIssue = {
              id: 1000 + issueNum,
              node_id: "I_kwDO123",
              number: issueNum,
              title: "Fuzz issue",
              body: markedBody,
              state: "open",
              state_reason: null,
              user: { id: 1, login: "alice" },
              labels: [{ name: "bug" }],
              comments: 1,
              created_at: "2026-10-01T00:00:00Z",
              updated_at: "2026-10-01T00:00:00Z",
              closed_at: null
            }
            const sampleComment = {
              id: 77,
              node_id: "IC_kwDO77",
              body: markedBody,
              user: { id: 1, login: "bot" },
              created_at: "2026-10-01T00:00:00Z",
              updated_at: "2026-10-01T00:00:00Z",
              issue_url: `https://api.github.com/repos/${owner}/${repo}/issues/${issueNum}`
            }
            const samplePr = {
              id: 3000 + issueNum,
              node_id: "PR_kwDO300",
              number: issueNum,
              title: "Fuzz PR",
              body: cleanBody,
              state: "open",
              draft: false,
              merged: false,
              mergeable: true,
              mergeable_state: "clean",
              html_url: `https://github.com/${owner}/${repo}/pull/${issueNum}`,
              user: { id: 1, login: "alice" },
              head: { ref: "feat/x", sha },
              base: { ref: "main", sha, repo: { full_name: `${owner}/${repo}`, default_branch: "main" } },
              labels: [],
              commits: 1,
              additions: 2,
              deletions: 1,
              changed_files: 1,
              created_at: "2026-10-01T00:00:00Z",
              updated_at: "2026-10-01T00:00:00Z",
              merged_at: null,
              closed_at: null
            }
            const fakeHttp = HttpClient.make((req, url) =>
              Effect.sync(() => {
                const p = url.pathname
                if (p.includes("/issues/") && p.endsWith("/comments") && req.method === "POST") {
                  return jsonResp(req, 201, sampleComment)
                }
                if (p.includes("/issues/") && p.endsWith("/comments") && req.method === "GET") {
                  return jsonResp(req, 200, [sampleComment])
                }
                if (p.includes("/issues/") && p.endsWith("/labels")) {
                  return jsonResp(req, 200, [{ name: "bug" }])
                }
                if (p.endsWith("/labels") && req.method === "POST") {
                  return jsonResp(req, 201, { name: "triage", color: labelColor })
                }
                if (p.endsWith(`/issues/${issueNum}`) && req.method === "GET") {
                  return jsonResp(req, 200, sampleIssue)
                }
                if (p.endsWith("/issues") && req.method === "POST") {
                  return jsonResp(req, 201, sampleIssue)
                }
                if (p.endsWith("/issues") && req.method === "GET") {
                  return jsonResp(req, 200, [sampleIssue])
                }
                if (p.includes("/pulls/") && p.endsWith("/commits")) {
                  return jsonResp(req, 200, [{
                    sha,
                    commit: { message: "feat: ok", author: { name: "alice", date: "2026-10-01T00:00:00Z" } },
                    author: { id: 1, login: "alice" }
                  }])
                }
                if (p.includes("/pulls/") && p.endsWith("/reviews") && req.method === "GET") {
                  return jsonResp(req, 200, [{
                    id: 5,
                    node_id: "PRR_5",
                    state: "COMMENTED",
                    body: "lgtm",
                    user: { id: 2, login: "bob" },
                    commit_id: sha,
                    submitted_at: "2026-10-01T00:00:00Z"
                  }])
                }
                if (p.includes("/pulls/") && p.endsWith("/merge") && req.method === "PUT") {
                  return jsonResp(req, 200, { sha, merged: true, message: "merged" })
                }
                if (p.endsWith(`/pulls/${issueNum}`)) {
                  return jsonResp(req, 200, samplePr)
                }
                if (p.endsWith("/pulls") && req.method === "GET") {
                  return jsonResp(req, 200, [samplePr])
                }
                if (p.includes("/git/ref/heads/") && req.method === "GET") {
                  return jsonResp(req, 200, { ref: `refs/heads/${branch}`, object: { sha, type: "commit" } })
                }
                if (p.includes("/git/matching-refs/heads/") && req.method === "GET") {
                  return jsonResp(req, 200, [{ ref: "refs/heads/main", object: { sha, type: "commit" } }])
                }
                if (p.endsWith("/git/refs") && req.method === "POST") {
                  return jsonResp(req, 201, { ref: `refs/heads/${branch}`, object: { sha, type: "commit" } })
                }
                if (p.includes("/contents/")) {
                  return jsonResp(req, 200, {
                    type: "file",
                    encoding: "base64",
                    content: b64Content,
                    sha,
                    path: filePath,
                    size: 16
                  })
                }
                if (p.includes("/statuses/")) {
                  return jsonResp(req, 201, {
                    id: 99,
                    state: statusState,
                    context: statusCtx,
                    description: "ok",
                    target_url: null,
                    created_at: "2026-10-01T00:00:00Z",
                    updated_at: "2026-10-01T00:00:00Z"
                  })
                }
                return jsonResp(req, 404, { message: "not found" })
              })
            )
            const ghLayer = Layer.merge(
              GitHubClient.layer({
                token: "ghp_fuzztoken1234567890",
                apiBaseUrl: "https://api.github.test"
              }).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, fakeHttp))),
              Logger.layer([])
            )

            return yield* Effect.gen(function*() {
              const iss = yield* Issues.getIssue(owner, repo, issueNum)
              if (iss.number !== issueNum) return false
              const comments = yield* Issues.listComments(owner, repo, issueNum)
              if (comments.items.length !== 1) return false
              const page = yield* Issues.listAllIssuesPage(owner, repo, {})
              if (page.items.length !== 1) return false
              yield* Issues.addLabels(owner, repo, issueNum, ["bug"])
              const lblRes = yield* Issues.createLabel(owner, repo, { name: "triage", color: labelColor }).pipe(Effect.result)
              if (Issues.LABEL_COLOR_PATTERN.test(labelColor) !== Result.isSuccess(lblRes)) return false

              if (Issues.WRITE_ID_PATTERN.test(writeId)) {
                const foundIss = yield* Issues.findIssueByWrite(owner, repo, { writeId, since: "2026-01-01T00:00:00Z" })
                if (Option.isNone(foundIss)) return false
                const foundCmt = yield* Issues.findCommentByWrite(owner, repo, issueNum, { writeId })
                if (Option.isNone(foundCmt)) return false
              }

              const pr = yield* Pulls.getPull(owner, repo, issueNum)
              if (pr.number !== issueNum) return false
              const prs = yield* Pulls.listPulls(owner, repo)
              if (prs.items.length !== 1) return false
              const commits = yield* Pulls.listCommits(owner, repo, issueNum)
              if (commits.items.length !== 1) return false
              const reviews = yield* Pulls.listReviews(owner, repo, issueNum)
              if (reviews.items.length !== 1) return false
              const merged = yield* Pulls.mergePull(owner, repo, issueNum, { sha, method: "squash" })
              if (merged.sha !== sha) return false

              const branches = yield* Refs.listBranches(owner, repo, "main")
              if (branches.items.length !== 1) return false
              if (branchOk) {
                const b = yield* Refs.getBranch(owner, repo, branch)
                if (Option.isNone(b) || b.value.sha !== sha) return false
                const created = yield* Refs.createBranch(owner, repo, { name: branch, sha })
                if (created.sha !== sha) return false
              }

              const fileRes = yield* Contents.getText(owner, repo, filePath).pipe(Effect.result)
              if (filePath === "README.md" || filePath === "src/index.ts") {
                if (!Result.isSuccess(fileRes) || Option.isNone(fileRes.success) || fileRes.success.value.text !== "hello from fuzz\n") {
                  return false
                }
              } else {
                if (Result.isSuccess(fileRes)) return false
              }

              const stRes = yield* Statuses.create(owner, repo, sha, {
                state: statusState,
                context: statusCtx,
                description: "ok"
              }).pipe(Effect.result)
              if (Statuses.CONTEXT_PATTERN.test(statusCtx) !== Result.isSuccess(stRes)) return false

              return true
            }).pipe(Effect.provide(ghLayer))
          }),
        { seed, executions: Math.min(executions, 80) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("ReadCache.make & PublicRead.site/route uphold caching, ETag revalidation, HMAC admission & tamper refusal", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        repo: Schema.Literals(["smithersai/smithers", "other/private"]),
        endpoint: Schema.Literals(["", "/issues", "/pulls", "/contents/README.md"]),
        secret: Schema.String.pipe(Schema.check(Schema.isMinLength(8), Schema.isMaxLength(24))),
        tamperSecret: Schema.Boolean,
        upstreamStatus: Schema.Literals([200, 304, 403, 404, 429]),
        hasEtag: Schema.Boolean
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ repo, endpoint, secret, tamperSecret, upstreamStatus, hasEtag }) =>
          Effect.gen(function*() {
            const store = yield* ReadCache.memoryStore()
            let upstreamCalls = 0
            const upstream = HttpClient.make((req) =>
              Effect.sync(() => {
                upstreamCalls++
                if (upstreamStatus === 429) {
                  return jsonResp(req, 429, { message: "rate limited" }, { "retry-after": "60" })
                }
                return jsonResp(
                  req,
                  upstreamStatus === 304 ? 200 : upstreamStatus,
                  { ok: true, calls: upstreamCalls },
                  hasEtag ? { etag: "\"v1\"" } : {}
                )
              })
            )
            const cached = yield* ReadCache.make({ store, upstream, freshFor: 60_000 })
            const r1 = yield* cached.execute(HttpClientRequest.get(`https://api.github.com/repos/${repo}${endpoint}`))
            const r2 = yield* cached.execute(HttpClientRequest.get(`https://api.github.com/repos/${repo}${endpoint}`))
            if (upstreamStatus === 200 || upstreamStatus === 304) {
              if (r1.status !== 200 || r2.status !== 200) return false
              if (hasEtag ? upstreamCalls !== 1 : upstreamCalls !== 2) return false
            }

            if (ReadCache.rateLimited(429, {}) !== true) return false
            if (ReadCache.rateLimited(200, {}) !== false) return false

            // PublicRead end-to-end site -> broker route round-trip
            const brokerOrigin = "https://broker.smithers.test"
            const siteOrigin = "https://app.smithers.test"
            const siteSecret = Redacted.make(secret)
            const brokerSecret = Redacted.make(tamperSecret ? secret + "-wrong" : secret)
            const [owner, name] = repo.split("/") as [string, string]
            const githubUpstream = HttpClient.make((req) =>
              Effect.sync(() => jsonResp(req, 200, { repo }, { etag: "\"gh1\"" }))
            )
            const brokerHttp = HttpClient.make((req) =>
              Effect.gen(function*() {
                const bodyObj = req.body
                const bodyBytes = bodyObj._tag === "Uint8Array" ? bodyObj.body : new Uint8Array()
                const init: RequestInit = bodyBytes.length > 0
                  ? { method: req.method, headers: req.headers as Record<string, string>, body: Buffer.from(bodyBytes) }
                  : { method: req.method, headers: req.headers as Record<string, string> }
                const srvReq = HttpServerRequest.fromWeb(new Request(req.url, init))
                const srvResp = yield* PublicRead.route({
                  origin: brokerOrigin,
                  sites: [{
                    origin: siteOrigin,
                    secret: brokerSecret,
                    reads: [{ repository: "smithersai/smithers", repositoryId: 11 }]
                  }],
                  token: () => Effect.succeed(Redacted.make("ghs_install_token")),
                  github: githubUpstream
                }).pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, srvReq))
                return HttpClientResponse.fromWeb(req, HttpServerResponse.toWeb(srvResp))
              })
            )
            const siteClient = yield* PublicRead.site({
              origin: siteOrigin,
              brokerOrigin,
              secret: siteSecret
            }).pipe(Effect.provideService(HttpClient.HttpClient, brokerHttp))

            const pubRes = yield* siteClient.execute(
              HttpClientRequest.get(`https://api.github.com/repos/${owner}/${name}${endpoint}`)
            ).pipe(Effect.result)

            if (tamperSecret || repo !== "smithersai/smithers") {
              if (Result.isSuccess(pubRes) && pubRes.success.status !== 403) return false
            }

            // Non-GET to PublicRead.site must always be refused
            const postRes = yield* siteClient.execute(
              HttpClientRequest.post(`https://api.github.com/repos/${owner}/${name}/issues`)
            ).pipe(Effect.result)
            if (Result.isSuccess(postRes)) return false

            return true
          }).pipe(Effect.provide(Logger.layer([]))),
        { seed: seed + 1, executions: Math.min(executions, 80) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Proxy.repositoryOf/make & RateLimit.make enforce repository routing, capability checks & rate limiting", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        path: Schema.Literals([
          "/repos/acme/app/issues",
          "/repos/acme/app/pulls/1",
          "/users/octocat",
          "/_smithers/health", "/_smithers/admission?repo=acme/app&writes=2", "/_smithers/unknown",
          "/repos/only-owner"
        ]),
        remaining: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 5000 }))),
        method: Schema.Literals(["GET", "POST", "PATCH"]),
        hasCap: Schema.Boolean
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ path, remaining, method, hasCap }) =>
          Effect.gen(function*() {
            const repo = Proxy.repositoryOf(path)
            if (path.startsWith("/repos/acme/app")) {
              if (repo !== "acme/app") return false
            } else {
              if (repo !== undefined) return false
            }

            const rl = yield* RateLimit.make({ maxWait: Duration.millis(10) })
            const earliest = yield* rl.earliestStart(1, path)
            if (earliest < 0) return false
            const limitedVal = yield* rl.limit(
              method,
              path,
              Effect.succeed("ok"),
              () => ({
                remaining,
                resetAtMs: Date.now() + 60_000,
                retryAfterMs: undefined,
                secondary: false,
                limited: remaining === 0
              })
            )
            if (limitedVal !== "ok") return false

            const upstream = HttpClient.make((req) =>
              Effect.sync(() => jsonResp(req, 200, { ok: true }, { "x-ratelimit-remaining": "4999" }))
            )
            const proxyHandler = yield* Proxy.make({
              upstream: "https://api.github.test",
              capability: "cap-secret-1",
              credential: () => Effect.succeed({ token: "ghp_proxy_tok", principal: "p1" })
            }).pipe(Effect.provideService(HttpClient.HttpClient, upstream))

            const headers: Record<string, string> = hasCap ? { authorization: "Bearer cap-secret-1" } : {}
            const srvReq = HttpServerRequest.fromWeb(
              new Request(`https://proxy.test${path}`, { method, headers })
            )
            const srvResp = yield* proxyHandler.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, srvReq))
            if (path === "/_smithers/health") {
              if (srvResp.status !== 200) return false
            } else if (path === "/_smithers/unknown") {
              if (srvResp.status !== 404) return false
            } else if (!hasCap) {
              if (srvResp.status !== 401) return false
            } else {
              if (srvResp.status !== 200) return false
            }
            return true
          }).pipe(Effect.provide(Logger.layer([]))),
        { seed: seed + 2, executions: Math.min(executions, 80) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Telegram.Source.updateToEvents & correlation IDs map message/edited_message updates deterministically", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        source: Schema.Literals(["tg-main", "tg-ops"]),
        updateId: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 1_000_000 }))),
        chatId: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: -1_000_000, maximum: 1_000_000 }))),
        msgId: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 100_000 }))),
        threadId: Schema.NullOr(Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 10_000 })))),
        text: Schema.String.pipe(Schema.check(Schema.isMaxLength(80))),
        isEdited: Schema.Boolean
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ source, updateId, chatId, msgId, threadId, text, isEdited }) =>
          Effect.sync(() => {
            const msg = {
              message_id: msgId,
              date: 1_700_000_000,
              chat: { id: chatId, type: "supergroup" },
              text,
              ...(threadId !== null ? { message_thread_id: threadId } : {})
            }
            const update = isEdited
              ? { update_id: updateId, edited_message: msg }
              : { update_id: updateId, message: msg }

            const events = TelegramSource.updateToEvents(source, update, 1_700_000_000_000)
            const expectedCount = threadId !== null ? 2 : 1
            if (events.length !== expectedCount) return false
            const expectedName = isEdited ? TelegramSource.EDITED_MESSAGE_EVENT : TelegramSource.MESSAGE_EVENT
            if (events[0]!.eventName !== expectedName) return false
            if (events[0]!.correlationId !== TelegramSource.chatCorrelationId(chatId)) return false
            if (threadId !== null && events[1]!.correlationId !== TelegramSource.threadCorrelationId(chatId, threadId)) {
              return false
            }
            // Empty/unrelated update produces zero events
            if (TelegramSource.updateToEvents(source, { update_id: updateId }, 1_700_000_000_000).length !== 0) {
              return false
            }
            return true
          }),
        { seed: seed + 3, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
