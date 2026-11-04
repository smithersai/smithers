/**
 * GitHub writes a durable step makes once and finds again by its key, for
 * `Action.once` from `@smthrs/flow`.
 *
 * A step that creates a branch, a commit, a pull request, an issue, a
 * comment or a review can lose GitHub's answer and run again. Each value here
 * is an `Action.Keyed`: `perform(key)` writes the step's key onto the object
 * in the request that creates it, and `find(key)` finds the object by that
 * key alone, never by its title, message, name, parent or age:
 *
 * | Object | Where the key goes | How it is found |
 * | --- | --- | --- |
 * | branch | the name's last `-` segment, its first {@link BRANCH_KEY_LENGTH} hex | the branches under the name's prefix |
 * | commit | a `Smithers-Write: <key>` trailer | the branch head, when it moved past the expected head |
 * | pull request, issue, comment, review | the body's hidden write marker | GitHub's listing, whole |
 * | merge | a `Smithers-Write: <key>` trailer in the merge commit's message | the pull request and its merge commit |
 * | merge into a branch | a `Smithers-Write: <key>` trailer in the merge commit's message | the branch head |
 *
 * A step writes with them like this; the key comes from the dispatch, so the
 * step never names one:
 *
 * ```ts
 * const sha = yield* Action.once("commit", GitHub.Once.commitOnBranch(owner, repo, change))
 * ```
 *
 * A lookup that runs out of pages fails rather than answer none, so a long
 * thread never reads as "not written". A commit lookup fails `status: 409,
 * stale: true` when someone else moved the branch.
 *
 * @since 1.0.0
 */
import { Action } from "@smthrs/flow";
import { Effect } from "effect";
import { IntegrationError } from "../../../../src/core/IntegrationError.ts";
import * as Commits from "./Commits.vibe";
import type { GitHubClient } from "../../../../src/github/GitHubClient.ts";
import * as Issues from "./Issues.vibe";
import * as Pulls from "../../../../src/github/Pulls.ts";
import * as Refs from "../../../../src/github/Refs.ts";
/**
 * The commit trailer that carries a write's key.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const TRAILER = "Smithers-Write";
/**
 * `message` with a blank line and the `Smithers-Write: <key>` trailer after
 * it.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const withTrailer: (message: string, key: string) => string;
/**
 * The key a commit message's last `Smithers-Write` trailer carries, or
 * `undefined`.
 *
 * @category getters
 * @since 1.0.0
 */
