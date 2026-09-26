/**
 * The X integration surface: read-only for now.
 *
 * A client with token refresh and rate-limit handling, the OAuth scopes each
 * operation needs, and change feeds of mentions and direct messages that map
 * to private source records. The client can also post and send a direct
 * message, but neither write is a durable action yet: a flow that must not
 * post twice has no reconcile step to rely on, so this surface is documented
 * and supported as a read integration.
 *
 * @since 1.0.0
 */

/**
 * @category constructors
 * @since 1.0.0
 */
export * as Capabilities from "./x/Capabilities.ts"

/**
 * @category constructors
 * @since 1.0.0
 */
export * as Config from "./x/Config.ts"

/**
 * @category constructors
 * @since 1.0.0
 */
export * as Records from "./x/Records.ts"

/**
 * @category services
 * @since 1.0.0
 */
export * as Sync from "./x/Sync.ts"

/**
 * @category services
 * @since 1.0.0
 */
export * as XClient from "./x/XClient.ts"
