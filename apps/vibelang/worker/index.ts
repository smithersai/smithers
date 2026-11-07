// The site Worker: serves the Vite build and hands /api/* to the API Worker (worker/Api.vibe) over its service
// binding, as apps/mvp's site does. Without the binding the site runs the mock agent in the browser, and `/api/health`
// says so; with it, the API answers health itself, `agent: "live"` (wiki/decisions/0006-hosting.md, 0010-live-agent.md).
interface Env {
  readonly ASSETS: Fetcher
  /** The API Worker; absent on a mock-only deployment. */
  readonly API?: Fetcher
}

export default {
  fetch: async (request, env) => {
    const url = new URL(request.url)
    if (url.pathname.startsWith("/api/")) {
      if (env.API !== undefined) return env.API.fetch(request)
      if (url.pathname === "/api/health") return Response.json({ ok: true, agent: "mock" })
      return new Response("Not found", { status: 404 })
    }
    // Only home and built assets exist. Reject before the asset service's SPA fallback can turn a miss into 200.
    const home = url.pathname === "/" || url.pathname === "/index.html"
    const asset = /^\/(?:assets|media)\/[^?]+\.[^/]+$/.test(url.pathname)
    if (!home && !asset) return new Response("Not found", { status: 404 })
    const response = await env.ASSETS.fetch(request)
    if (asset && response.headers.get("Content-Type")?.includes("text/html")) return new Response("Not found", { status: 404 })
    return response
  },
} satisfies ExportedHandler<Env>
