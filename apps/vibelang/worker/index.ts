// The site Worker: serves the Vite build. `/api/health` says which agent the deployment runs, so a smoke test can
// tell a mock deployment from a live one. The Effect-native API and the agent's Durable Object arrive with the live
// agent (wiki/roadmap.md, brick 1b).
interface Env {
  readonly ASSETS: Fetcher
}

export default {
  fetch: async (request, env) => {
    const url = new URL(request.url)
    if (url.pathname === "/api/health") return Response.json({ ok: true, agent: "mock" })
    // Only home and built assets exist today. Reject before the asset service's SPA fallback can turn a miss into 200.
    const home = url.pathname === "/" || url.pathname === "/index.html"
    const asset = /^\/(?:assets|media)\/[^?]+\.[^/]+$/.test(url.pathname)
    if (!home && !asset) return new Response("Not found", { status: 404 })
    const response = await env.ASSETS.fetch(request)
    if (asset && response.headers.get("Content-Type")?.includes("text/html")) return new Response("Not found", { status: 404 })
    return response
  },
} satisfies ExportedHandler<Env>
