/**
 * The one control-character rule every trust boundary in this package shares.
 *
 * A C0 control or DEL in a name corrupts a Markdown report and a CI log line:
 * a newline lets the value print its own line, which on GitHub Actions is a
 * workflow command the runner executes, and an ESC sequence rewrites the
 * visible log. Values an author declares (suite and case names, baseline
 * records) are rejected where they enter the system; values a target returns
 * at runtime (step keys, failure messages) are flattened instead, so a broken
 * target stays a readable failure rather than a rejected run.
 *
 * @since 0.1.0
 */

/**
 * Names the first C0 control or DEL in `value`, or `undefined` when there is
 * none.
 *
 * @since 0.1.0
 * @private
 */
export const controlCharacter = (value: string): string | undefined => {
  for (const character of value) {
    const code = character.codePointAt(0)!
    if (code < 0x20 || code === 0x7f) return `U+${code.toString(16).toUpperCase().padStart(4, "0")}`
  }
  return undefined
}

/**
 * Replaces every C0 control and DEL with a space, the way a report cell does,
 * so a hostile string cannot emit its own log line or terminal escape.
 *
 * @since 0.1.0
 * @private
 */
export const flattenControlCharacters = (value: string): string =>
  controlCharacter(value) === undefined ? value : value.replace(/[\u0000-\u001F\u007F]/gu, " ")
