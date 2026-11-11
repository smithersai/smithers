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

/**
 * The pidfile directory of one user on a machine several users share, such as
 * a `CommandSandbox` host: {@link pidDirectory} suffixed with the user's
 * numeric id, so no user writes in a directory another user created.
 *
 * @category constants
 * @since 1.0.0
 */
export const userPidDirectory = (uid: string): string => `${pidDirectory}-${uid}`
