/*
 * Lane L3b — the ONE place a minted desktop credential is allowed to live.
 *
 * `POST /api/repos/{o}/{r}/workspaces/{id}/desktop/session` answers a `token`,
 * a `vnc_password`, and an ABSOLUTE `stream_url` that already carries both.
 * That answer is a credential, so it must never reach a TanStack DB
 * collection, a transcript row, or a card payload — every one of those is
 * persisted by the SQLite/localStorage backend and would write the password
 * of a live VM to disk.
 *
 * AGENTS.md says React components are projections and application state lives
 * in collections. A minted session is deliberately NOT application state: it
 * is a short-lived secret whose only consumer is the mounted `<iframe>`'s
 * `src`. So it lives here, in module memory, and the facet reads it through
 * `useSyncExternalStore` — React's own external-store hook, no `useEffect`,
 * no lifecycle synchronisation.
 *
 * Exactly one mint is held at a time. It is dropped by the acts that end the
 * facet's life — leaving the Desktop facet, deleting the workspace, disposing
 * the seam — so no token outlives the surface that showed it.
 */

/** A minted desktop session, as the POST answered it. Never serialised, never stored. */
export interface DesktopStream {
  readonly workspaceId: string
  /**
   * The absolute, already-credentialed `stream_url`. It embeds the session
   * token and the VNC password, which is why it is only ever an iframe `src`.
   */
  readonly url: string
  readonly sessionId: string
  /** When the session lapses (plue mints for 12 h); null when the answer named none. */
  readonly expiresAt: string | null
}

let held: DesktopStream | null = null
const listeners = new Set<() => void>()

const announce = (): void => {
  for (const listener of [...listeners]) listener()
}

/** Subscribe a mounted facet to the held mint (the `useSyncExternalStore` subscribe half). */
export const subscribeDesktopStream = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

/**
 * The mint for one workspace, or null. The reference is stable while the mint
 * is, which is what `useSyncExternalStore` needs from a snapshot.
 */
export const readDesktopStream = (workspaceId: string): DesktopStream | null =>
  held !== null && held.workspaceId === workspaceId ? held : null

/** Hold the freshly minted session, replacing whatever was held (a rotate swaps the src). */
export const holdDesktopStream = (stream: DesktopStream): void => {
  held = stream
  announce()
}

/** Drop the mint: the facet closed, the workspace went away, or the seam was disposed. */
export const dropDesktopStream = (workspaceId?: string): void => {
  if (held === null) return
  if (workspaceId !== undefined && held.workspaceId !== workspaceId) return
  held = null
  announce()
}
