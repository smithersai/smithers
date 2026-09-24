/*
 * Test support: an upstream body far larger than any ceiling this Worker
 * reads under. It records how many bytes a reader pulled and whether the
 * reader cancelled it, so a test can prove a bounded read stopped early and
 * released the upstream instead of buffering the whole answer.
 */

export const FLOOD_CHUNK_BYTES = 64 * 1024

/** The flood ends by itself here, so an unbounded read fails its test instead of hanging it. */
const FLOOD_TOTAL_BYTES = 32 * 1024 * 1024

export const floodStream = () => {
  const seen = { pulled: 0, cancelled: false }
  const chunk = new Uint8Array(FLOOD_CHUNK_BYTES).fill(0x78)
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (seen.pulled >= FLOOD_TOTAL_BYTES) return controller.close()
      seen.pulled += chunk.byteLength
      controller.enqueue(chunk)
    },
    cancel() {
      seen.cancelled = true
    }
  })
  return { stream, seen }
}
