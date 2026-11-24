/**
 * Derives a vendor machine name from a session key.
 *
 * @since 0.1.0
 */

import { legacySessionSlug, sessionSlug } from "./sessionSlug.ts"

/**
 * The lowercase, dot- and underscore-free name `prefix` plus the session slug.
 *
 * @category utils
 * @since 0.1.0
 */
export const machineName = (prefix: string, session: string): string =>
  `${prefix}${sessionSlug(session)}`.toLowerCase().replaceAll(/[._]/g, "-")

/**
 * Existing pre-SHA machine name.
 * @category utils
 * @since 1.0.0-rc.18
 */
export const legacyMachineName = (prefix: string, session: string): string =>
  `${prefix}${legacySessionSlug(session)}`.toLowerCase().replaceAll(/[._]/g, "-")
