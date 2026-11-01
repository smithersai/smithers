/** A vertical interval occupied by page chrome or a primary action. */
export type ToastObstacle = { readonly top: number; readonly bottom: number };

/**
 * First gap below the anchor that fits the stack; otherwise the largest gap,
 * with scrolling inside the overlay. Inputs and output are viewport pixels.
 * Six pixels separate the stack from controls, including its entrance slide.
 */
export function toastClearance(top: number, height: number, viewportHeight: number, obstacles: readonly ToastObstacle[]): { top: number; maxHeight: number } {
  const end = viewportHeight - 6;
  let cursor = Math.max(6, top);
  let best = { top: cursor, maxHeight: 0 };
  for (const obstacle of [...obstacles, { top: viewportHeight, bottom: viewportHeight }].sort((a, b) => a.top - b.top)) {
    if (obstacle.bottom + 6 <= cursor) continue;
    const available = Math.max(0, Math.min(end, obstacle.top - 6) - cursor);
    if (available >= height) return { top: cursor, maxHeight: available };
    if (available > best.maxHeight) best = { top: cursor, maxHeight: available };
    cursor = Math.max(cursor, obstacle.bottom + 6);
  }
  // A scrolled-off anchor may have no room below it; search the visible page once.
  return best.maxHeight === 0 && top > 6 ? toastClearance(6, height, viewportHeight, obstacles) : best;
}
