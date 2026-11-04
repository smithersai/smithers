import { Effect } from "effect"
import { createHmac } from "node:crypto"
import { afterEach, describe, expect, it } from "vitest"
import { readIssueComment } from "../examples/github-webhook.vibe"
import { listOpenIssueTitles } from "../examples/list-open-issues.vibe"
import { isIntegrationError } from "../src/core/IntegrationError.ts"
import { type Fixture, json, startFixture } from "./Fixture.ts"
import { gitHubClient } from "./Http.ts"

let fixture: Fixture | undefined

afterEach(async () => {
  await fixture?.close()
  fixture = undefined
})

describe("examples/github-webhook", () => {
  const SECRET = "fixture-webhook-secret"
  const body = JSON.stringify({
    action: "created",
    issue: { number: 7 },
    comment: { id: 1, body: "/triage", user: { login: "octocat" } },
    repository: { full_name: "octo/repo" }
  })
  // GitHub's side of the exchange, signed with `node:crypto`.
  const sign = (payload: string) => `sha256=${createHmac("sha256", SECRET).update(payload).digest("hex")}`
  const signed = { body, signature: sign(body) }
  const read = (delivery: Parameters<typeof readIssueComment>[0], secret: string) =>
    Effect.runPromise(readIssueComment(delivery, secret))

  it("reads the comment from a correctly signed delivery", async () => {
    expect(await read(signed, SECRET)).toEqual({
      repository: "octo/repo",
      issueNumber: 7,
      author: "octocat",
      body: "/triage"
    })
  })

  it("refuses a delivery signed with another secret, a missing header, or a changed body", async () => {
    expect(await read(signed, "other-secret")).toBeUndefined()
    expect(await read({ body, signature: undefined }, SECRET)).toBeUndefined()
    expect(await read({ ...signed, body: body.replace("/triage", "/merge") }, SECRET)).toBeUndefined()
  })

  it("refuses a signed body that is not an issue_comment payload", async () => {
    const push = JSON.stringify({ ref: "refs/heads/main", repository: { full_name: "octo/repo" } })
    expect(await read({ body: push, signature: sign(push) }, SECRET)).toBeUndefined()
  })
})

describe("examples/list-open-issues", () => {
  const client = () => gitHubClient({ token: "ghp-fixture-token", apiBaseUrl: (fixture as Fixture).origin })

  it("follows rel=next pages and returns every title in page order", async () => {
    fixture = await startFixture((request, response) =>
      request.url.includes("page=2")
        ? json(response, 200, [{ number: 3, title: "third" }])
        : json(response, 200, [{ number: 1, title: "first" }, { number: 2, title: "second" }], {
          link: `<${(fixture as Fixture).origin}/repos/octo/repo/issues?state=open&page=2>; rel="next"`
        })
    )
    const result = await Effect.runPromise(listOpenIssueTitles(client(), "octo", "repo"))
    expect(result).toEqual({ titles: ["first", "second", "third"], truncated: false })
    expect(fixture.requests.map((request) => request.url)).toEqual([
      "/repos/octo/repo/issues?state=open&per_page=100",
      "/repos/octo/repo/issues?state=open&page=2"
    ])
  })

  it("refuses a traversal repository name before any request is sent", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, []))
    const failure = await Effect.runPromise(Effect.flip(listOpenIssueTitles(client(), "octo", "..")))
    expect(isIntegrationError(failure) && failure.reason).toBe("invalid-config")
    expect(fixture.requests).toHaveLength(0)
  })

  it("fails as decode-failed when an item is not an issue", async () => {
    fixture = await startFixture((_request, response) => json(response, 200, [{ number: "1" }]))
    const failure = await Effect.runPromise(Effect.flip(listOpenIssueTitles(client(), "octo", "repo")))
    expect(isIntegrationError(failure) && failure.reason).toBe("decode-failed")
  })
})
