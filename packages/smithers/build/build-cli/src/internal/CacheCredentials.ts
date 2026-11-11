/**
 * Invocation-local cache credentials; values never become declaration data.
 *
 * @since 1.0.0
 */

import { Context } from "effect"

/**
 * Credential lookup supplied by the host, independently of the target environment.
 * @category services
 * @since 1.0.0
 */
export interface CacheCredentials {
  readonly read: (environment: Readonly<Record<string, string | undefined>>, name: string) => string | undefined
}

/**
 * One invocation's credential lookup; absent variables resolve to undefined.
 * @category services
 * @since 1.0.0
 */
export const CacheCredentials = Context.Reference<CacheCredentials>("@smthrs/build-cli/CacheCredentials", {
  defaultValue: () => ({ read: (environment, name) => environment[name] })
})
