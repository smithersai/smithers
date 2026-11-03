/**
 * Repository collaborator permissions over the {@link GitHubClient} in
 * context.
 *
 * A plain operation, not a durable action: the flow step that calls it
 * chooses the token by providing the client. The login is validated against
 * GitHub's account naming rules before it becomes a request path.
 *
 * @since 1.0.0
 */

import { Effect, Option, Schema } from "effect"
import { IntegrationError } from "../core/IntegrationError.ts"
import { GitHubClient } from "./GitHubClient.ts"
import { requireRepositoryPath } from "./Repository.ts"

/**
 * A person's or App's access to a repository.
 *
 * `permission` is GitHub's legacy base role (`admin`, `write`, `read` or
 * `none`); `roleName` is the role GitHub names, which may be a custom one
 * such as `maintain`, `triage` or an organization's own. `userId` is the
 * numeric id of the account GitHub answered for, when it names one: a login
 * can change hands after a rename, an id never does.
 *
 * @category models
 * @since 1.0.0
 */
export interface Permission {
  readonly permission: string
  readonly roleName: string
  readonly userId?: number
}

/**
 * What a login may be: `Repository.OWNER_PATTERN`'s account name, optionally
 * followed by `[bot]`, which GitHub appends to an App's bot account.
 *
 * @category constants
 * @since 1.0.0
 */
export const LOGIN_PATTERN =
  /^(?=.{1,39}(?:\[bot\])?$)[A-Za-z0-9][A-Za-z0-9-]*(?:_[A-Za-z0-9][A-Za-z0-9-]*)?(?:\[bot\])?$/

const PermissionAnswer = Schema.Struct({
  permission: Schema.String,
  role_name: Schema.String,
  user: Schema.optional(Schema.NullOr(Schema.Struct({ id: Schema.Number })))
})

const requireLogin = (login: string): Effect.Effect<string, IntegrationError> =>
  typeof login === "string" && LOGIN_PATTERN.test(login)
    ? Effect.succeed(encodeURIComponent(login))
    : Effect.fail(
      new IntegrationError("invalid-config", "A GitHub login is not a valid account name.", {
        field: "login",
        login: typeof login === "string" ? login.slice(0, 64) : typeof login,
        retryable: false
      })
    )

/**
 * `login`'s permission on the repository:
 * `GET /repos/{owner}/{repo}/collaborators/{login}/permission`. Answers
 * `Option.none()` when GitHub answers 404, as it does for an account that
 * does not exist or a repository the token cannot see.
 *
 * `login` matches {@link LOGIN_PATTERN}, so an App's bot account such as
 * `dependabot[bot]` is accepted.
 *
 * @category getters
 * @since 1.0.0
 */
export const permission = (
  owner: string,
  repo: string,
  login: string
): Effect.Effect<Option.Option<Permission>, IntegrationError, GitHubClient> =>
  Effect.gen(function*() {
    const client = yield* GitHubClient
    const repository = yield* requireRepositoryPath(owner, repo)
    const account = yield* requireLogin(login)
    return yield* client.request(
      "GET",
      `/repos/${repository}/collaborators/${account}/permission`,
      undefined,
      { schema: PermissionAnswer }
    ).pipe(
      Effect.map((answer) =>
        Option.some<Permission>({
          permission: answer.permission,
          roleName: answer.role_name,
          ...(answer.user === undefined || answer.user === null ? {} : { userId: answer.user.id })
        })
      ),
      Effect.catchIf(
        (error) => error.details?.["status"] === 404,
        () => Effect.succeed(Option.none<Permission>())
      )
    )
  }).pipe(
    Effect.withSpan("GitHub.Collaborators.permission", { attributes: { "github.owner": owner, "github.repo": repo } })
  )
