import type { ImmutableCache } from "@smthrs/artifacts"
import { CodeStorage } from "@smthrs/effect-code-storage"
import type { GitHub } from "@smthrs/integrations"
import { Config, Effect, type Layer, Option } from "effect"
import type { HttpClient } from "effect/http"
import type { SqlClient } from "effect/sql"
import * as RepoClone from "./flows/RepoClone.vibe"
import { statusOf } from "./github/Calls.vibe"
import * as GitHubHost from "./github/Host.ts"
import * as RepoReads from "./RepoReads.ts"
import * as Repos from "./Repos.ts"
import { RepoUpstream } from "./RepoUpstream.vibe"

// The repository feature's configuration (docs/features/repo.md#configuration), read with Effect `Config` where ChatApi
// and the `FlowExecution` Durable Object start: the Code Storage organization, GitHub's optional token, the budgets and
// the clone's deadline. Reading them while Alchemy plans the Worker is what binds each one that is set to it.

/**
 * The Code Storage client for `CODE_STORAGE_ORG` and `CODE_STORAGE_KEY` (and the optional `CODE_STORAGE_API_URL`), or
 * `None` when either is unset: this deployment clones nothing. A key that doesn't import is logged, never printed, and
 * is `None` too.
 */
export const codeStorage: Effect.Effect<Option.Option<CodeStorage.Client>, never, HttpClient.HttpClient> = Effect.gen(
  function* () {
    const credentials = yield* Config.option(CodeStorage.config).pipe(Effect.orDie)
    if (Option.isNone(credentials)) return Option.none()
    return yield* Effect.service(CodeStorage.CodeStorage).pipe(
      Effect.provide(CodeStorage.CodeStorage.layer(credentials.value)),
      Effect.map(Option.some),
      Effect.catch((error) =>
        Effect.as(
          Effect.logError("repo.config").pipe(Effect.annotateLogs({ errorCode: error.code })),
          Option.none<CodeStorage.Client>(),
        )
      ),
    )
  },
)

/**
 * Whether the Smithers GitHub App is installed on a repository, asked of GitHub as the `app` of `github` (the host's
 * ready App, `GitHubHost.ready`): GitHub's 404 is not installed, and any other refusal is `CloneUnavailable`, which
 * Index's retry policy waits out. A deployment without the App (`None`) has it installed nowhere.
 */
export const installedWith =
  (github: Option.Option<{ readonly app: GitHub.AppAuth.AppAuth }>) => (owner: string, name: string) =>
    Option.isNone(github) ? Effect.succeed(false) : github.value.app.installation(owner, name).pipe(
      Effect.as(true),
      Effect.catch((error) => statusOf(error) === 404 ? Effect.succeed(false) : Effect.fail(new RepoClone.CloneUnavailable())),
    )

/**
 * What `repo/Clone` needs on this host, over `database` (the app's tables) and `cache` (the immutable cache RepoApi's
 * reads share), or `None` without a Code Storage organization. Index's file list goes through RepoApi's own tree read,
 * so the first visit finds it cached; the App's installation is asked of GitHub as the App, when this deployment has
 * one, and is `false` otherwise.
 */
export const cloneServices = <E, R>(
  database: Layer.Layer<SqlClient.SqlClient, E, R>,
  cache: Layer.Layer<ImmutableCache.ImmutableCache>,
) =>
  Effect.gen(function* () {
    const client = yield* codeStorage
    if (Option.isNone(client)) return Option.none<RepoClone.Services<E, R>>()
    const upstream = yield* Effect.service(RepoUpstream).pipe(Effect.provide(RepoUpstream.layerConfig))
    const budgets = yield* Repos.budgets
    const reads = RepoReads.make({
      codeStorage: client.value,
      database,
      budgets,
      maxTreePaths: yield* RepoReads.maxTreePaths,
      maxRefs: yield* RepoReads.maxRefs,
    })
    const app = yield* GitHubHost.ready(database)
    return Option.some<RepoClone.Services<E, R>>({
      database,
      codeStorage: client.value,
      upstream,
      budgets,
      deadline: yield* RepoClone.deadline,
      index: (owner, name, sha) =>
        reads.files(owner, name, sha).pipe(Effect.provide(cache), Effect.mapError(() => new RepoClone.CloneUnavailable())),
      installed: installedWith(app),
    })
  })
