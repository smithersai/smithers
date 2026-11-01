/**
 * Commits over the {@link GitHubClient} in context: append one commit to a
 * branch with GraphQL `createCommitOnBranch`, read a commit, and compare two.
 *
 * A plain operation, not a durable action: the flow step that calls it
 * chooses the token by providing the client.
 *
 * **Fenced, never forced.** {@link createOnBranch} sends the head it expects
 * the branch to have (`expectedHeadOid`), so GitHub refuses the commit when
 * the branch moved since, failing with `status: 409` and `stale: true`. GitHub
 * signs the commit and attributes it to the token's account. The whole files
 * it adds replace what the branch had at those paths, so build them from the
 * branch's own head.
 *
 * **Writing once.** A lost answer fails `outcomeUnknown`. Never adopt a head
 * because its parent and message look like yours: another attempt's or a
 * person's commit can match both. Write through `GitHub.Once.commitOnBranch`
 * and `Action.once` from `@smthrs/flow`, which put the step's key in a
 * `Smithers-Write` trailer and adopt only the commit that carries it.
 *
 * @since 1.0.0
 */
import { Effect, Schema } from "effect";
import { IntegrationError } from "../core/IntegrationError.ts";
import { GitHubClient } from "./GitHubClient.ts";
/**
 * A file a commit adds or replaces: its path and its whole content, base64.
 *
 * @category models
 * @since 1.0.0
 */
export interface FileAddition {
    readonly path: string;
    readonly contents: string;
}
/**
 * A commit as `GET /repos/{owner}/{repo}/git/commits/{sha}` returns it,
 * narrowed to its tree, parents and message.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const GitCommit: Schema.Struct<{
    readonly sha: Schema.String;
    readonly message: Schema.String;
    readonly tree: Schema.Struct<{
        readonly sha: Schema.String;
    }>;
    readonly parents: Schema.$Array<Schema.Struct<{
        readonly sha: Schema.String;
    }>>;
}>;
/**
 * A decoded {@link GitCommit}.
 *
 * @category models
 * @since 1.0.0
 */
export type GitCommit = typeof GitCommit.Type;
/**
 * One changed file of a comparison. `patch` is absent for a binary file and
 * for one GitHub found too large to show.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const ChangedFile: Schema.Struct<{
    readonly filename: Schema.String;
    readonly status: Schema.String;
    readonly additions: Schema.Number;
    readonly deletions: Schema.Number;
    readonly patch: Schema.optionalKey<Schema.String>;
    readonly previous_filename: Schema.optionalKey<Schema.String>;
}>;
/**
 * A decoded {@link ChangedFile}.
 *
 * @category models
 * @since 1.0.0
 */
export type ChangedFile = typeof ChangedFile.Type;
/**
 * The most files GitHub lists in one comparison.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const MAX_COMPARE_FILES = 300;
/**
 * One commit of a comparison: its SHA, its message's first line, the GitHub
 * login of its author (`null` when GitHub links the commit to no account),
 * and when it was authored (`null` when GitHub names no time).
 *
 * @category models
 * @since 1.0.0
 */
export interface ComparedCommit {
    readonly sha: string;
    readonly headline: string;
    readonly authorLogin: string | null;
    readonly authoredAt: string | null;
}
/**
 * Two commits compared: how far apart they are, the files that differ, and
 * the commits `head` has that `base` lacks, oldest first.
 *
 * - `truncated` when GitHub listed {@link MAX_COMPARE_FILES} files and may
 *   hold more.
 * - `commitsTruncated` when GitHub counted more commits than it listed: a
 *   comparison lists at most 250.
 *
 * @category models
 * @since 1.0.0
 */
export interface Comparison {
    readonly aheadBy: number;
    readonly behindBy: number;
    readonly files: ReadonlyArray<ChangedFile>;
    readonly truncated: boolean;
    readonly commits: ReadonlyArray<ComparedCommit>;
    readonly commitsTruncated: boolean;
}
/**
 * Appends one commit to branch `branch` whose head is `expectedHeadOid`, as
 * the token's account, through GraphQL `createCommitOnBranch`: `POST /graphql`.
 * Answers the new commit's SHA.
 *
 * `headline` is the message's first line and `body` the rest. Each addition
 * is a whole file, base64; each deletion a path. At least one change, at most
 * 1,000.
 *
 * Fails `status: 409, stale: true` when the branch's head is not
 * `expectedHeadOid`, and `status: 422` for any other GraphQL error, neither
 * retryable. A lost answer fails `outcomeUnknown`; see the module notes.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const createOnBranch: (owner: string, repo: string, input: {
    readonly branch: string;
    readonly expectedHeadOid: string;
    readonly headline: string;
    readonly body?: string | undefined;
    readonly additions: ReadonlyArray<FileAddition>;
    readonly deletions: ReadonlyArray<string>;
}) => Effect.Effect<string, IntegrationError, GitHubClient>;
/**
 * What {@link mergeInto} did: made merge commit `sha` on the branch, or found
 * the branch already held `head` (`upToDate`).
 *
 * @category models
 * @since 1.0.0
 */
export type MergedInto = {
    readonly kind: "merged";
    readonly sha: string;
} | {
    readonly kind: "upToDate";
};
/**
 * Merges `head` (a branch or a commit SHA) into branch `base`, as the token's
 * account: `POST /repos/{owner}/{repo}/merges`. A stacked branch takes in what
 * the branch below it merged this way, never by a rebase, so nothing is
 * forced and a person's pushed commit survives.
 *
 * Answers `merged` with the merge commit, or `upToDate` when `base` already
 * holds `head` (GitHub's 204). Merging again what was merged is `upToDate`,
 * so a lost answer fails `retryable`. GitHub answers 409 for a conflict and
 * 404 when `base` or `head` doesn't exist: neither retryable.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const mergeInto: (owner: string, repo: string, input: {
    readonly base: string;
    readonly head: string;
    readonly commitMessage?: string | undefined;
}) => Effect.Effect<MergedInto, IntegrationError, GitHubClient>;
/**
 * Commit `sha`'s tree, parents and message:
 * `GET /repos/{owner}/{repo}/git/commits/{sha}`.
 *
 * @category getters
 * @since 1.0.0
 */
export declare const getCommit: (owner: string, repo: string, sha: string) => Effect.Effect<GitCommit, IntegrationError, GitHubClient>;
/**
 * Compares commit `base` with commit `head`:
 * `GET /repos/{owner}/{repo}/compare/{base}...{head}`. Two SHAs never change
 * what they compare, so a caller may keep the answer forever.
 *
 * Answers the commits `head` has that `base` lacks in GitHub's order, oldest
 * first, each with its headline, author login and author time. GitHub lists
 * at most 250; `commitsTruncated` says it counted more.
 *
 * @category getters
 * @since 1.0.0
 */
export declare const compare: (owner: string, repo: string, base: string, head: string) => Effect.Effect<Comparison, IntegrationError, GitHubClient>;
