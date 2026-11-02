import { GitHub } from "@smthrs/integrations"
import { Clock, Effect, Function, type Layer, Option } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import type { SqlClient } from "effect/sql"
import { type GitHubApp, repositoryOf } from "../github/Config.ts"
import * as Tokens from "../github/Tokens.ts"
import type { GitCredential } from "./Api.ts"

// A runner's read credential for its repository (decision 0148, docs/features/agent-runners.md#private-repositories):
// the App's installation token for that one repository with `contents: read` and nothing else, as git over HTTPS takes
// it (`x-access-token` and the token). GitHub ends it an hour after minting; the runner is told to ask again 10 minutes
// before that. The token never reaches a log: the route records the job and the outcome only.

/** How long after minting a credential the runner treats it as spent: GitHub's hour, less a margin for clocks. */
export const CREDENTIAL_LIFETIME_MS = 50 * 60 * 1000

/** The repository's HTTPS remote on GitHub, from its `github/<owner>/<name>` id. */
export const remoteOf = (repoId: string, webBaseUrl = "https://github.com"): string =>
  `${webBaseUrl}/${repoId.slice("github/".length)}.git`

/**
 * Mints a credential for `repoId` with the App, over `database` (which remembers the App's installations); `none`
 * without the App, or where it isn't installed on the repository or wasn't granted contents. Anything else fails, and
 * the route answers 503.
 */
export const make = <E, R>(
  app: Option.Option<GitHubApp>,
  database: Layer.Layer<SqlClient.SqlClient, E, R>,
  http?: HttpClient.HttpClient,
) =>
(repoId: string): Effect.Effect<Option.Option<GitCredential>, unknown, R> =>
  Option.isNone(app)
    ? Effect.succeed(Option.none())
    : Effect.gen(function* () {
      // The signer is built for each request, never shared across them (worker/github/RepoRoles.ts).
      const auth = yield* GitHub.AppAuth.make({
        appId: app.value.appId,
        privateKey: app.value.privateKey,
        apiBaseUrl: app.value.apiBaseUrl,
      })
      const tokens = Tokens.make({ app: auth, keys: Option.none(), refresh: Function.constant(Effect.void) })
      const minted = yield* tokens.forInstallation(repositoryOf(repoId.slice("github/".length)), "contents").pipe(
        Effect.result,
      )
      if (minted._tag === "Failure") {
        const reason = minted.failure.reason
        if (reason === "app_not_installed" || reason === "not_allowed") return Option.none<GitCredential>()
        return yield* Effect.fail(minted.failure)
      }
      const now = yield* Clock.currentTimeMillis
      return Option.some<GitCredential>({
        remote: remoteOf(repoId),
        username: "x-access-token",
        password: minted.success,
        expiresAt: now + CREDENTIAL_LIFETIME_MS,
      })
    }).pipe(
      http === undefined ? Effect.provide(FetchHttpClient.layer) : Effect.provideService(HttpClient.HttpClient, http),
      Effect.provide(database),
    )
