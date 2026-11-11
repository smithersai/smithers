/**
 * Code-point-safe text helpers shared by the boundary, the shape gate and
 * the observation caps.
 *
 * A lone UTF-16 surrogate is not Unicode text: canonical JSON and the
 * SHA-256 digest both refuse it, so any string the chain journals, compares
 * or digests must be well-formed.
 *
 * @since 0.1.0
 */

const isHigh = (code: number): boolean => code >= 0xd800 && code <= 0xdbff
const isLow = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff

/**
 * Whether `text` holds no unpaired UTF-16 surrogate.
 *
 * @private
 * @since 0.1.0
 */
export const isWellFormed = (text: string): boolean => {
  for (let index = 0; index < text.length; index = index + 1) {
    const code = text.charCodeAt(index)
    if (isHigh(code) && isLow(text.charCodeAt(index + 1))) index = index + 1
    else if (isHigh(code) || isLow(code)) return false
  }
  return true
}

/**
 * `text` with every unpaired surrogate replaced by U+FFFD.
 *
 * @private
 * @since 0.1.0
 */
export const toWellFormed = (text: string): string => text.replace(/\p{Cs}/gu, "�")

/**
 * The first `end` code units of `text`, one fewer when the cut would split a
 * surrogate pair, so a well-formed text stays well-formed.
 *
 * @private
 * @since 0.1.0
 */
export const prefix = (text: string, end: number): string =>
  text.slice(0, end > 0 && isHigh(text.charCodeAt(end - 1)) && isLow(text.charCodeAt(end)) ? end - 1 : end)
