/**
 * Limits streamed HTTP payloads during collection.
 *
 * @since 1.0.0-rc.18
 */

import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"

/**
 * Collects streams under a shared ceiling, even when input arrives one byte at a time.
 *
 * @category constructors
 * @since 1.0.0-rc.18
 */
export const byteBudget = <E>(limit: number, exceeded: E) => {
  let remaining = limit
  return <F>(stream: Stream.Stream<Uint8Array, F>) => {
    let buffer = new Uint8Array()
    let used = 0
    return Stream.runForEach(stream, (chunk) => {
      if (chunk.length > remaining) return Effect.fail(exceeded)
      const end = used + chunk.length
      if (end > buffer.length) {
        const next = new Uint8Array(Math.min(used + remaining, Math.max(end, buffer.length * 2, 256)))
        next.set(buffer)
        buffer = next
      }
      buffer.set(chunk, used)
      used = end
      remaining -= chunk.length
      return Effect.void
    }).pipe(Effect.map(() => buffer.subarray(0, used)))
  }
}
