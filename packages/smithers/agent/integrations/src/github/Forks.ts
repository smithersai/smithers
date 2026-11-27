/**
 * Repository fork and upstream sync REST operations over {@link GitHubClient}.
 *
 * Every coordinate is validated through {@link requireRepositoryPath} and
 * {@link requireBranch} before it becomes a request path.
 *
 * @since 1.0.0
 */

import { Effect, Schema } from "effect"
import type { IntegrationError } from "../core/IntegrationError.ts"
import { GitHubClient } from "./GitHubClient.ts"
import { requireBranch } from "./Refs.ts"
import { requireRepositoryPath } from "./Repository.ts"

const ForkOwner = Schema.Struct({
  login: Schema.String,
})

const ForkParent = Schema.Struct({
  name: Schema.String,
  full_name: Schema.String,
  owner: ForkOwner,
})

/**
 * Decoded response from `POST /repos/{owner}/{repo}/forks`.
 *
 * @category schemas
 * @since 1.0.0
 */
export const ForkRepository = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  full_name: Schema.String,
  owner: ForkOwner,
  default_branch: Schema.String,
  html_url: Schema.String,
  parent: Schema.optional(ForkParent),
})

/**
 * @category models
 * @since 1.0.0
 */
export type ForkRepository = typeof ForkRepository.Type

/**
 * Decoded response from `POST /repos/{owner}/{repo}/merge-upstream`.
 *
 * @category schemas
 * @since 1.0.0
 */
export const MergeUpstreamResult = Schema.Struct({
  message: Schema.String,
  merge_type: Schema.optional(Schema.String),
  base_branch: Schema.optional(Schema.String),
})

/**
 * @category models
 * @since 1.0.0
 */
export type MergeUpstreamResult = typeof MergeUpstreamResult.Type

/**
 * Creates (or returns an existing) fork of `owner/repo` in the authenticated
 * user's account: `POST /repos/{owner}/{repo}/forks`.
 *
 * GitHub's fork creation endpoint is idempotent for a given user and upstream,
 * so `retryUnsafeWrites` is safe.
 *
 * @category constructors
 * @since 1.0.0
 */
export const createFork = (
  owner: string,
  repo: string,
  options?: { readonly defaultBranchOnly?: boolean | undefined },
): Effect.Effect<ForkRepository, IntegrationError, GitHubClient> =>
  Effect.gen(function* () {
    const client = yield* GitHubClient
    const repository = yield* requireRepositoryPath(owner, repo)
    const body = options?.defaultBranchOnly === true ? { default_branch_only: true } : {}
    return yield* client.request("POST", `/repos/${repository}/forks`, body, {
      schema: ForkRepository,
      retryUnsafeWrites: true,
    })
  }).pipe(Effect.withSpan("GitHub.Forks.createFork"))

/**
 * Syncs `branch` of a forked repository with its upstream repository:
 * `POST /repos/{owner}/{repo}/merge-upstream`.
 *
 * @category constructors
 * @since 1.0.0
 */
export const syncUpstream = (
  owner: string,
  repo: string,
  branch: string,
): Effect.Effect<MergeUpstreamResult, IntegrationError, GitHubClient> =>
  Effect.gen(function* () {
    const client = yield* GitHubClient
    const repository = yield* requireRepositoryPath(owner, repo)
    const validatedBranch = yield* requireBranch(branch)
    return yield* client.request(
      "POST",
      `/repos/${repository}/merge-upstream`,
      { branch: validatedBranch },
      { schema: MergeUpstreamResult },
    )
  }).pipe(Effect.withSpan("GitHub.Forks.syncUpstream"))
