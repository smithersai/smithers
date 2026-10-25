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

import { Effect, Schema } from "effect"
import { IntegrationError } from "../core/IntegrationError.ts"
import { GitHubClient } from "./GitHubClient.ts"
import { requireBranch } from "./Refs.ts"
import { requireRepositoryPath } from "./Repository.ts"

/**
 * A file a commit adds or replaces: its path and its whole content, base64.
 *
 * @category models
 * @since 1.0.0
 */
export interface FileAddition {
  readonly path: string
  readonly contents: string
}

/**
 * A commit as `GET /repos/{owner}/{repo}/git/commits/{sha}` returns it,
 * narrowed to its tree, parents and message.
 *
 * @category schemas
 * @since 1.0.0
 */
export const GitCommit = Schema.Struct({
  sha: Schema.String,
  message: Schema.String,
  tree: Schema.Struct({ sha: Schema.String }),
  parents: Schema.Array(Schema.Struct({ sha: Schema.String }))
})

/**
 * A decoded {@link GitCommit}.
 *
 * @category models
 * @since 1.0.0
 */
export type GitCommit = typeof GitCommit.Type

/**
 * One changed file of a comparison. `patch` is absent for a binary file and
 * for one GitHub found too large to show.
 *
 * @category schemas
 * @since 1.0.0
 */
export const ChangedFile = Schema.Struct({
  filename: Schema.String,
  status: Schema.String,
  additions: Schema.Number,
  deletions: Schema.Number,
  patch: Schema.optionalKey(Schema.String),
  previous_filename: Schema.optionalKey(Schema.String)
})

/**
 * A decoded {@link ChangedFile}.
 *
 * @category models
 * @since 1.0.0
 */
export type ChangedFile = typeof ChangedFile.Type

/**
 * The most files GitHub lists in one comparison.
 *
 * @category constants
 * @since 1.0.0
 */
export const MAX_COMPARE_FILES = 300

/**
 * One commit of a comparison: its SHA, its message's first line, the GitHub
 * login of its author (`null` when GitHub links the commit to no account),
 * and when it was authored (`null` when GitHub names no time).
 *
 * @category models
 * @since 1.0.0
 */
export interface ComparedCommit {
  readonly sha: string
  readonly headline: string
  readonly authorLogin: string | null
  readonly authoredAt: string | null
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
  readonly aheadBy: number
  readonly behindBy: number
  readonly files: ReadonlyArray<ChangedFile>
  readonly truncated: boolean
  readonly commits: ReadonlyArray<ComparedCommit>
  readonly commitsTruncated: boolean
}

const CompareCommitAnswer = Schema.Struct({
  sha: Schema.String,
  commit: Schema.Struct({
    message: Schema.String,
    author: Schema.NullOr(Schema.Struct({ date: Schema.optionalKey(Schema.String) })).pipe(
      Schema.withDecodingDefault(Effect.succeed(null))
    )
  }),
  author: Schema.NullOr(Schema.Struct({ login: Schema.String })).pipe(
    Schema.withDecodingDefault(Effect.succeed(null))
  )
})

const CompareAnswer = Schema.Struct({
  ahead_by: Schema.Number,
  behind_by: Schema.Number,
  total_commits: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  commits: Schema.Array(CompareCommitAnswer).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  files: Schema.Array(ChangedFile).pipe(Schema.withDecodingDefault(Effect.succeed([])))
})

// A message's first line: everything before its first line break.
const headlineOf = (message: string): string => /^[^\r\n]*/.exec(message)![0]

const GraphQLAnswer = Schema.Struct({
  data: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        createCommitOnBranch: Schema.NullOr(Schema.Struct({ commit: Schema.Struct({ oid: Schema.String }) }))
      })
    )
  ),
  errors: Schema.optionalKey(
    Schema.Array(Schema.Struct({ message: Schema.String, type: Schema.optionalKey(Schema.String) }))
  )
})

const SHA = /^[0-9a-f]{40}$/

/** The most files one commit may add or delete. */
const MAX_CHANGES = 1000

const invalid = (field: string, message: string): IntegrationError =>
  new IntegrationError("invalid-config", message, { field, retryable: false })

const requireSha = (field: string, sha: string): Effect.Effect<string, IntegrationError> =>
  typeof sha === "string" && SHA.test(sha)
    ? Effect.succeed(sha)
    : Effect.fail(invalid(field, "A commit SHA must be 40 lowercase hex digits."))

// A repository-relative path: segments that are not empty, `.` or `..`, with
// no control character or backslash.
const isFilePath = (path: unknown): path is string =>
  typeof path === "string" && path.length <= 4096 &&
  ![...path].some((char) => char === "\\" || char.charCodeAt(0) <= 0x1F || char.charCodeAt(0) === 0x7F) &&
  path.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..")

const isBase64 = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9+/]*={0,2}$/.test(value) && value.length % 4 === 0

const spanAttributes = (owner: string, repo: string): Record<string, unknown> => ({
  "github.owner": owner,
  "github.repo": repo
})

