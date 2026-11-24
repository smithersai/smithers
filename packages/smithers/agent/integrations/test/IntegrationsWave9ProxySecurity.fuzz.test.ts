import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { refusal } from "../src/github/internal/proxyPolicy.ts"

const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261144")
const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "100")
const fastExec = Math.max(50, Math.min(baseExecutions, 200))

const enc = (value: unknown): Uint8Array =>
  new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value))

const assertPassed = <A>(report: Fuzz.Report<A>): void => {
  expect(report._tag, Fuzz.formatReport(report)).toBe("Passed")
}

describe("GitHub proxyPolicy trust-boundary Wave 9 security fuzzing", () => {
  it(
    "refuses every REST merge, dismissal, non-COMMENT review, percent-encoded evasion, invalid UTF-8/JSON, and query-param bypass",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          method: Schema.Literals(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]),
          prefix: Schema.Literals([
            "/repos/acme/app",
            "/REPOS/acme/app",
            "/api/v3/repos/acme/app",
            "/repositories/42",
            "/api/v3/repositories/42",
            "/other/path"
          ]),
          endpoint: Schema.Literals([
            "/merges",
            "/%6Derges/",
            "/pulls/7/merge",
            "/pulls/7/%6Derge/",
            "/pulls/7/reviews",
            "/pulls/7/reviews/9/events",
            "/pulls/7/reviews/9/dismissals",
            "/issues/1/comments",
            "/pulls/%ZZ/merge"
          ]),
          bodyMode: Schema.Literals([
            "comment",
            "approve",
            "request-changes",
            "dismiss",
            "empty-obj",
            "bad-json",
            "array",
            "bad-utf8"
          ]),
          withEventQuery: Schema.Boolean
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ method, prefix, endpoint, bodyMode, withEventQuery }) =>
            Effect.sync(() => {
              const path = `${prefix}${endpoint}`
              const body = bodyMode === "comment"
                ? enc({ event: "COMMENT", body: "looks good" })
                : bodyMode === "approve"
                ? enc({ event: "APPROVE" })
                : bodyMode === "request-changes"
                ? enc({ event: "REQUEST_CHANGES" })
                : bodyMode === "dismiss"
                ? enc({ event: "DISMISS" })
                : bodyMode === "empty-obj"
                ? enc({ body: "draft" })
                : bodyMode === "bad-json"
                ? enc("{not json")
                : bodyMode === "array"
                ? enc([1, 2, 3])
                : new Uint8Array([0xff, 0xfe, 0x80])
              const qs = withEventQuery ? new URLSearchParams({ Event: "APPROVE" }) : undefined
              const res = refusal(method, path, body, qs)

              if (method === "GET" || method === "HEAD") {
                expect(res).toBeUndefined()
                return true
              }
              if (endpoint === "/pulls/%ZZ/merge") {
                expect(res).toBeDefined()
                return true
              }
              const isRepo = prefix !== "/other/path"
              if (!isRepo) {
                expect(res).toBeUndefined()
                return true
              }
              if (
                endpoint === "/merges" ||
                endpoint === "/%6Derges/" ||
                endpoint === "/pulls/7/merge" ||
                endpoint === "/pulls/7/%6Derge/"
              ) {
                expect(res).toContain("merging")
              } else if (endpoint === "/pulls/7/reviews/9/dismissals") {
                expect(res).toContain("COMMENT")
              } else if (endpoint === "/pulls/7/reviews") {
                if (withEventQuery || bodyMode === "bad-json" || bodyMode === "array" || bodyMode === "bad-utf8") {
                  expect(res).toBeDefined()
                } else if (bodyMode === "comment" || bodyMode === "empty-obj") {
                  expect(res).toBeUndefined()
                } else {
                  expect(res).toContain("COMMENT")
                }
              } else if (endpoint === "/pulls/7/reviews/9/events") {
                if (withEventQuery || bodyMode !== "comment") {
                  expect(res).toBeDefined()
                } else {
                  expect(res).toBeUndefined()
                }
              } else {
                expect(res).toBeUndefined()
              }
              return true
            }),
          { seed, executions: fastExec }
        )
      )
      assertPassed(report)
    },
    60_000
  )

  it(
    "refuses every GraphQL merge, dismissal, review approval/request-changes (inline or nested variables), unterminated strings, and query-param bypasses",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          path: Schema.Literals(["/graphql", "/api/graphql", "/api/v3/graphql"]),
          scenario: Schema.Literals([
            "safe-query",
            "safe-comment-review",
            "merge-mutation",
            "auto-merge-mutation",
            "enqueue-pr",
            "merge-branch",
            "dismiss-review",
            "review-inline-approve",
            "review-var-nested-approve",
            "review-var-request-changes",
            "comment-then-merge",
            "string-hiding-word-safe",
            "block-string-escaped-safe",
            "block-string-then-merge",
            "unterminated-string",
            "unterminated-block-string",
            "non-object-variables",
            "array-variables",
            "missing-query",
            "query-param-bypass"
          ])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ path, scenario }) =>
            Effect.sync(() => {
              let body: Uint8Array = enc({ query: "query { viewer { login } }" })
              let qs: URLSearchParams | undefined
              let expectRefused = false

              switch (scenario) {
                case "safe-query":
                  body = enc({ query: "query { repository(owner:\"a\", name:\"b\") { id } }" })
                  break
                case "safe-comment-review":
                  body = enc({
                    query: "mutation($e: PullRequestReviewEvent) { addPullRequestReview(input: { event: $e }) { id } }",
                    variables: { e: "COMMENT", nested: { ok: [1, "COMMENT", null] } }
                  })
                  break
                case "merge-mutation":
                  body = enc({
                    query: "mutation { mergePullRequest(input: { pullRequestId: \"1\" }) { clientMutationId } }"
                  })
                  expectRefused = true
                  break
                case "auto-merge-mutation":
                  body = enc({ query: "mutation { enablePullRequestAutoMerge(input: {}) { clientMutationId } }" })
                  expectRefused = true
                  break
                case "enqueue-pr":
                  body = enc({ query: "mutation { enqueuePullRequest(input: {}) { clientMutationId } }" })
                  expectRefused = true
                  break
                case "merge-branch":
                  body = enc({ query: "mutation { mergeBranch(input: {}) { clientMutationId } }" })
                  expectRefused = true
                  break
                case "dismiss-review":
                  body = enc({ query: "mutation { dismissPullRequestReview(input: {}) { clientMutationId } }" })
                  expectRefused = true
                  break
                case "review-inline-approve":
                  body = enc({ query: "mutation { submitPullRequestReview(input: { event: APPROVE }) { id } }" })
                  expectRefused = true
                  break
                case "review-var-nested-approve":
                  body = enc({
                    query: "mutation($in: AddPullRequestReviewInput!) { addPullRequestReview(input: $in) { id } }",
                    variables: { in: { deep: [{ ev: "APPROVE" }] } }
                  })
                  expectRefused = true
                  break
                case "review-var-request-changes":
                  body = enc({
                    query:
                      "mutation($e: PullRequestReviewEvent) { submitPullRequestReview(input: { event: $e }) { id } }",
                    variables: { e: "REQUEST_CHANGES" }
                  })
                  expectRefused = true
                  break
                case "comment-then-merge":
                  body = enc({
                    query: "# comment with \" unclosed quote\nmutation { mergePullRequest(input: {}) { id } }"
                  })
                  expectRefused = true
                  break
                case "string-hiding-word-safe":
                  body = enc({
                    query: "query { search(query: \"mergePullRequest \\\"escaped\\\" \\\\ ok\") { issueCount } }"
                  })
                  break
                case "block-string-escaped-safe":
                  body = enc({
                    query: "query { search(query: \"\"\"mergePullRequest \\\"\"\" still string\"\"\") { issueCount } }"
                  })
                  break
                case "block-string-then-merge":
                  body = enc({ query: "mutation { a(x: \"\"\"ok\"\"\") mergePullRequest(input: {}) { id } }" })
                  expectRefused = true
                  break
                case "unterminated-string":
                  body = enc({ query: "query { search(query: \"unterminated\n) { id } }" })
                  expectRefused = true
                  break
                case "unterminated-block-string":
                  body = enc({ query: "query { search(query: \"\"\"never closes) { id } }" })
                  expectRefused = true
                  break
                case "non-object-variables":
                  body = enc({ query: "mutation { addPullRequestReview(input: {}) { id } }", variables: "APPROVE" })
                  expectRefused = true
                  break
                case "array-variables":
                  body = enc({ query: "mutation { addPullRequestReview(input: {}) { id } }", variables: ["APPROVE"] })
                  expectRefused = true
                  break
                case "missing-query":
                  body = enc({ variables: {} })
                  expectRefused = true
                  break
                case "query-param-bypass":
                  qs = new URLSearchParams({ operationName: "Merge" })
                  expectRefused = true
                  break
              }

              const res = refusal("POST", path, body, qs)
              if (expectRefused) {
                expect(res).toBeDefined()
              } else {
                expect(res).toBeUndefined()
              }
              return true
            }),
          { seed: seed + 1, executions: fastExec }
        )
      )
      assertPassed(report)
    },
    60_000
  )
})
