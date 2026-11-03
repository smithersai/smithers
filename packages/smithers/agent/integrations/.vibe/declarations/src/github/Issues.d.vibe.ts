/**
 * Issue and issue-comment REST operations, and the hidden write marker that
 * lets a step adopt its own earlier write.
 *
 * These are plain operations over the {@link GitHubClient} in context, not
 * durable actions: the flow step that calls them chooses the token (a
 * person's user token or an App installation token) by providing the client,
 * and settles its own projection from the result.
 *
 * **Writing once.** A POST whose answer is lost (a 5xx, a dropped connection,
 * a timeout) fails with `outcomeUnknown: true`: GitHub may have created the
 * issue or comment. Repeating the POST risks a second one, so every created
 * issue and comment carries a hidden `<!-- smithers:write=<id> -->` marker
 * ({@link withWriteMarker}), where the id is the step's write id. A step
 * writes like this:
 *
 * 1. On its first attempt, POST once with the marked body.
 * 2. On an attempt after `outcomeUnknown`, look first:
 *    {@link findIssueByWrite} or {@link findCommentByWrite}, with `since` a
 *    little before the first attempt started. Adopt what it finds.
 * 3. Only when nothing carries the marker, POST again.
 *
 * A write id should be unguessable and come from the step that writes, such
 * as `Action.effectKey` from `@smthrs/flow`; `GitHub.Once` does all three
 * steps for you through `Action.once`. The finders return the
 * earliest-created match, so a copy someone posts after seeing the marker
 * never wins over the original. They read at most {@link RECONCILE_PAGES}
 * pages, and a search that runs out of pages without a match fails
 * (`poll-failed`, `incomplete: true`) rather than answer none: none would let
 * the caller write a second time.
 *
 * **Labels.** {@link addLabels}, {@link removeLabel} and {@link createLabel}
 * are idempotent at GitHub: adding a label the issue has, removing one it
 * lacks, or creating one the repository has changes nothing. So they classify
 * a 5xx or a dropped connection as `retryable` while retaining `outcomeUnknown`, and a
 * step's retry policy repeats them without looking first.
 *
 * Every coordinate is validated before it becomes a request path, as
 * `Repository.repositoryPath` does, so a hostile owner, repository, number or
 * label name cannot walk the token-bearing request to another endpoint.
 *
 * @since 1.0.0
 */
import { Effect, Option, Schema } from "effect";
import { IntegrationError } from "../../../../src/core/IntegrationError.ts";
import { GitHubClient } from "../../../../src/github/GitHubClient.ts";
/**
 * The account on an issue or comment. GitHub sends `null` for a deleted
 * account.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const IssueUser: Schema.NullOr<Schema.Struct<{
    readonly id: Schema.Number;
    readonly login: Schema.String;
}>>;
/**
 * A label on an issue, narrowed to its name. GitHub's other label fields are
 * dropped.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const IssueLabel: Schema.Struct<{
    readonly name: Schema.String;
}>;
/**
 * A decoded {@link IssueLabel}.
 *
 * @category models
 * @since 1.0.0
 */
export type IssueLabel = typeof IssueLabel.Type;
/**
 * An issue as GitHub's REST API returns it, narrowed to the fields Smithers
 * reads. GitHub's other fields are dropped. `pull_request` is present when the
 * issue is a pull request. A missing `state_reason` decodes as `null` and
 * missing `labels` as none.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const Issue: Schema.Struct<{
    readonly id: Schema.Number;
    readonly node_id: Schema.String;
    readonly number: Schema.Number;
    readonly title: Schema.String;
    readonly body: Schema.NullOr<Schema.String>;
    readonly state: Schema.Literals<readonly ["open", "closed"]>;
    readonly state_reason: Schema.withDecodingDefault<Schema.NullOr<Schema.String>, never>;
    readonly user: Schema.NullOr<Schema.Struct<{
        readonly id: Schema.Number;
        readonly login: Schema.String;
    }>>;
    readonly labels: Schema.withDecodingDefault<Schema.$Array<Schema.Struct<{
        readonly name: Schema.String;
    }>>, never>;
    readonly comments: Schema.Number;
    readonly created_at: Schema.String;
    readonly updated_at: Schema.String;
    readonly closed_at: Schema.NullOr<Schema.String>;
    readonly pull_request: Schema.optionalKey<Schema.Unknown>;
}>;
/**
 * A decoded {@link Issue}.
 *
 * @category models
 * @since 1.0.0
 */
