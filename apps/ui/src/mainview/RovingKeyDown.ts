/*
 * One roving-focus keyboard vocabulary for the app's menus, rows and tablists.
 *
 * Seven handlers — the three composer menus, the connectors rows, the
 * workflow-repo list, the session tablist and the targets table — each wrote
 * the same ArrowUp/ArrowDown wrap over an index-aligned list, and two of them
 * were byte-identical (§ review ui-cards-tabs/maintainability/5). They differ
 * only in ways a caller can state: whether the ends wrap, whether Home and End
 * jump to them, and whether Escape closes the list.
 *
 * The helper is index math alone. It never reads the DOM and never learns what
 * a list's items are: a list that skips entries — a menu with a disabled row —
 * roves over the enabled indices it already builds and maps the answer back.
 */

/** What a keydown asks a roving list to do. */
export type RovingMove =
  | { readonly kind: "move"; readonly index: number }
  | { readonly kind: "escape" }
  | { readonly kind: "ignore" }

const IGNORE: RovingMove = { kind: "ignore" }

/**
 * The index the ring lands on, given the key and where it is now.
 *
 * `ignore` means the key is not the list's to handle, so the caller must leave
 * the browser default alone — an empty list ignores every key but Escape, the
 * way each of the seven handlers already returned before calling preventDefault.
 */
export const rovingKeyDown = (
  key: string,
  options: {
    readonly count: number
    readonly current: number
    /** The ends wrap onto each other; a clamping list stops at them instead. */
    readonly loop?: boolean
    /** Home and End jump to the ends; off, they stay the browser's scroll. */
    readonly ends?: boolean
    /** Escape closes the list — a menu's key, never a tablist's. */
    readonly escape?: boolean
  }
): RovingMove => {
  const { count, current, loop = true, ends = false, escape = false } = options
  /* Escape answers before the count check: a menu closes even with nothing to rove. */
  if (escape && key === "Escape") return { kind: "escape" }
  if (count <= 0) return IGNORE
  const last = count - 1
  if (ends && key === "Home") return { kind: "move", index: 0 }
  if (ends && key === "End") return { kind: "move", index: last }
  const step = key === "ArrowDown" ? 1 : key === "ArrowUp" ? -1 : 0
  if (step === 0) return IGNORE
  const moved = current + step
  return {
    kind: "move",
    index: loop ? ((moved % count) + count) % count : Math.min(Math.max(moved, 0), last)
  }
}
