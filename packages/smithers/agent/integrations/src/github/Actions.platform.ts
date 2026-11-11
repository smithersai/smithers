/**
 * The SHA-256 digest behind a run-scoped write-back key.
 *
 * @since 1.0.0
 */

/**
 * SHA-256 of `text` as UTF-8.
 *
 * @since 1.0.0
 */
export const digestRunKey = (text: string): Promise<ArrayBuffer> =>
  crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
