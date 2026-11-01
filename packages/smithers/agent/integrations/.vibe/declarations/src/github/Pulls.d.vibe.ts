/**
 * Pull request REST operations: read, list, open, close, merge, and review,
 * with the same hidden write marker {@link Issues.withWriteMarker} gives
 * issues and comments.
 *
 * These are plain operations over the {@link GitHubClient} in context, not
 * durable actions: the flow step that calls them chooses the token (a
 * person's user token or an App installation token) by providing the client,
 * and settles its own projection from the result.
 *
 * **Writing once.** Opening a pull request and submitting a review are not
 * idempotent, so a lost answer fails `outcomeUnknown: true`. Mark the body
 * with `Issues.withWriteMarker` and, on an attempt after `outcomeUnknown`,
 * look first: {@link findPullByHead} (GitHub allows one open pull request per
 * head and base) or {@link findReviewByWrite}. A step merges through
 * `GitHub.Once.merge`, which keys the merge commit's message and finds the
 * merge by that key, never by the pull request merely being merged. Closing is
 * idempotent and retries as `retryable`.
 *
 * **Merging is fenced.** {@link mergePull} sends the head SHA the person saw,
 * so GitHub refuses with 409 when the head moved since, and 405 when the pull
 * request is not mergeable (a draft, a conflict, or a required check). Nothing
 * here bypasses branch protection.
 *
 * **Updating is fenced too.** {@link updateBranch} brings a pull request's
 * branch up to date with its base only while the branch's head is still the
 * one the caller saw. A rebase rewrites the branch; a merge only adds to it.
 *
 * Every coordinate is validated before it becomes a request path, as
 * `Repository.repositoryPath` does.
 *
 * @since 1.0.0
 */
import { Effect, Option, Schema } from "effect";
import { IntegrationError } from "../core/IntegrationError.ts";
import { GitHubClient } from "./GitHubClient.ts";
/**
 * One end of a pull request: its branch and the commit it points at.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const PullEnd: Schema.Struct<{
    readonly ref: Schema.String;
    readonly sha: Schema.String;
}>;
/**
 * A pull request's base: its branch and commit, and the repository it merges
 * into with that repository's default branch. `repo` decodes as `null` when
 * GitHub's answer leaves it out.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const PullBase: Schema.Struct<{
    readonly ref: Schema.String;
    readonly sha: Schema.String;
    readonly repo: Schema.withDecodingDefault<Schema.NullOr<Schema.Struct<{
        readonly default_branch: Schema.String;
    }>>, never>;
}>;
/**
 * A pull request as GitHub's REST API returns it, narrowed to the fields
 * Smithers reads. A listing omits the merge and size fields, which then
 * decode as `false`, `null` or `0`.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const PullRequest: Schema.Struct<{
    readonly id: Schema.Number;
    readonly node_id: Schema.String;
    readonly number: Schema.Number;
    readonly title: Schema.String;
    readonly body: Schema.NullOr<Schema.String>;
    readonly state: Schema.Literals<readonly ["open", "closed"]>;
    readonly draft: Schema.withDecodingDefault<Schema.Boolean, never>;
    readonly merged: Schema.withDecodingDefault<Schema.Boolean, never>;
    readonly merged_at: Schema.withDecodingDefault<Schema.NullOr<Schema.String>, never>;
    readonly merge_commit_sha: Schema.withDecodingDefault<Schema.NullOr<Schema.String>, never>;
    readonly merged_by: Schema.withDecodingDefault<Schema.NullOr<Schema.Struct<{
        readonly id: Schema.Number;
        readonly login: Schema.String;
    }>>, never>;
    readonly mergeable_state: Schema.withDecodingDefault<Schema.NullOr<Schema.String>, never>;
    readonly user: Schema.NullOr<Schema.Struct<{
        readonly id: Schema.Number;
        readonly login: Schema.String;
    }>>;
    readonly head: Schema.Struct<{
        readonly ref: Schema.String;
        readonly sha: Schema.String;
    }>;
    readonly base: Schema.Struct<{
        readonly ref: Schema.String;
        readonly sha: Schema.String;
        readonly repo: Schema.withDecodingDefault<Schema.NullOr<Schema.Struct<{
            readonly default_branch: Schema.String;
        }>>, never>;
    }>;
    readonly commits: Schema.withDecodingDefault<Schema.Number, never>;
    readonly additions: Schema.withDecodingDefault<Schema.Number, never>;
    readonly deletions: Schema.withDecodingDefault<Schema.Number, never>;
    readonly changed_files: Schema.withDecodingDefault<Schema.Number, never>;
    readonly created_at: Schema.String;
    readonly updated_at: Schema.String;
    readonly closed_at: Schema.NullOr<Schema.String>;
}>;
/**
 * A decoded {@link PullRequest}.
 *
 * @category models
 * @since 1.0.0
 */
