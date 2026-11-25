/**
 * POSIX shell single-word quoting shared by CLI presentation and forensics.
 *
 * Kept separate from `Forensics.ts` so lightweight modules such as
 * `CloudSandbox.ts` -> `Client.ts` -> `Presentation.ts` do not pull in
 * `@smthrs/agent/AgentSession` or `@smthrs/engine-store`.
 *
 * @since 1.0.0
 */

const inertWord = /^[A-Za-z0-9_@%+=:,./-]+$/

/**
 * Quotes one argv element as exactly one POSIX shell word.
 *
 * @category conversions
 * @since 1.0.0
 */
export const shellQuote = (value: string): string =>
  inertWord.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`
