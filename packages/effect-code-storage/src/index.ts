/**
 * Code Storage, Pierre's git hosting, for Effect programs: import a public
 * GitHub repository, list its files, read a file, and list its commits,
 * branches and tags; read any git remote's HEAD or a branch over smart HTTP;
 * and proxy a guest's clone read-only, adding the credential outside it.
 *
 * @since 0.1.0
 */

/**
 * @category client
 * @since 0.1.0
 */
export * as CodeStorage from "./CodeStorage.ts"

/**
 * @category git
 * @since 0.1.0
 */
export * as GitRemote from "./GitRemote.ts"

/**
 * @category git
 * @since 0.2.0
 */
export * as GitProxy from "./GitProxy.ts"
