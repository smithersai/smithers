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

import { Effect, Option, Schema } from "effect"
import { IntegrationError } from "../core/IntegrationError.ts"
import { RECONCILE_PAGES } from "./Actions.ts"
import { GitHubClient } from "./GitHubClient.ts"
import { IssueUser, WRITE_ID_PATTERN, writeIdOf } from "./Issues.ts"
import { requireBranch } from "./Refs.ts"
import { IssueNumber, requireRepositoryPath } from "./Repository.ts"

/**
 * One end of a pull request: its branch and the commit it points at.
 *
 * @category schemas
 * @since 1.0.0
 */
export const PullEnd = Schema.Struct({ ref: Schema.String, sha: Schema.String })

/**
 * A pull request's base: its branch and commit, and the repository it merges
 * into with that repository's default branch. `repo` decodes as `null` when
 * GitHub's answer leaves it out.
 *
 * @category schemas
 * @since 1.0.0
 */
export const PullBase = Schema.Struct({
  ...PullEnd.fields,
  repo: Schema.NullOr(Schema.Struct({ default_branch: Schema.String })).pipe(
    Schema.withDecodingDefault(Effect.succeed(null))
  )
})

/**
 * A pull request as GitHub's REST API returns it, narrowed to the fields
 * Smithers reads. A listing omits the merge and size fields, which then
 * decode as `false`, `null` or `0`.
 *
 * @category schemas
 * @since 1.0.0
 */
export const PullRequest = Schema.Struct({
  id: Schema.Number,
  node_id: Schema.String,
  number: Schema.Number,
  title: Schema.String,
  body: Schema.NullOr(Schema.String),
  state: Schema.Literals(["open", "closed"]),
  draft: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  merged: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  merged_at: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  merge_commit_sha: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  merged_by: IssueUser.pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  mergeable_state: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  user: IssueUser,
  head: PullEnd,
  base: PullBase,
  commits: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  additions: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  deletions: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  changed_files: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  created_at: Schema.String,
  updated_at: Schema.String,
  closed_at: Schema.NullOr(Schema.String)
})

/**
 * A decoded {@link PullRequest}.
 *
 * @category models
 * @since 1.0.0
 */
export type PullRequest = typeof PullRequest.Type

/**
 * A commit on a pull request, narrowed to its SHA, message, author and time.
 * `author` is the GitHub account, `null` when the commit's email maps to none.
 *
 * @category schemas
 * @since 1.0.0
 */
export const PullCommit = Schema.Struct({
  sha: Schema.String,
  commit: Schema.Struct({
    message: Schema.String,
    author: Schema.NullOr(Schema.Struct({ name: Schema.String, date: Schema.String }))
  }),
  author: IssueUser
})

/**
 * A decoded {@link PullCommit}.
 *
 * @category models
 * @since 1.0.0
 */
export type PullCommit = typeof PullCommit.Type

/**
 * A pull request review, narrowed to the fields Smithers reads. `commit_id`
 * is the head the review was submitted against.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Review = Schema.Struct({
  id: Schema.Number,
  node_id: Schema.String,
  user: IssueUser,
  body: Schema.NullOr(Schema.String),
  state: Schema.String,
  commit_id: Schema.NullOr(Schema.String),
  submitted_at: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null)))
})

/**
 * A decoded {@link Review}.
 *
 * @category models
 * @since 1.0.0
 */
export type Review = typeof Review.Type

/**
 * What a review submits. `COMMENT` leaves findings without a decision;
 * `APPROVE` and `REQUEST_CHANGES` are a person's decisions.
 *
 * @category models
 * @since 1.0.0
 */
export type ReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES"

/**
 * How {@link mergePull} merges.
 *
 * @category models
 * @since 1.0.0
 */
export type MergeMethod = "squash" | "merge" | "rebase"

/**
 * How {@link updateBranch} brings a pull request's branch up to date with its
 * base: a merge commit on the branch, or a rebase that rewrites it.
 *
 * @category models
 * @since 1.0.0
 */
export type UpdateMethod = "merge" | "rebase"

/**
 * What GitHub answered a merge: the merge commit's SHA, and whether it merged.
 *
 * @category models
 * @since 1.0.0
 */
export interface Merged {
  readonly sha: string
  readonly merged: boolean
}

const MergeAnswer = Schema.Struct({ sha: Schema.String, merged: Schema.Boolean })

const SHA = /^[0-9a-f]{40}$/

const invalid = (field: string, message: string, value?: unknown): IntegrationError =>
  new IntegrationError("invalid-config", message, {
    field,
    ...(value === undefined ? {} : { value: typeof value === "string" ? value.slice(0, 64) : typeof value }),
    retryable: false
  })

