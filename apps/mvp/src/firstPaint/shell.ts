import { FIRST_PAINT_SEGMENT, type FirstPaint, type FirstPaintIssue } from "../features/issues/contract"
import { DATA_LOCK, WIPE } from "../wipe"

// The first paint (docs/features/issues.md#first-paint, devpriv FINAL §3.10): a cold issue page's heading, or an issues
// list's first page, painted by the shell's inline script before the app's bundle runs. vite.config.ts bundles this
// module into index.html as one inline script, so it starts as the document parses.
//
// The private bytes exist only inside one uninterrupted shared hold of `smithers-data`, the Web Lock a sign-out's wipe
// waits on (src/wipe.ts), and only in this module's memory and the painted node: never in any device store. In order:
// - no request when the wipe mark is present or unreadable, or the route isn't an issue page or an unfiltered list;
// - hold `smithers-data`, shared; once granted, read the mark again (present: let go, stop);
// - read `first-paint` with the cookie, `no-store`; its deadline is `sentAt + (expiresAt - serverNow)`, and at most
//   30 s from the paint without a hand-over;
// - paint with `textContent` only, while nothing revoked it, the mark is absent, the deadline is ahead and the page is
//   visible; a hidden page hides the node, and showing it again checks the deadline and the mark first;
// - revoke (remove the node, drop the answer, abort what is pending, let go of the hold) on a wipe-channel message, the
//   mark appearing, `pagehide`, the deadline, or the page's first session answer naming someone else (`verify`);
// - hand over: the app's page adopts the hold as its own `smithers-data` hold with no gap (`handOver`, src/wipe.ts
//   `open`), and the node goes once the app shows the page itself (`data-first-paint="settled"`) or the route changes;
// - it never blocks a person: it covers the empty page only until the app renders anything to act on. From then on it
//   sits in the page's flow, in the slot the page left for it (`data-first-paint-slot`), else after the app.

/** The global the shell leaves for the app: the shell's hand-over, its viewer check and its revocation. */
export const FIRST_PAINT_GLOBAL = "__smithersFirstPaint"

/** The painted node's id, outside `#root` so React's first render never replaces it. */
export const FIRST_PAINT_NODE = "first-paint"

/** The attribute an app page sets once it shows the page the first paint stood in for, or why it can't. */
export const SETTLED_ATTRIBUTE = "data-first-paint"

/** The empty element an app page leaves where its rows or title will show, for the paint to sit in until they do. */
export const SLOT_ATTRIBUTE = "data-first-paint-slot"

/** Set on the node once it sits in the page's flow: it covers nothing, and the page's controls stay usable. */
export const PLACED_ATTRIBUTE = "data-placed"

/** What a person can act on: once the app has rendered any of it, the paint never covers the page. */
const ACTIONABLE = "#root main, #root button, #root input, #root a"

/** The longest a paint stays without a hand-over, from when it painted. */
export const HAND_OVER_WITHIN_MS = 30_000

/** The longest the shell waits for the answer: past the route's own 2.5 s deadline, with a moment for the network. */
export const ANSWER_WITHIN_MS = 3_500

/** What the shell paints: an issue's heading, or an unfiltered issues list's first page. */
export type Route =
  | { readonly kind: "issue"; readonly owner: string; readonly name: string; readonly number: number }
  | { readonly kind: "list"; readonly owner: string; readonly name: string }

const NAME = /^[A-Za-z0-9_.-]{1,100}$/

/** The route `pathname` and `search` name, when the shell paints for it. A list with any search paints nothing. */
export const routeOf = (pathname: string, search: string): Route | undefined => {
  const match = /^\/([^/]+)\/([^/]+)\/issues(?:\/([1-9]\d{0,9}))?\/?$/.exec(pathname)
  if (match === null || !NAME.test(match[1]!) || !NAME.test(match[2]!)) return undefined
  const [, owner, name, number] = match as unknown as [string, string, string, string | undefined]
  if (number !== undefined) return { kind: "issue", owner, name, number: Number(number) }
  return search === "" ? { kind: "list", owner, name } : undefined
}

/** The first-paint request's URL for `route`. */
export const requestOf = (route: Route): string =>
  `/api/repos/${encodeURIComponent(route.owner)}/${encodeURIComponent(route.name)}/${FIRST_PAINT_SEGMENT}?${
    route.kind === "issue" ? `issue=${route.number}` : "list=all"
  }`

const isIssue = (value: unknown): value is FirstPaintIssue => {
  const issue = value as FirstPaintIssue
  return typeof issue === "object" && issue !== null && typeof issue.number === "number" && typeof issue.title === "string" &&
    typeof issue.state === "string" && (issue.author === null || typeof issue.author === "string")
}

