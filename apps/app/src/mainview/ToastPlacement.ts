export type Rect = { x: number; y: number; width: number; height: number }
const right = (r: Rect) => r.x + r.width
const bottom = (r: Rect) => r.y + r.height
const intersects = (a: Rect, b: Rect) => a.x < right(b) && right(a) > b.x && a.y < bottom(b) && bottom(a) > b.y
const contains = (a: Rect, b: Rect) => a.x <= b.x && a.y <= b.y && right(a) >= right(b) && bottom(a) >= bottom(b)

/** Prefer outside the modal; any overlay must leave every control unobstructed. */
export function placeToast(bounds: Rect, size: Pick<Rect, "width" | "height">, modal: Rect, controls: readonly Rect[], gap: number): Rect | null {
  // DOMRect's dimensions are accessors, so copy them explicitly before spreading.
  size = { width: size.width, height: size.height }
  const obstacles = controls.map(r => ({ x: r.x - gap, y: r.y - gap, width: r.width + gap * 2, height: r.height + gap * 2 }))
  const x = right(bounds) - size.width
  const candidates = [
    { x, y: bounds.y, ...size },
    { x, y: bottom(modal) + gap, ...size },
    { x, y: modal.y - gap - size.height, ...size },
  ]
  for (const [index, rect] of candidates.entries()) {
    if (index === 0 && rect.x < right(modal) + gap) continue
    if (contains(bounds, rect) && !obstacles.some(control => intersects(rect, control))) return rect
  }

  // Subtract control boxes into maximal free rectangles. This also finds space
  // to the left or inside a full-screen modal without knowing its component.
  let free = [bounds]
  for (const control of obstacles) {
    const next = free.flatMap(r => !intersects(r, control) ? [r] : [
      { ...r, width: control.x - r.x },
      { ...r, x: right(control), width: right(r) - right(control) },
      { ...r, height: control.y - r.y },
      { ...r, y: bottom(control), height: bottom(r) - bottom(control) },
    ].filter(part => part.width > 0 && part.height > 0))
    free = next.filter((r, i) => !next.some((other, j) => i !== j && contains(other, r) && (!contains(r, other) || j < i)))
  }
  const full = free.filter(r => r.width >= size.width && r.height >= size.height)
    .sort((a, b) => a.y - b.y || right(b) - right(a))[0]
  if (full) return { x: right(full) - size.width, y: full.y, ...size }

  // If no complete toast fits, keep its normal width and scroll in the largest
  // safe region. If even that is impossible, leave the toast pending until the
  // modal changes/closes rather than covering a control or truncating its width.
  const scroll = free.filter(r => r.width >= size.width)
    .sort((a, b) => b.height - a.height || right(b) - right(a))[0]
  return scroll ? { x: right(scroll) - size.width, y: scroll.y, width: size.width, height: Math.min(size.height, scroll.height) } : null
}
