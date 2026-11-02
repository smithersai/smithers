/**
 * Commit statuses over the {@link GitHubClient} in context: report one
 * check's state on one commit, write-only.
 *
 * A plain operation, not a durable action: the flow step that calls it
 * chooses the token by providing the client. An App's installation token
 * needs the `statuses: write` permission.
 *
 * **Safe to repeat.** A status is a fact about a commit: GitHub keeps every
 * one it is sent and shows the latest per context. Sending the same state
 * again changes nothing anyone reads, so {@link create} asks the client to
 * retry a write whose answer was lost (`retryUnsafeWrites`) while retaining
 * `outcomeUnknown` in the failure report.
 *
 * **Per commit.** A status names the exact SHA it describes, never a branch:
 * a newer head starts with no statuses, so a result for an older head can't
 * stand in for it. Branch protection that requires a context waits until that
 * context reports `success` on the head.
 *
 * @since 1.0.0
 */
import { Effect, Schema } from "effect";
import { IntegrationError } from "../../../../src/core/IntegrationError.ts";
import { GitHubClient } from "../../../../src/github/GitHubClient.ts";
/**
 * The states GitHub takes: running (`pending`), passed (`success`), failed
 * (`failure`), or could not run (`error`).
 *
 * @category constants
 * @since 1.0.0
 */
export declare const STATES: readonly ["pending", "success", "failure", "error"];
/**
 * One of {@link STATES}.
 *
 * @category models
 * @since 1.0.0
 */
export type State = (typeof STATES)[number];
/**
 * The longest description GitHub stores; {@link create} cuts a longer one to
 * fit rather than have GitHub refuse it.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const MAX_DESCRIPTION = 140;
/**
 * What a context may be: 1 to 255 printable characters, such as
 * `smithers/lint`. It names the check across commits, and branch protection
 * requires it by this name.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const CONTEXT_PATTERN: RegExp;
/**
 * What to report: the state, the context it is for, and optionally one line
 * and a link a person follows to the run.
 *
 * @category models
 * @since 1.0.0
 */
export interface Input {
    readonly state: State;
    readonly context: string;
    readonly description?: string | undefined;
    /** An absolute `https:` URL; GitHub links the status to it. */
    readonly targetUrl?: string | undefined;
}
/**
 * A status as `POST /repos/{owner}/{repo}/statuses/{sha}` answers it.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const Status: Schema.Struct<{
    readonly id: Schema.Number;
    readonly state: Schema.Literals<readonly ["pending", "success", "failure", "error"]>;
    readonly context: Schema.String;
    readonly description: Schema.NullOr<Schema.String>;
    readonly target_url: Schema.NullOr<Schema.String>;
    readonly created_at: Schema.String;
}>;
/**
 * A decoded {@link Status}.
 *
 * @category models
 * @since 1.0.0
 */
export type Status = typeof Status.Type;
/**
 * Reports `input` on commit `sha`:
 * `POST /repos/{owner}/{repo}/statuses/{sha}`. GitHub's `422` (a commit it
 * doesn't have, or a commit with too many statuses) and `403` or `404` (a
 * token without `statuses: write`, or a repository it can't see) fail with
 * the client's classification, never retried.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const create: (owner: string, repo: string, sha: string, input: Input) => Effect.Effect<Status, IntegrationError, GitHubClient>;
