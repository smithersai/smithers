/**
 * Bounded diagnostics for values thrown during canonical encoding.
 *
 * @since 0.1.0
 */

/** Best-effort detail for an arbitrary thrown value.
 * @since 0.1.0
 * @private
 */
export const describe = (cause: unknown): string => {
  try {
    return String(cause instanceof Error ? cause.message : cause).slice(0, 1024)
  } catch {
    return "Unable to describe thrown value"
  }
}
