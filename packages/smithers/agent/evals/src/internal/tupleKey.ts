/**
 * The one injective tuple encoder every key in this package is built with.
 *
 * Joining caller-supplied strings on a delimiter is not injective: under a NUL
 * separator the tuples `["a", "b" + NUL + "c"]` and `["a" + NUL + "b", "c"]`
 * produce one key, so two distinct score jobs could share an identity and two
 * distinct baseline records could sort as one. Encoding the tuple as a JSON
 * array keeps the components separated by the encoding itself, whatever they
 * contain.
 *
 * @since 0.1.0
 */

/**
 * Encodes a tuple of strings as one key.
 *
 * @since 0.1.0
 * @private
 */
export const tupleKey = (...parts: ReadonlyArray<string>): string => JSON.stringify(parts)
