/**
 * The one scorer label rule every rendering in this package shares.
 *
 * A scorer has two identities: `scorer` is the key, a digest of the scorer's
 * own declaration and the only thing a baseline matches on, and `scorerName`
 * is the readable name carried beside it. A digest is unreadable in a report
 * cell, a CI log line, or a diagnostic, so each of them prints the name with
 * the first eight key characters instead. Without a name there is nothing to
 * abbreviate the key down to, so the label is the key itself: a truncated
 * digest and no name would leave a reader nothing to match a baseline record
 * on. One rule is what keeps a report from naming one scorer two ways, an
 * inconclusive reason built by the runner and a Missing row built by the
 * reporter agree.
 *
 * @since 0.1.0
 */

/**
 * Renders `name (first 8 of the key)`, or the bare key when the scorer carries
 * no name.
 *
 * A scorer is a flow, and a flow declared without a name is an anonymous
 * function whose `name` is the empty string. That is an absent name, not a
 * name, so it labels as the key rather than as a blank followed by a digest.
 *
 * @since 0.1.0
 * @private
 */
export const scorerLabel = (
  identity: { readonly scorer: string; readonly scorerName?: string | undefined }
): string => {
  const name = identity.scorerName
  return name === undefined || name.length === 0 ? identity.scorer : `${name} (${identity.scorer.slice(0, 8)})`
}
