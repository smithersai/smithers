// The site Worker serves origin-aware HTML, forwards API and docs requests, and sends an alias's or active custom
// domain's `/` to its repository page.
import { DOMAIN_RESOLVE_ROUTE } from "../src/features/domains/contract.ts"
import {
  MCP_OAUTH_AUTH_SERVER_ROUTE,
  MCP_OAUTH_PROTECTED_RESOURCE_ROUTE,
  parsePublicRepoMcpPath,
  repoMcpRoute,
} from "../src/features/mcp/contract.ts"
import { DOCS_SITE_FOLDERS } from "../src/pwa.ts"
import { aliasLocation } from "./aliases.ts"
import { isAppRoute } from "./appRoute.ts"
import { cachedPublicAbout, injectEdgeFirstPaint } from "./edgeFirstPaint.ts"

interface Env {
  readonly ASSETS: Fetcher
  readonly CHAT_API: Fetcher
  /** `APP_DOMAIN`: the deployment's own hostname; requests on any other hostname resolve active custom domains. */
  readonly APP_DOMAIN?: string
  /** `APP_ALIASES`: hostnames whose `/` opens one page of the app (worker/aliases.ts); unset without any. */
  readonly APP_ALIASES?: string
}

/** Resolves `/` on an active custom domain via ChatApi; returns `undefined` when inactive, unknown, or unreachable. */
const customDomainLocation = async (env: Env, url: URL): Promise<string | undefined> => {
  if (url.pathname !== "/" || env.APP_DOMAIN === undefined || url.hostname === env.APP_DOMAIN) return undefined
  try {
    const response = await env.CHAT_API.fetch(
      new Request(`${url.origin}${DOMAIN_RESOLVE_ROUTE}?host=${encodeURIComponent(url.hostname)}`),
    )
    if (!response.ok) return undefined
    const body = (await response.json()) as { readonly path?: unknown }
    if (typeof body.path !== "string" || !body.path.startsWith("/") || body.path.startsWith("//")) return undefined
    return `${url.origin}${body.path}${url.search}`
    // expected: an unreachable or malformed resolve lookup falls back safely to the site assets
  } catch {
    return undefined
  }
}

const SUBRESOURCE_DESTINATIONS: ReadonlySet<string> = new Set([
  "audio",
  "audioworklet",
  "embed",
  "font",
  "image",
  "manifest",
  "object",
  "paintworklet",
  "script",
  "serviceworker",
  "sharedworker",
  "style",
  "track",
  "video",
  "worker",
  "xslt",
])

/** Extensions that are always static code/style/binary assets and never SPA HTML documents. */
const STATIC_ASSET_EXTENSIONS: ReadonlySet<string> = new Set(["js", "mjs", "cjs", "css", "wasm", "map"])

const decodePathname = (pathname: string): string =>
  pathname
    .split("/")
    .map((segment) => {
      try {
        return decodeURIComponent(segment)
      } catch {
        return segment
      }
    })
    .join("/")
    .replace(/\/+/g, "/")

/** Whether a 404 from `ASSETS` is a missing static asset rather than an app route or unknown HTML page. */
const isMissingStaticAsset = (pathname: string, request: Request): boolean => {
  const normalized = decodePathname(pathname)
  // Any removed Vite build output under /assets/ is always a resource miss, even if Accept asks for HTML.
  if (normalized.startsWith("/assets/")) return true
  const dest = request.headers.get("sec-fetch-dest")?.toLowerCase()
  if (dest !== undefined && SUBRESOURCE_DESTINATIONS.has(dest)) return true
  if (isAppRoute(pathname)) return false
  const segment = normalized.slice(normalized.lastIndexOf("/") + 1)
  const dot = segment.lastIndexOf(".")
  if (dot <= 0 || dot === segment.length - 1) return false
  const ext = segment.slice(dot + 1).toLowerCase()
  if (ext === "html" || ext === "htm") return false
  if (STATIC_ASSET_EXTENSIONS.has(ext)) return true
  const accept = request.headers.get("accept")
  return accept === null || !accept.includes("text/html")
}

/** Returns a truthful empty 404 without `_headers`'s immutable caching on retired asset paths. */
const nonCacheableMissing = (response: Response): Response => {
  const headers = new Headers(response.headers)
  headers.delete("etag")
  headers.delete("content-length")
  headers.delete("content-type")
  headers.set("cache-control", "no-store")
  return new Response(null, { status: 404, headers })
}

export default {
  fetch: async (request: Request, env: Env, ctx?: ExecutionContext) => {
    const url = new URL(request.url)
    if (url.pathname === "/api/health" && (request.method === "GET" || request.method === "HEAD")) {
      const headers = new Headers({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
      return new Response(request.method === "HEAD" ? null : JSON.stringify({ ok: true, service: "smithers" }), { status: 200, headers })
    }
    if (url.pathname.startsWith("/api/")) {
      const cachedAbout = await cachedPublicAbout(request, env.CHAT_API, ctx)
      if (cachedAbout !== undefined) return cachedAbout
      return env.CHAT_API.fetch(request)
    }
    if (
      url.pathname === MCP_OAUTH_PROTECTED_RESOURCE_ROUTE ||
      url.pathname.startsWith(`${MCP_OAUTH_PROTECTED_RESOURCE_ROUTE}/`) ||
      url.pathname === MCP_OAUTH_AUTH_SERVER_ROUTE ||
      url.pathname.startsWith(`${MCP_OAUTH_AUTH_SERVER_ROUTE}/`)
    ) {
      return env.CHAT_API.fetch(request)
    }
    const repository = parsePublicRepoMcpPath(url.pathname)
    if (repository !== null) {
      url.pathname = repoMcpRoute(repository.owner, repository.name)
      return env.CHAT_API.fetch(new Request(url.toString(), request))
    }
    const alias = aliasLocation(env.APP_ALIASES, url)
    if (alias !== undefined) return Response.redirect(alias, 302)
    const customDomain = await customDomainLocation(env, url)
    if (customDomain !== undefined) return Response.redirect(customDomain, 302)
    if (DOCS_SITE_FOLDERS.includes(url.pathname)) {
      url.pathname = `${url.pathname}/`
      return Response.redirect(url.toString(), 301)
    }
    let response = await env.ASSETS.fetch(request)
    if (response.status === 404) {
      if ((request.method !== "GET" && request.method !== "HEAD") || isMissingStaticAsset(url.pathname, request)) {
        return nonCacheableMissing(response)
      }
      // App deep links and unknown page routes render the stored SPA shell without letting ASSETS rewrite missing files.
      const shell = new URL("/", url.origin)
      response = await env.ASSETS.fetch(new Request(shell, { method: request.method }))
    }
    if (response.status !== 200 || !response.headers.get("content-type")?.startsWith("text/html")) return response
    // Asset validators and lengths describe the stored shell, not this origin-specific representation.
    const headers = new Headers(response.headers)
    headers.delete("content-length")
    headers.delete("etag")
    const status = url.pathname === "/index.html" || isAppRoute(url.pathname) ? 200 : 404
    if (status === 404) headers.set("x-robots-tag", "noindex")
    if (request.method === "HEAD") {
      return new Response(null, { status, headers })
    }
    let html = (await response.text()).replaceAll("__SMITHERS_ORIGIN__", url.origin)
    if (status === 200) {
      html = await injectEdgeFirstPaint(html, url, request, env.CHAT_API, ctx)
    }
    return new Response(html, {
      status,
      headers,
    })
  },
} satisfies ExportedHandler<Env>
