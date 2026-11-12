/**
 * The sealed-secret half of a credential store's compare-and-set.
 * @since 1.0.0
 */

/**
 * Whether `stored` still holds the sealed secret of `previous`, the record a
 * writer read. Ciphertext and nonce change together on every seal, so a record
 * removed and recreated at the same version does not match.
 * @category comparisons
 * @since 1.0.0
 */
export const sealsMatch = (
  stored: { readonly ciphertext: string; readonly nonce: string } | undefined,
  previous: { readonly ciphertext: string; readonly nonce: string } | undefined
): boolean => previous === undefined || (stored?.ciphertext === previous.ciphertext && stored?.nonce === previous.nonce)
