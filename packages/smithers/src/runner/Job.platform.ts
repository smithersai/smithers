/**
 * Host access for the adjacent VibeLang module.
 *
 * @since 1.0.0
 */

import * as Transcript from "@smthrs/agent/Transcript"

/**
 * A transcript scrubber: regular-expression replacement over one string.
 *
 * @private
 * @since 1.0.0
 */
export interface Scrub {
  (text: string): string
}

/**
 * The default scrubber, typed with the contract its replacement never breaks.
 *
 * @private
 * @since 1.0.0
 */
export const scrubber = (): Scrub => Transcript.scrubber()