export type PullRequest = typeof PullRequest.Type;
/**
 * A commit on a pull request, narrowed to its SHA, message, author and time.
 * `author` is the GitHub account, `null` when the commit's email maps to none.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const PullCommit: Schema.Struct<{
    readonly sha: Schema.String;
    readonly commit: Schema.Struct<{
        readonly message: Schema.String;
        readonly author: Schema.NullOr<Schema.Struct<{
            readonly name: Schema.String;
            readonly date: Schema.String;
        }>>;
    }>;
    readonly author: Schema.NullOr<Schema.Struct<{
        readonly id: Schema.Number;
        readonly login: Schema.String;
    }>>;
}>;
/**
 * A decoded {@link PullCommit}.
 *
 * @category models
 * @since 1.0.0
 */
export type PullCommit = typeof PullCommit.Type;
/**
 * A pull request review, narrowed to the fields Smithers reads. `commit_id`
 * is the head the review was submitted against.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const Review: Schema.Struct<{
    readonly id: Schema.Number;
    readonly node_id: Schema.String;
    readonly user: Schema.NullOr<Schema.Struct<{
        readonly id: Schema.Number;
        readonly login: Schema.String;
    }>>;
    readonly body: Schema.NullOr<Schema.String>;
    readonly state: Schema.String;
    readonly commit_id: Schema.NullOr<Schema.String>;
    readonly submitted_at: Schema.withDecodingDefault<Schema.NullOr<Schema.String>, never>;
}>;
/**
 * A decoded {@link Review}.
 *
 * @category models
 * @since 1.0.0
 */
export type Review = typeof Review.Type;
/**
 * What a review submits. `COMMENT` leaves findings without a decision;
 * `APPROVE` and `REQUEST_CHANGES` are a person's decisions.
 *
 * @category models
 * @since 1.0.0
 */
export type ReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
/**
 * How {@link mergePull} merges.
 *
 * @category models
 * @since 1.0.0
 */
export type MergeMethod = "squash" | "merge" | "rebase";
/**
 * How {@link updateBranch} brings a pull request's branch up to date with its
 * base: a merge commit on the branch, or a rebase that rewrites it.
 *
 * @category models
 * @since 1.0.0
 */
export type UpdateMethod = "merge" | "rebase";
/**
 * What GitHub answered a merge: the merge commit's SHA, and whether it merged.
 *
 * @category models
 * @since 1.0.0
 */
export interface Merged {
    readonly sha: string;
    readonly merged: boolean;
}
/**
 * Pull request `number`: `GET /repos/{owner}/{repo}/pulls/{number}`, with
 * its merge state and size.
 *
 * @category getters
 * @since 1.0.0
 */
export declare const getPull: (owner: string, repo: string, number: number) => Effect.Effect<PullRequest, IntegrationError, GitHubClient>;
/**
 * The repository's pull requests, most recently updated first:
 * `GET /repos/{owner}/{repo}/pulls?state=…&sort=updated&direction=desc`,
 * within `maxPages` pages of 100 (default 10). `head` narrows to one branch of
 * the repository itself. `truncated` is true when pages remained.
 *
 * @category getters
 * @since 1.0.0
 */
export declare const listPulls: (owner: string, repo: string, options?: {
    readonly state?: "open" | "closed" | "all" | undefined;
    readonly head?: string | undefined;
    readonly maxPages?: number | undefined;
}) => Effect.Effect<{
    readonly items: ReadonlyArray<PullRequest>;
    readonly truncated: boolean;
}, IntegrationError, GitHubClient>;
/**
 * The pull request from branch `head` of the repository itself, open or
 * closed, whose body carries `writeId`'s marker when one is given; the
 * earliest opened wins. `Option.none()` when there is none; a listing that
 * runs out of pages without a match fails `poll-failed` with
 * `incomplete: true`.
 *
 * @category getters
 * @since 1.0.0
 */
