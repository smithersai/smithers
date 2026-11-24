import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Duration, Effect, Layer, Logger, Option, Redacted, Result, Schema } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientError from "effect/http/HttpClientError"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import { describe, expect, it } from "vitest"
import * as Commits from "../src/github/Commits.ts"
import * as GitDatabase from "../src/github/GitDatabase.ts"
import * as GitHubClient from "../src/github/GitHubClient.ts"
import * as Once from "../src/github/Once.ts"
import * as Pulls from "../src/github/Pulls.ts"
import * as TelegramSource from "../src/telegram/Source.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "70")
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261127")
const silentLogger = Logger.layer([])

const assertPassed = (report: Parameters<typeof Fuzz.formatReport>[0]) => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const makeJsonResponse = (
  req: Parameters<Parameters<typeof HttpClient.make>[0]>[0],
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
) =>
  HttpClientResponse.fromWeb(
    req,
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers }
    })
  )

describe("@smthrs/integrations Deep3 Fuzz (Telegram.Source, GitHub Pulls, Commits, Once, GitDatabase)", () => {
  it("Telegram.Source.make & poll fuzz all config validation, HTTP statuses, rate limits, malformed updates, cursor checks, and token redaction", async () => {
    const validToken = "123456789:AABBCCDDEEFFGGHHIIJJKKLLMMNNOOPPQQR"
    const arb = Arbitrary.schema(
      Schema.Struct({
        configMode: Schema.Literals([
          "valid",
          "badSourceId",
          "emptyChats",
          "badPollTimeout",
          "badOrigin",
          "missingToken",
          "badReqTimeout"
        ]),
        responseMode: Schema.Literals([
          "okUpdates",
          "okEmpty",
          "rateLimit429",
          "server500",
          "auth401",
          "badBody",
          "badUpdateId",
          "transportFail",
          "timeout"
        ]),
        cursorMode: Schema.Literals(["null", "valid", "invalid"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (c) =>
          Effect.gen(function*() {
            const client = HttpClient.make((req) => {
              if (c.responseMode === "transportFail") {
                return Effect.fail(
                  new HttpClientError.HttpClientError({
                    reason: new HttpClientError.TransportError({
                      request: req,
                      cause: new Error(`connect failed for ${req.url}`)
                    })
                  })
                )
              }
              if (c.responseMode === "timeout") {
                return Effect.sleep(Duration.millis(80)).pipe(
                  Effect.as(makeJsonResponse(req, 200, { ok: true, result: [] }))
                )
              }
              if (c.responseMode === "rateLimit429") {
                return Effect.succeed(
                  makeJsonResponse(req, 429, {
                    ok: false,
                    description: "Too Many Requests",
                    parameters: { retry_after: 3 }
                  })
                )
              }
              if (c.responseMode === "server500") {
                return Effect.succeed(makeJsonResponse(req, 500, { ok: false, description: "internal error" }))
              }
              if (c.responseMode === "auth401") {
                return Effect.succeed(makeJsonResponse(req, 401, { ok: false, description: "Unauthorized" }))
              }
              if (c.responseMode === "badBody") {
                return Effect.succeed(makeJsonResponse(req, 200, { ok: true, result: "not-an-array" }))
              }
              if (c.responseMode === "badUpdateId") {
                return Effect.succeed(makeJsonResponse(req, 200, { ok: true, result: [{ update_id: -5 }] }))
              }
              if (c.responseMode === "okEmpty") {
                return Effect.succeed(makeJsonResponse(req, 200, { ok: true, result: [] }))
              }
              return Effect.succeed(
                makeJsonResponse(req, 200, {
                  ok: true,
                  result: [
                    {
                      update_id: 100,
                      message: {
                        message_id: 1,
                        date: 1700000000,
                        chat: { id: 42, type: "private" },
                        from: { id: 7, is_bot: false, first_name: "Will" },
                        text: "hello allowed"
                      }
                    },
                    {
                      update_id: 101,
                      edited_message: {
                        message_id: 2,
                        date: 1700000001,
                        edit_date: 1700000002,
                        chat: { id: 99999, type: "group" },
                        text: "blocked chat"
                      }
                    }
                  ]
                })
              )
            })

            const opts: TelegramSource.Options = {
              sourceId: c.configMode === "badSourceId" ? " bad " : "tg-fuzz",
              allowedChatIds: c.configMode === "emptyChats" ? [] : [42],
              pollTimeoutSeconds: c.configMode === "badPollTimeout" ? -1 : 0,
              apiBaseUrl: c.configMode === "badOrigin"
                ? "ftp://user:pass@bad.example/path"
                : "https://api.telegram.test",
              botToken: c.configMode === "missingToken" ? undefined : Redacted.make(validToken),
              requestTimeout: c.configMode === "badReqTimeout"
                ? Duration.millis(0)
                : c.responseMode === "timeout"
                ? Duration.millis(15)
                : Duration.seconds(2)
            }

            const made = yield* Effect.result(
              TelegramSource.make(opts, {}).pipe(Effect.provideService(HttpClient.HttpClient, client))
            )
            if (c.configMode !== "valid") {
              if (Result.isSuccess(made)) return false
              if (made.failure.message.includes(validToken)) return false
              return true
            }
            if (Result.isFailure(made)) return false

            const cursor = c.cursorMode === "null" ? null : c.cursorMode === "valid" ? "50" : "not-a-number"
            const polled = yield* Effect.result(made.success.poll(cursor))
            if (c.cursorMode === "invalid") {
              return Result.isFailure(polled) && !polled.failure.message.includes(validToken)
            }
            if (c.responseMode === "okUpdates") {
              if (Result.isFailure(polled)) return false
              // Blocked chat 99999 must be filtered out; allowed chat 42 kept; cursor advances to 102
              if (polled.success.cursor !== "102") return false
              if (polled.success.events.length !== 1) return false
              return true
            }
            if (c.responseMode === "okEmpty") {
              return Result.isSuccess(polled) && polled.success.events.length === 0
            }
            if (Result.isSuccess(polled)) return false
            // Bot token must NEVER leak into any error message
            if (polled.failure.message.includes(validToken)) return false
            return true
          }).pipe(Effect.provide(silentLogger)),
        { seed, executions }
      )
    )
    assertPassed(report)
  })

  it("GitHub Pulls, Commits, Once & GitDatabase full API lifecycle fuzz over in-process Effect HttpClient", async () => {
    const sha1 = "a".repeat(40)
    const sha2 = "b".repeat(40)
    const writeKey = "c".repeat(64)

    const samplePr = (num = 12, draft = false) => ({
      id: 1000 + num,
      node_id: `PR_${num}`,
      number: num,
      state: "open",
      draft,
      title: "Fuzz PR",
      body: `Summary\n\nSmithers-Write: ${writeKey}`,
      html_url: `https://github.com/o/r/pull/${num}`,
      head: { ref: "feat/fuzz", sha: sha2 },
      base: { ref: "main", sha: sha1 },
      user: { login: "smithers", id: 1 },
      mergeable: true,
      mergeable_state: "clean",
      merged: false,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      closed_at: null
    })

    const arb = Arbitrary.schema(
      Schema.Struct({
        mergeMethod: Schema.Literals(["squash", "merge", "rebase"]),
        reviewEvent: Schema.Literals(["COMMENT", "APPROVE", "REQUEST_CHANGES"]),
        updateMethod: Schema.Literals(["merge", "rebase"]),
        mergeIntoStatus: Schema.Literals([201, 204, 409]),
        prAlreadyExists: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (c) =>
          Effect.gen(function*() {
            let prCreated = c.prAlreadyExists
            let reviewCreated = false
            const fakeHttp = HttpClient.make((req) => {
              const u = new URL(req.url)
              const p = u.pathname
              const m = req.method

              if (p === "/graphql") {
                return Effect.succeed(
                  makeJsonResponse(req, 200, {
                    data: {
                      markPullRequestReadyForReview: {
                        pullRequest: { id: "PR_12", number: 12, isDraft: false }
                      },
                      updatePullRequestBranch: {
                        pullRequest: { id: "PR_12", headRefOid: sha2 }
                      }
                    }
                  })
                )
              }
              if (p.endsWith("/pulls/12/commits")) {
                return Effect.succeed(
                  makeJsonResponse(req, 200, [
                    {
                      sha: sha2,
                      commit: { message: "feat: fuzz", author: { name: "Will", date: "2026-01-01T00:00:00Z" } },
                      author: { login: "smithers", id: 1 }
                    }
                  ])
                )
              }
              if (p.endsWith("/pulls/12/reviews") && m === "GET") {
                return Effect.succeed(
                  makeJsonResponse(
                    req,
                    200,
                    reviewCreated
                      ? [{
                        id: 55,
                        node_id: "REV_55",
                        state: c.reviewEvent,
                        body: `LGTM\n\nSmithers-Write: ${writeKey}`,
                        user: { login: "smithers", id: 1 },
                        commit_id: sha2
                      }]
                      : []
                  )
                )
              }
              if (p.endsWith("/pulls/12/reviews") && m === "POST") {
                reviewCreated = true
                return Effect.succeed(
                  makeJsonResponse(req, 200, {
                    id: 55,
                    node_id: "REV_55",
                    state: c.reviewEvent,
                    body: `LGTM\n\nSmithers-Write: ${writeKey}`,
                    user: { login: "smithers", id: 1 },
                    commit_id: sha2
                  })
                )
              }
              if (p.endsWith("/pulls/12/merge") && m === "PUT") {
                return Effect.succeed(makeJsonResponse(req, 200, { sha: sha2, merged: true, message: "merged" }))
              }
              if (p.endsWith("/pulls/12/update-branch") && m === "PUT") {
                return Effect.succeed(makeJsonResponse(req, 202, { message: "Updating", url: req.url }))
              }
              if (p.endsWith("/pulls/12") && (m === "GET" || m === "PATCH")) {
                return Effect.succeed(makeJsonResponse(req, 200, samplePr(12, false)))
              }
              if (p.endsWith("/pulls") && m === "GET") {
                return Effect.succeed(makeJsonResponse(req, 200, prCreated ? [samplePr(12)] : []))
              }
              if (p.endsWith("/pulls") && m === "POST") {
                prCreated = true
                return Effect.succeed(makeJsonResponse(req, 201, samplePr(12)))
              }
              if (p.endsWith("/merges") && m === "POST") {
                if (c.mergeIntoStatus === 204) {
                  return Effect.succeed(HttpClientResponse.fromWeb(req, new Response(null, { status: 204 })))
                }
                if (c.mergeIntoStatus === 409) {
                  return Effect.succeed(makeJsonResponse(req, 409, { message: "Merge conflict" }))
                }
                return Effect.succeed(
                  makeJsonResponse(req, 201, {
                    sha: sha2,
                    commit: { message: "merge", tree: { sha: sha1 } },
                    parents: [{ sha: sha1 }]
                  })
                )
              }
              if (p.includes("/compare/")) {
                return Effect.succeed(
                  makeJsonResponse(req, 200, {
                    status: "ahead",
                    ahead_by: 1,
                    behind_by: 0,
                    total_commits: 1,
                    merge_base_commit: { sha: sha1 },
                    commits: [{
                      sha: sha2,
                      commit: { message: "feat", author: { name: "Will", date: "2026-01-01T00:00:00Z" } },
                      author: { login: "smithers", id: 1 }
                    }],
                    files: [{ filename: "a.ts", status: "added", additions: 5, deletions: 0, changes: 5 }]
                  })
                )
              }
              if (p.includes("/commits/") && !p.includes("/git/commits/") && m === "GET") {
                return Effect.succeed(
                  makeJsonResponse(req, 200, {
                    sha: sha2,
                    commit: { message: `msg\n\nSmithers-Write: ${writeKey}`, tree: { sha: sha1 } },
                    parents: [{ sha: sha1 }]
                  })
                )
              }
              if (p.includes("/git/refs/heads/")) {
                return Effect.succeed(
                  makeJsonResponse(req, 200, { ref: "refs/heads/feat/fuzz", object: { sha: sha2, type: "commit" } })
                )
              }
              if (p.endsWith("/git/refs") && m === "POST") {
                return Effect.succeed(
                  makeJsonResponse(req, 201, { ref: "refs/heads/feat/fuzz", object: { sha: sha1, type: "commit" } })
                )
              }
              if (p.endsWith("/git/blobs") && m === "POST") {
                return Effect.succeed(makeJsonResponse(req, 201, { sha: sha1, url: req.url }))
              }
              if (p.includes("/git/blobs/") && m === "GET") {
                return Effect.succeed(
                  makeJsonResponse(req, 200, {
                    sha: sha1,
                    content: Buffer.from("hi").toString("base64"),
                    encoding: "base64",
                    size: 2
                  })
                )
              }
              if (p.endsWith("/git/trees") && m === "POST") {
                return Effect.succeed(makeJsonResponse(req, 201, { sha: sha1, tree: [] }))
              }
              if (p.includes("/git/trees/") && m === "GET") {
                return Effect.succeed(
                  makeJsonResponse(req, 200, {
                    sha: sha1,
                    truncated: false,
                    tree: [{ path: "a.ts", mode: "100644", type: "blob", sha: sha1 }]
                  })
                )
              }
              if (p.endsWith("/git/commits") && m === "POST") {
                return Effect.succeed(
                  makeJsonResponse(req, 201, { sha: sha2, message: "c", tree: { sha: sha1 }, parents: [{ sha: sha1 }] })
                )
              }
              if (p.includes("/git/commits/") && m === "GET") {
                return Effect.succeed(
                  makeJsonResponse(req, 200, {
                    sha: sha2,
                    message: `msg\n\nSmithers-Write: ${writeKey}`,
                    tree: { sha: sha1 },
                    parents: [{ sha: sha1 }]
                  })
                )
              }
              return Effect.succeed(makeJsonResponse(req, 200, {}))
            })

            const ghLayer = GitHubClient.layer({
              token: "ghp_fuzztoken1234567890"
            }).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, fakeHttp)))

            return yield* Effect.gen(function*() {
              const owner = "acme"
              const repo = "demo"

              // Pulls operations
              const got = yield* Pulls.getPull(owner, repo, 12)
              if (got.number !== 12) return false
              const listed = yield* Pulls.listPulls(owner, repo, { state: "open" })
              if (c.prAlreadyExists && listed.items.length !== 1) return false
              const found = yield* Pulls.findPullByHead(owner, repo, { head: "acme:feat/fuzz" })
              if (c.prAlreadyExists && found === undefined) return false
              const created = yield* Pulls.createPull(owner, repo, {
                title: "T",
                head: "feat/fuzz",
                base: "main",
                body: "B"
              })
              if (created.number !== 12) return false
              yield* Pulls.setBase(owner, repo, 12, "main")
              yield* Pulls.closePull(owner, repo, 12)
              yield* Pulls.markReady(owner, repo, "PR_12")
              yield* Pulls.updateBranch(owner, repo, {
                pullNodeId: "PR_12",
                expectedHeadOid: sha2,
                method: c.updateMethod
              })
              const merged = yield* Pulls.mergePull(owner, repo, 12, { method: c.mergeMethod, sha: sha2 })
              if (!merged.merged) return false
              const commits = yield* Pulls.listCommits(owner, repo, 12)
              if (commits.items.length !== 1) return false
              yield* Pulls.createReview(owner, repo, 12, { commitId: sha2, event: c.reviewEvent, body: "LGTM" })
              const revs = yield* Pulls.listReviews(owner, repo, 12)
              if (revs.items.length !== 1) return false
              yield* Pulls.findReviewByWrite(owner, repo, 12, { writeId: writeKey })

              // Commits operations
              const cmp = yield* Commits.compare(owner, repo, sha1, sha2)
              if (cmp.commits.length !== 1) return false
              const gotCommit = yield* Commits.getCommit(owner, repo, sha2)
              if (gotCommit.sha !== sha2) return false
              const miRes = yield* Effect.result(
                Commits.mergeInto(owner, repo, { base: "main", head: "feat/fuzz", commitMessage: "merge" })
              )
              if (
                c.mergeIntoStatus === 204 && (Result.isFailure(miRes) || miRes.success.kind !== "upToDate")
              ) return false
              if (c.mergeIntoStatus === 201 && (Result.isFailure(miRes) || miRes.success.kind !== "merged")) {
                return false
              }
              if (c.mergeIntoStatus === 409 && Result.isSuccess(miRes)) return false

              // GitDatabase operations
              const gdb = yield* GitDatabase.make(owner, repo)
              const readC = yield* gdb.readCommit(sha2)
              if (readC.oid !== sha2) return false

              // Once helpers
              const msg = Once.withTrailer("feat: hi", writeKey)
              if (Once.trailerKeyOf(msg) !== writeKey) return false
              const bn = Once.branchName("smithers", "My Feature!", writeKey)
              if (!bn.includes(writeKey.slice(0, Once.BRANCH_KEY_LENGTH))) return false
              return true
            }).pipe(Effect.provide(ghLayer), Effect.provide(silentLogger))
          }),
        { seed: seed + 1, executions: Math.min(executions, 35) }
      )
    )
    assertPassed(report)
  })
})
