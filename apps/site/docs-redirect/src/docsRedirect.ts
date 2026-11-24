import * as Effect from "effect/Effect"
import { DOCS_PAGES, DOCS_REDIRECTS, README_URL } from "./docsRedirectMap"
import { fetchWithDeadline, readBoundedJson, Transport } from "./Http"

/*
 * The retired library docs sites (T-DOC-04, #3510): a separate Worker,
 * `smithers-docs-redirect` (alchemy.run.ts, entry src/worker.ts). README.md
 * is the runbook: inventory, routes, DNS.
 *
 * `<slug>.smithers.sh/<page path>` answers 301 to that page's file in the
 * slug's package docs/ folder on GitHub, and any other path to the folder.
 * `flows.smithers.sh/<sub>/<page path>` also names a page of the package
 * nested at packages/smithers/flows/<sub> (`aggregateSites` in the generator).
 * The Location is always a value of the generated maps: the Host picks a slug,
 * the path is only a lookup key into DOCS_PAGES, and the query is dropped, so
 * no request text reaches the answer and the target is always the
 * smithersai/smithers repository.
 *
 * Every other request passes through unchanged. The default config attaches
 * only the per-slug routes, so nothing else reaches this Worker. The opt-in
 * `unknown-slugs` env adds a `*.smithers.sh/*` route; under it, a single-label
 * host outside the map goes to the README only when DNS proves no record
 * claims the name: the wildcard TXT marker below is visible at a name only
 * when no explicit record of any type exists there.
 */

export const ZONE_SUFFIX = ".smithers.sh"

/** The TXT data `*.smithers.sh` carries in the unknown-slugs setup. */
export const UNCLAIMED_MARKER = "smithers-unclaimed=docs-redirect"

/** How `UNKNOWN_SLUGS` turns on the README redirect; anything else is off. */
export const UNKNOWN_SLUGS_TXT_MARKER = "txt-marker"

export interface DocsRedirectEnv {
  readonly DOCS_REDIRECT_ZONE?: string
  readonly UNKNOWN_SLUGS?: string
}

export type DocsRedirectDecision =
  | { readonly kind: "redirect"; readonly location: string }
  | { readonly kind: "unknown-slug"; readonly hostname: string }
  | { readonly kind: "pass" }

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/** Where every old site served its API reference; a path under it meant that page. */
const API_PAGE = "/reference/api/"

/**
 * A URL path in DOCS_PAGES key form: percent-decoded, a trailing `index.html`
 * dropped, ending in a slash. Undefined when it does not decode. The URL
 * parser has already resolved `.` and `..` segments.
 */
export const pageKey = (pathname: string): string | undefined => {
  let path: string
  try {
    path = decodeURIComponent(pathname)
  } catch {
    return undefined
  }
  if (path.endsWith("/index.html")) path = path.slice(0, -"index.html".length)
  return path.endsWith("/") ? path : `${path}/`
}

const pageLocation = (slug: string, pathname: string): string | undefined => {
  const pages = DOCS_PAGES.get(slug)
  const key = pageKey(pathname)
  if (pages === undefined || key === undefined) return undefined
  return pages.get(key) ?? (key.startsWith(API_PAGE) ? pages.get(API_PAGE) : undefined)
}

/** What a request URL asks for: the hostname picks the site, the path picks a page. */
export const decide = (url: URL, suffix = ZONE_SUFFIX): DocsRedirectDecision => {
  const hostname = url.hostname
  if (!hostname.endsWith(suffix)) return { kind: "pass" }
  const label = hostname.slice(0, -suffix.length)
  if (!LABEL.test(label)) return { kind: "pass" }
  const folder = DOCS_REDIRECTS.get(label)
  if (folder === undefined) return { kind: "unknown-slug", hostname }
  return { kind: "redirect", location: pageLocation(label, url.pathname) ?? folder }
}

const permanent = (location: string): Response =>
  new Response(null, { status: 301, headers: { location, "cache-control": "public, max-age=3600" } })

const DNS_TIMEOUT_MS = 2_000
const CACHE_TTL_MS = 300_000

