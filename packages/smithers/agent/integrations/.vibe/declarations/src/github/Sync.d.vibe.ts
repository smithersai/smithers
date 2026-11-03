/**
 * A repository's issues, pull requests and issue comments as source records.
 *
 * The adapter walks two listings of one repository, in order, on every sync:
 * `GET /repos/{owner}/{repo}/issues?state=all&sort=updated&direction=asc`,
 * which returns issues and pull requests alike, and
 * `GET /repos/{owner}/{repo}/issues/comments?sort=updated&direction=asc`,
 * which returns the conversation comments on both. One `changes` call fetches
 * one page, so the sync driver commits each page with its cursor.
 *
 * **Paging by change time.** A page-numbered walk of a list sorted by update
 * time skips an item whenever an earlier item is edited mid-walk and moves to
 * the end. The cursor therefore records the latest change time a page
 * contained and asks the next page for everything `since` one second before
 * it, so the page boundary's second is read twice (the store drops the
 * duplicates) and an item edited during the walk is met again further on. Only
 * a full page whose items all fall inside that one second advances by page
 * number instead. The cursor is JSON the adapter writes and validates; a
 * corrupt one fails rather than restarting the listing.
 *
 * **Pull requests** come back from the issues listing with a `pull_request`
 * member and are recorded with kind `pull-request`; issues are `issue`, and
 * comments on either are `issue-comment` whose parent and thread are the
 * issue's record. External ids carry the numeric repository id, which survives
 * renames: `repo:<id>:issue:<number>` and `repo:<id>:comment:<id>`.
 *
 * **Access.** A public repository's records are `public`; a private or
 * internal one's are `container`-scoped to the repository id. Either way the
 * thread container is the repository id, which is what a grant names.
 *
 * **Deletions are not visible here.** GitHub's list endpoints omit deleted
 * issues and comments rather than reporting them, so an incremental sync
 * never learns of a deletion. A `fullListing` adapter starts a fresh full walk
 * that reports `reset`, after which the driver tombstones every record of the
 * repository the walk did not contain; run one periodically, or turn the
 * `issues.deleted` and `issue_comment.deleted` webhooks into
 * `SourceRecord.tombstone`s. A transferred issue leaves this repository's
 * listing the same way.
 *
 * A rate limit or a transient read failure fails the run, `retryable` and
 * with the server's `retryAfterMillis`: run the sync as a durable step whose
 * retry policy repeats it (`Core.ActionFailure.retryPolicy`), and the repeat
 * resumes from the committed cursor. The client never repeats a request.
 *
 * @since 1.0.0
 */
import type { SyncAdapter } from "../core/Sync.vibe";
import { type GitHubClient } from "../../../../src/github/GitHubClient.ts";
/**
 * The provider name on every record.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const PROVIDER = "github";
/**
 * What the adapter needs.
 *
 * @category models
 * @since 1.0.0
 */
export interface Options {
    /** The connection the records belong to. */
    readonly connectionId: string;
    readonly owner: string;
    readonly repo: string;
    readonly client: GitHubClient;
    /** The sync stream name. Defaults to `owner/repo`. */
    readonly stream?: string | undefined;
    /** Items per page, 1 to 100. Defaults to 100. */
    readonly perPage?: number | undefined;
    /**
     * Start a fresh full listing, reported as `reset`, whenever the stored
     * cursor is not already inside one. Used to discover deletions.
     */
    readonly fullListing?: boolean | undefined;
}
/**
 * The external id of an issue or pull request.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const issueId: (repositoryId: number, issueNumber: number) => string;
/**
 * The external id of an issue comment.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const commentId: (repositoryId: number, id: number) => string;
/**
 * Builds the sync adapter for one repository.
 *
 * Throws `invalid-config` for an owner or repository name GitHub could not
 * have issued, or a page size outside 1 to 100, before any request is made.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const make: (options: Options) => SyncAdapter;
