import type { PageWipe } from "../wipe"
import { boundFetch, reopenDue } from "../device/identity"
import { SESSION_ROUTE, SIGN_OUT_ROUTE } from "../features/auth/contract"
import { CHATAPI_ORIGIN } from "./chatApi"

/** How long main.tsx's `reopen` holds back a second reopen from the same tab. */
const REOPEN_WITHIN = 60_000
const REOPENED = "smithers-identity-reopened"

/**
 * One browser on a device, signed in as `person`, for tests of a write ChatApi refuses `401`. Its tabs' transport is the
 * page's real one (`boundFetch`, as main.tsx builds it) around the harness's fetch (`TabOptions.transport`):
 * - while `cookie` is `"unread"`, ChatApi refuses the requests `refuses` matches `401`, as it does when it can't tell
 *   who asked (a cookie another tab's sign-in swapped, or a session that ended);
 * - the session read answers as ChatApi's own does, or signed out while `session` is `"signed_out"`;
 * - reopening is main.tsx's: at most once a minute from this browser's tab, by a mark that outlives the tab's reloads
 *   as sessionStorage does. `reopens` counts the reopens that went, `suppressed` the ones the minute held back;
 * - while `holdSignOut` is set, a sign-out ends the session at once (the session read says signed out) and its `204`
 *   waits for `releaseSignOut`.
 *
 * Signing in again is the browser's sign-in redirect: a test sets `cookie` to `"read"` and opens the tab again.
 */
export const browserSession = (person: string, refuses: (request: Request) => boolean) => {
  const state = {
    cookie: "unread" as "unread" | "read",
    session: "chatapi" as "chatapi" | "signed_out",
    holdSignOut: false,
    /** Requests ChatApi refused 401, and requests `refuses` matched that went through once the cookie was read. */
    refusals: 0,
    delivered: 0,
    reopens: 0,
    suppressed: 0,
    /** Sign-outs ChatApi took whose answer is held. */
    signingOut: 0,
  }
  // The tab's sessionStorage, which outlives its reloads.
  const marks = new Map<string, string>()
  const storage = { getItem: (key: string) => marks.get(key) ?? null, setItem: (key: string, value: string) => void marks.set(key, value) }
  let release: () => void = () => {}
  const signOutReleased = () => new Promise<void>((resolve) => (release = resolve))
  const transport = (fetch: typeof globalThis.fetch, page?: PageWipe) =>
    boundFetch(async (input, init) => {
      const request = new Request(input, init)
      const path = new URL(request.url).pathname
      if (path === SESSION_ROUTE && state.session === "signed_out") return Response.json({ signedIn: false, available: true })
      if (path === SIGN_OUT_ROUTE && state.holdSignOut) {
        // ChatApi took it and ended the session: its session read says signed out from here, and its answer is held.
        const released = signOutReleased()
        state.session = "signed_out"
        state.signingOut++
        await released
        return new Response(null, { status: 204 })
      }
      if (refuses(request)) {
        if (state.cookie === "unread") {
          state.refusals++
          return Response.json({ code: "authentication" }, { status: 401 })
        }
        state.delivered++
      }
      return fetch(request)
    }, {
      origin: CHATAPI_ORIGIN,
      principal: () => person,
      signOut: page?.signOut,
      reauthorize: async () => {
        if (!reopenDue(storage, REOPENED, REOPEN_WITHIN, Date.now())) {
          state.suppressed++
          return false
        }
        const reopened = page === undefined ? true : await page.reopen("identity_reopen")
        if (reopened) { storage.setItem(REOPENED, String(Date.now())); state.reopens++ }
        return reopened
      },
    })
  return {
    state,
    transport,
    /** Lets a held sign-out's answer through. */
    releaseSignOut: () => release(),
  }
}

export type BrowserSession = ReturnType<typeof browserSession>