const requireNumber = (number: number): Effect.Effect<number, IntegrationError> =>
  Schema.is(IssueNumber)(number)
    ? Effect.succeed(number)
    : Effect.fail(invalid("number", "A GitHub pull request number must be a positive integer.", number))

const requireSha = (field: string, sha: string): Effect.Effect<string, IntegrationError> =>
  typeof sha === "string" && SHA.test(sha)
    ? Effect.succeed(sha)
    : Effect.fail(invalid(field, "A commit SHA must be 40 lowercase hex digits.", sha))

// A finder that ran out of pages without a match cannot say the write was never made; see `Issues`.
const incomplete = (operation: string): IntegrationError =>
  new IntegrationError(
    "poll-failed",
    `${operation}: the search ran out of its ${RECONCILE_PAGES}-page budget before it could rule the write out.`,
    { operation, incomplete: true, retryable: false }
  )

const requireWriteId = (writeId: string): Effect.Effect<string, IntegrationError> =>
  typeof writeId === "string" && WRITE_ID_PATTERN.test(writeId)
    ? Effect.succeed(writeId)
    : Effect.fail(invalid("writeId", "A write id must be 1 to 100 letters, digits and hyphens.", writeId))

const requireMethod = (method: MergeMethod): Effect.Effect<MergeMethod, IntegrationError> =>
  method === "squash" || method === "merge" || method === "rebase"
    ? Effect.succeed(method)
    : Effect.fail(invalid("method", "A merge method is squash, merge or rebase.", method))

const requireUpdateMethod = (method: UpdateMethod): Effect.Effect<UpdateMethod, IntegrationError> =>
  method === "merge" || method === "rebase"
    ? Effect.succeed(method)
    : Effect.fail(invalid("method", "A branch update method is merge or rebase.", method))

const requireNodeId = (field: string, nodeId: string): Effect.Effect<string, IntegrationError> =>
  typeof nodeId === "string" && /^[A-Za-z0-9_=-]{1,100}$/.test(nodeId)
    ? Effect.succeed(nodeId)
    : Effect.fail(invalid(field, "A pull request's node id is 1 to 100 letters, digits, - and _.", nodeId))

const requireEvent = (event: ReviewEvent): Effect.Effect<ReviewEvent, IntegrationError> =>
  event === "COMMENT" || event === "APPROVE" || event === "REQUEST_CHANGES"
    ? Effect.succeed(event)
    : Effect.fail(invalid("event", "A review event is COMMENT, APPROVE or REQUEST_CHANGES.", event))

const decodeFailed = (path: string, cause: unknown): IntegrationError =>
  new IntegrationError("decode-failed", `GitHub response for GET ${path} failed schema validation.`, {
    method: "GET",
    path
  }, { cause })

const decodeAll = <A>(
  schema: Schema.Decoder<A>,
  items: ReadonlyArray<unknown>,
  path: string
): Effect.Effect<ReadonlyArray<A>, IntegrationError> =>
  Schema.decodeUnknownEffect(Schema.Array(schema))(items).pipe(Effect.mapError((cause) => decodeFailed(path, cause)))

const spanAttributes = (owner: string, repo: string, number?: number): Record<string, unknown> => ({
  "github.owner": owner,
  "github.repo": repo,
  ...(number === undefined ? {} : { "github.number": number })
})

/**
 * Pull request `number`: `GET /repos/{owner}/{repo}/pulls/{number}`, with
 * its merge state and size.
 *
 * @category getters
 * @since 1.0.0
 */
export const getPull = (
  owner: string,
  repo: string,
  number: number
): Effect.Effect<PullRequest, IntegrationError, GitHubClient> =>
  Effect.gen(function*() {
    const client = yield* GitHubClient
    const repository = yield* requireRepositoryPath(owner, repo)
    const pull = yield* requireNumber(number)
    return yield* client.request("GET", `/repos/${repository}/pulls/${pull}`, undefined, { schema: PullRequest })
  }).pipe(Effect.withSpan("GitHub.Pulls.getPull", { attributes: spanAttributes(owner, repo, number) }))

/**
 * The repository's pull requests, most recently updated first:
 * `GET /repos/{owner}/{repo}/pulls?state=…&sort=updated&direction=desc`,
 * within `maxPages` pages of 100 (default 10). `head` narrows to one branch of
 * the repository itself. `truncated` is true when pages remained.
 *
 * @category getters
 * @since 1.0.0
 */