export declare const findPullByHead: (owner: string, repo: string, options: {
    readonly head: string;
    readonly writeId?: string | undefined;
}) => Effect.Effect<Option.Option<PullRequest>, IntegrationError, GitHubClient>;
/**
 * Opens a pull request from branch `head` into `base`:
 * `POST /repos/{owner}/{repo}/pulls`. Mark `body` with
 * `Issues.withWriteMarker` so a retry can find it.
 *
 * GitHub answers 422 when the branch has no commits beyond `base`, when an
 * open pull request for the same head and base exists, or when it refuses a
 * draft. A lost answer fails `outcomeUnknown`; see the module notes before
 * writing again.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const createPull: (owner: string, repo: string, input: {
    readonly head: string;
    readonly base: string;
    readonly title: string;
    readonly body: string;
    readonly draft?: boolean | undefined;
}) => Effect.Effect<PullRequest, IntegrationError, GitHubClient>;
/**
 * Closes pull request `number` without merging it:
 * `PATCH /repos/{owner}/{repo}/pulls/{number}` with `state: closed`. Closing
 * a closed pull request changes nothing, so a lost answer fails `retryable`.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const closePull: (owner: string, repo: string, number: number) => Effect.Effect<PullRequest, IntegrationError, GitHubClient>;
/**
 * Moves pull request `number` onto base branch `base`:
 * `PATCH /repos/{owner}/{repo}/pulls/{number}` with `base`. A stacked pull
 * request retargets onto the default branch this way once the one below it
 * merged. Setting the base it has changes nothing, so a lost answer fails
 * `retryable`. GitHub answers 422 when `base` doesn't exist or the pull
 * request is closed.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const setBase: (owner: string, repo: string, number: number, base: string) => Effect.Effect<PullRequest, IntegrationError, GitHubClient>;
/**
 * Marks draft pull request `nodeId` (its `node_id`) ready for review, through
 * GraphQL `markPullRequestReadyForReview`: `POST /graphql`. REST can't take a
 * pull request out of draft. Marking a ready pull request ready changes
 * nothing, so a lost answer fails `retryable`; a GraphQL error fails
 * `status: 422`, not retryable.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const markReady: (owner: string, repo: string, nodeId: string) => Effect.Effect<void, IntegrationError, GitHubClient>;
/**
 * Brings pull request `pullNodeId`'s branch (its `node_id`) up to date with
 * its base, as the token's account, through GraphQL `updatePullRequestBranch`:
 * `POST /graphql`. Answers the branch's new head SHA.
 *
 * GitHub fences the update by the head: it refuses when the branch's head is
 * no longer `expectedHeadOid`, so a commit a person pushed since is never
 * lost. `merge` adds a merge commit of the base to the branch. `rebase`
 * rewrites the branch: its commits are made again on the base with new SHAs,
 * and anyone holding the old head must fetch the new one.
 *
 * Any GraphQL error, a stale head among them, fails `status: 422` with the
 * first error's `type` in the details, not retryable. A lost answer fails
 * `outcomeUnknown`: read the pull request's head before updating again.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const updateBranch: (owner: string, repo: string, input: {
    readonly pullNodeId: string;
    readonly expectedHeadOid: string;
    readonly method: UpdateMethod;
}) => Effect.Effect<{
    readonly headSha: string;
}, IntegrationError, GitHubClient>;
/**
 * Merges pull request `number` at exactly `sha`, its head as the person saw
 * it: `PUT /repos/{owner}/{repo}/pulls/{number}/merge`. Squash is what most
 * repositories allow; `commitTitle` and `commitMessage` name the commit.
 *
 * GitHub answers 409 when the head is no longer `sha`, 405 when the pull
 * request is not mergeable, and 422 for a method the repository disallows. A
 * lost answer fails `outcomeUnknown`. A step that may run again merges through
 * `GitHub.Once.merge`, which puts its key in the commit message and finds the
 * merge by it.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const mergePull: (owner: string, repo: string, number: number, input: {
    readonly sha: string;
    readonly method: MergeMethod;
    readonly commitTitle?: string | undefined;
    readonly commitMessage?: string | undefined;
}) => Effect.Effect<Merged, IntegrationError, GitHubClient>;
/**
 * The commits on pull request `number`, oldest first:
 * `GET /repos/{owner}/{repo}/pulls/{number}/commits`, within `maxPages` pages
 * of 100 (default 3; GitHub lists at most 250).
 *
 * @category getters
 * @since 1.0.0
 */
export declare const listCommits: (owner: string, repo: string, number: number, options?: {
    readonly maxPages?: number | undefined;
}) => Effect.Effect<{
    readonly items: ReadonlyArray<PullCommit>;
    readonly truncated: boolean;
}, IntegrationError, GitHubClient>;
/**
 * The reviews on pull request `number`, oldest first:
 * `GET /repos/{owner}/{repo}/pulls/{number}/reviews`, within `maxPages` pages
 * of 100 (default 3).
 *
 * @category getters
 * @since 1.0.0
 */
export declare const listReviews: (owner: string, repo: string, number: number, options?: {
    readonly maxPages?: number | undefined;
}) => Effect.Effect<{
    readonly items: ReadonlyArray<Review>;
    readonly truncated: boolean;
}, IntegrationError, GitHubClient>;
/**
 * Submits a review on pull request `number` against head `commitId`:
 * `POST /repos/{owner}/{repo}/pulls/{number}/reviews`. Mark `body` with
 * `Issues.withWriteMarker` so a retry can find it.
 *
 * `COMMENT` needs a body. A lost answer fails `outcomeUnknown`; look with
 * {@link findReviewByWrite} before submitting again.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const createReview: (owner: string, repo: string, number: number, input: {
    readonly commitId: string;
    readonly event: ReviewEvent;
    readonly body: string;
}) => Effect.Effect<Review, IntegrationError, GitHubClient>;
/**
 * The review on pull request `number` whose body carries `writeId`'s marker;
 * the earliest submitted wins. `Option.none()` when there is none; a listing
 * that runs out of pages without a match fails `poll-failed` with
 * `incomplete: true`.
 *
 * @category getters
 * @since 1.0.0
 */
export declare const findReviewByWrite: (owner: string, repo: string, number: number, options: {
    readonly writeId: string;
}) => Effect.Effect<Option.Option<Review>, IntegrationError, GitHubClient>;
