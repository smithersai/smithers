/** Join all in-flight reads before surfacing failure, so restore cannot race them. */
export const exportBatch = async <T>(items: readonly T[], run: (item: T) => Promise<void>, concurrency = 8): Promise<void> => {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error("Invalid export concurrency")
  let next = 0, failed = false, failure: unknown
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (!failed && next < items.length) {
      const item = items[next++]!
      try { await run(item) } catch (error) { if (!failed) { failed = true; failure = error } }
    }
  }))
  if (failed) throw failure
}
