// What `repo/Inspect` asks GitHub (worker/RepoUpstream.ts): HEAD over git's smart HTTP and the size from the REST API.
// The live case reads the real github.com and skips, saying so, only when it doesn't answer. GitHub's refusals are a
// scripted GitHub on the `HttpClient` seam, an Effect service injected into the layer; nothing intercepts a request.
import { GitRemote } from "@smthrs/effect-code-storage"
import { ConfigProvider, Effect, Layer, Option, Redacted } from "effect"
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http"
import { describe, expect, test } from "vitest"
import * as ReadToken from "./github/ReadToken.ts"
import { DEFAULT_RATE_LIMIT_WAIT_MS, RepoUpstream, UpstreamUnavailable } from "./RepoUpstream.ts"

// GitHub answers the ref advertisement 200. Any other answer is not GitHub's: a box whose egress reaches only the
// package registries gets the egress's own 403 (decision 0145), which is no more GitHub than no answer at all.
const githubUp = await fetch("https://github.com/octocat/Spoon-Knife.git/info/refs?service=git-upload-pack", {
  signal: AbortSignal.timeout(5_000),
}).then(
  (response) => {
    if (!response.ok) console.warn(`The live GitHub check is skipped: github.com answered ${response.status}.`)
    return response.ok
  },
  (error: unknown) => {
    console.warn(`The live GitHub check is skipped: github.com did not answer (${(error as Error).name}).`)
    return false
  },
)

/** A GitHub that answers every request with `answer`, and the requests it saw. */
const scriptedGitHub = (answer: (url: URL) => Response) => {
  const seen: Array<{ readonly url: URL; readonly userAgent: string | undefined; readonly authorization: string | undefined }> = []
  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      seen.push({ url, userAgent: request.headers["user-agent"], authorization: request.headers["authorization"] })
      return HttpClientResponse.fromWeb(request, answer(url))
    })
  )
  return { seen, layer: Layer.succeed(HttpClient.HttpClient, client) }
}

const upstream = (http: Layer.Layer<HttpClient.HttpClient>, token?: string) =>
  Effect.runPromise(
    Effect.service(RepoUpstream).pipe(
      Effect.provide(
        RepoUpstream.layer({ token: ReadToken.fixed(Option.fromUndefinedOr(token).pipe(Option.map(Redacted.make))) }),
      ),
      Effect.provide(http),
    ),
  )

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } })

describe("RepoUpstream", () => {
  test.skipIf(!githubUp)("reads a public repository's HEAD and size from the real GitHub", async () => {
    const github = await Effect.runPromise(
      Effect.service(RepoUpstream).pipe(
        Effect.provide(RepoUpstream.layerConfig),
        Effect.provide(FetchHttpClient.layer),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv())),
      ),
    )
    const head = await Effect.runPromise(github.head("octocat", "Spoon-Knife"))
    expect(head).toEqual({ sha: expect.stringMatching(/^[0-9a-f]{40}$/), branch: "main" })
    const size = await Effect.runPromise(github.size("octocat", "Spoon-Knife"))
    // Without GITHUB_TOKEN this spends one of the 60 calls an hour GitHub allows this address; rate limited is a size.
    expect("bytes" in size || "retryAt" in size).toBe(true)
  })

  test("the size in bytes, asked with the token when one is configured, and without one otherwise", async () => {
    const github = scriptedGitHub(() => json({ size: 640 }))
    const withToken = await upstream(github.layer, "ghs_scripted")
    expect(await Effect.runPromise(withToken.size("octocat", "Spoon-Knife"))).toEqual({ bytes: 640 * 1024 })
    expect(github.seen[0]!.url.toString()).toBe("https://api.github.com/repos/octocat/Spoon-Knife")
    expect(github.seen[0]!.authorization).toBe("Bearer ghs_scripted")
    const anonymous = await upstream(github.layer)
    await Effect.runPromise(anonymous.size("octocat", "Spoon-Knife"))
    expect(github.seen[1]!.authorization).toBeUndefined()
  })

  test("rate limited: the size is unknown until GitHub's reset, or an hour when it doesn't say", async () => {
    const resetAt = Math.floor(Date.now() / 1000) + 600
    const limited = await upstream(
      scriptedGitHub(() =>
        json({ message: "API rate limit exceeded" }, 403, {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(resetAt),
        })
      ).layer,
    )
    const sized = await Effect.runPromise(limited.size("octocat", "Spoon-Knife"))
    expect("retryAt" in sized && Math.abs(sized.retryAt - resetAt * 1000)).toBeLessThan(2_000)
    const silent = await upstream(scriptedGitHub(() => json({ message: "slow down" }, 429)).layer)
    const unsaid = await Effect.runPromise(silent.size("octocat", "Spoon-Knife"))
    expect("retryAt" in unsaid && unsaid.retryAt - Date.now()).toBeGreaterThan(DEFAULT_RATE_LIMIT_WAIT_MS - 5_000)
  })

  test("a repository the REST API doesn't have is missing; a GitHub that fails is unavailable, with its wait", async () => {
    const missing = await upstream(scriptedGitHub(() => json({ message: "Not Found" }, 404)).layer)
    expect(await Effect.runPromise(missing.size("octocat", "Gone"))).toEqual({ missing: true })
    const busy = await upstream(scriptedGitHub(() => json({}, 503, { "retry-after": "3" })).layer)
    expect(await Effect.runPromise(Effect.flip(busy.size("octocat", "Spoon-Knife")))).toEqual(
      new UpstreamUnavailable({ retryAfterMillis: 3_000 }),
    )
    const broken = await upstream(scriptedGitHub(() => json({}, 500)).layer)
    expect(await Effect.runPromise(Effect.flip(broken.size("octocat", "Spoon-Knife")))).toEqual(new UpstreamUnavailable({}))
  })

  test("HEAD comes from git's smart HTTP, with no credential", async () => {
    const github = scriptedGitHub(() => new Response("Not found", { status: 404 }))
    const remote = await upstream(github.layer, "ghs_scripted")
    expect(await Effect.runPromise(Effect.flip(remote.head("octocat", "Gone")))).toEqual(
      new GitRemote.GitRemoteError({ code: "not_found", status: 404 }),
    )
    expect(github.seen[0]!.url.toString()).toBe("https://github.com/octocat/Gone.git/info/refs?service=git-upload-pack")
    expect(github.seen[0]!.authorization).toBeUndefined()
    expect(github.seen[0]!.userAgent).toBe("smithers-integrations")
  })
})
