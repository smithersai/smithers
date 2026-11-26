import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { Effect, Layer } from "effect"
import { FetchHttpClient, HttpClient, HttpClientError, HttpClientRequest } from "effect/http"
import { afterEach, describe, expect, test } from "vitest"
import { submitWaitlist, waitlistErrorMessage, WaitlistJoinFailed } from "./api.vibe"
import { WAITLIST_JOIN_ROUTE } from "./contract.ts"
import { renderWaitlistPrompt } from "./waitlist-render.tsx"

const repoUrl = "https://github.com/evmts/voltaire"
const servers: Array<ReturnType<typeof createServer>> = []
afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
      server.closeAllConnections()
    })
  }
})

const serve = async (status: number, body: string) => {
  const requests: Array<{ method: string | undefined; path: string | undefined; contentType: string | undefined; body: string }> = []
  const server = createServer((request, response) => {
    let payload = ""
    request.setEncoding("utf8")
    request.on("data", (chunk: string) => { payload += chunk })
    request.on("end", () => {
      requests.push({ method: request.method, path: request.url, contentType: request.headers["content-type"], body: payload })
      response.writeHead(status, { "content-type": "application/json" }).end(body)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  servers.push(server)
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests }
}

const rejected = (input: Parameters<typeof submitWaitlist>[0], client = FetchHttpClient.layer) =>
  Effect.runPromise(Effect.flip(submitWaitlist(input)).pipe(Effect.provide(client)))

describe("waitlist client api", () => {
  test("posts to the waitlist route, trims the workflow note, and decodes the queue position", async () => {
    const receipt = { status: "submitted", repoUrl, position: 7 }
    const { origin, requests } = await serve(200, JSON.stringify(receipt))
    const result = await Effect.runPromise(submitWaitlist({
      origin,
      repoUrl,
      workflowNote: "  .smithers/workflows/ci.vibe  ",
    }).pipe(Effect.provide(FetchHttpClient.layer)))

    expect(result).toEqual(receipt)
    expect(requests).toEqual([{
      method: "POST",
      path: WAITLIST_JOIN_ROUTE,
      contentType: "application/json",
      body: JSON.stringify({ repoUrl, workflowNote: ".smithers/workflows/ci.vibe" }),
    }])
  })

  test.each([undefined, "  "])("uses the relative route and omits a blank or missing note (%s)", async (workflowNote) => {
    const receipt = { status: "submitted", repoUrl, position: 7 }
    const { origin, requests } = await serve(200, JSON.stringify(receipt))
    const sameOrigin = Layer.effect(HttpClient.HttpClient, Effect.map(
      HttpClient.HttpClient,
      HttpClient.mapRequest(HttpClientRequest.prependUrl(origin)),
    )).pipe(Layer.provide(FetchHttpClient.layer))

    expect(await Effect.runPromise(submitWaitlist({ repoUrl, workflowNote }).pipe(Effect.provide(sameOrigin)))).toEqual(receipt)
    expect(requests).toEqual([{
      method: "POST",
      path: WAITLIST_JOIN_ROUTE,
      contentType: "application/json",
      body: JSON.stringify({ repoUrl }),
    }])
  })

  test.each([
    [400, '{"error":"invalid_repo_url","code":"ignored"}', "invalid_repo_url"],
    [400, '{"code":"invalid_json"}', "invalid_json"],
    [403, '{"error":"person_only"}', "person_only"],
    [429, "gateway response", "rate_limited"],
    [413, '{"error":413}', "too_large"],
    [502, "gateway response", "unavailable"],
    [503, "{}", "unavailable"],
  ] as const)("maps status %s and body %s to %s", async (status, body, code) => {
    const { origin } = await serve(status, body)
    const error = await rejected({ origin, repoUrl })
    expect(error).toBeInstanceOf(WaitlistJoinFailed)
    expect(error).toMatchObject({ status, code })
  })

  test.each(["{", '{"status":"submitted"}'])("rejects a malformed success receipt (%s)", async (body) => {
    const { origin } = await serve(200, body)
    expect(await rejected({ origin, repoUrl })).toMatchObject({ status: 200, code: "invalid_response" })
  })

  test("reports transport failure without an HTTP status", async () => {
    const transportDown = Layer.succeed(HttpClient.HttpClient, HttpClient.make((request) =>
      Effect.fail(new HttpClientError.HttpClientError({ reason: new HttpClientError.TransportError({ request }) }))))
    const error = await rejected({ repoUrl }, transportDown)
    expect(error.code).toBe("unavailable")
    expect(error.status).toBeUndefined()
  })

  test("rejects an unserializable value from an untyped caller before sending a request", async () => {
    const { origin, requests } = await serve(200, "{}")
    const error = await rejected({ origin, repoUrl: 1n as unknown as string })
    expect(error.code).toBe("invalid_payload")
    expect(error.status).toBeUndefined()
    expect(requests).toEqual([])
  })

  test.each([
    ["invalid_repo_url", "Enter a valid HTTPS repository URL."],
    ["invalid_json", "Enter a valid HTTPS repository URL."],
    ["invalid_payload", "Enter a valid HTTPS repository URL."],
    ["person_only", "Sign in directly to request repository hosting."],
    ["rate_limited", "Too many requests. Wait a minute and try again."],
    ["too_large", "Request is too large."],
    ["unavailable", "Waitlist is unavailable right now. Try again shortly."],
  ])("shows the message for %s", (code, message) => {
    expect(waitlistErrorMessage(new WaitlistJoinFailed({ code }))).toBe(message)
  })
})

describe("WaitlistPrompt", () => {
  test("renders idle, submitted receipt, and error states", () => {
    const idle = renderWaitlistPrompt({
      repoUrl: "https://github.com/evmts/voltaire",
      workflowNote: ".smithers/workflows/ci.vibe",
      status: "idle",
      onRepoUrlChange: () => {},
      onWorkflowNoteChange: () => {},
      onSubmit: () => {},
    })
    expect(idle).toContain("Host your repository on smithers.sh")
    expect(idle).toContain("Request maintainer access")

    const submitted = renderWaitlistPrompt({
      repoUrl: "https://github.com/evmts/voltaire",
      status: "submitted",
      position: 7,
      onRepoUrlChange: () => {},
      onSubmit: () => {},
    })
    expect(submitted).toContain("Waitlist confirmed")
    expect(submitted).toContain("position 7")

    const failed = renderWaitlistPrompt({
      repoUrl: "https://github.com/evmts/voltaire",
      status: "error",
      errorMessage: "Enter a valid HTTPS repository URL.",
      onRepoUrlChange: () => {},
      onSubmit: () => {},
    })
    expect(failed).toContain("Enter a valid HTTPS repository URL.")
  })
})
