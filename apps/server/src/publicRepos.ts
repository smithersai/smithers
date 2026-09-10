import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import * as Result from "effect/Result"
import * as Semaphore from "effect/Semaphore"
import type { ServerConfig } from "./Config"
import { EdgeCache, GithubAppAuth } from "./githubApp"
import { fetchWithDeadline, readJson, readText, Transport } from "./Http"
import { AVAILABLE_REPOS, COMING_SOON_REPOS, PUBLIC_REPOS_PATH } from "./publicRepoCatalog"
import type { PublicComingSoonRepository, PublicRepoCatalog, PublicRepoStats, PublicRepository } from "./publicRepoCatalog"

/*
 * GET /api/public/repos: the curated public roster's stats read on the app
 * Worker. It reads the same GitHub metadata resource the account-scoped
 * source-repository route does, but never borrows a visitor's credentials: it
 * carries the GITHUB_TOKEN override when that secret is set, otherwise the
 * Smithers GitHub App's installation token (src/githubApp.ts, through the
 * `GithubAppAuth` service), and reads anonymously when neither exists. With
 * either credential GitHub meters the reads at 5000 requests an hour instead
 * of the 60 an unauthenticated address gets; with neither, a tripped limit
 * shows as "Stats unavailable" on the cards.
 *
 * A credential leaves this module only inside the GitHub request's
 * authorization header; it never reaches a log, the catalog cache, or the
 * response. Edge caching and an in-flight join bound GitHub traffic on this
 * public page.
 */

export interface PublicReposRoster {
  /** The curated roster; tests pass a larger one to exercise the multi-repo fetch. */
  readonly repos?: ReadonlyArray<Pick<PublicRepository, "name" | "title" | "url" | "summary">>
  /** The coming-soon roster; its stats come from the same GitHub resource. */
  readonly comingSoon?: ReadonlyArray<Pick<PublicComingSoonRepository, "name" | "title" | "url">>
}

/** How GitHub answered one stats read. */
interface StatsResult {
  readonly stats: PublicRepoStats | null
  /**
   * A transient failure (a network error, a timeout, or a 5xx) is worth retrying
   * soon. A 403 or 429 means GitHub is rate limiting this Worker, and any other
   * settled answer (a 404, private metadata, an invalid body) will not change in
   * the next few minutes either; retrying those every 30 s would keep the limit
   * tripped, so they cache for the full TTL.
   */
  readonly transient: boolean
  /**
   * GitHub refused the credential. An installation token expires in an hour and
   * can be revoked early, so one 401 buys exactly one new token and one retry.
   */
  readonly unauthorized: boolean
}

/** The cache TTL in seconds: the full window, or a short retry after a transient outage. */
const FULL_TTL = 300
const RETRY_TTL = 30

/** How long one metadata read gets to answer its headers. */
const STATS_TIMEOUT_MS = 10_000

const headers = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, OPTIONS",
  "x-content-type-options": "nosniff"
}

const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0

/** Only public, matching GitHub metadata can enter the public catalog. */
const parseStats = (value: unknown, name: string): PublicRepoStats | null => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null
  const repo = value as Record<string, unknown>
  if (repo.full_name !== name || repo.private !== false || repo.disabled === true) return null
  if (!count(repo.stargazers_count) || !count(repo.forks_count) || !count(repo.open_issues_count)) return null
  const license = repo.license as { spdx_id?: unknown } | null | undefined
  return {
    stars: repo.stargazers_count,
    forks: repo.forks_count,
    openIssuesAndPulls: repo.open_issues_count,
    language: typeof repo.language === "string" ? repo.language : null,
    license: typeof license?.spdx_id === "string" && license.spdx_id !== "NOASSERTION" ? license.spdx_id : null
  }
}

const TRANSIENT: StatsResult = { stats: null, transient: true, unauthorized: false }
const SETTLED_NULL: StatsResult = { stats: null, transient: false, unauthorized: false }

/** One GitHub metadata read, as a settled result: never a failure. */
const statsFor = (name: string, token: string | undefined): Effect.Effect<StatsResult, never, Transport> =>
  Effect.gen(function*() {
    const request = new Request(`https://api.github.com/repos/${name}`, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "Smithers-public-repos",
        ...(token === undefined ? {} : { authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28" })
      },
      // workerd refuses redirect: "error" (it throws before the request is
      // sent, which nulled every card's stats in production while Bun let the
      // tests pass), so the redirect is requested manually and a 3xx answer
      // below is a settled non-answer.
      redirect: "manual"
    })
    const answer = yield* Effect.result(fetchWithDeadline("publicRepos.stats", request, undefined, STATS_TIMEOUT_MS))
    // Availability is curated independently of a transient metadata outage.
    if (Result.isFailure(answer)) return TRANSIENT
    const response = answer.success
    if (response.status >= 500) return TRANSIENT
    // GitHub metadata never redirects; a 3xx is not metadata and will not
    // change in the next few minutes, so it caches for the full window.
    if (response.status >= 300 && response.status < 400) return SETTLED_NULL
    if (!response.ok) return { stats: null, transient: false, unauthorized: response.status === 401 }
    const body = yield* Effect.result(readJson(response))
    if (Result.isFailure(body)) return SETTLED_NULL
    return { stats: parseStats(body.success, name), transient: false, unauthorized: false }
  })

