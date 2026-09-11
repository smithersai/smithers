/**
 * Constant-time byte comparison for credential and checksum digests.
 *
 * @since 0.1.0
 */

/**
 * Compares two byte strings without short-circuiting on the first difference.
 *
 * Only the length comparison returns early, and every caller compares
 * fixed-length SHA-256 digests, so the lengths are public.
 *
 * @category encoding
 * @since 0.1.0
 */
export const constantTimeEquals = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.byteLength !== right.byteLength) return false
  let difference = 0
  right.forEach((byte, index) => {
    difference |= byte ^ left[index]!
  })
  return difference === 0
}
