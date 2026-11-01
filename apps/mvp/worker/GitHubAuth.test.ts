// The real GitHub App adapter (worker/GitHubAuth.ts) against a scripted GitHub on loopback HTTP: the token endpoint,
// `/user` and `/repos/<owner>/<name>`, answering as GitHub documents, including its `200 OK` OAuth errors. Requests go
// over the real fetch transport through `@smthrs/integrations`. The real GitHub is worker/GitHubAuth.live.test.ts.
import { Cause, Context, Effect, Exit, Redacted } from "effect"
import { FetchHttpClient } from "effect/http"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, test } from "vitest"
import { GitHubAuth, GitHubRefused, type Permission } from "./GitHubAuth.ts"

interface Seen {
  readonly method: string
  readonly path: string
  readonly authorization: string | undefined
  readonly form: Record<string, string>
  readonly body: string
}

const servers: Array<Server> = []
afterEach(() => Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done)))))

/** A GitHub on loopback that answers each request with `answer(path)`: a status and a JSON body. */
const github = async (answer: (path: string) => { readonly status: number; readonly body: unknown }) => {
  const seen: Array<Seen> = []
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = ""
    request.on("data", (chunk) => (body += chunk))
    request.on("end", () => {
      const path = request.url!.split("?")[0]!
      seen.push({
        method: request.method!,
        path,
        authorization: request.headers.authorization,
        form: Object.fromEntries(new URLSearchParams(body)),
        body,
      })
      const { status, body: json } = answer(path)
      response.writeHead(status, { "content-type": "application/json" })
      response.end(status === 204 ? undefined : JSON.stringify(json))
    })
  })
  servers.push(server)
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const service = await Effect.runPromise(
    Effect.service(GitHubAuth).pipe(
      Effect.provide(
        GitHubAuth.layer({
          clientId: "Iv1.loopback",
          clientSecret: Redacted.make("loopback-secret"),
          webBaseUrl: origin,
          apiBaseUrl: origin,
        }),
      ),
      Effect.provide(FetchHttpClient.layer),
    ),
  )
  return { service, seen, origin }
}

const run = <A>(effect: Effect.Effect<A, GitHubRefused>) => Effect.runPromiseExit(effect)
const refused = (step: GitHubRefused["step"], reason: GitHubRefused["reason"], traced = true) =>
  traced ? Exit.failCause(Cause.annotate(
    Cause.fail(new GitHubRefused({ step, reason })),
    Context.make(Cause.StackTrace, {
      name: step === "exchange" || step === "refresh" ? "OAuthToken.request" : "GitHubClient.request",
      parent: undefined,
      stack: expect.any(Function),
    }),
  )) : Exit.fail(new GitHubRefused({ step, reason }))
const token = Redacted.make("ghu_loopback")

