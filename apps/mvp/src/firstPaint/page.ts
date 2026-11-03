import { SESSION_ROUTE } from "../features/auth/contract"
import { FIRST_PAINT_GLOBAL, type Shell } from "./shell"

// The app's side of the first paint (src/firstPaint/shell.ts): it takes the shell the inline script left, adopts its
// `smithers-data` hold (src/wipe.ts `open`), and checks the paint's viewer against every session answer this page reads.

/** The shell the inline script left on `target`, taken once: none when it didn't paint for this route. */
export const takeShell = (target: object): Shell | undefined => {
  const holder = target as Record<string, unknown>
  const shell = holder[FIRST_PAINT_GLOBAL] as Shell | undefined
  delete holder[FIRST_PAINT_GLOBAL]
  return shell
}

/**
 * `fetch`, with every session answer it reads shown to `shell`: a paint read for anyone else goes in the task the
 * answer arrives in (devpriv FINAL §3.10, "the seed is used only until the page's first session answer").
 */
export const verifyingFetch = (fetch: typeof globalThis.fetch, shell: Shell | undefined): typeof globalThis.fetch => {
  if (shell === undefined) return fetch
  return async (input, init) => {
    const response = await fetch(input, init)
    const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost")
    if (url.pathname !== SESSION_ROUTE || !response.ok) return response
    // expected: an unreadable session body revokes, as a session that names no one would
    const body = (await response.clone().json().catch(() => undefined)) as { signedIn?: unknown; personId?: unknown } | undefined
    shell.verify({
      signedIn: body?.signedIn === true,
      personId: typeof body?.personId === "string" ? body.personId : undefined,
    })
    return response
  }
}

/**
 * Tells `shell` each location the app's router moves to, until the returned function stops it. A paint read for another
 * path or search goes then, whether or not the page's DOM changes.
 */
export const followRoute = (
  shell: Shell | undefined,
  history: { readonly subscribe: (listener: () => void) => () => void; readonly location: { readonly pathname: string; readonly search: string } },
): (() => void) | undefined => {
  if (shell === undefined) return undefined
  return history.subscribe(() => shell.routed(history.location.pathname, history.location.search))
}
