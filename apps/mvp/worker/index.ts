// The site Worker serves origin-aware HTML, forwards API and docs requests, and sends an alias's or active custom
// domain's `/` to its repository page.
import { DOMAIN_RESOLVE_ROUTE } from "../src/features/domains/contract.ts"
import { DOCS_SITE_FOLDERS } from "../src/pwa.ts"
import { aliasLocation } from "./aliases.ts"
import { isAppRoute } from "./appRoute.ts"

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

export default {
  fetch: async (request, env) => {
    const url = new URL(request.url)
    if (url.pathname.startsWith("/api/")) return env.CHAT_API.fetch(request)
    const alias = aliasLocation(env.APP_ALIASES, url)
    if (alias !== undefined) return Response.redirect(alias, 302)
    const customDomain = await customDomainLocation(env, url)
    if (customDomain !== undefined) return Response.redirect(customDomain, 302)
    if (DOCS_SITE_FOLDERS.includes(url.pathname)) {
      url.pathname = `${url.pathname}/`
      return Response.redirect(url.toString(), 301)
    }
    const response = await env.ASSETS.fetch(request)
    if (response.status !== 200 || !response.headers.get("content-type")?.startsWith("text/html")) return response
    // Asset validators and lengths describe the stored shell, not this origin-specific representation.
    const headers = new Headers(response.headers)
    headers.delete("content-length")
    headers.delete("etag")
    const status = url.pathname === "/index.html" || isAppRoute(url.pathname) ? 200 : 404
    if (status === 404) headers.set("x-robots-tag", "noindex")
    return new Response((await response.text()).replaceAll("__SMITHERS_ORIGIN__", url.origin), {
      status,
      headers,
    })
  },
} satisfies ExportedHandler<Env>