export type Issue = typeof Issue.Type;
/**
 * An issue comment as GitHub's REST API returns it, narrowed to the fields
 * Smithers reads.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const IssueComment: Schema.Struct<{
    readonly id: Schema.Number;
    readonly node_id: Schema.String;
    readonly body: Schema.NullOr<Schema.String>;
    readonly user: Schema.NullOr<Schema.Struct<{
        readonly id: Schema.Number;
        readonly login: Schema.String;
    }>>;
    readonly created_at: Schema.String;
    readonly updated_at: Schema.String;
    readonly issue_url: Schema.String;
}>;
/**
 * A decoded {@link IssueComment}.
 *
 * @category models
 * @since 1.0.0
 */
export type IssueComment = typeof IssueComment.Type;
/**
 * What a write id may be: 1 to 100 letters, digits and hyphens, such as a
 * UUID.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const WRITE_ID_PATTERN: RegExp;
/**
 * The hidden marker for `writeId`: `<!-- smithers:write=<id> -->`, which
 * GitHub renders as nothing.
 *
 * Throws an `IntegrationError` `invalid-config` when `writeId` is not 1 to 100
 * letters, digits and hyphens.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const writeMarker: (writeId: string) => string;
/**
 * `body`, then a blank line and {@link writeMarker}. An empty body is the
 * marker alone.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const withWriteMarker: (body: string, writeId: string) => string;
/**
 * The write id the body's marker names, or `undefined`. Whitespace around the
 * marker and inside its delimiters is tolerated; with several markers, the
 * last one wins.
 *
 * @category getters
 * @since 1.0.0
 */
export declare const writeIdOf: (body: string | null | undefined) => string | undefined;
/**
 * `body` with every write marker, and the blank line before each, removed, for
 * display. `withoutWriteMarker(withWriteMarker(body, id))` is `body`.
 *
 * @category getters
 * @since 1.0.0
 */
export declare const withoutWriteMarker: (body: string) => string;
/**
 * What a label color may be: six hex digits, without `#`.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const LABEL_COLOR_PATTERN: RegExp;
/**
 * The longest label description GitHub accepts.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const MAX_LABEL_DESCRIPTION = 100;
/**
 * The issue (or pull request, which GitHub numbers in the same sequence):
 * `GET /repos/{owner}/{repo}/issues/{number}`.
 *
 * @category getters
 * @since 1.0.0
 */
export declare const getIssue: (owner: string, repo: string, number: number) => Effect.Effect<Issue, IntegrationError, GitHubClient>;
/**
 * The comments on issue `number`, oldest first:
 * `GET /repos/{owner}/{repo}/issues/{number}/comments`, optionally only those
 * updated since `since` (ISO 8601), within `maxPages` pages of 100 (default
 * 10). `truncated` is true when pages remained.
 *
 * @category getters
 * @since 1.0.0
 */