/**
 * The most hostnames the DNS answer cache holds. Under the wildcard route a
 * scan of random subdomains brings a new name per request; past this many the
 * least recently used name is evicted, so the isolate's memory stays bounded.
 */
export const MAX_UNCLAIMED_CACHE_ENTRIES = 1_024

/** Hostname to DNS answer, in least-to-most recently used order. */
const unclaimedCache = new Map<string, { readonly unclaimed: boolean; readonly expires: number }>()

/** How many hostnames the DNS answer cache holds now; a test seam. */
export const unclaimedCacheSize = (): number => unclaimedCache.size

/** A fresh cached answer, moved to most recently used; an expired one is deleted. */
const cachedAnswer = (hostname: string, now: number): boolean | undefined => {
  const cached = unclaimedCache.get(hostname)
  if (cached === undefined) return undefined
  unclaimedCache.delete(hostname)
  if (cached.expires <= now) return undefined
  unclaimedCache.set(hostname, cached)
  return cached.unclaimed
}

/** Store an answer, first evicting expired names and then the least recently used. */
const cacheAnswer = (hostname: string, unclaimed: boolean, now: number): void => {
  unclaimedCache.delete(hostname)
  if (unclaimedCache.size >= MAX_UNCLAIMED_CACHE_ENTRIES) {
    for (const [name, entry] of unclaimedCache) if (entry.expires <= now) unclaimedCache.delete(name)
  }
  while (unclaimedCache.size >= MAX_UNCLAIMED_CACHE_ENTRIES) {
    const oldest = unclaimedCache.keys().next()
    if (oldest.done === true) break
    unclaimedCache.delete(oldest.value)
  }
  unclaimedCache.set(hostname, { unclaimed, expires: now + CACHE_TTL_MS })
}

/** Whether a DNS-over-HTTPS answer for `hostname` TXT carries the wildcard marker. */
export const answerIsUnclaimed = (hostname: string, body: unknown): boolean => {
  if (typeof body !== "object" || body === null || !("Status" in body) || body.Status !== 0) return false
  const answers = "Answer" in body && Array.isArray(body.Answer) ? body.Answer as ReadonlyArray<unknown> : []
  return answers.some(answer => typeof answer === "object" && answer !== null &&
    "type" in answer && answer.type === 16 &&
    "name" in answer && typeof answer.name === "string" && answer.name.replace(/\.$/, "") === hostname &&
    "data" in answer && answer.data === JSON.stringify(UNCLAIMED_MARKER))
}

/** Any DNS failure reads as claimed, so the request passes through. */
const isUnclaimed = (hostname: string): Effect.Effect<boolean, never, Transport> =>
  Effect.gen(function* () {
    const now = Date.now()
    const cached = cachedAnswer(hostname, now)
    if (cached !== undefined) return cached
    const query = new URL("https://cloudflare-dns.com/dns-query")
    query.searchParams.set("name", hostname)
    query.searchParams.set("type", "TXT")
    const response = yield* fetchWithDeadline("dns", query, { headers: { accept: "application/dns-json" } }, DNS_TIMEOUT_MS)
    const unclaimed = response.ok && answerIsUnclaimed(hostname, yield* readBoundedJson(response, 65_536))
    cacheAnswer(hostname, unclaimed, now)
    return unclaimed
  }).pipe(Effect.catch(() => Effect.succeed(false)))

const passThrough = (request: Request): Effect.Effect<Response, never, Transport> =>
  Transport.use(transport => transport.fetch("pass-through", request)).pipe(
    Effect.catch(() => Effect.succeed(new Response("Bad Gateway", { status: 502 })))
  )

export const handleDocsRedirect = (request: Request, env: DocsRedirectEnv): Effect.Effect<Response, never, Transport> =>
  Effect.gen(function* () {
    const decision = decide(new URL(request.url), env.DOCS_REDIRECT_ZONE && `.${env.DOCS_REDIRECT_ZONE}`)
    if (decision.kind === "redirect") return permanent(decision.location)
    if (decision.kind === "unknown-slug" && env.UNKNOWN_SLUGS === UNKNOWN_SLUGS_TXT_MARKER &&
      (yield* isUnclaimed(decision.hostname))) return permanent(README_URL)
    return yield* passThrough(request)
  })
