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

import { Effect, Option, Schema } from "effect"
import { IntegrationError } from "../core/IntegrationError.ts"
import { GitHubClient } from "./GitHubClient.ts"
import { requireRepositoryPath } from "./Repository.ts"

/**
 * The longest branch name {@link requireBranch} accepts.
 *
 * @category constants
 * @since 1.0.0
 */
export const MAX_BRANCH_LENGTH = 200

/**
 * A branch and the commit it points at.
 *
 * @category models
 * @since 1.0.0
 */
export interface Branch {
  readonly name: string
  readonly sha: string
}

const RefAnswer = Schema.Struct({
  ref: Schema.String,
  object: Schema.Struct({ sha: Schema.String, type: Schema.String })
})

const SEGMENT = /^[A-Za-z0-9._-]+$/
const SHA = /^[0-9a-f]{40}$/

/**
 * Whether `name` is a branch name this module sends: 1 to
 * {@link MAX_BRANCH_LENGTH} characters of letters, digits, `.`, `_`, `-` and
 * `/`, in segments that are not empty, do not start with `.` and do not end
 * with `.lock`, with no `..` anywhere: a subset of git's `check-ref-format`.
 *
 * @category predicates
 * @since 1.0.0
 */
export const isBranch = (name: unknown): name is string =>
  typeof name === "string" && name.length > 0 && name.length <= MAX_BRANCH_LENGTH && !name.includes("..") &&
  name.split("/").every((segment) => SEGMENT.test(segment) && !segment.startsWith(".") && !segment.endsWith(".lock"))

/**
 * `name` when {@link isBranch} holds, else an `invalid-config` failure.
 *
 * @category constructors
 * @since 1.0.0
 */
export const requireBranch = (name: string): Effect.Effect<string, IntegrationError> =>
  isBranch(name) ? Effect.succeed(name) : Effect.fail(
    new IntegrationError("invalid-config", "A branch name must follow git's ref rules.", {
      field: "branch",
      branch: typeof name === "string" ? (name as string).slice(0, 64) : typeof name,
      retryable: false
    })
  )

const spanAttributes = (owner: string, repo: string): Record<string, unknown> => ({
  "github.owner": owner,
  "github.repo": repo
})

/**
 * Branch `name`'s head: `GET /repos/{owner}/{repo}/git/ref/heads/{name}`.
 * `Option.none()` when GitHub answers 404, as it does for a branch that does
 * not exist.
 *
 * @category getters
 * @since 1.0.0
 */
export const getBranch = (
  owner: string,
  repo: string,
  name: string
): Effect.Effect<Option.Option<Branch>, IntegrationError, GitHubClient> =>
  Effect.gen(function*() {
    const client = yield* GitHubClient
    const repository = yield* requireRepositoryPath(owner, repo)
    const branch = yield* requireBranch(name)
    return yield* client.request("GET", `/repos/${repository}/git/ref/heads/${branch}`, undefined, {
      schema: RefAnswer
    }).pipe(
      Effect.map((answer) => Option.some({ name: branch, sha: answer.object.sha })),
      Effect.catchIf((error) => error.details?.["status"] === 404, () => Effect.succeed(Option.none<Branch>()))
    )
  }).pipe(Effect.withSpan("GitHub.Refs.getBranch", { attributes: spanAttributes(owner, repo) }))

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
export const listBranches = (
  owner: string,
  repo: string,
  prefix: string,
  options?: { readonly maxPages?: number | undefined }
): Effect.Effect<
  { readonly items: ReadonlyArray<Branch>; readonly truncated: boolean },
  IntegrationError,
  GitHubClient
> =>
  Effect.gen(function*() {
    const client = yield* GitHubClient
    const repository = yield* requireRepositoryPath(owner, repo)
    // A prefix is a branch name cut short: `smithers/t12-` is valid once its last segment is completed.
    const valid = yield* requireBranch(`${prefix}x`)
    const path = `/repos/${repository}/git/matching-refs/heads/${valid.slice(0, -1)}`
    const page = yield* client.paginate(path, { maxPages: options?.maxPages })
    const items: Array<Branch> = []
    for (const item of page.items) {
      const ref = yield* Schema.decodeUnknownEffect(RefAnswer)(item).pipe(
        Effect.mapError((cause) =>
          new IntegrationError("decode-failed", `GitHub response for GET ${path} failed schema validation.`, {
            method: "GET",
            path
          }, { cause })
        )
      )
      if (ref.ref.startsWith("refs/heads/")) {
        items.push({ name: ref.ref.slice("refs/heads/".length), sha: ref.object.sha })
      }
    }
    return { items, truncated: page.truncated }
  }).pipe(Effect.withSpan("GitHub.Refs.listBranches", { attributes: spanAttributes(owner, repo) }))

/**
 * Creates branch `name` at commit `sha`: `POST /repos/{owner}/{repo}/git/refs`.
 *
 * GitHub answers 422 when the branch exists. A lost answer fails
 * `outcomeUnknown`; see the module notes before writing again.
 *
 * @category constructors
 * @since 1.0.0
 */
export const createBranch = (
  owner: string,
  repo: string,
  input: { readonly name: string; readonly sha: string }
): Effect.Effect<Branch, IntegrationError, GitHubClient> =>
  Effect.gen(function*() {
    const client = yield* GitHubClient
    const repository = yield* requireRepositoryPath(owner, repo)
    const branch = yield* requireBranch(input.name)
    if (typeof input.sha !== "string" || !SHA.test(input.sha)) {
      return yield* Effect.fail(
        new IntegrationError("invalid-config", "A commit SHA must be 40 lowercase hex digits.", {
          field: "sha",
          retryable: false
        })
      )
    }
    const answer = yield* client.request("POST", `/repos/${repository}/git/refs`, {
      ref: `refs/heads/${branch}`,
      sha: input.sha
    }, { schema: RefAnswer })
    return { name: branch, sha: answer.object.sha }
  }).pipe(Effect.withSpan("GitHub.Refs.createBranch", { attributes: spanAttributes(owner, repo) }))
