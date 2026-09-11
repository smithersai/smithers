/**
 * Hexadecimal digest decoding for SHA-256 comparisons and R2 checksums.
 *
 * @since 0.1.0
 */

/**
 * Decodes a lowercase hexadecimal digest into its bytes.
 *
 * @category encoding
 * @since 0.1.0
 */
export const digestBytes = (digest: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(
    { length: digest.length / 2 },
    (_, index) => Number.parseInt(digest.slice(index * 2, index * 2 + 2), 16)
  )