export const listPulls = (
  owner: string,
  repo: string,
  options?: {
    readonly state?: "open" | "closed" | "all" | undefined
    readonly head?: string | undefined
    readonly maxPages?: number | undefined
  }
): Effect.Effect<
  { readonly items: ReadonlyArray<PullRequest>; readonly truncated: boolean },
  IntegrationError,
  GitHubClient
> =>
  Effect.gen(function*() {
    const client = yield* GitHubClient
    const repository = yield* requireRepositoryPath(owner, repo)
    const search = new URLSearchParams({ state: options?.state ?? "all", sort: "updated", direction: "desc" })
    // The owner was validated with the repository path above.
    if (options?.head !== undefined) search.set("head", `${owner}:${yield* requireBranch(options.head)}`)
    const path = `/repos/${repository}/pulls`
    const page = yield* client.paginate(`${path}?${search.toString()}`, { maxPages: options?.maxPages })
    const items = yield* decodeAll(PullRequest, page.items, path)
    return { items, truncated: page.truncated }
  }).pipe(Effect.withSpan("GitHub.Pulls.listPulls", { attributes: spanAttributes(owner, repo) }))

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
export const findPullByHead = (
  owner: string,
  repo: string,
  options: { readonly head: string; readonly writeId?: string | undefined }
): Effect.Effect<Option.Option<PullRequest>, IntegrationError, GitHubClient> =>
  Effect.gen(function*() {
    const writeId = options.writeId === undefined ? undefined : yield* requireWriteId(options.writeId)
    const listed = yield* listPulls(owner, repo, { state: "all", head: options.head, maxPages: RECONCILE_PAGES })
    const matches = listed.items.filter((pull) => writeId === undefined || writeIdOf(pull.body) === writeId)
    const earliest = [...matches].sort((a, b) => a.number - b.number)[0]
    if (earliest === undefined && listed.truncated) return yield* Effect.fail(incomplete("findPullByHead"))
    return Option.fromUndefinedOr(earliest)
  }).pipe(Effect.withSpan("GitHub.Pulls.findPullByHead", { attributes: spanAttributes(owner, repo) }))

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
export const createPull = (
  owner: string,
  repo: string,
  input: {
    readonly head: string
    readonly base: string
    readonly title: string
    readonly body: string
    readonly draft?: boolean | undefined
  }
): Effect.Effect<PullRequest, IntegrationError, GitHubClient> =>
  Effect.gen(function*() {
    const client = yield* GitHubClient
    const repository = yield* requireRepositoryPath(owner, repo)
    const head = yield* requireBranch(input.head)
    const base = yield* requireBranch(input.base)
    if (typeof input.title !== "string" || input.title.trim().length === 0) {
      return yield* Effect.fail(invalid("title", "A pull request needs a title."))
    }
    return yield* client.request("POST", `/repos/${repository}/pulls`, {
      head,
      base,
      title: input.title,
      body: input.body,
      draft: input.draft ?? false
    }, { schema: PullRequest })
  }).pipe(Effect.withSpan("GitHub.Pulls.createPull", { attributes: spanAttributes(owner, repo) }))

/**
 * Closes pull request `number` without merging it:
 * `PATCH /repos/{owner}/{repo}/pulls/{number}` with `state: closed`. Closing
 * a closed pull request changes nothing, so a lost answer fails `retryable`.
 *
 * @category constructors
 * @since 1.0.0
 */
export const closePull = (
  owner: string,
  repo: string,
  number: number
): Effect.Effect<PullRequest, IntegrationError, GitHubClient> =>
  Effect.gen(function*() {
    const client = yield* GitHubClient
    const repository = yield* requireRepositoryPath(owner, repo)
    const pull = yield* requireNumber(number)
    return yield* client.request("PATCH", `/repos/${repository}/pulls/${pull}`, { state: "closed" }, {
      schema: PullRequest,
      retryUnsafeWrites: true
    })
  }).pipe(Effect.withSpan("GitHub.Pulls.closePull", { attributes: spanAttributes(owner, repo, number) }))

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
export const setBase = (
  owner: string,
  repo: string,
  number: number,
  base: string
): Effect.Effect<PullRequest, IntegrationError, GitHubClient> =>
  Effect.gen(function*() {
    const client = yield* GitHubClient
    const repository = yield* requireRepositoryPath(owner, repo)
    const pull = yield* requireNumber(number)
    const branch = yield* requireBranch(base)
    return yield* client.request("PATCH", `/repos/${repository}/pulls/${pull}`, { base: branch }, {
      schema: PullRequest,
      retryUnsafeWrites: true
    })
  }).pipe(Effect.withSpan("GitHub.Pulls.setBase", { attributes: spanAttributes(owner, repo, number) }))

