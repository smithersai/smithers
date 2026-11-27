import { Effect, Layer, Redacted } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import { describe, expect, test } from "vitest"
import { GitHub } from "../src/index.ts"

const mockClient = (handler: (url: string, method: string, body: unknown) => { status: number; body: unknown }) => {
  const http = HttpClient.make((request) => {
    const rawBody = request.body._tag === "Uint8Array"
      ? new TextDecoder().decode(request.body.body)
      : undefined
    const parsed = rawBody ? JSON.parse(rawBody) : undefined
    const res = handler(request.url, request.method, parsed)
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(res.body), {
          status: res.status,
          headers: { "content-type": "application/json" },
        }),
      ),
    )
  })
  return GitHub.GitHubClient.layer({
    token: Redacted.make("ghu_test_token_1234567890"),
    apiBaseUrl: "https://api.github.com",
  }).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, http)))
}

describe("GitHub.Forks", () => {
  test("createFork posts to /repos/{owner}/{repo}/forks and decodes ForkRepository", async () => {
    let seen: { url: string; method: string; body: unknown } | undefined
    const layer = mockClient((url, method, body) => {
      seen = { url, method, body }
      return {
        status: 202,
        body: {
          id: 999,
          name: "smithers",
          full_name: "alice/smithers",
          owner: { login: "alice" },
          default_branch: "main",
          html_url: "https://github.com/alice/smithers",
          parent: { name: "smithers", full_name: "smithersai/smithers", owner: { login: "smithersai" } },
        },
      }
    })
    const forked = await Effect.runPromise(
      GitHub.Forks.createFork("smithersai", "smithers", { defaultBranchOnly: true }).pipe(Effect.provide(layer)),
    )
    expect(seen).toEqual({
      url: "https://api.github.com/repos/smithersai/smithers/forks",
      method: "POST",
      body: { default_branch_only: true },
    })
    expect(forked.full_name).toBe("alice/smithers")
    expect(forked.parent?.full_name).toBe("smithersai/smithers")
  })

  test("createFork rejects path traversal coordinates", async () => {
    const layer = mockClient(() => ({ status: 200, body: {} }))
    const exit = await Effect.runPromiseExit(
      GitHub.Forks.createFork("..", "smithers").pipe(Effect.provide(layer)),
    )
    expect(exit._tag).toBe("Failure")
  })

  test("syncUpstream posts branch to /repos/{owner}/{repo}/merge-upstream", async () => {
    let seen: { url: string; method: string; body: unknown } | undefined
    const layer = mockClient((url, method, body) => {
      seen = { url, method, body }
      return {
        status: 200,
        body: { message: "Successfully fetched and fast-forwarded from upstream.", merge_type: "fast-forward", base_branch: "smithersai:main" },
      }
    })
    const res = await Effect.runPromise(
      GitHub.Forks.syncUpstream("alice", "smithers", "main").pipe(Effect.provide(layer)),
    )
    expect(seen).toEqual({
      url: "https://api.github.com/repos/alice/smithers/merge-upstream",
      method: "POST",
      body: { branch: "main" },
    })
    expect(res.merge_type).toBe("fast-forward")
  })
})
