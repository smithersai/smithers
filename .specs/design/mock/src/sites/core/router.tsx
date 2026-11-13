/*
 * The site mocks' router. A route is "<host>/<path>", so one bundle holds effeck.dev and smithers.sh pages and links
 * between them stay inside the mock: #/effeck.dev/, #/smithers.sh/smithersai/smithers/blob/main/README.md?L=4.
 * Patterns use :name for one segment and a trailing * for the rest ("smithers.sh/:owner/:repo/blob/:ref/*").
 * Mock flags in a route's query (?as=in&hosted=paused) set the mock state when the route opens (see mock.tsx).
 */
import { useEffect, useSyncExternalStore, type AnchorHTMLAttributes, type ReactNode } from "react"

/* default: the default repo UI (UI Mock Program stage 1); effect: the Effect.ts monorepo site (stage 4). */
export type Site = "effeck" | "smithers" | "default" | "effect" | "smithers-site" | "effeck-site"

export interface RouteContext {
  /** "smithers.sh/smithersai/smithers/blob/main/README.md" */
  path: string
  params: Record<string, string>
  query: URLSearchParams
}

/** One review screen: a concrete route plus mock flags, listed on #/__screens and shot by shot.mjs --all. */
export interface Screen {
  /** Stable file-name-safe id, e.g. "repo-home-signed-out". */
  id: string
  /** Route with its flags, no leading slash: "smithers.sh/smithersai/smithers?as=out". */
  route: string
  /** What the screen shows, in a few words. */
  label: string
  /** Which mock lists it. Omit for both. */
  site?: Site
  /** Milliseconds to wait before a screenshot, for screens that animate in. */
  wait?: number
}

export interface Route {
  pattern: string
  /** Which page-map entry this is, e.g. "S#6 Smithers' repo home" or "E#1 Converter". */
  name: string
  render: (context: RouteContext) => ReactNode
  /** Every state of this route worth reviewing. crawl.mjs fails a route with none. */
  screens: Array<Screen>
}

/* Trailing slashes never matter: "smithers.sh/" and "smithers.sh" are the same route. */
const segments = (path: string) => path.replace(/\/+$/, "").split("/")

export const matchPattern = (pattern: string, path: string): Record<string, string> | null => {
  const want = segments(pattern)
  const have = segments(path).map(segment => decodeURIComponent(segment))
  const params: Record<string, string> = {}
  for (let i = 0; i < want.length; i += 1) {
    const part = want[i]
    if (part === "*") { params["*"] = have.slice(i).join("/"); return params }
    if (i >= have.length || have[i] === "") return null
    if (part.startsWith(":")) params[part.slice(1)] = have[i]
    else if (part !== have[i]) return null
  }
  return have.length === want.length ? params : null
}

let routes: Array<Route> = []
export const setRoutes = (next: Array<Route>) => { routes = next }
export const allRoutes = () => routes

/** The first route whose pattern matches, in registration order. */
export const resolveRoute = (route: string): { route: Route; context: RouteContext } | null => {
  const [rawPath, rawQuery = ""] = route.replace(/^\/+/, "").split("?")
  const path = rawPath.replace(/\/+$/, "")
  for (const candidate of routes) {
    const params = matchPattern(candidate.pattern, path)
    if (params !== null) return { route: candidate, context: { path, params, query: new URLSearchParams(rawQuery) } }
  }
  return null
}

/* Location lives in the hash so the mock works from file://. */
const read = () => window.location.hash.replace(/^#\/?/, "")
const listeners = new Set<() => void>()
window.addEventListener("hashchange", () => { for (const listener of listeners) listener() })
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }

/** The current route string, e.g. "smithers.sh/smithersai/smithers?as=in". */
export const useLocation = () => useSyncExternalStore(subscribe, read)

export const navigate = (to: string, options: { replace?: boolean } = {}) => {
  const hash = `#/${to.replace(/^\/+/, "")}`
  if (options.replace) { history.replaceState(null, "", hash); for (const listener of listeners) listener() }
  else window.location.hash = hash
}

export const back = () => history.back()

/** A link to another mock route: <Link to="smithers.sh/docs/install">. External URLs use <a target="_blank">. */
export const Link = ({ to, children, ...rest }: { to: string; children: ReactNode } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href">) =>
  <a href={`#/${to.replace(/^\/+/, "")}`} {...rest}>{children}</a>

/** Scroll to the top when the path (not the query) changes. */
export const useScrollReset = (path: string) => {
  useEffect(() => { window.scrollTo(0, 0) }, [path])
}
