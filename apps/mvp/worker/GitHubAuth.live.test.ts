// The GitHub App adapter (worker/GitHubAuth.ts) against the real GitHub, with the Smithers GitHub App's credentials.
// Each case skips, naming what is missing, without its variables:
// - GITHUB_APP_CLIENT_ID and GITHUB_APP_CLIENT_SECRET: GitHub refuses a made-up refresh token and a made-up code as
//   `rejected`, which it does only for the App's real client id and secret (otherwise `misconfigured`);
// - GITHUB_SIGN_IN_CALLBACK_URL, such as http://localhost:1337/api/auth/callback: GitHub accepts it as the App's
//   callback URL (a URL not registered on the App is `redirect_uri_mismatch`, so `misconfigured`);
// - GITHUB_SIGN_IN_TEST_TOKEN, a `ghu_` user token from a real sign-in: who it belongs to, and their permission on
//   GITHUB_REPOSITORY (smithersai/smithers unless set).
// The browser half of the happy path, pressing Approve on GitHub, is the end-to-end suite's (decision 0008, E2).
import { Effect, Exit, Redacted } from "effect"
import { FetchHttpClient } from "effect/http"
import { describe, expect, test } from "vitest"
import { GitHubAuth, GitHubRefused, roleOf } from "./GitHubAuth.ts"
import { DEFAULT_REPOSITORY } from "./SignIn.vibe"

const clientId = process.env.GITHUB_APP_CLIENT_ID
const clientSecret = process.env.GITHUB_APP_CLIENT_SECRET
const userToken = process.env.GITHUB_SIGN_IN_TEST_TOKEN
const callbackUrl = process.env.GITHUB_SIGN_IN_CALLBACK_URL
const repository = process.env.GITHUB_REPOSITORY ?? DEFAULT_REPOSITORY

const missing = (names: Record<string, string | undefined>) =>
  Object.entries(names).filter(([, value]) => value === undefined || value === "").map(([name]) => name)

const appMissing = missing({ GITHUB_APP_CLIENT_ID: clientId, GITHUB_APP_CLIENT_SECRET: clientSecret })
const tokenMissing = [...appMissing, ...missing({ GITHUB_SIGN_IN_TEST_TOKEN: userToken })]
const callbackMissing = [...appMissing, ...missing({ GITHUB_SIGN_IN_CALLBACK_URL: callbackUrl })]

const github = () =>
  Effect.runPromise(
    Effect.service(GitHubAuth).pipe(
      Effect.provide(GitHubAuth.layer({ clientId: clientId!, clientSecret: Redacted.make(clientSecret!) })),
      Effect.provide(FetchHttpClient.layer),
    ),
  )

const named = (what: string, needs: ReadonlyArray<string>) =>
  needs.length === 0 ? what : `${what} (skipped: set ${needs.join(" and ")})`

describe("the real GitHub", () => {
  test.skipIf(appMissing.length > 0)(
    named("knows the App: a made-up refresh token and code are rejected, not misconfigured", appMissing),
    async () => {
      const service = await github()
      const refresh = await Effect.runPromiseExit(service.refresh(Redacted.make("ghr_not_a_real_token")))
      expect(refresh).toEqual(Exit.fail(new GitHubRefused({ step: "refresh", reason: "rejected" })))
      // An empty redirect URI leaves GitHub's callback check out, so only the client and the code are judged.
      const code = await Effect.runPromiseExit(
        service.exchange({ code: Redacted.make("not-a-real-code"), codeVerifier: Redacted.make("v".repeat(43)), redirectUri: "" }),
      )
      expect(code).toEqual(Exit.fail(new GitHubRefused({ step: "exchange", reason: "rejected" })))
    },
    30_000,
  )

  test.skipIf(callbackMissing.length > 0)(
    named(`accepts ${callbackUrl ?? "the callback URL"} as the App's callback`, callbackMissing),
    async () => {
      const service = await github()
      const code = await Effect.runPromiseExit(
        service.exchange({
          code: Redacted.make("not-a-real-code"),
          codeVerifier: Redacted.make("v".repeat(43)),
          redirectUri: callbackUrl!,
        }),
      )
      expect(code).toEqual(Exit.fail(new GitHubRefused({ step: "exchange", reason: "rejected" })))
    },
    30_000,
  )

  test.skipIf(tokenMissing.length > 0)(
    named(`reads a signed-in person and their role on ${repository}`, tokenMissing),
    async () => {
      const service = await github()
      const token = Redacted.make(userToken!)
      const user = await Effect.runPromise(service.user(token))
      expect(user.id).toBeGreaterThan(0)
      expect(user.login.length).toBeGreaterThan(0)
      const permission = await Effect.runPromise(service.permission(token, repository))
      expect(["admin", "maintain", "write", "triage", "read", "none"]).toContain(permission)
      expect([null, "admin", "maintainer", "member", "guest"]).toContain(roleOf(permission))
    },
    30_000,
  )
})
