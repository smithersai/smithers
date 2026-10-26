// When a page's shapes are up to date, read from Electric's own protocol (https://electric-sql.com/docs/api/http): a
// shape is caught up once a response to it carries the `electric-up-to-date` header, which ChatApi's proxy passes on
// (worker/Chat.ts). e2e/health.spec.ts waits on this instead of a sleep.

/** The parameters that move a request along a shape's log, not the ones that choose which shape it is. */
const CURSOR = new Set(["offset", "handle", "live", "cursor", "expired_handle", "live_sse", "experimental_live_sse", "log"])

/**
 * Which shape a request reads: its `/api/shapes/<name>` path and the parameters that choose its rows, sorted; undefined
 * for any other request.
 */
export const shapeOf = (url: string): string | undefined => {
  const parsed = new URL(url)
  if (!parsed.pathname.startsWith("/api/shapes/")) return undefined
  const chosen = [...parsed.searchParams].filter(([name]) => !CURSOR.has(name)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return chosen.length === 0 ? parsed.pathname : `${parsed.pathname}?${new URLSearchParams(chosen)}`
}

/** A page's shapes: each one it asked for, and whether it has settled. */
export class ShapeSync {
  private readonly shapes = new Map<string, boolean>()

  /** The page asked for `url`. */
  requested(url: string): void {
    const shape = shapeOf(url)
    if (shape !== undefined && !this.shapes.has(shape)) this.shapes.set(shape, false)
  }

  /**
   * The page got an answer to `url`. A shape settles once an answer says it is up to date, or once the server refuses
   * it (a 4xx other than Electric's 409, which tells the client to start the shape again): the app stops a refused
   * shape, and the test's check reports Chrome's console error about it.
   */
  answered(url: string, status: number, headers: Readonly<Record<string, string>>): void {
    const shape = shapeOf(url)
    if (shape === undefined) return
    const upToDate = status >= 200 && status < 300 && "electric-up-to-date" in headers
    const refused = status >= 400 && status < 500 && status !== 409
    if (upToDate || refused) this.shapes.set(shape, true)
    else if (!this.shapes.has(shape)) this.shapes.set(shape, false)
  }

  /** How many shapes the page has asked for. */
  get count(): number {
    return this.shapes.size
  }

  /** The shapes still catching up. */
  behind(): Array<string> {
    return [...this.shapes].filter(([, settled]) => !settled).map(([shape]) => shape)
  }
}