export declare const listComments: (owner: string, repo: string, number: number, options?: {
    readonly since?: string | undefined;
    readonly maxPages?: number | undefined;
}) => Effect.Effect<{
    readonly items: ReadonlyArray<IssueComment>;
    readonly truncated: boolean;
}, IntegrationError, GitHubClient>;
/**
 * Opens an issue: `POST /repos/{owner}/{repo}/issues`. Mark `body` with
 * {@link withWriteMarker} so a retry can find it.
 *
 * A lost answer fails `outcomeUnknown`; see the module notes before writing
 * again.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const createIssue: (owner: string, repo: string, input: {
    readonly title: string;
    readonly body: string;
}) => Effect.Effect<Issue, IntegrationError, GitHubClient>;
/**
 * Comments on issue or pull request `number`:
 * `POST /repos/{owner}/{repo}/issues/{number}/comments`. Mark `body` with
 * {@link withWriteMarker} so a retry can find it.
 *
 * A lost answer fails `outcomeUnknown`; see the module notes before writing
 * again.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const createComment: (owner: string, repo: string, number: number, body: string) => Effect.Effect<IssueComment, IntegrationError, GitHubClient>;
/**
 * The issue whose body carries `writeId`'s marker, among issues updated since
 * `since` (ISO 8601), walking at most {@link RECONCILE_PAGES} pages of
 * `GET /repos/{owner}/{repo}/issues?state=all&sort=created&direction=desc&since=…`.
 * Pull requests are skipped.
 *
 * With more than one match, the earliest created wins. A search that runs out
 * of pages fails `poll-failed` with `incomplete: true`, even with a match:
 * an older original may lie beyond the page budget.
 *
 * @category getters
 * @since 1.0.0
 */
export declare const findIssueByWrite: (owner: string, repo: string, options: {
    readonly writeId: string;
    readonly since: string;
}) => Effect.Effect<Option.Option<Issue>, IntegrationError, GitHubClient>;
/**
 * The comment on issue `number` whose body carries `writeId`'s marker, among
 * all its comments or those updated since `since` (ISO 8601), walking at most
 * {@link RECONCILE_PAGES} pages.
 *
 * With more than one match, the earliest created wins. A search that runs out
 * of pages without a match fails `poll-failed` with `incomplete: true`.
 *
 * @category getters
 * @since 1.0.0
 */
export declare const findCommentByWrite: (owner: string, repo: string, number: number, options: {
    readonly writeId: string;
    readonly since?: string | undefined;
}) => Effect.Effect<Option.Option<IssueComment>, IntegrationError, GitHubClient>;
/**
 * Adds labels to issue or pull request `number`, keeping the ones it has:
 * `POST /repos/{owner}/{repo}/issues/{number}/labels`. Answers every label
 * the issue carries afterwards.
 *
 * Each name is 1 to 50 characters. GitHub creates a label the repository
 * lacks. Adding a label the issue already has changes nothing, so a lost
 * answer fails `retryable` and the step repeats the call.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const addLabels: (owner: string, repo: string, number: number, names: readonly [string, ...Array<string>]) => Effect.Effect<ReadonlyArray<IssueLabel>, IntegrationError, GitHubClient>;
/**
 * Removes label `name` from issue or pull request `number`:
 * `DELETE /repos/{owner}/{repo}/issues/{number}/labels/{name}`. Answers
 * `true` when GitHub removed it and `false` when GitHub answers 404, which it
 * does for a label the issue lacks, and also for an issue or repository the
 * token cannot see.
 *
 * `name` is 1 to 50 characters and not `.` or `..`, which no request path
 * can address. Removing twice changes nothing, so a lost answer fails
 * `retryable`.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const removeLabel: (owner: string, repo: string, number: number, name: string) => Effect.Effect<boolean, IntegrationError, GitHubClient>;
/**
 * Creates a repository label: `POST /repos/{owner}/{repo}/labels`. Answers
 * `true` when GitHub created it and `false` when GitHub answers 422, which,
 * with the input validated first, means a label of that name exists.
 *
 * `name` is 1 to 50 characters, `color` six hex digits without `#`, and
 * `description` at most {@link MAX_LABEL_DESCRIPTION} characters. A repeat
 * finds the label made, so a lost answer fails `retryable`.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const createLabel: (owner: string, repo: string, input: {
    readonly name: string;
    readonly color: string;
    readonly description?: string | undefined;
}) => Effect.Effect<boolean, IntegrationError, GitHubClient>;
