/**
 * Body cancellation for requests and objects the worker refuses.
 *
 * @since 0.1.0
 */

/**
 * Cancels a body the worker will not read without letting cleanup mask the answer.
 *
 * @category runtime
 * @since 0.1.0
 */
export const discardBody = (body: ReadableStream<Uint8Array> | null): Promise<void> => {
  if (body === null) return Promise.resolve()
  try {
    void body.cancel().catch(() => undefined)
  } catch {
    // A body that cannot be cancelled is already unusable; the answer stands.
  }
  return Promise.resolve()
}
