const encoder = new TextEncoder()
const CODE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/

/** Constant-time byte comparison using a length-padded XOR fold. */
export const timingSafeEqual = (left: Uint8Array, right: Uint8Array): boolean => {
  const maxLen = Math.max(left.byteLength, right.byteLength)
  let diff = left.byteLength ^ right.byteLength
  for (let i = 0; i < maxLen; i++) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0)
  }
  return diff === 0
}

/** Constant-time UTF-8 string comparison built over {@link timingSafeEqual}.
 * @throws {never}
 */
export const timingSafeEqualString = (left: string, right: string): boolean =>
  timingSafeEqual(encoder.encode(left), encoder.encode(right))

/** Validates RFC 7636 `code_verifier` format (43..128 unreserved ASCII chars).
 * @throws {never}
 */
export const validateCodeVerifier = (value: string): boolean => CODE_VERIFIER_PATTERN.test(value)

