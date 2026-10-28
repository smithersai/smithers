import { Core, GitHub } from "@smthrs/integrations"
import { Clock, Config, Context, Effect, Layer, Redacted, Schema } from "effect"
import type { HttpClient } from "effect/http"
import type { Role } from "../src/features/auth/contract.ts"

// What sign-in asks of GitHub (docs/features/sign-in.md): the Smithers GitHub App's user authorization, with PKCE S256
// and `state`, its 8-hour `ghu_` tokens and single-use `ghr_` refresh tokens, who the person is, their permission on
// the repository, and revoking a token at sign-out. It is a service, so a test injects a GitHub that refuses or fails;
// `GitHubAuth.layer` is the real one, over `@smthrs/integrations` and the `HttpClient` in context. Failures carry the
// step and a reason, never GitHub's text or a token.

/** Where GitHub's web and API live, unless set: github.com. */
export const GITHUB_WEB = "https://github.com"
export const GITHUB_API = "https://api.github.com"

/** `GITHUB_APP_SLUG`: the Smithers GitHub App's name in its URLs, `smithers` unless set: where Install goes. */
export const appSlug = Config.schema(Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,99}$/)), "GITHUB_APP_SLUG")
  .pipe(Config.withDefault("smithers"))

/**
 * GitHub didn't do what sign-in asked:
 * - `rejected`: a definite no, such as a used or expired code or refresh token, or a token GitHub no longer accepts;
 * - `misconfigured`: GitHub refused the App's client id, secret or callback URL;
 * - `unavailable`: no answer, a rate limit, a server error, or an answer outside its contract.
 */
export class GitHubRefused extends Schema.TaggedError<GitHubRefused>()("@smthrs/mvp/auth/GitHubRefused", {
  step: Schema.Literals(["exchange", "refresh", "user", "permission", "revoke"]),
  reason: Schema.Literals(["rejected", "misconfigured", "unavailable"]),
}) {}

/** A user access token, when it expires (epoch ms; `null` when GitHub didn't say), and its refresh token. */
export interface Tokens {
  readonly accessToken: Redacted.Redacted<string>
  readonly expiresAt: number | null
  readonly refreshToken: Redacted.Redacted<string> | null
}

/** A person's permission on a repository, as GitHub names it; `none` when they can't see it. */
export type Permission = "admin" | "maintain" | "write" | "triage" | "read" | "none"

/**
 * A person's role from their GitHub permission (decision 0007 §1 and §9), never with more power over the repository
 * than GitHub gives: admin is Admin, maintain is Maintainer, write is Member, triage and read are Guest, and no
 * permission is no role.
 */
export const roleOf = (permission: Permission): Role | null => {
  switch (permission) {
    case "admin":
      return "admin"
    case "maintain":
      return "maintainer"
    case "write":
      return "member"
    case "triage":
    case "read":
      return "guest"
    case "none":
      return null
  }
}

export class GitHubAuth extends Context.Service<
  GitHubAuth,
  {
    /** The URL of GitHub's authorization page for one sign-in. */
    readonly authorizeUrl: (request: {
      readonly state: string
      readonly codeChallenge: string
      readonly redirectUri: string
    }) => string
    /** Redeems the code GitHub's callback carried, with the PKCE verifier and the same redirect URI. */
    readonly exchange: (request: {
      readonly code: Redacted.Redacted<string>
      readonly codeVerifier: Redacted.Redacted<string>
      readonly redirectUri: string
    }) => Effect.Effect<Tokens, GitHubRefused>
    /** Trades a refresh token, once, for new tokens. */
    readonly refresh: (refreshToken: Redacted.Redacted<string>) => Effect.Effect<Tokens, GitHubRefused>
    /** Who the token belongs to: GitHub's numeric id and login. */
    readonly user: (
      accessToken: Redacted.Redacted<string>,
    ) => Effect.Effect<{ readonly id: number; readonly login: string }, GitHubRefused>
    /** The token's person's permission on `repository` (`owner/name`). */
    readonly permission: (
      accessToken: Redacted.Redacted<string>,
      repository: string,
    ) => Effect.Effect<Permission, GitHubRefused>
    /**
     * Revokes a user access token on GitHub, as the App. A token GitHub no longer has (revoked, expired or never
     * issued) counts as revoked. Fails `misconfigured` when GitHub refuses the App's client credentials.
     */
    readonly revoke: (accessToken: Redacted.Redacted<string>) => Effect.Effect<void, GitHubRefused>
  }
>()("@smthrs/mvp/auth/GitHubAuth") {
  /**
   * The real GitHub, as the App `clientId` with `clientSecret`, over the `HttpClient` in context. `webBaseUrl` and
   * `apiBaseUrl` default to github.com.
   */
  static readonly layer = (options: {
    readonly clientId: string
    readonly clientSecret: Redacted.Redacted<string>
    readonly webBaseUrl?: string
    readonly apiBaseUrl?: string
  }): Layer.Layer<GitHubAuth, never, HttpClient.HttpClient> =>
    Layer.effect(GitHubAuth, make(options))
}

const User = Schema.Struct({ id: Schema.Number, login: Schema.String })

const Repository = Schema.Struct({
  permissions: Schema.optional(
    Schema.Struct({
      admin: Schema.Boolean,
      maintain: Schema.optional(Schema.Boolean),
      push: Schema.Boolean,
      triage: Schema.optional(Schema.Boolean),
      pull: Schema.Boolean,
    }),
  ),
})

