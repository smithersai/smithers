/**
 * Branch refs over the {@link GitHubClient} in context: read a branch's head,
 * list the branches under a prefix, and create a branch at a commit.
 *
 * A plain operation, not a durable action: the flow step that calls it
 * chooses the token by providing the client. Nothing here moves an existing
 * ref, so nothing here can force one: a branch changes only by a fenced commit
 * (`Commits.createOnBranch`) or a merge.
 *
 * **Writing once.** A branch's name is the only identity it can carry, so a
 * branch a step may need to find again carries the step's key in its name:
 * make it with `GitHub.Once.branch` through `Action.once` from `@smthrs/flow`.
 * Never adopt a branch because its name looks like yours or it points at the
 * commit you meant: someone else's can do both.
 *
 * A branch name is validated against git's ref rules before it becomes a
 * request path, so a hostile name cannot walk the token-bearing request to
 * another endpoint.
 *
 * @since 1.0.0
 */
import { Effect, Option } from "effect";
import { IntegrationError } from "../../../../src/core/IntegrationError.ts";
import { GitHubClient } from "../../../../src/github/GitHubClient.ts";
/**
 * The longest branch name {@link requireBranch} accepts.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const MAX_BRANCH_LENGTH = 200;
/**
 * A branch and the commit it points at.
 *
 * @category models
 * @since 1.0.0
 */
export interface Branch {
    readonly name: string;
    readonly sha: string;
}
/**
 * Whether `name` is a branch name this module sends: 1 to
 * {@link MAX_BRANCH_LENGTH} characters of letters, digits, `.`, `_`, `-` and
 * `/`, in segments that are not empty, do not start with `.` and do not end
 * with `.lock`, with no `..` anywhere: a subset of git's `check-ref-format`.
 *
 * @category predicates
 * @since 1.0.0
 */
export declare const isBranch: (name: unknown) => name is string;
/**
 * `name` when {@link isBranch} holds, else an `invalid-config` failure.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const requireBranch: (name: string) => Effect.Effect<string, IntegrationError>;
/**
 * Branch `name`'s head: `GET /repos/{owner}/{repo}/git/ref/heads/{name}`.
 * `Option.none()` when GitHub answers 404, as it does for a branch that does
 * not exist.
 *
 * @category getters
 * @since 1.0.0
 */
export declare const getBranch: (owner: string, repo: string, name: string) => Effect.Effect<Option.Option<Branch>, IntegrationError, GitHubClient>;
/**
 * The branches whose names start with `prefix`:
 * `GET /repos/{owner}/{repo}/git/matching-refs/heads/{prefix}`, within
 * `maxPages` pages of 100 (default 10). `truncated` is true when pages
 * remained. `prefix` follows the same rules as a branch name, except that it
 * may end in `-` or `/`.
 *
 * @category getters
 * @since 1.0.0
 */
export declare const listBranches: (owner: string, repo: string, prefix: string, options?: {
    readonly maxPages?: number | undefined;
}) => Effect.Effect<{
    readonly items: ReadonlyArray<Branch>;
    readonly truncated: boolean;
}, IntegrationError, GitHubClient>;
/**
 * Creates branch `name` at commit `sha`: `POST /repos/{owner}/{repo}/git/refs`.
 *
 * GitHub answers 422 when the branch exists. A lost answer fails
 * `outcomeUnknown`; see the module notes before writing again.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const createBranch: (owner: string, repo: string, input: {
    readonly name: string;
    readonly sha: string;
}) => Effect.Effect<Branch, IntegrationError, GitHubClient>;
