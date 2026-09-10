import * as Effect from "effect/Effect"
import { fetchWithDeadline, Transport } from "./Http"
import { cloudRepoFor } from "./publicRepoCatalog"

/** Public repository documents, not account, workspace, gateway, or secret reads. */
export const isPublicRepositoryRead = (method: string, pathname: string): boolean => {
  if (method !== "GET") return false
  const match = /^\/api\/repos\/([a-z\d][a-z\d-]{0,38})\/([a-z\d_.-]{1,100})(.*)$/i.exec(pathname)
  if (!match || match[2] === "." || match[2] === "..") return false
  return /^(?:\/?|\/contents(?:\/.*)?|\/topics|\/stargazers|\/bookmarks(?:\/[^/]+)?|\/changes(?:\/[^/]+(?:\/(?:diff|files))?)?|\/issues(?:\/\d+(?:\/comments)?)?|\/labels|\/git\/(?:refs|trees\/[^/]+|commits\/[^/]+))$/.test(match[3]!)
}

/**
 * A catalog repository is read from its Smithers Cloud mirror namespace; the
 * rest of the path and the query are unchanged. Any other repository keeps
 * the name the browser asked for.
 */
export const cloudReadPath = (pathname: string): string => {
  const match = /^\/api\/repos\/([^/]+)\/([^/]+)(.*)$/.exec(pathname)
  if (!match) return pathname
  const cloudRepo = cloudRepoFor(`${match[1]}/${match[2]}`)
  return cloudRepo === undefined ? pathname : `/api/repos/${cloudRepo}${match[3]}`
}

/** How long the Cloud backend gets to send a document's headers. */
const READ_TIMEOUT_MS = 15_000

/**
 * The Cloud backend remains the authority for public visibility. Anonymous
 * reads carry no credentials. Repository visibility and documents can change,
 * so every read reaches the backend and neither browsers nor the edge retain
 * an answer that could outlive its public visibility.
 */
const unavailable = (): Response =>
  Response.json({ message: "Repository data is temporarily unavailable." }, {
    status: 502, headers: { "cache-control": "private, no-store" }
  })

/**
 * One anonymous document read against the Cloud mirror at `base`. An
 * unreachable, slow, or redirecting backend is the one 502 above; every
 * other answer is forwarded with its status and body, never cacheable.
 */
export const readPublicRepository = Effect.fn("PublicRepositories.read")(
  function*(url: URL, base: string) {
    const target = new URL(cloudReadPath(url.pathname) + url.search, base)
    const upstream = yield* fetchWithDeadline(
      "publicRepositories.fetch",
      new Request(target, { headers: { accept: "application/json" }, redirect: "manual" }),
      undefined,
      READ_TIMEOUT_MS
    )
    if (upstream.status >= 300 && upstream.status < 400) return unavailable()
    const headers = new Headers(upstream.headers)
    headers.delete("set-cookie")
    headers.set("cache-control", "private, no-store")
    return new Response(upstream.body, { status: upstream.status, headers })
  },
  Effect.catch(() => Effect.sync(unavailable))
) satisfies (url: URL, base: string) => Effect.Effect<Response, never, Transport>