// A GraphQL error's type or message saying the branch moved since the
// expected head: the fence refused the commit.
const isStale = (error: { readonly message: string; readonly type?: string }): boolean =>
  error.type === "STALE_DATA" || /expected branch to point to/i.test(error.message)

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
export const createOnBranch = (
  owner: string,
  repo: string,
  input: {
    readonly branch: string
    readonly expectedHeadOid: string
    readonly headline: string
    readonly body?: string | undefined
    readonly additions: ReadonlyArray<FileAddition>
    readonly deletions: ReadonlyArray<string>
  }
): Effect.Effect<string, IntegrationError, GitHubClient> =>
  Effect.gen(function*() {
    const client = yield* GitHubClient
    yield* requireRepositoryPath(owner, repo)
    const branch = yield* requireBranch(input.branch)
    const expectedHeadOid = yield* requireSha("expectedHeadOid", input.expectedHeadOid)
    if (typeof input.headline !== "string" || input.headline.trim().length === 0 || input.headline.includes("\n")) {
      return yield* Effect.fail(invalid("headline", "A commit headline is one line, not blank."))
    }
    const changes = input.additions.length + input.deletions.length
    if (changes === 0 || changes > MAX_CHANGES) {
      return yield* Effect.fail(invalid("fileChanges", `A commit changes 1 to ${MAX_CHANGES} files.`))
    }
    if (!input.additions.every((file) => isFilePath(file.path) && isBase64(file.contents))) {
      return yield* Effect.fail(invalid("additions", "An addition is a repository path and base64 contents."))
    }
    if (!input.deletions.every(isFilePath)) {
      return yield* Effect.fail(invalid("deletions", "A deletion is a repository path."))
    }
    const answer = yield* client.request("POST", "/graphql", {
      query: "mutation($input: CreateCommitOnBranchInput!) " +
        "{ createCommitOnBranch(input: $input) { commit { oid } } }",
      variables: {
        input: {
          branch: { repositoryNameWithOwner: `${owner}/${repo}`, branchName: branch },
          expectedHeadOid,
          message: { headline: input.headline, ...(input.body === undefined ? {} : { body: input.body }) },
          fileChanges: {
            additions: input.additions.map((file) => ({ path: file.path, contents: file.contents })),
            deletions: input.deletions.map((path) => ({ path }))
          }
        }
      }
    }, { schema: GraphQLAnswer })
    const commit = answer.data?.createCommitOnBranch?.commit
    if (answer.errors !== undefined && answer.errors.length > 0 || commit === undefined) {
      const stale = (answer.errors ?? []).some(isStale)
      return yield* Effect.fail(
        new IntegrationError(
          "delivery-failed",
          stale
            ? "GitHub refused the commit: the branch moved since the expected head."
            : "GitHub refused the commit.",
          { status: stale ? 409 : 422, stale, graphql: true, retryable: false, outcomeUnknown: false }
        )
      )
    }
    return commit.oid
  }).pipe(Effect.withSpan("GitHub.Commits.createOnBranch", { attributes: spanAttributes(owner, repo) }))

/**
 * What {@link mergeInto} did: made merge commit `sha` on the branch, or found
 * the branch already held `head` (`upToDate`).
 *
 * @category models
 * @since 1.0.0
 */
export type MergedInto =
  | { readonly kind: "merged"; readonly sha: string }
  | { readonly kind: "upToDate" }

const MergeIntoAnswer = Schema.NullOr(Schema.Struct({ sha: Schema.String }))

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
export const mergeInto = (
  owner: string,
  repo: string,
  input: { readonly base: string; readonly head: string; readonly commitMessage?: string | undefined }
): Effect.Effect<MergedInto, IntegrationError, GitHubClient> =>
  Effect.gen(function*() {
    const client = yield* GitHubClient
    const repository = yield* requireRepositoryPath(owner, repo)
    const base = yield* requireBranch(input.base)
    const head = typeof input.head === "string" && SHA.test(input.head) ? input.head : yield* requireBranch(input.head)
    const answer = yield* client.request("POST", `/repos/${repository}/merges`, {
      base,
      head,
      ...(input.commitMessage === undefined ? {} : { commit_message: input.commitMessage })
    }, { schema: MergeIntoAnswer, retryUnsafeWrites: true })
    return answer === null ? { kind: "upToDate" } as const : { kind: "merged", sha: answer.sha } as const
  }).pipe(Effect.withSpan("GitHub.Commits.mergeInto", { attributes: spanAttributes(owner, repo) }))

/**
 * Commit `sha`'s tree, parents and message:
 * `GET /repos/{owner}/{repo}/git/commits/{sha}`.
 *
 * @category getters
 * @since 1.0.0
 */
export const getCommit = (
  owner: string,
  repo: string,
  sha: string
): Effect.Effect<GitCommit, IntegrationError, GitHubClient> =>
  Effect.gen(function*() {
    const client = yield* GitHubClient
    const repository = yield* requireRepositoryPath(owner, repo)
    const commit = yield* requireSha("sha", sha)
    return yield* client.request("GET", `/repos/${repository}/git/commits/${commit}`, undefined, { schema: GitCommit })
  }).pipe(Effect.withSpan("GitHub.Commits.getCommit", { attributes: spanAttributes(owner, repo) }))

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
export const compare = (
  owner: string,
  repo: string,
  base: string,
  head: string
): Effect.Effect<Comparison, IntegrationError, GitHubClient> =>
  Effect.gen(function*() {
    const client = yield* GitHubClient
    const repository = yield* requireRepositoryPath(owner, repo)
    const from = yield* requireSha("base", base)
    const to = yield* requireSha("head", head)
    const answer = yield* client.request("GET", `/repos/${repository}/compare/${from}...${to}`, undefined, {
      schema: CompareAnswer
    })
    const commits = answer.commits.map((commit): ComparedCommit => ({
      sha: commit.sha,
      headline: headlineOf(commit.commit.message),
      authorLogin: commit.author?.login ?? null,
      authoredAt: commit.commit.author?.date ?? null
    }))
    return {
      aheadBy: answer.ahead_by,
      behindBy: answer.behind_by,
      files: answer.files,
      truncated: answer.files.length >= MAX_COMPARE_FILES,
      commits,
      commitsTruncated: answer.total_commits > commits.length
    }
  }).pipe(Effect.withSpan("GitHub.Commits.compare", { attributes: spanAttributes(owner, repo) }))