/** `body` as a first paint for `route`, or `undefined` when it isn't one. */
export const answerOf = (body: unknown, route: Route): FirstPaint | undefined => {
  const answer = body as FirstPaint
  if (typeof answer !== "object" || answer === null || typeof answer.serverNow !== "number") return undefined
  if (answer.viewer !== null && typeof answer.viewer !== "string") return undefined
  if (answer.expiresAt !== undefined && typeof answer.expiresAt !== "number") return undefined
  if (route.kind === "issue") return isIssue(answer.issue) && answer.issue.number === route.number ? answer : undefined
  return Array.isArray(answer.list) && answer.list.every(isIssue) ? answer : undefined
}

/**
 * The local time the answer stops being usable: `sentAt + (expiresAt - serverNow)`, so a fixed browser-clock offset
 * cancels and a slow answer only brings it earlier; `Infinity` without an `expiresAt` (the hand-over cap still applies).
 */
export const deadlineOf = (answer: FirstPaint, sentAt: number): number =>
  answer.expiresAt === undefined ? Infinity : sentAt + (answer.expiresAt - answer.serverNow)

/** What the page's session answer says: signed in as `personId`, or not. */
export interface SessionAnswer {
  readonly signedIn: boolean
  readonly personId?: string | undefined
}

/** Whether a paint read for `viewer` may stay under `session`: a public read for anyone; a person's only for them. */
export const sameViewer = (viewer: string | null, session: SessionAnswer): boolean =>
  viewer === null || (session.signedIn && session.personId === viewer)

/** Why a paint went. */
export type Ended =
  | "revoked"
  | "released"
  | "wipe"
  | "mark"
  | "pagehide"
  | "deadline"
  | "hand_over_timeout"
  | "person_mismatch"
  | "handed_over"
  | "navigated"

/** What the app reads of the shell (`window.__smithersFirstPaint`). */
export interface Shell {
  /**
   * The app's page takes over the shell's `smithers-data` hold: its release, when the shell holds it and the mark is
   * still absent. Waits for a pending grant; a wipe, revocation or refused grant resolves to `undefined`.
   */
  readonly handOver: () => Promise<(() => void) | undefined>
  /** The page's session answer: a paint read for anyone else goes. */
  readonly verify: (session: SessionAnswer) => void
  /**
   * The router's location: a paint read for any other path or search goes in that task. A navigation between two pages
   * whose DOM doesn't change, such as two issues still loading, reaches the shell only this way.
   */
  readonly routed: (pathname: string, search: string) => void
  /** Removes the node and drops the answer, and lets go of the hold unless the page adopted it. */
  readonly revoke: (why?: Ended) => void
  /** How the shell's paint stands, for the app's boot record: `painted`, `none`, or why it ended. */
  readonly outcome: () => "pending" | "painted" | "none" | Ended
}

/** The browser the shell runs in: main.tsx's tests give fakes. */
export interface ShellHost {
  readonly window: Pick<Window, "addEventListener" | "removeEventListener" | "setTimeout" | "clearTimeout"> & {
    readonly location: Pick<Location, "pathname" | "search">
  }
  readonly document: Pick<Document, "createElement" | "body" | "visibilityState" | "addEventListener" | "removeEventListener" | "querySelector">
  readonly locks: Pick<LockManager, "request">
  readonly fetch: typeof fetch
  readonly now: () => number
  readonly marks: Pick<Storage, "getItem">
  readonly channel: (name: string) => Pick<BroadcastChannel, "close"> & { onmessage: ((event: MessageEvent) => void) | null }
  readonly observe: (callback: () => void) => { readonly disconnect: () => void }
  readonly mark: (name: string) => void
}

/** `path` without its trailing slash. */
const bare = (path: string) => path.replace(/\/$/, "")

/** Whether the wipe mark is absent: `false` when present or unreadable. */
const unmarked = (marks: ShellHost["marks"]) => {
  try {
    return marks.getItem(WIPE) === null
  } catch {
    // expected: storage that refuses reads can't prove the device unmarked, so nothing private is read
    return false
  }
}