describe("the GitHub App adapter", () => {
  test("builds GitHub's authorization URL with the App's client id, state and an S256 challenge", async () => {
    const { service, origin } = await github(() => ({ status: 404, body: {} }))
    const url = new URL(service.authorizeUrl({ state: "s".repeat(43), codeChallenge: "c".repeat(43), redirectUri: "https://app.test/cb" }))
    expect(`${url.origin}${url.pathname}`).toBe(`${origin}/login/oauth/authorize`)
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: "Iv1.loopback",
      redirect_uri: "https://app.test/cb",
      state: "s".repeat(43),
      code_challenge: "c".repeat(43),
      code_challenge_method: "S256",
    })
  })

  test("is github.com unless told otherwise", async () => {
    const service = await Effect.runPromise(
      Effect.service(GitHubAuth).pipe(
        Effect.provide(GitHubAuth.layer({ clientId: "Iv1.real", clientSecret: Redacted.make("secret") })),
        Effect.provide(FetchHttpClient.layer),
      ),
    )
    const url = new URL(service.authorizeUrl({ state: "s".repeat(43), codeChallenge: "c".repeat(43), redirectUri: "x" }))
    expect(`${url.origin}${url.pathname}`).toBe("https://github.com/login/oauth/authorize")
  })

  test("redeems a code with its verifier for an 8-hour token and a refresh token", async () => {
    const { service, seen } = await github(() => ({
      status: 200,
      body: { access_token: "ghu_new", expires_in: 28800, refresh_token: "ghr_new", refresh_token_expires_in: 15811200, token_type: "bearer", scope: "" },
    }))
    const before = Date.now()
    const tokens = await Effect.runPromise(
      service.exchange({ code: Redacted.make("code-1"), codeVerifier: Redacted.make("v".repeat(43)), redirectUri: "https://app.test/cb" }),
    )
    expect(Redacted.value(tokens.accessToken)).toBe("ghu_new")
    expect(Redacted.value(tokens.refreshToken!)).toBe("ghr_new")
    expect(tokens.expiresAt).toBeGreaterThanOrEqual(before + 28_800_000)
    expect(tokens.expiresAt).toBeLessThanOrEqual(Date.now() + 28_800_000)
    expect(seen[0]).toMatchObject({
      method: "POST",
      path: "/login/oauth/access_token",
      form: {
        grant_type: "authorization_code",
        code: "code-1",
        redirect_uri: "https://app.test/cb",
        code_verifier: "v".repeat(43),
        client_id: "Iv1.loopback",
        client_secret: "loopback-secret",
      },
    })
  })

  test("a token that never expires has no expiry and no refresh token", async () => {
    const { service } = await github(() => ({ status: 200, body: { access_token: "ghu_forever", token_type: "bearer" } }))
    const tokens = await Effect.runPromise(service.refresh(Redacted.make("ghr_old")))
    expect(tokens.expiresAt).toBeNull()
    expect(tokens.refreshToken).toBeNull()
  })

  test("reads GitHub's 200 OK errors and its failures as rejected, misconfigured or unavailable", async () => {
    const cases: ReadonlyArray<readonly [{ readonly status: number; readonly body: unknown }, GitHubRefused["reason"]]> = [
      [{ status: 200, body: { error: "bad_verification_code" } }, "rejected"],
      [{ status: 200, body: { error: "incorrect_client_credentials" } }, "misconfigured"],
      [{ status: 200, body: { error: "redirect_uri_mismatch" } }, "misconfigured"],
      [{ status: 401, body: { error: "invalid_client" } }, "misconfigured"],
      [{ status: 502, body: {} }, "unavailable"],
      [{ status: 200, body: { nothing: true } }, "unavailable"],
    ]
    for (const [answer, reason] of cases) {
      const { service } = await github(() => answer)
      const exit = await run(
        service.exchange({ code: Redacted.make("c"), codeVerifier: Redacted.make("v".repeat(43)), redirectUri: "x" }),
      )
      expect(exit, JSON.stringify(answer)).toEqual(refused("exchange", reason))
    }
  })

  test("trades a refresh token once, and an expired one is rejected", async () => {
    const rotating = await github(() => ({
      status: 200,
      body: { access_token: "ghu_2", expires_in: 28800, refresh_token: "ghr_2", token_type: "bearer" },
    }))
    const tokens = await Effect.runPromise(rotating.service.refresh(Redacted.make("ghr_1")))
    expect(Redacted.value(tokens.refreshToken!)).toBe("ghr_2")
    expect(rotating.seen[0]!.form).toMatchObject({ grant_type: "refresh_token", refresh_token: "ghr_1" })
    const expired = await github(() => ({ status: 200, body: { error: "bad_refresh_token" } }))
    expect(await run(expired.service.refresh(Redacted.make("ghr_1")))).toEqual(refused("refresh", "rejected"))
  })

  test("asks who the token belongs to, as the person", async () => {
    const { service, seen } = await github(() => ({ status: 200, body: { id: 583231, login: "octocat", name: "x" } }))
    expect(await Effect.runPromise(service.user(token))).toEqual({ id: 583231, login: "octocat" })
    expect(seen[0]).toMatchObject({ method: "GET", path: "/user", authorization: "Bearer ghu_loopback" })
    const revoked = await github(() => ({ status: 401, body: { message: "Bad credentials" } }))
    expect(await run(revoked.service.user(token))).toEqual(refused("user", "rejected"))
    const odd = await github(() => ({ status: 200, body: { login: 7 } }))
    expect(await run(odd.service.user(token))).toEqual(refused("user", "unavailable", false))
  })

  test("reads the person's permission on the repository from GitHub's permissions", async () => {
    const flags = (set: Partial<Record<"admin" | "maintain" | "push" | "triage" | "pull", boolean>>) => ({
      admin: false,
      maintain: false,
      push: false,
      triage: false,
      pull: false,
      ...set,
    })
    const cases: ReadonlyArray<readonly [unknown, Permission]> = [
      [{ permissions: flags({ admin: true, maintain: true, push: true, triage: true, pull: true }) }, "admin"],
      [{ permissions: flags({ maintain: true, push: true, triage: true, pull: true }) }, "maintain"],
      [{ permissions: flags({ push: true, triage: true, pull: true }) }, "write"],
      [{ permissions: flags({ triage: true, pull: true }) }, "triage"],
      [{ permissions: flags({ pull: true }) }, "read"],
      // GitHub's older answer has no maintain or triage.
      [{ permissions: { admin: false, push: false, pull: true } }, "read"],
      [{ permissions: flags({}) }, "none"],
      [{ private: false }, "none"],
    ]
    for (const [body, permission] of cases) {
      const { service, seen } = await github(() => ({ status: 200, body }))
      expect(await Effect.runPromise(service.permission(token, "acme/widgets")), JSON.stringify(body)).toBe(permission)
      expect(seen[0]).toMatchObject({ path: "/repos/acme/widgets", authorization: "Bearer ghu_loopback" })
    }
    // A repository the person can't see is a 404: no permission, not a failure.
    const hidden = await github(() => ({ status: 404, body: { message: "Not Found" } }))
    expect(await Effect.runPromise(hidden.service.permission(token, "acme/secret"))).toBe("none")
    const revoked = await github(() => ({ status: 401, body: { message: "Bad credentials" } }))
    expect(await run(revoked.service.permission(token, "acme/widgets"))).toEqual(refused("permission", "rejected"))
  })

  test("revokes a user's token as the App, and a token GitHub no longer has counts as revoked", async () => {
    const { service, seen } = await github(() => ({ status: 204, body: {} }))
    await Effect.runPromise(service.revoke(token))
    expect(seen[0]).toMatchObject({
      method: "DELETE",
      path: "/applications/Iv1.loopback/token",
      authorization: `Basic ${btoa("Iv1.loopback:loopback-secret")}`,
    })
    expect(JSON.parse(seen[0]!.body)).toEqual({ access_token: "ghu_loopback" })
    for (const status of [404, 422]) {
      const gone = await github(() => ({ status, body: { message: "Not Found" } }))
      expect(await run(gone.service.revoke(token)), String(status)).toEqual(Exit.void)
    }
  })

  test("a revocation GitHub refuses the App for is misconfigured; an outage or a rate limit is unavailable", async () => {
    const cases: ReadonlyArray<readonly [number, GitHubRefused["reason"]]> = [
      [401, "misconfigured"],
      [403, "misconfigured"],
      [429, "unavailable"],
      [502, "unavailable"],
    ]
    for (const [status, reason] of cases) {
      const { service } = await github(() => ({ status, body: { message: "no" } }))
      expect(await run(service.revoke(token)), String(status)).toEqual(refused("revoke", reason))
    }
  })
})
