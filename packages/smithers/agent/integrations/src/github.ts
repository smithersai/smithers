/**
 * The GitHub integration surface.
 *
 * A narrow host layer plus the durable actions over it: a REST client,
 * payload schemas, and the actions a flow calls. An application composes them
 * into flows of its own and adds actions for the endpoints it needs. GitHub
 * webhooks enter through the Smithers backend, which decides who may start
 * work.
 *
 * @since 1.0.0
 */

/**
 * @category actions
 * @since 1.0.0
 */
export * as Actions from "./github/Actions.ts"

/**
 * @category services
 * @since 1.0.0
 */
export * as AppAuth from "./github/AppAuth.vibe"

/**
 * @category getters
 * @since 1.0.0
 */
export * as Collaborators from "./github/Collaborators.vibe"

/**
 * @category constructors
 * @since 1.0.0
 */
export * as Commits from "./github/Commits.vibe"

/**
 * @category constructors
 * @since 1.0.0
 */
export * as Config from "./github/Config.vibe"

/**
 * @category getters
 * @since 1.0.0
 */
export * as Contents from "./github/Contents.vibe"

/**
 * @category services
 * @since 1.0.0
 */
export * as GitHubClient from "./github/GitHubClient.vibe"

/**
 * @category constructors
 * @since 1.0.0
 */
export * as Issues from "./github/Issues.vibe"

/**
 * @category constructors
 * @since 1.0.0
 */
export * as Once from "./github/Once.vibe"

/**
 * @category schemas
 * @since 1.0.0
 */
export * as Payload from "./github/Payload.vibe"

/**
 * @category services
 * @since 1.0.0
 */
export * as Proxy from "./github/Proxy.ts"

/**
 * @category constructors
 * @since 1.0.0
 */
export * as Pulls from "./github/Pulls.vibe"

/**
 * @category services
 * @since 1.0.0
 */
export * as RateLimit from "./github/RateLimit.ts"

/**
 * @category constructors
 * @since 1.0.0
 */
export * as Refs from "./github/Refs.vibe"

/**
 * @category constructors
 * @since 1.0.0
 */
export * as Repository from "./github/Repository.vibe"

/**
 * @category constructors
 * @since 1.0.0
 */
export * as Statuses from "./github/Statuses.vibe"

/**
 * @category constructors
 * @since 1.0.0
 */
export * as Sync from "./github/Sync.vibe"