/** The heading or the list as plain DOM, with `textContent` only. */
const render = (doc: ShellHost["document"], route: Route, answer: FirstPaint): HTMLElement => {
  const node = doc.createElement("div")
  node.id = FIRST_PAINT_NODE
  const main = doc.createElement("div")
  main.className = "first-paint-body"
  node.append(main)
  const repository = doc.createElement("p")
  repository.className = "first-paint-repo"
  repository.textContent = `${route.owner}/${route.name}`
  main.append(repository)
  const path = (number: number) => `/${route.owner}/${route.name}/issues/${number}`
  // `answerOf` checked that the answer holds what its route asked for.
  if (route.kind === "issue") {
    const issue = answer.issue!
    const heading = doc.createElement("h1")
    heading.textContent = `${issue.title} #${issue.number}`
    const meta = doc.createElement("p")
    meta.className = "first-paint-meta"
    meta.textContent = [issue.state === "open" ? "Open" : "Closed", issue.author].filter((part) => part !== null).join(" · ")
    main.append(heading, meta)
  } else {
    const heading = doc.createElement("h1")
    heading.className = "first-paint-list-title"
    heading.textContent = "Issues"
    const list = doc.createElement("ul")
    for (const issue of answer.list!) {
      const row = doc.createElement("li")
      const link = doc.createElement("a")
      link.href = path(issue.number)
      link.textContent = issue.title
      const number = doc.createElement("span")
      number.textContent = ` #${issue.number}`
      row.append(link, number)
      list.append(row)
    }
    main.append(heading, list)
  }
  return node
}

