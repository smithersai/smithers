import * as GitHubCreation from "../branch/GitHubCreation.ts"
import { GitHub } from "@smthrs/integrations"
import { Effect, Layer, Option } from "effect"
import { HttpClient } from "effect/http"
import type { SqlClient } from "effect/sql"
import { codeOf } from "../ErrorCode.ts"
import type { Seat } from "../ModelEndpoint.ts"
import type { SessionKeys } from "../SessionKeys.ts"
import * as Apply from "./Apply.ts"
import * as GitHubConfig from "./Config.ts"
import * as Merge from "./Merge.ts"
import * as Reconcile from "./Reconcile.ts"
import * as Tokens from "./Tokens.ts"
import * as Triage from "./Triage.ts"
import * as Write from "./Write.ts"

// What a host needs to run the GitHub flows (docs/features/issues.md#remote-flows): the App (`GitHub.AppAuth` from
// `@smthrs/integrations`, which signs its JWT with WebCrypto), Postgres, GitHub's HTTP, the tokens, and triage's judge
// (the `judge` model role, admitted and metered as the model endpoint's calls are). The Durable Object builds it from the
// deployment's config (worker/Executions.ts); the tests build it over a scripted GitHub and a scripted model. Nothing
// here names a host.

/** The GitHub flows, in the order a host registers them. */
export const flows = [Apply.Apply, Reconcile.Reconcile, Write.Write, Triage.TriageRun, Merge.Merge, GitHubCreation.Create] as const

/** The App, configured and ready: what `services` turns into the flows' services once the host knows how to refresh. */
export interface Ready<E, R> {
  readonly app: GitHub.AppAuth.AppAuth
  readonly database: Layer.Layer<SqlClient.SqlClient, E, R>
  readonly http: HttpClient.HttpClient
  readonly apiBaseUrl: string
}

/**
 * The App from the deployment's config (`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_API_URL`), over the
 * `HttpClient` in context, with the app's tables on `database`. `None` when the App isn't configured, or its key doesn't
 * import, which logs `github.config` with the code only.
 */
export const ready = <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>) =>
  Effect.gen(function* () {
    const configured = yield* GitHubConfig.configured
    if (Option.isNone(configured)) return Option.none<Ready<E, R>>()
    const { appId, privateKey, apiBaseUrl } = configured.value
    const app = yield* GitHub.AppAuth.make({ appId, privateKey, apiBaseUrl }).pipe(Effect.result)
    if (app._tag === "Failure") {
      yield* Effect.logError("github.config").pipe(Effect.annotateLogs({ errorCode: codeOf(app.failure) }))
      return Option.none<Ready<E, R>>()
    }
    return Option.some<Ready<E, R>>({ app: app.success, database, http: yield* HttpClient.HttpClient, apiBaseUrl })
  })

/**
 * The flows' services from `ready`: sign-in's keys open a person's token (none without sign-in), `refresh` starts the
 * session's `auth/RecheckRole`, and `judge` is the model triage decides with for the person who enabled it
 * (`ModelEndpoint.local`'s `judge` role).
 */
export const services = <E, R>(
  ready: Ready<E, R>,
  sessions: {
    readonly keys: Option.Option<SessionKeys>
    readonly refresh: (sessionId: string, generation: number) => Effect.Effect<void>
  },
  judge: (enabledBy: string) => Seat,
): Triage.Services<E, R> => ({
  database: ready.database,
  http: ready.http,
  apiBaseUrl: ready.apiBaseUrl,
  tokens: Tokens.make({ app: ready.app, keys: sessions.keys, refresh: sessions.refresh }),
  judge,
})

/** Registers `github/Apply`, `github/Reconcile`, `github/Write`, `triage/Run` and `pr/Merge` over `services`. */
export const registration = <E, R>(services: Triage.Services<E, R>) =>
  Layer.mergeAll(
    Apply.registration(services),
    Reconcile.registration(services),
    Write.registration(services),
    Triage.registration(services),
    Merge.registration(services),
    GitHubCreation.registration(services.database, services.http),
  )
