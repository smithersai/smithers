import { Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { expect, test } from "vitest"
import { withUserAgent } from "./Http.ts"

// A refusing HTTP service exposes the actual outbound request without contacting GitHub or disclosing credentials.
test.each([
  [false, "https://github.example/login/oauth/access_token", undefined, "smithers-integrations"],
  [true, "https://api.github.com/repos/acme/widgets", undefined, "smithers-integrations"],
  [true, "https://github.com/acme/widgets.git/info/refs", "guest", "smithers-integrations"],
  [true, "https://uploads.github.com/repos/acme/widgets/releases/1/assets", "", "smithers-integrations"],
  [true, "https://registry.npmjs.org/effect", "package-client", "package-client"],
  [true, "https://github.com.example.org/", "other-client", "other-client"],
  [true, "https://example.org/", undefined, undefined],
] as const)("identifies GitHub requests and preserves mixed egress (%s, %s)", async (githubHostsOnly, url, initial, expected) => {
  const sent: Array<string | undefined> = []
  const http = HttpClient.make((request) => Effect.sync(() => {
    sent.push(request.headers["user-agent"])
    return HttpClientResponse.fromWeb(request, new Response(null, { status: 403 }))
  }))
  const request = HttpClientRequest.get(url, { headers: initial === undefined ? {} : { "user-agent": initial } })
  const response = await Effect.runPromise(HttpClient.execute(request).pipe(
    (effect) => withUserAgent(effect, githubHostsOnly),
    Effect.provide(Layer.succeed(HttpClient.HttpClient, http)),
  ))
  expect(response.status).toBe(403)
  expect(sent).toEqual([expected])
})
