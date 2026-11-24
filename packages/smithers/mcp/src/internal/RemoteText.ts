/**
 * Server-authored prose made safe to place in text a model or a person reads.
 *
 * @since 1.0.0-rc.19
 */

// Cc is C0, DEL and C1; Cf is the bidi overrides and isolates, zero-width
// marks and soft hyphen; Cs is a lone surrogate, which UTF-8 encoding would
// replace; Zl and Zp are U+2028 and U+2029. Line feed and tab are kept: prose
// is laid out with them and neither hides or reorders text.
const invisible = /(?![\n\t])[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu

/**
 * Removes control and format characters from a server-supplied description,
 * keeping line feeds and tabs. A bidi override or a zero-width mark can make
 * the text a person reviews differ from the text a model reads.
 *
 * @category conversions
 * @since 1.0.0-rc.19
 */
export const visible = (text: string): string => text.replace(invisible, "")
