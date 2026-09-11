/**
 * Locates the guest directory spawned commands record their pids in.
 *
 * @since 0.1.0
 */

/**
 * The session-private guest directory spawned commands record their pids in.
 * Every provider that signals guests through a pidfile wipes it on acquire,
 * so a reattached machine cannot mis-target a previous incarnation's pids.
 *
 * @category constants
 * @since 0.1.0
 */
export const pidDirectory = "/tmp/.smthrs-sbx"