export declare const trailerKeyOf: (message: string) => string | undefined;
/**
 * How many hex digits of a write's key a branch name carries.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const BRANCH_KEY_LENGTH = 12;
/**
 * The branch name {@link branch} makes: `prefix`, `label` and a `-`, then the
 * key's first {@link BRANCH_KEY_LENGTH} hex digits.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const branchName: (prefix: string, label: string, key: string) => string;
/**
 * A branch whose name carries the write's key, made at the commit `at`
 * answers.
 *
 * - `prefix` is the part of the name that stays the same for every attempt,
 *   such as `smithers/t12-`; the lookup lists the branches under it.
 * - `label` is for people, such as a slug of a title. It may differ between
 *   runs of the step; the lookup ignores it.
 * - `at` is read only when the branch is made, so a step that runs again
 *   after the default branch moved finds the branch it made, at the commit it
 *   was made at, instead of making a second.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const branch: <E = never, R = never>(owner: string, repo: string, input: {
    readonly prefix: string;
    readonly label: string;
    readonly at: Effect.Effect<string, E, R>;
}) => Action.Keyed<Refs.Branch, IntegrationError | E, GitHubClient | R>;
/**
 * One commit appended to `branch`, fenced by `expectedHeadOid`, whose message
 * ends with the write's `Smithers-Write` trailer. Answers its SHA.
 *
 * The lookup reads the branch: at `expectedHeadOid` nothing was made; a head
 * carrying the key's trailer is the commit; any other head means someone else
 * moved the branch, which fails `status: 409, stale: true`. The fence keeps
 * GitHub from appending a second commit.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const commitOnBranch: (owner: string, repo: string, input: {
    readonly branch: string;
    readonly expectedHeadOid: string;
    readonly headline: string;
    readonly body?: string | undefined;
    readonly additions: ReadonlyArray<Commits.FileAddition>;
    readonly deletions: ReadonlyArray<string>;
}) => Action.Keyed<string, IntegrationError, GitHubClient>;
/**
 * A pull request from `head` into `base` whose body carries the write's
 * marker. The lookup reads every pull request from `head`, open or closed.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const pull: (owner: string, repo: string, input: {
    readonly head: string;
    readonly base: string;
    readonly title: string;
    readonly body: string;
    readonly draft?: boolean | undefined;
}) => Action.Keyed<Pulls.PullRequest, IntegrationError, GitHubClient>;
/**
 * An issue whose body carries the write's marker. The lookup reads the issues
 * updated since `since`, which must be a time before the write's first
 * attempt that every attempt agrees on, such as when the write was admitted.
 * With `author`, the acting account's login, only issues it wrote match, so a
 * marker someone copied into an issue of theirs is never the match.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const issue: (owner: string, repo: string, input: {
    readonly title: string;
    readonly body: string;
    readonly since: string;
    readonly author?: string | undefined;
}) => Action.Keyed<Issues.Issue, IntegrationError, GitHubClient>;
/**
 * A comment on issue or pull request `number` whose body carries the write's
 * marker. The lookup reads the whole thread. With `author`, only comments that
 * login wrote match.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const comment: (owner: string, repo: string, number: number, body: string, options?: {
    readonly author?: string | undefined;
}) => Action.Keyed<Issues.IssueComment, IntegrationError, GitHubClient>;
/**
 * A review on pull request `number` against head `commitId` whose body
 * carries the write's marker. The lookup reads every review.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const review: (owner: string, repo: string, number: number, input: {
    readonly commitId: string;
    readonly event: Pulls.ReviewEvent;
    readonly body: string;
}) => Action.Keyed<Pulls.Review, IntegrationError, GitHubClient>;
/**
 * A merge of pull request `number` at head `sha`, as the person whose token
 * makes it, its commit message ending with the write's `Smithers-Write`
 * trailer. Answers GitHub's {@link Pulls.Merged}.
 *
 * The merge is fenced by the head: GitHub answers 409 when the head is no
 * longer `sha`. The lookup reads the pull request. Unmerged, nothing was made.
 * Merged, the merge commit's trailer must carry the key; a merge without it is
 * someone else's, and the lookup answers none. A rebase writes no message of
 * its own, so a rebase merge carries no key and its lookup always answers
 * none: a rebase whose answer was lost reads afterwards as a pull request
 * someone merged, never as this write's merge.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const merge: (owner: string, repo: string, number: number, input: {
    readonly sha: string;
    readonly method: Pulls.MergeMethod;
    readonly commitTitle?: string | undefined;
    readonly commitMessage?: string | undefined;
}) => Action.Keyed<Pulls.Merged, IntegrationError, GitHubClient>;
/**
 * A merge of `head` (a branch or a commit SHA) into branch `base`, its commit
 * message ending with the write's `Smithers-Write` trailer, through
 * `Commits.mergeInto`. Answers its {@link Commits.MergedInto} unchanged:
 * `merged` with the merge commit, or `upToDate` when `base` already held
 * `head`.
 *
 * The lookup reads `base`'s head. A head whose message carries the key's
 * trailer is this write's merge; any other head, or no branch, answers none,
 * so someone else's commit is never adopted. A commit pushed on top of the
 * merge hides it: the lookup answers none, and merging again answers
 * `upToDate`, since `base` already holds `head`.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const mergeInto: (owner: string, repo: string, input: {
    readonly base: string;
    readonly head: string;
    readonly commitMessage?: string | undefined;
}) => Action.Keyed<Commits.MergedInto, IntegrationError, GitHubClient>;