/** Starts the shell for the page's route, or does nothing; answers the shell the app reads, when there is one. */
export const startShell = (host: ShellHost): Shell | undefined => {
  const route = routeOf(host.window.location.pathname, host.window.location.search)
  if (route === undefined || !unmarked(host.marks)) return undefined
  const { window: win, document: doc } = host

  let state: "pending" | "painted" | "none" | Ended = "pending"
  let granted = false
  let grantSettled!: () => void
  const ready = new Promise<void>((resolve) => { grantSettled = resolve })
  let adopted = false
  let release: (() => void) | undefined
  let node: HTMLElement | undefined
  let deadline = Infinity
  // When the paint stops showing: the deadline, or the hand-over cap from when it painted, whichever is first.
  let showUntil = Infinity
  // The answer, while it may be shown; and the page's last session answer, which an answer arriving later must agree with.
  let seed: FirstPaint | undefined
  let session: SessionAnswer | undefined
  const asking = new AbortController()
  const timers: Array<number> = []
  const wipes = host.channel(WIPE)
  // The route the read was for: the page moving on from it ends the paint, before or after it shows.
  const { pathname } = win.location

  const letGo = () => {
    asking.abort()
    if (!adopted) release?.()
    release = undefined
  }
  const listeners: Array<() => void> = []
  const stopListening = () => {
    for (const stop of listeners.splice(0)) stop()
    for (const timer of timers.splice(0)) win.clearTimeout(timer)
    wipes.onmessage = null
    wipes.close()
  }
  const end = (why: Ended | "none") => {
    if (state !== "pending" && state !== "painted") return
    state = why
    grantSettled()
    node?.remove()
    node = undefined
    seed = undefined
    letGo()
    stopListening()
    host.mark(`smithers.first_paint.${why}`)
  }

  // Still the page the read was for: the same path, whatever its trailing slash (the router's first replace drops it);
  // for a list, no search, as any search filters what it shows. A search says nothing of which issue a page shows.
  const sameRoute = (nextPath: string, nextSearch: string) =>
    bare(nextPath) === bare(pathname) && (route.kind === "issue" || nextSearch === "")
  const routed = (nextPath: string, nextSearch: string) => {
    if (!sameRoute(nextPath, nextSearch)) end("navigated")
  }
  wipes.onmessage = () => end("wipe")
  const on = <K extends string>(target: { addEventListener: (k: K, l: (e: never) => void) => void; removeEventListener: (k: K, l: (e: never) => void) => void }, kind: K, listener: (event: never) => void) => {
    target.addEventListener(kind, listener)
    listeners.push(() => target.removeEventListener(kind, listener))
  }
  on(win as never, "storage", ((event: StorageEvent) => {
    if (event.key === WIPE && event.newValue !== null) end("mark")
    else if (event.key === null) end("mark")
  }) as never)
  on(win as never, "pagehide", (() => end("pagehide")) as never)
  // Back or forward, before the app's router exists to say so.
  on(win as never, "popstate", (() => routed(win.location.pathname, win.location.search)) as never)
  // Hidden or frozen, the node hides; visible or resumed, the clock and the mark are checked first, as a hidden or
  // frozen page's timers may not have run.
  const hide = () => {
    if (node !== undefined) node.hidden = true
  }
  const recheck = () => {
    if (node === undefined || doc.visibilityState !== "visible") return
    if (host.now() >= showUntil) return end(showUntil === deadline ? "deadline" : "hand_over_timeout")
    if (!unmarked(host.marks)) return end("mark")
    node.hidden = false
  }
  on(doc as never, "visibilitychange", (() => (doc.visibilityState === "visible" ? recheck() : hide())) as never)
  on(doc as never, "freeze", hide as never)
  on(doc as never, "resume", recheck as never)

  /** Whether the paint should go now: the route moved on, or the app's page already shows itself. */
  const superseded = () =>
    !sameRoute(win.location.pathname, win.location.search)
      ? "navigated"
      : doc.querySelector(`#root [${SETTLED_ATTRIBUTE}="settled"]`) !== null
      ? "handed_over"
      : undefined

  // Where the node sits: over the empty page, until there is something to act on; then in the page's slot, or after
  // the app. A slot the app took away with the node in it is the app showing the page itself.
  const place = () => {
    const shown = node!
    const slot = doc.querySelector(`#root [${SLOT_ATTRIBUTE}]`)
    if (slot !== null) {
      if (shown.parentNode !== slot) {
        shown.setAttribute(PLACED_ATTRIBUTE, "")
        slot.append(shown)
      }
      return
    }
    if (!shown.isConnected) return end("handed_over")
    if (!shown.hasAttribute(PLACED_ATTRIBUTE) && doc.querySelector(ACTIONABLE) !== null) {
      shown.setAttribute(PLACED_ATTRIBUTE, "")
      doc.body.append(shown)
    }
  }

  const paint = (answer: FirstPaint) => {
    if (state !== "pending") return
    if (!unmarked(host.marks)) return end("mark")
    if (host.now() >= deadline) return end("deadline")
    if (session !== undefined && !sameViewer(answer.viewer, session)) return end("person_mismatch")
    // An answer that arrives after the app showed the page, or after the route moved on, is never painted.
    const already = superseded()
    if (already !== undefined) return end(already)
    seed = answer
    node = render(doc, route, answer)
    node.hidden = doc.visibilityState !== "visible"
    doc.body.prepend(node)
    state = "painted"
    host.mark("smithers.first_paint.painted")
    showUntil = Math.min(deadline, host.now() + HAND_OVER_WITHIN_MS)
    timers.push(win.setTimeout(() => end(showUntil === deadline ? "deadline" : "hand_over_timeout"), showUntil - host.now()))
    // The app's page shows itself, or the route moves on: the node goes, and so does the answer.
    const watch = host.observe(() => {
      const why = superseded()
      if (why !== undefined) return end(why)
      place()
    })
    listeners.push(() => watch.disconnect())
    place()
  }

  // The hold first, then the read; nothing private exists outside it.
  void host.locks.request(DATA_LOCK, { mode: "shared", signal: asking.signal }, () => {
    granted = true
    grantSettled()
    return new Promise<void>((resolve) => {
      // Revoked while it waited: let go at once.
      if (state !== "pending") return resolve()
      release = resolve
      if (!unmarked(host.marks)) return end("mark")
      const sentAt = host.now()
      timers.push(win.setTimeout(() => asking.abort(), ANSWER_WITHIN_MS))
      host.fetch(requestOf(route), { credentials: "same-origin", cache: "no-store", signal: asking.signal })
        .then((response) => (response.status === 200 ? response.json() : undefined))
        .then((body) => {
          const answer = body === undefined ? undefined : answerOf(body, route)
          if (answer === undefined) return end("none")
          deadline = deadlineOf(answer, sentAt)
          paint(answer)
        })
        // recorded: smithers.first_paint.none on the boot timeline; the app's own page follows as before
        .catch(() => end("none"))
    })
  }).catch(() => {
    // An aborted request already ended; a refused grant must also release an app waiting to adopt it.
    end("none")
  })

  return {
    handOver: async () => {
      if (state !== "pending" && state !== "painted") return undefined
      if (!unmarked(host.marks)) {
        end("mark")
        return undefined
      }
      if (!granted) {
        // A fast bundle can reach this before WebKit dispatches the lock callback. Keep the shell's queued
        // request: adopting an ungranted hold would be unsafe, and revoking it loses the first paint entirely.
        host.mark("smithers.first_paint.hand_over_waiting")
        await ready
        if (state !== "pending" && state !== "painted") return undefined
        host.mark("smithers.first_paint.hand_over_ready")
      }
      if (!unmarked(host.marks)) {
        end("mark")
        return undefined
      }
      // Granted while pending: the callback kept its release. The page's release ends the paint first, so no private
      // byte outlives the hold.
      adopted = true
      const held = release!
      return () => {
        end("released")
        held()
      }
    },
    verify: (answer) => {
      session = answer
      if (seed !== undefined && !sameViewer(seed.viewer, answer)) end("person_mismatch")
    },
    routed,
    revoke: (why = "revoked") => end(why),
    outcome: () => state,
  }
}
