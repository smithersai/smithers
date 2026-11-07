import { GitHub } from "@smthrs/integrations"
import { Effect, Function, Option } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import type { SqlClient } from "effect/sql"
import { withToken } from "#vibelang/emitted/worker/github/Calls"
import type { GitHubApp, Repository } from "../github/Config.vibe"
import { readIssue } from "../github/Project.ts"
import * as Tokens from "../github/Tokens.ts"

// One issue read from GitHub into the projection, for `attach`'s live check (decision 0153): GitHub's answer, under the
// projection's newer-than guard, so an issue a missed webhook hid as deleted is tombstoned before the writer decides.
// Read as the App, with a token narrowed to the repository and `issues: read`.
export const make = (app: GitHubApp, http: Option.Option<HttpClient.HttpClient> = Option.none()) =>
  Effect.gen(function* () {
    const appAuth = GitHub.AppAuth.make({ appId: app.appId, privateKey: app.privateKey, apiBaseUrl: app.apiBaseUrl })
    return (repository: Repository, number: number): Effect.Effect<void, unknown, SqlClient.SqlClient> =>
      Effect.gen(function* () {
        // Installation tokens only: no session's token to refresh.
        const tokens = Tokens.make({ app: yield* appAuth, keys: Option.none(), refresh: Function.constant(Effect.void) })
        const token = yield* tokens.forInstallation(repository, "read")
        yield* readIssue(repository, number).pipe(withToken(token, app.apiBaseUrl))
      }).pipe(
        Option.isSome(http) ? Effect.provideService(HttpClient.HttpClient, http.value) : Effect.provide(FetchHttpClient.layer),
        Effect.withSpan("stack.issue.read"),
      )
  })
