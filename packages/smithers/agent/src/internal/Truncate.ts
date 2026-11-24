/**
 * Cuts text to a bound without parting a surrogate pair.
 * @since 1.0.0
 */

/**
 * `text` cut to at most `limit` UTF-16 units, one fewer when the cut would
 * part a surrogate pair: a lone high surrogate is not text, and a reader
 * renders it as U+FFFD.
 *
 * @category constructors
 * @since 1.0.0
 */
export const truncated = (text: string, limit: number): string => {
  if (text.length <= limit) return text
  const last = text.charCodeAt(limit - 1)
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? limit - 1 : limit)
}
