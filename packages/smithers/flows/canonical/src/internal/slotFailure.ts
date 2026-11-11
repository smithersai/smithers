/**
 * The shared failure boundary for native slot inspection.
 *
 * A TypeError means a receiver lacks the expected slot. Other failures do
 * not establish its brand and must propagate before any negative caching.
 *
 * @since 0.1.0
 */

/** Propagates every failure except a native missing-slot TypeError.
 * @since 0.1.0
 * @private
 */
export const rethrowUnlessMissingSlot = (cause: unknown): void => {
  if (!(cause instanceof TypeError)) throw cause
}
