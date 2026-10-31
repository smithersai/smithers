/**
 * Scrubbing what leaves the runner (OBS-5): an agent's text can quote a
 * credential it saw, so the runner replaces every value it knows to be secret
 * and every shape that looks like one before anything is uploaded.
 *
 * @since 1.0.0
 */

/**
 * What a scrubbed value becomes.
 *
 * @category constants
 * @since 1.0.0
 */
export const REDACTED = "[redacted]"

/**
 * The shapes scrubbed whatever the profile says: API keys of the `sk-` and
 * `sess-` kinds, bearer credentials, GitHub tokens, three-part JWTs, and
 * email addresses.
 *
 * @category constants
 * @since 1.0.0
 */
export const SHAPES: ReadonlyArray<RegExp> = [
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\bsess-[A-Za-z0-9_-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/g,
  /\bghp_[A-Za-z0-9]{8,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{8,}/g,
  /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g,
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g
]

/**
 * A scrubber over `secrets`, the values the runner knows are secret: each
 * value of at least 4 characters, longest first, then every {@link SHAPES}
 * match, becomes {@link REDACTED}.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (secrets: Iterable<string>) => {
  const values = [...new Set(secrets)].filter((value) => value.length >= 4).sort((a, b) => b.length - a.length)
  return (text: string): string => {
    let scrubbed = text
    for (const value of values) scrubbed = scrubbed.split(value).join(REDACTED)
    for (const shape of SHAPES) scrubbed = scrubbed.replace(shape, REDACTED)
    return scrubbed
  }
}
