/**
 * Pure scoring helpers for semantic recall.
 *
 * @since 0.1.0
 */

/** Cosine similarity between two embedding vectors; 0 for empty, mismatched, or zero vectors. */
export const cosine = (left: ArrayLike<number>, right: ArrayLike<number>): number => {
  if (left.length !== right.length || left.length === 0) return 0
  let dot = 0
  let leftMagnitude = 0
  let rightMagnitude = 0
  for (let index = 0; index < left.length; index++) {
    const leftValue = left[index] ?? 0
    const rightValue = right[index] ?? 0
    dot += leftValue * rightValue
    leftMagnitude += leftValue * leftValue
    rightMagnitude += rightValue * rightValue
  }
  return leftMagnitude === 0 || rightMagnitude === 0 ? 0 : dot / Math.sqrt(leftMagnitude * rightMagnitude)
}

/** The exponential recency weight: 1 at `updatedAtMs`, halving every `halfLifeMs`. */
export const recency = (updatedAtMs: number, nowMs: number, halfLifeMs: number): number =>
  2 ** (-Math.max(0, nowMs - updatedAtMs) / halfLifeMs)