/** The HTTP status an `@smthrs/integrations` failure answered with, if any. */
const statusOf = (error: Core.IntegrationError.IntegrationError) => error.details?.["status"]

/**
 * What an `@smthrs/integrations` failure means for sign-in: a refused grant, or a 401, 403 or 404 that isn't a rate
 * limit, is `rejected`; a refused client is `misconfigured`; anything else is `unavailable`.
 */
const reasonOf = (error: Core.IntegrationError.IntegrationError): GitHubRefused["reason"] => {
  if (error.reason === "permission-denied") return "rejected"
  if (error.reason === "invalid-config" || error.reason === "credentials-missing") return "misconfigured"
  const status = statusOf(error)
  return error.details?.["rateLimited"] !== true && (status === 401 || status === 403 || status === 404)
    ? "rejected"
    : "unavailable"
}

const make = (options: {
  readonly clientId: string
  readonly clientSecret: Redacted.Redacted<string>
  readonly webBaseUrl?: string
  readonly apiBaseUrl?: string
}) =>
  Effect.gen(function* () {
    const web = options.webBaseUrl ?? GITHUB_WEB
    const apiBaseUrl = options.apiBaseUrl ?? GITHUB_API
    const endpoint = {
      tokenUrl: `${web}/login/oauth/access_token`,
      clientId: options.clientId,
      clientSecret: options.clientSecret,
      provider: "GitHub",
    }
    // The services the `@smthrs/integrations` calls need: the caller's `HttpClient`.
    const context = yield* Effect.context<HttpClient.HttpClient>()
    const refused = (step: GitHubRefused["step"]) => (error: Core.IntegrationError.IntegrationError) =>
      new GitHubRefused({ step, reason: reasonOf(error) })
    const tokens = (grant: Core.OAuthToken.Grant) =>
      Effect.map(Clock.currentTimeMillis, (now): Tokens => ({
        accessToken: grant.accessToken,
        expiresAt: grant.expiresInSeconds === null ? null : now + grant.expiresInSeconds * 1000,
        refreshToken: grant.refreshToken,
      }))
    // A client acting as the person, never the ambient environment's token.
    const asPerson = (accessToken: Redacted.Redacted<string>) =>
      GitHub.GitHubClient.make({ token: Redacted.value(accessToken), apiBaseUrl }, {})
    // A client acting as the App's OAuth client (HTTP Basic), for `/applications/<client id>/...`.
    const asApp = GitHub.GitHubClient.make({
      clientCredentials: { clientId: options.clientId, clientSecret: options.clientSecret },
      apiBaseUrl,
    }, {})

    return GitHubAuth.of({
      authorizeUrl: ({ state, codeChallenge, redirectUri }) =>
        Core.AuthorizationUrl.buildAuthorizationUrl({
          authorizationEndpoint: `${web}/login/oauth/authorize`,
          clientId: options.clientId,
          redirectUri,
          state,
          codeChallenge,
          codeChallengeMethod: "S256",
        }),
      exchange: ({ code, codeVerifier, redirectUri }) =>
        Core.OAuthToken.exchangeCode({ ...endpoint, code, codeVerifier, redirectUri }).pipe(
          Effect.mapError(refused("exchange")),
          Effect.flatMap(tokens),
          Effect.provide(context),
        ),
      refresh: (refreshToken) =>
        Core.OAuthToken.exchangeRefreshToken({ ...endpoint, refreshToken }).pipe(
          Effect.mapError(refused("refresh")),
          Effect.flatMap(tokens),
          Effect.provide(context),
        ),
      user: (accessToken) =>
        asPerson(accessToken).pipe(
          Effect.flatMap((client) => client.request("GET", "/user", undefined, { schema: User })),
          Effect.map(({ id, login }) => ({ id, login })),
          Effect.mapError(refused("user")),
          Effect.provide(context),
        ),
      permission: (accessToken, repository) =>
        asPerson(accessToken).pipe(
          Effect.flatMap((client) =>
            client.request("GET", `/repos/${repository}`, undefined, { schema: Repository })
          ),
          Effect.map(({ permissions }): Permission =>
            permissions === undefined
              ? "none"
              : permissions.admin
              ? "admin"
              : permissions.maintain === true
              ? "maintain"
              : permissions.push
              ? "write"
              : permissions.triage === true
              ? "triage"
              : permissions.pull
              ? "read"
              : "none"
          ),
          // A repository the person can't see is a 404, not a failure: they have no permission on it.
          Effect.catchIf(
            (error) => statusOf(error) === 404,
            () => Effect.succeed<Permission>("none"),
          ),
          Effect.mapError(refused("permission")),
          Effect.provide(context),
        ),
      // `DELETE /applications/<client id>/token`: 204 when GitHub revoked it, 404 or 422 when it no longer has it.
      // Revoking twice is harmless, so a retried step may send it again.
      revoke: (accessToken) =>
        asApp.pipe(
          Effect.flatMap((client) =>
            client.request("DELETE", `/applications/${encodeURIComponent(options.clientId)}/token`, {
              access_token: Redacted.value(accessToken),
            }, { retryUnsafeWrites: true })
          ),
          Effect.asVoid,
          Effect.catchIf(
            (error) => statusOf(error) === 404 || statusOf(error) === 422,
            () => Effect.void,
          ),
          // As the App, a refusal is GitHub refusing the App's client credentials.
          Effect.mapError((error) =>
            new GitHubRefused({
              step: "revoke",
              reason: reasonOf(error) === "rejected" ? "misconfigured" : reasonOf(error),
            })
          ),
          Effect.provide(context),
        ),
    })
  })
