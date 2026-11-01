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
import { Effect, Option } from "effect";
import { IntegrationError } from "../core/IntegrationError.ts";
import { GitHubClient } from "./GitHubClient.ts";
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
    readonly permission: string;
    readonly roleName: string;
    readonly userId?: number;
}
/**
 * What a login may be: `Repository.OWNER_PATTERN`'s account name, optionally
 * followed by `[bot]`, which GitHub appends to an App's bot account.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const LOGIN_PATTERN: RegExp;
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
export declare const permission: (owner: string, repo: string, login: string) => Effect.Effect<Option.Option<Permission>, IntegrationError, GitHubClient>;