const ReadyAnswer = Schema.Struct({
  data: Schema.optionalKey(Schema.NullOr(Schema.Struct({
    markPullRequestReadyForReview: Schema.NullOr(Schema.Struct({
      pullRequest: Schema.Struct({ isDraft: Schema.Boolean })
    }))
  }))),
  errors: Schema.optionalKey(Schema.Array(Schema.Struct({ message: Schema.String })))
})

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
export const markReady = (
  owner: string,
  repo: string,
  nodeId: string
): Effect.Effect<void, IntegrationError, GitHubClient> =>
  Effect.gen(function*() {
    const client = yield* GitHubClient
    yield* requireRepositoryPath(owner, repo)
    yield* requireNodeId("nodeId", nodeId)
    const answer = yield* client.request("POST", "/graphql", {
      query: "mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) " +
        "{ pullRequest { isDraft } } }",
      variables: { id: nodeId }
    }, { schema: ReadyAnswer, retryUnsafeWrites: true })
    if ((answer.errors !== undefined && answer.errors.length > 0) || !answer.data?.markPullRequestReadyForReview) {
      return yield* Effect.fail(
        new IntegrationError("delivery-failed", "GitHub refused to mark the pull request ready.", {
          status: 422,
          graphql: true,
          retryable: false,
          outcomeUnknown: false
        })
      )
    }
  }).pipe(Effect.withSpan("GitHub.Pulls.markReady", { attributes: spanAttributes(owner, repo) }))

const UpdateBranchAnswer = Schema.Struct({
  data: Schema.optionalKey(Schema.NullOr(Schema.Struct({
    updatePullRequestBranch: Schema.NullOr(Schema.Struct({
      pullRequest: Schema.NullOr(Schema.Struct({ headRefOid: Schema.String }))
    }))
  }))),
  errors: Schema.optionalKey(
    Schema.Array(Schema.Struct({ message: Schema.String, type: Schema.optionalKey(Schema.String) }))
  )
})

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
export const updateBranch = (
  owner: string,
  repo: string,
  input: { readonly pullNodeId: string; readonly expectedHeadOid: string; readonly method: UpdateMethod }
): Effect.Effect<{ readonly headSha: string }, IntegrationError, GitHubClient> =>
  Effect.gen(function*() {
    const client = yield* GitHubClient
    yield* requireRepositoryPath(owner, repo)
    const pullRequestId = yield* requireNodeId("pullNodeId", input.pullNodeId)
    const expectedHeadOid = yield* requireSha("expectedHeadOid", input.expectedHeadOid)
    const method = yield* requireUpdateMethod(input.method)
    const answer = yield* client.request("POST", "/graphql", {
      query: "mutation($input: UpdatePullRequestBranchInput!) " +
        "{ updatePullRequestBranch(input: $input) { pullRequest { headRefOid } } }",
      variables: {
        input: { pullRequestId, expectedHeadOid, updateMethod: method === "merge" ? "MERGE" : "REBASE" }
      }
    }, { schema: UpdateBranchAnswer })
    const pullRequest = answer.data?.updatePullRequestBranch?.pullRequest
    if (
      (answer.errors !== undefined && answer.errors.length > 0) || pullRequest === undefined || pullRequest === null
    ) {
      const type = answer.errors?.[0]?.type
      return yield* Effect.fail(
        new IntegrationError("delivery-failed", "GitHub refused to update the pull request's branch.", {
          status: 422,
          graphql: true,
          ...(type === undefined ? {} : { type: type.slice(0, 64) }),
          retryable: false,
          outcomeUnknown: false
        })
      )
    }
    return { headSha: pullRequest.headRefOid }
  }).pipe(Effect.withSpan("GitHub.Pulls.updateBranch", { attributes: spanAttributes(owner, repo) }))

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
export const mergePull = (
  owner: string,
  repo: string,
  number: number,
  input: {
    readonly sha: string
    readonly method: MergeMethod
    readonly commitTitle?: string | undefined
    readonly commitMessage?: string | undefined
  }
): Effect.Effect<Merged, IntegrationError, GitHubClient> =>
  Effect.gen(function*() {
    const client = yield* GitHubClient
    const repository = yield* requireRepositoryPath(owner, repo)
    const pull = yield* requireNumber(number)
    const sha = yield* requireSha("sha", input.sha)
    const method = yield* requireMethod(input.method)
    return yield* client.request("PUT", `/repos/${repository}/pulls/${pull}/merge`, {
      sha,
      merge_method: method,
      ...(input.commitTitle === undefined ? {} : { commit_title: input.commitTitle }),
      ...(input.commitMessage === undefined ? {} : { commit_message: input.commitMessage })
    }, { schema: MergeAnswer })
  }).pipe(Effect.withSpan("GitHub.Pulls.mergePull", { attributes: spanAttributes(owner, repo, number) }))