interface Snapshot {
  readonly body: string
  readonly expiresAt: number
}

export type PublicReposHandler = (
  request: Request
) => Effect.Effect<Response, never, Transport | ServerConfig | GithubAppAuth | EdgeCache>

/**
 * A catalog handler with its own snapshot and in-flight gate: the isolate's
 * copy of the catalog. `handlePublicRepos` is the deployed one; a test builds
 * its own to play two isolates over one edge cache.
 */
export const makePublicReposHandler = (roster: PublicReposRoster = {}): PublicReposHandler => {
  const repos = roster.repos ?? AVAILABLE_REPOS
  const comingSoon = roster.comingSoon ?? COMING_SOON_REPOS
  const names = [...repos, ...comingSoon].map((repo) => repo.name)
  const snapshot = Ref.makeUnsafe<Snapshot | undefined>(undefined)
  const gate = Semaphore.makeUnsafe(1)

  const readAll = (token: string | undefined) =>
    Effect.forEach(names, (name) => statsFor(name, token), { concurrency: "unbounded" })

  const refresh = (cacheKey: string): Effect.Effect<void, never, Transport | GithubAppAuth | EdgeCache> =>
    Effect.gen(function*() {
      const edge = yield* EdgeCache
      const auth = yield* GithubAppAuth
      const cached = yield* edge.match(cacheKey)
      if (cached !== undefined) {
        const now = yield* Clock.currentTimeMillis
        const ttl = Math.max(0, Number(cached.headers.get("x-catalog-expires")) - now) / 1000
        if (ttl > 0) {
          const body = yield* Effect.result(readText(cached))
          if (Result.isSuccess(body)) {
            yield* Ref.set(snapshot, { body: body.success, expiresAt: now + ttl * 1000 })
            return
          }
        }
      }
      const bearer = yield* auth.token()
      let results = yield* readAll(bearer?.value)
      // An installation token can expire or be revoked mid-window. One 401 drops
      // it and buys exactly one new token; a failed re-exchange leaves the stats
      // null rather than falling back to an anonymous read GitHub would meter at
      // 60 an hour.
      if (bearer?.renewable === true && results.some((result) => result.unauthorized)) {
        yield* auth.forget()
        const renewed = yield* auth.token()
        if (renewed !== undefined) results = yield* readAll(renewed.value)
      }
      const statsOf = (index: number) => results[index]!.stats
      const body: PublicRepoCatalog = {
        // Only the public fields; the catalog's Cloud mirror path stays server-side.
        repos: repos.map((repo, index) => ({
          name: repo.name, title: repo.title, url: repo.url, summary: repo.summary, stats: statsOf(index)
        })),
        comingSoon: comingSoon.map((repo, index) => ({
          name: repo.name, title: repo.title, url: repo.url, stats: statsOf(repos.length + index)
        }))
      }
      const ttl = results.some((result) => result.transient) ? RETRY_TTL : FULL_TTL
      const now = yield* Clock.currentTimeMillis
      const next: Snapshot = { body: JSON.stringify(body), expiresAt: now + ttl * 1000 }
      yield* Ref.set(snapshot, next)
      yield* edge.put(cacheKey, new Response(next.body, {
        headers: { ...headers, "cache-control": `public, max-age=${ttl}`, "x-catalog-expires": String(next.expiresAt) }
      }))
    })

  const stale = Effect.gen(function*() {
    const current = yield* Ref.get(snapshot)
    const now = yield* Clock.currentTimeMillis
    return current === undefined || current.expiresAt <= now
  })

  return (request) =>
    Effect.gen(function*() {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers })
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response(JSON.stringify({ message: "Method not allowed." }), {
          status: 405, headers: { ...headers, allow: "GET, HEAD, OPTIONS" }
        })
      }
      if (yield* stale) {
        // Query strings and visitor headers never change the public cache key.
        const key = new URL(PUBLIC_REPOS_PATH, request.url).href
        // Concurrent readers queue behind one refresh; a reader that waited
        // finds the snapshot fresh and never refreshes again.
        yield* gate.withPermit(Effect.gen(function*() {
          if (yield* stale) yield* refresh(key)
        }))
      }
      const current = (yield* Ref.get(snapshot))!
      const now = yield* Clock.currentTimeMillis
      return new Response(request.method === "HEAD" ? null : current.body, {
        headers: { ...headers, "cache-control": `public, max-age=${Math.max(0, Math.ceil((current.expiresAt - now) / 1000))}` }
      })
    })
}

/** The deployed catalog route: one snapshot per isolate. */
export const handlePublicRepos: PublicReposHandler = makePublicReposHandler()
