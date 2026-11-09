// A scripted GitHub for the sign-in tests (docs/features/sign-in.md#tests): the second scripted seam beside the model
// (decision 0008, Consequences). It keeps GitHub's rules that sign-in relies on: a code is bound to the PKCE challenge
// and redirect URI it was issued for and redeems once, a refresh token redeems once and is replaced, tokens name the
// person they were issued to, and a revoked access token stops working (revoking one GitHub no longer has succeeds,
// as GitHub's 404 and 422 count as revoked). A test injects a fault per step. The real GitHub is worker/GitHubAuth.live.test.ts.
import { Core } from "@smthrs/integrations"
import { Clock, Effect, Redacted } from "effect"
import { GitHubAuth, GitHubRefused, type Permission, type Tokens } from "../GitHubAuth.ts"

/** GitHub's user tokens last 8 hours. */
export const ACCESS_TTL_MS = 8 * 60 * 60 * 1000

type Step = GitHubRefused["step"]

export interface ScriptedGitHub {
  readonly service: GitHubAuth["Service"]
  /** Who signs in, and their permission on the repository. */
  person: { id: number; login: string }
  permission: Permission
  /** Steps that fail, with the reason each fails with, until a test clears them. */
  readonly faults: Partial<Record<Step, GitHubRefused["reason"]>>
  /** Steps that die once, as a bug in GitHub's client would. */
  readonly defects: Set<Step>
  /** Whether new tokens expire, as when the App opts into expiring user tokens: GitHub's default. */
  expiring: boolean
  /** Steps that fail once, with the reason each fails with. */
  readonly failOnce: Partial<Record<Step, GitHubRefused["reason"]>>
  /** Runs as a refresh reaches GitHub, before GitHub redeems the token: where a test puts a concurrent refresh. */
  beforeRefresh: Effect.Effect<void> | undefined
  /**
   * Runs after GitHub redeemed a refresh token and issued its replacement, before the answer reaches the caller: where a
   * test pauses a check between redeeming and storing.
   */
  afterRefresh: Effect.Effect<void> | undefined
  /** Every call, in order, by step. */
  readonly calls: Array<Step>
  /** The repositories `permission` was asked about. */
  readonly repositories: Array<string>
  /** Every token handed out, in order. */
  readonly issued: Array<Tokens>
  /** The code GitHub's page would hand back for the sign-in whose authorization URL was `location`. */
  readonly approve: (location: string) => { readonly code: string; readonly state: string }
  /** Retires a refresh token, as GitHub does when it expires after six months. */
  readonly expire: (refreshToken: Redacted.Redacted<string>) => void
  /** Revokes an access token, as when a person revokes the App on GitHub. */
  readonly revoke: (accessToken: Redacted.Redacted<string>) => void
  /** Whether GitHub still accepts an access token. */
  readonly accepts: (accessToken: Redacted.Redacted<string>) => boolean
}

/** A scripted GitHub, `https://github.test`, where `octocat` (id 583231) has write access. */
export const scriptedGitHub = (): ScriptedGitHub => {
  const authorizations = new Map<string, { readonly challenge: string; readonly redirectUri: string }>()
  const codes = new Map<string, { readonly challenge: string; readonly redirectUri: string }>()
  const refreshTokens = new Set<string>()
  const accessTokens = new Set<string>()
  let minted = 0

  const mint = Effect.gen(function* () {
    minted += 1
    const tokens: Tokens = {
      accessToken: Redacted.make(`ghu_scripted_${minted}`),
      expiresAt: github.expiring ? (yield* Clock.currentTimeMillis) + ACCESS_TTL_MS : null,
      refreshToken: github.expiring ? Redacted.make(`ghr_scripted_${minted}`) : null,
    }
    accessTokens.add(Redacted.value(tokens.accessToken))
    if (tokens.refreshToken !== null) refreshTokens.add(Redacted.value(tokens.refreshToken))
    github.issued.push(tokens)
    return tokens
  })

  const step = <A>(name: Step, effect: Effect.Effect<A, GitHubRefused>) =>
    Effect.suspend(() => {
      github.calls.push(name)
      if (github.defects.delete(name)) return Effect.die(new Error(`scripted ${name} defect`))
      const once = github.failOnce[name]
      delete github.failOnce[name]
      const fault = once ?? github.faults[name]
      return fault === undefined ? effect : Effect.fail(new GitHubRefused({ step: name, reason: fault }))
    })

  const rejected = (name: Step) => Effect.fail(new GitHubRefused({ step: name, reason: "rejected" }))

  const asPerson = (name: Step, accessToken: Redacted.Redacted<string>) =>
    accessTokens.has(Redacted.value(accessToken)) ? Effect.void : rejected(name)

  const github: ScriptedGitHub = {
    person: { id: 583231, login: "octocat" },
    permission: "write",
    faults: {},
    failOnce: {},
    defects: new Set(),
    expiring: true,
    beforeRefresh: undefined,
    afterRefresh: undefined,
    calls: [],
    repositories: [],
    issued: [],
    service: GitHubAuth.of({
      deviceCode: () => Effect.fail(new GitHubRefused({ step: "device", reason: "unavailable" })),
      deviceToken: () => Effect.fail(new GitHubRefused({ step: "device", reason: "unavailable" })),
      authorizeUrl: ({ state, codeChallenge, redirectUri }) => {
        authorizations.set(state, { challenge: codeChallenge, redirectUri })
        return Core.AuthorizationUrl.buildAuthorizationUrl({
          authorizationEndpoint: "https://github.test/login/oauth/authorize",
          clientId: "Iv1.scripted",
          redirectUri,
          state,
          codeChallenge,
        })
      },
      exchange: ({ code, codeVerifier, redirectUri }) =>
        step(
          "exchange",
          Effect.gen(function* () {
            const issued = codes.get(Redacted.value(code))
            codes.delete(Redacted.value(code))
            const challenge = yield* Core.Pkce.deriveCodeChallenge(Redacted.value(codeVerifier)).pipe(
              Effect.catch(() => rejected("exchange")),
            )
            if (issued === undefined || issued.challenge !== challenge || issued.redirectUri !== redirectUri) {
              return yield* rejected("exchange")
            }
            return yield* mint
          }),
        ),
      refresh: (refreshToken) =>
        step(
          "refresh",
          Effect.gen(function* () {
            if (github.beforeRefresh !== undefined) yield* github.beforeRefresh
            if (!refreshTokens.delete(Redacted.value(refreshToken))) return yield* rejected("refresh")
            const tokens = yield* mint
            if (github.afterRefresh !== undefined) yield* github.afterRefresh
            return tokens
          }),
        ),
      user: (accessToken) => step("user", Effect.as(asPerson("user", accessToken), { ...github.person })),
      permission: (accessToken, repository) =>
        step(
          "permission",
          Effect.suspend(() => {
            github.repositories.push(repository)
            return Effect.as(asPerson("permission", accessToken), github.permission)
          }),
        ),
      revoke: (accessToken) => step("revoke", Effect.sync(() => void accessTokens.delete(Redacted.value(accessToken)))),
    }),
    approve: (location) => {
      const url = new URL(location)
      const state = url.searchParams.get("state")!
      const code = `code_${crypto.randomUUID()}`
      codes.set(code, authorizations.get(state)!)
      return { code, state }
    },
    expire: (refreshToken) => void refreshTokens.delete(Redacted.value(refreshToken)),
    revoke: (accessToken) => void accessTokens.delete(Redacted.value(accessToken)),
    accepts: (accessToken) => accessTokens.has(Redacted.value(accessToken)),
  }
  return github
}