/**
 * The commits on pull request `number`, oldest first:
 * `GET /repos/{owner}/{repo}/pulls/{number}/commits`, within `maxPages` pages
 * of 100 (default 3; GitHub lists at most 250).
 *
 * @category getters
 * @since 1.0.0
 */
export const listCommits = (
  owner: string,
  repo: string,
  number: number,
  options?: { readonly maxPages?: number | undefined }
): Effect.Effect<
  { readonly items: ReadonlyArray<PullCommit>; readonly truncated: boolean },
  IntegrationError,
  GitHubClient
> =>
  Effect.gen(function*() {
    const client = yield* GitHubClient
    const repository = yield* requireRepositoryPath(owner, repo)
    const pull = yield* requireNumber(number)
    const path = `/repos/${repository}/pulls/${pull}/commits`
    const page = yield* client.paginate(path, { maxPages: options?.maxPages ?? 3 })
    return { items: yield* decodeAll(PullCommit, page.items, path), truncated: page.truncated }
  }).pipe(Effect.withSpan("GitHub.Pulls.listCommits", { attributes: spanAttributes(owner, repo, number) }))

/**
 * The reviews on pull request `number`, oldest first:
 * `GET /repos/{owner}/{repo}/pulls/{number}/reviews`, within `maxPages` pages
 * of 100 (default 3).
 *
 * @category getters
 * @since 1.0.0
 */
export const listReviews = (
  owner: string,
  repo: string,
  number: number,
  options?: { readonly maxPages?: number | undefined }
): Effect.Effect<
  { readonly items: ReadonlyArray<Review>; readonly truncated: boolean },
  IntegrationError,
  GitHubClient
> =>
  Effect.gen(function*() {
    const client = yield* GitHubClient
    const repository = yield* requireRepositoryPath(owner, repo)
    const pull = yield* requireNumber(number)
    const path = `/repos/${repository}/pulls/${pull}/reviews`
    const page = yield* client.paginate(path, { maxPages: options?.maxPages ?? 3 })
    return { items: yield* decodeAll(Review, page.items, path), truncated: page.truncated }
  }).pipe(Effect.withSpan("GitHub.Pulls.listReviews", { attributes: spanAttributes(owner, repo, number) }))

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
export const createReview = (
  owner: string,
  repo: string,
  number: number,
  input: { readonly commitId: string; readonly event: ReviewEvent; readonly body: string }
): Effect.Effect<Review, IntegrationError, GitHubClient> =>
  Effect.gen(function*() {
    const client = yield* GitHubClient
    const repository = yield* requireRepositoryPath(owner, repo)
    const pull = yield* requireNumber(number)
    const commitId = yield* requireSha("commitId", input.commitId)
    const event = yield* requireEvent(input.event)
    if (event === "COMMENT" && (typeof input.body !== "string" || input.body.trim().length === 0)) {
      return yield* Effect.fail(invalid("body", "A COMMENT review needs a body."))
    }
    return yield* client.request("POST", `/repos/${repository}/pulls/${pull}/reviews`, {
      commit_id: commitId,
      event,
      body: input.body
    }, { schema: Review })
  }).pipe(Effect.withSpan("GitHub.Pulls.createReview", { attributes: spanAttributes(owner, repo, number) }))

/**
 * The review on pull request `number` whose body carries `writeId`'s marker;
 * the earliest submitted wins. `Option.none()` when there is none; a listing
 * that runs out of pages without a match fails `poll-failed` with
 * `incomplete: true`.
 *
 * @category getters
 * @since 1.0.0
 */
export const findReviewByWrite = (
  owner: string,
  repo: string,
  number: number,
  options: { readonly writeId: string }
): Effect.Effect<Option.Option<Review>, IntegrationError, GitHubClient> =>
  Effect.gen(function*() {
    const writeId = yield* requireWriteId(options.writeId)
    const reviews = yield* listReviews(owner, repo, number, { maxPages: RECONCILE_PAGES })
    const found = reviews.items.find((review) => writeIdOf(review.body) === writeId)
    if (found === undefined && reviews.truncated) return yield* Effect.fail(incomplete("findReviewByWrite"))
    return Option.fromUndefinedOr(found)
  }).pipe(Effect.withSpan("GitHub.Pulls.findReviewByWrite", { attributes: spanAttributes(owner, repo, number) }))
